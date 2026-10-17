import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { App } from '../../core/app/types';
import { approvalLogged } from '../../kb/log';
import { summarizableSections, summarizing } from '../../kb/sectionTexts';
import { PENDING_TOPICS_FILE } from '../../kb/folder';

/**
 * The console's Knowledge page: each app's knowledge base at a glance, read only. The passages by state
 * as `pnpm kb:status` counts them, from the knowledge base as this server loaded it (what its callers
 * hear: a passage approved since it started is said once it starts again), and the drafts and proposed
 * topics waiting in kb/pending, counted from the app's folder when the server knows it. The unanswered
 * questions come from Insights' figures (figures.ts gapTopics). Approving stays a person's, at their
 * terminal (`pnpm kb:approve`) or on the local review page (`pnpm kb:review`).
 */

/** One app's knowledge base, counted. */
export interface KnowledgeStatus {
  /** `kb`: a knowledge base (kb/); `code`: topics its own code answers (no passages); `none`. */
  kind: 'kb' | 'code' | 'none';
  topics: number;
  passages?: {
    total: number;
    /** Approved and fresh, with its approval in the log. */
    fresh: number;
    /** Approved, but outside kb:approve (no line in the log): pnpm check refuses it. */
    outside: number;
    /** Stale: its source changed since it was approved (withheld). */
    sourceChanged: number;
    /** Stale: edited after it was approved (withheld). */
    edited: number;
    /** Never approved: never said. */
    unapproved: number;
  };
  /**
   * With answers from documents on (kb.yaml documents): the documents that may be summarized, by state
   * (approved and fresh, changed since their approval, never approved), as kb:status counts them; absent
   * with summarizing off.
   */
  documents?: { approved: number; edited: number; unapproved: number };
  /** Drafts waiting in kb/pending, and whether topics are proposed there; null when the server does not know the app's folder. */
  drafts: number | null;
  proposedTopics: boolean | null;
}

/** The app's knowledge base, counted as kb:status counts it; `appDir` the app's folder, when known, for its drafts. */
export async function knowledgeStatusOf(app: App, appDir: string | undefined): Promise<KnowledgeStatus> {
  const k = app.knowledge;
  if (!k) return { kind: 'none', topics: 0, drafts: null, proposedTopics: null };
  if (!k.kb) return { kind: 'code', topics: k.topics.length, drafts: null, proposedTopics: null };
  const kb = k.kb;
  const all = Object.values(kb.passages);
  const count = (f: (p: (typeof all)[number]) => boolean): number => all.filter(f).length;
  const outside = count((p) => p.freshness === 'fresh' && approvalLogged(kb, p) === false);
  const passages = {
    total: all.length,
    fresh: count((p) => p.freshness === 'fresh') - outside,
    outside,
    sourceChanged: count((p) => p.freshness === 'source-changed'),
    edited: count((p) => p.freshness === 'edited'),
    unapproved: count((p) => p.freshness === 'unapproved'),
  };
  let drafts: number | null = null;
  let proposedTopics: boolean | null = null;
  if (appDir !== undefined) {
    const pending = join(appDir, 'kb', 'pending');
    try {
      const names = await readdir(pending);
      drafts = names.filter((n) => n.endsWith('.yaml') && !n.startsWith('.') && n !== PENDING_TOPICS_FILE).length;
      proposedTopics = names.includes(PENDING_TOPICS_FILE);
    } catch {
      // No pending folder: nothing waits, when the knowledge base is there.
      const there = await stat(join(appDir, 'kb')).then((s) => s.isDirectory(), () => false);
      drafts = there ? 0 : null;
      proposedTopics = there ? false : null;
    }
  }
  // The documents with something to summarize (kb.yaml documents), by state.
  let documents: KnowledgeStatus['documents'];
  if (summarizing(kb)) {
    const withSections = new Set(summarizableSections(kb, { approved: false }).map((s) => s.document));
    const docs = Object.values(kb.sources).filter((d) => withSections.has(d.id));
    documents = { approved: docs.filter((d) => d.freshness === 'fresh').length, edited: docs.filter((d) => d.freshness === 'edited').length, unapproved: docs.filter((d) => d.freshness === 'unapproved').length };
  }
  return { kind: 'kb', topics: Object.keys(kb.topics).length, passages, ...(documents !== undefined ? { documents } : {}), drafts, proposedTopics };
}
