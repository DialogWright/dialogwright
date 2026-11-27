import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { ConverseApp } from '../converse/app';
import { passageOf, PENDING_TOPICS_FILE } from '../kb/folder';
import { defaultRetriever } from '../kb/hybrid';
import { kbPendingSchema, kbTopicsSchema } from '../kb/schema';
import type { KbPassage, KbTopic, KnowledgeBase } from '../kb/types';

/**
 * Test support: an agent app as it would run once a person had accepted every topic its kb/pending/topics.yaml proposes
 * and approved every draft in kb/pending, built in memory only, so a test can hold the lookup to the app's own drafts
 * before anyone has approved them. Nothing is written: the app's folder, its approvals and its log are as they were. A
 * test double, never an approval: each passage is marked fresh with an approval by no one (`approvedBy` says so), and
 * the app it returns is never served.
 */
export function withPendingApproved(app: ConverseApp, today = '2026-11-27'): ConverseApp {
  const k = app.knowledge;
  if (k === undefined) throw new Error(`${app.id} has no knowledge base (kb/)`);
  const dir = join(app.dir, 'kb', 'pending');
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.yaml') && n !== PENDING_TOPICS_FILE).sort();
  } catch {
    names = [];
  }
  const proposed = (() => {
    try {
      return kbTopicsSchema.parse(parse(readFileSync(join(dir, PENDING_TOPICS_FILE), 'utf8')) ?? {});
    } catch {
      return {};
    }
  })();
  const topics: Record<string, KbTopic> = { ...k.kb.topics };
  for (const [id, t] of Object.entries(proposed)) {
    if (!Object.hasOwn(topics, id)) topics[id] = { id, title: t.title, keywords: t.keywords ?? [], asks: t.asks ?? [], risk: t.risk, locales: {} };
  }
  const passages: Record<string, KbPassage> = { ...k.kb.passages };
  for (const name of names) {
    const { drafted: _drafted, ...yaml } = kbPendingSchema.parse(parse(readFileSync(join(dir, name), 'utf8')));
    const p = passageOf(yaml, k.kb.defaultLocale, `kb/pending/${name}`, topics, k.kb.sources, k.kb.defaultLocale);
    passages[p.id] = { ...p, approval: { owner: 'test', approvedBy: 'no one (a test double: withPendingApproved)', on: today, sourceHash: p.current.sourceHash ?? '', hash: p.current.hash }, freshness: 'fresh' };
  }
  const kb: KnowledgeBase = { ...k.kb, topics, passages };
  return { ...app, knowledge: { kb, retriever: defaultRetriever(kb).retriever } };
}
