import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bakeoff, collapseWhitespace, defaultRetriever, loadKnowledgeFolder, modelPresent, parseParaphrases, POTION_BASE_8M, REGRESS_TODAY,
} from 'dialogwright';
import { describe, expect, it } from 'vitest';

/**
 * The knowledge base (kb/), read as a folder: its topics, the passages that answer them for each
 * plan, and how well retrieval finds a topic for words it has never seen (fixtures/kb/paraphrases.yaml,
 * the numbers pnpm kb:bakeoff prints). The answers themselves are said in the scripted calls.
 */
const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const kb = loadKnowledgeFolder(join(APP_DIR, 'kb')).kb!;
const paraphrases = parseParaphrases(readFileSync(join(APP_DIR, 'fixtures/kb/paraphrases.yaml'), 'utf8'), kb);

describe('the knowledge base', () => {
  it('has fourteen topics, each answered for both plans by a passage in force today', () => {
    expect(Object.keys(kb.topics)).toHaveLength(14);
    for (const topic of Object.keys(kb.topics)) {
      for (const plan of ['advantage', 'advantage_plus']) {
        const inForce = Object.values(kb.passages).filter((p) => p.topic === topic && (p.applies.plan ?? []).includes(plan)
          && p.effective.from <= REGRESS_TODAY && (p.effective.to === undefined || REGRESS_TODAY <= p.effective.to));
        expect(inForce.map((p) => p.id), `${topic} ${plan}`).toHaveLength(1);
      }
    }
  });

  it('adds the member\'s own use of the benefit after physical therapy and follow-up visits, through a gated tool', () => {
    for (const topic of ['physical_therapy', 'follow_up']) {
      expect(kb.topics[topic]!.accountLine).toEqual({ text: "You've used {used} of them this year.", from: 'getUsage' });
    }
  });
});

describe('retrieval on paraphrases it has never seen (fixtures/kb/paraphrases.yaml)', () => {
  it('holds the paraphrases out of the topics\' own words', () => {
    const own = new Set(Object.values(kb.topics).flatMap((t) => [t.title, ...t.keywords, ...t.asks]).map((x) => collapseWhitespace(x).toLowerCase()));
    const lines = [...Object.values(paraphrases.topics).flat(), ...paraphrases.none];
    expect(lines.filter((l) => own.has(collapseWhitespace(l).toLowerCase()))).toEqual([]);
    expect(Object.keys(paraphrases.topics).sort()).toEqual(Object.keys(kb.topics).sort());
    for (const [topic, lines] of Object.entries(paraphrases.topics)) expect(lines.length, topic).toBeGreaterThanOrEqual(8);
  });

  // The real model, when it is in the cache (pnpm kb:model); CI sets DIALOGWRIGHT_REQUIRE_MODEL after restoring the cache, so its absence fails there.
  const REAL = modelPresent(POTION_BASE_8M) || process.env.DIALOGWRIGHT_REQUIRE_MODEL === '1';

  it.skipIf(!REAL)('nominates the right topic for at least 95 percent of them at the cap, with the hybrid retriever kb.yaml names, and few topics for words about nothing', async () => {
    const { retriever, kind } = defaultRetriever(kb);
    expect(kind).toBe('hybrid');
    const result = await bakeoff(retriever, paraphrases, kb.defaultLocale, REGRESS_TODAY);
    // The floor and the cap were chosen with the sweep (kb.yaml; DESIGN.md, "Knowledge").
    expect(result.recall).toBeGreaterThanOrEqual(0.95);
    expect(result.noneCandidates).toBeLessThanOrEqual(1.5);
    // Every topic is found for most of its paraphrases, so no topic depends on its keywords alone.
    for (const [topic, row] of Object.entries(result.perTopic)) expect(row.hits / row.total, topic).toBeGreaterThanOrEqual(0.75);
  });
});
