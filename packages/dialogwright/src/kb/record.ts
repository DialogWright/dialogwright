import type { AuditDraft } from '../audit/types';
import type { KbSource } from '../core/lifecycle';
import type { KbPassage } from './types';

/**
 * The knowledge record (core/lifecycle.ts KbSource) built from a `kb/` passage, and the audit row
 * that records an answer read from one.
 *
 * Hashes in the record and the row are short: the first KB_SHORT_HASH (12) hex characters of the
 * SHA-256 digest, 48 bits, enough to tell one approval from another in a trace or an audit row. The
 * full digests stay in the passage's own file (kb/passages/<id>.yaml `approval`).
 */

/** How many hex characters of a digest the knowledge record and its audit row keep. */
export const KB_SHORT_HASH = 12;

/** A digest's first KB_SHORT_HASH hex characters. */
export function shortHash(hex: string): string {
  return hex.slice(0, KB_SHORT_HASH);
}

/** What the record needs beside the passage: whom it answered, and whether it may be said. */
export interface KbSourceOptions {
  /** The caller's value of each fact the passage depends on, as the gated tool read them. */
  readonly applies: Readonly<Record<string, string>>;
  /** The locale it was said in; default: the passage's own. */
  readonly locale?: string;
  /** Whether it may be said; default: the passage's freshness is `fresh`. */
  readonly fresh?: boolean;
  /** The source document as the console names it (its title, kb/sources/<doc>.yaml `document`); default: the document's id. */
  readonly document?: string;
}

/**
 * The knowledge record for a passage resolved (kb/resolve.ts) for a caller:
 *
 *   const r = resolvePassage(kb, { topic, facts, todayIso });
 *   if ('passage' in r && r.passage) c.out.kb = kbSourceOf(r.passage, { applies: facts, fresh: 'fresh' in r });
 *
 * Its applies are the caller's facts the passage depends on, and only those; the hashes are the
 * approval's, short (none when it has no approval).
 */
export function kbSourceOf(passage: KbPassage, opts: KbSourceOptions): KbSource {
  const applies: Record<string, string> = {};
  for (const fact of Object.keys(passage.applies).sort()) {
    const value = Object.hasOwn(opts.applies, fact) ? opts.applies[fact] : undefined;
    if (value !== undefined) applies[fact] = value;
  }
  const a = passage.approval;
  return {
    passageId: passage.id,
    topic: passage.topic,
    version: passage.version,
    applies,
    locale: opts.locale ?? passage.locale,
    document: opts.document ?? passage.source.document,
    section: passage.source.section,
    effectiveFrom: passage.effective.from,
    ...(passage.effective.to !== undefined ? { effectiveTo: passage.effective.to } : {}),
    ...(a ? { approvedBy: a.approvedBy, approvedOn: a.on, sourceHash: shortHash(a.sourceHash), approvalHash: shortHash(a.hash) } : {}),
    fresh: opts.fresh ?? passage.freshness === 'fresh',
  };
}

/**
 * The audit row for an answer read from the knowledge base: `kb_answer`, naming the passage, its
 * version, whether it was fresh, and (where the record has them) its locale and short hashes. An
 * app's tool audit hook (ToolDef.audit) adds it for the turn's record (ToolAuditInput.kb):
 *
 *   audit: ({ call, summary, kb }) => [{ type: 'tool_result', detail: { tool: call.tool, summary } }, ...(kb ? [kbAuditRow(kb)] : [])]
 *
 * It holds nothing of the caller's: the facts the passage applied to stay out of it.
 */
export function kbAuditRow(source: KbSource): AuditDraft {
  return {
    type: 'kb_answer',
    detail: {
      passageId: source.passageId,
      version: source.version,
      fresh: source.fresh,
      ...(source.locale !== undefined ? { locale: source.locale } : {}),
      ...(source.sourceHash !== undefined ? { sourceHash: shortHash(source.sourceHash) } : {}),
      ...(source.approvalHash !== undefined ? { approvalHash: shortHash(source.approvalHash) } : {}),
    },
  };
}
