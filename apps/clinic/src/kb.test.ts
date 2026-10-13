import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bakeoff, collapseWhitespace, defaultRetriever, kbPlaceOf, loadKnowledgeFolder, parseParaphrases, pendingDrafts, REGRESS_TODAY, type KbPlace,
} from 'dialogwright';
import { describe, expect, it } from 'vitest';

/**
 * The knowledge base (kb/), read as a folder: its topics, the passages and drafts that answer them,
 * and how well retrieval finds a topic for words it has never seen (fixtures/kb/paraphrases.yaml,
 * the numbers pnpm kb:bakeoff prints). The answers themselves are said in the scripted calls.
 */
const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const KB_DIR = join(APP_DIR, 'kb');
const kb = loadKnowledgeFolder(KB_DIR).kb!;
const paraphrases = parseParaphrases(readFileSync(join(APP_DIR, 'fixtures/kb/paraphrases.yaml'), 'utf8'), kb);

/** The drafts waiting in kb/pending for a person to approve, each checked as kb:approve checks it (none once all are approved). */
const drafts = pendingDrafts(kbPlaceOf(APP_DIR, 'apps/clinic') as KbPlace, kb);

describe('the knowledge base', () => {
  it('has five topics, each answered by exactly one passage or one draft waiting for review', () => {
    expect(Object.keys(kb.topics).sort()).toEqual(['accessibility', 'cancellation_policy', 'first_visit', 'opening_hours', 'parking']);
    for (const topic of Object.keys(kb.topics)) {
      const answers = [...Object.values(kb.passages).filter((p) => p.topic === topic).map((p) => p.id), ...drafts.filter((d) => d.draft?.topic === topic).map((d) => d.id)];
      expect(answers, topic).toHaveLength(1);
    }
  });

  it('has drafts that read as drafts, quote their source section word for word, are short enough to say, and were drafted by no person', () => {
    for (const d of drafts) {
      expect(d.problems, d.id).toEqual([]);
      expect(d.draft!.drafted.excerpt, d.id).toBeDefined();
      expect(collapseWhitespace(d.draft!.answer).length, d.id).toBeLessThanOrEqual(kb.settings.maxAnswerChars);
      expect(d.draft!.drafted.by, d.id).toMatch(/^assistant /);
    }
  });

  it('has every answer for every caller, and no embedder: topics are found by their words alone', () => {
    expect(kb.settings.applies).toEqual({});
    expect(kb.settings.retrieval.embedder).toBeUndefined();
  });
});

describe('retrieval on paraphrases it has never seen (fixtures/kb/paraphrases.yaml)', () => {
  it('holds the paraphrases out of the topics\' own words', () => {
    const own = new Set(Object.values(kb.topics).flatMap((t) => [t.title, ...t.keywords, ...t.asks]).map((x) => collapseWhitespace(x).toLowerCase()));
    const lines = [...Object.values(paraphrases.topics).flat(), ...paraphrases.none];
    expect(lines.filter((l) => own.has(collapseWhitespace(l).toLowerCase()))).toEqual([]);
    expect(Object.keys(paraphrases.topics).sort()).toEqual(Object.keys(kb.topics).sort());
  });

  // Keyword retrieval, the same on every machine with nothing downloaded. kb:bakeoff measured 82.5
  // percent at the cap here, and 97.5 percent for the hybrid retriever (potion-base-8M), which the
  // clinic does not use so that its regression prints the same with no model in the cache.
  it('nominates the right topic for at least 80 percent of them at the cap, and few topics for words about nothing', async () => {
    const { retriever, kind } = defaultRetriever(kb);
    expect(kind).toBe('keyword: no embedder');
    const result = await bakeoff(retriever, paraphrases, kb.defaultLocale, REGRESS_TODAY);
    expect(result.recall).toBeGreaterThanOrEqual(0.8);
    expect(result.noneCandidates).toBeLessThanOrEqual(0.5);
    // Every topic is found for most of its paraphrases.
    for (const [topic, row] of Object.entries(result.perTopic)) expect(row.hits / row.total, topic).toBeGreaterThanOrEqual(0.75);
  });
});
