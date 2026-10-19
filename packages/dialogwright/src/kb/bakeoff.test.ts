import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { main } from '../define/cli';
import { FIXTURES, libraryKb, TODAY } from './__fixtures__/library';
import { syntheticEmbedder } from './__fixtures__/syntheticModel';
import { bakeoff, followUpBakeoff, formatFollowUps, formatResults, formatSweep, parseFollowUps, parseParaphrases, sweep } from './bakeoff';
import type { Retriever } from './types';
import { DenseRetriever } from './hybrid';
import { KeywordRetriever } from './keyword';
import { buildIndex } from './vectorIndex';

/** The retrieval bake-off over the library knowledge base and its paraphrase set. */

const paraphrases = () => parseParaphrases(readFileSync(join(FIXTURES, 'paraphrases.yaml'), 'utf8'), libraryKb());

describe('the bake-off', () => {
  it('reads a paraphrase file, and refuses one that names a topic the knowledge base does not have', () => {
    const p = paraphrases();
    expect(Object.keys(p.topics)).toEqual(['opening_hours', 'card_renewal', 'late_fees']);
    expect([Object.values(p.topics).flat().length, p.none.length]).toEqual([24, 8]);
    expect(() => parseParaphrases('opening_hourz: [x]', libraryKb())).toThrow('"opening_hourz" is not a topic of the knowledge base');
    expect(() => parseParaphrases('none: x', libraryKb())).toThrow('"none" is not a list of lines');
    expect(() => parseParaphrases('- x', libraryKb())).toThrow('is a map');
  });

  it('reports recall at the cap per topic and overall, top-1, and candidates (keyword retrieval on the fixture)', async () => {
    const r = await bakeoff(new KeywordRetriever(libraryKb()), paraphrases(), 'en-US', TODAY);
    expect({ ...r, meanMs: 0, p95Ms: 0 }).toEqual({
      retriever: 'keyword',
      perTopic: { opening_hours: { hits: 6, first: 6, total: 8 }, card_renewal: { hits: 8, first: 8, total: 8 }, late_fees: { hits: 7, first: 7, total: 8 } },
      recall: 21 / 24,
      top1: 21 / 24,
      meanCandidates: 23 / 24,
      noneCandidates: 2 / 8,
      meanMs: 0,
      p95Ms: 0,
    });
    expect(formatResults([r])[1]).toMatch(/^1\. keyword +87\.5% +87\.5% +0\.96 +0\.25 /);
  });

  it('sweeps the floor and cap from one pass of scores', async () => {
    const embedder = syntheticEmbedder();
    const built = await buildIndex(libraryKb(), embedder);
    const points = await sweep(new KeywordRetriever(libraryKb()), new DenseRetriever(libraryKb(), { embedder, vectors: built.data, floor: 0.9 }), paraphrases(), 'en-US', [0, 0.9, 1.01], [1, 8]);
    expect(points).toHaveLength(12);
    const at = (retriever: string, floor: number, cap: number) => points.find((p) => p.retriever === retriever && p.floor === floor && p.cap === cap)!;
    expect(at('dense', 0, 8).meanCandidates).toBe(3);
    expect(at('dense', 1.01, 8)).toMatchObject({ recall: 0, meanCandidates: 0, noneCandidates: 0 });
    // The hybrid above every dense score is keyword retrieval alone.
    expect(at('hybrid', 1.01, 8)).toMatchObject({ recall: 21 / 24, meanCandidates: 23 / 24, noneCandidates: 2 / 8 });
    expect(at('hybrid', 0, 1).meanCandidates).toBe(1);
    expect(formatSweep(points)[0]).toBe('hybrid: recall / mean candidates (on none), by floor and cap');
  });

  it('kb:bakeoff and kb:index say how to call them', async () => {
    const err: string[] = [];
    const io = { out: () => {}, err: (l: string) => err.push(l), cwd: FIXTURES };
    expect(await main(['kb:bakeoff', join(FIXTURES, 'kb')], io)).toBe(2);
    expect(err[0]).toContain('give one knowledge base (an app folder, or a kb folder) and either --paraphrases <file> (topics) or --sections <file>');
    expect(await main(['kb:index', '--wat'], io)).toBe(2);
    expect(err[1]).toBe('dialogwright kb:index: --wat is not an option');
  });
});

describe('follow-ups in the bake-off (--sections --follow-ups)', () => {
  const KEYS = ['guide#fees', 'guide#hours', 'guide#parking'];

  it('reads a follow-up file, naming an entry that is not one and a section that may not be summarized', () => {
    expect(parseFollowUps('- after: what are the fees\n  say: and for a child?\n  sections: [guide#fees]\n', KEYS)).toEqual([{ after: 'what are the fees', say: 'and for a child?', sections: ['guide#fees'] }]);
    expect(() => parseFollowUps('after: x', KEYS)).toThrow('a follow-up file is a list');
    expect(() => parseFollowUps('- say: and for a child?\n  sections: [guide#fees]\n', KEYS)).toThrow('entry 1 is not');
    expect(() => parseFollowUps('- after: x\n  say: y\n  sections: [guide#gone]\n', KEYS)).toThrow('entry 1 names sections that may not be summarized: guide#gone');
  });

  it('counts each follow-up alone and read with its earlier question, and each paraphrase after unrelated earlier questions', async () => {
    // Alone, a follow-up's words find nothing; read with an earlier question, the earlier question's section.
    const sectionOf = (text: string): string[] => (/fee/.test(text) ? ['guide#fees'] : /hour|open/.test(text) ? ['guide#hours'] : /park/.test(text) ? ['guide#parking'] : []);
    const plain: Retriever = { id: 'plain', nominate: ({ text }) => sectionOf(text).map((topic) => ({ topic, title: topic, score: 1, via: 'keyword' })) };
    const withEarlier: Retriever = { id: 'with', nominate: ({ text, earlier }) => [...new Set([...sectionOf(text), ...(earlier !== undefined ? sectionOf(earlier) : [])])].map((topic) => ({ topic, title: topic, score: 1, via: 'keyword' })) };
    const followUps = parseFollowUps('- after: what are the fees\n  say: and for a child?\n  sections: [guide#fees]\n- after: when are you open\n  say: and on Sunday?\n  sections: [guide#hours]\n', KEYS);
    const paraphrases = { topics: { 'guide#parking': ['where do I park'] }, none: [] };
    const r = await followUpBakeoff(plain, withEarlier, followUps, paraphrases, 'en-US', TODAY);
    expect(r).toEqual({ followUps: { n: 2, alone: 0, read: 2 }, singles: { n: 2, alone: 2, read: 2 } });
    expect(formatFollowUps('test', r)).toEqual([
      'test:',
      '  follow-ups (2): alone 0.0% (0), read with the earlier question 100.0% (2)',
      '  questions on their own after an unrelated earlier one (2): alone 100.0%, read with it 100.0%',
    ]);
  });
});
