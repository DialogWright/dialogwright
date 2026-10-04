import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { main } from '../define/cli';
import { FIXTURES, libraryKb, TODAY } from './__fixtures__/library';
import { syntheticEmbedder } from './__fixtures__/syntheticModel';
import { bakeoff, formatResults, formatSweep, parseParaphrases, sweep } from './bakeoff';
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
    expect(err[0]).toContain('give one knowledge base (an app folder, or a kb folder) and --paraphrases <file>');
    expect(await main(['kb:index', '--wat'], io)).toBe(2);
    expect(err[1]).toBe('dialogwright kb:index: --wat is not an option');
  });
});
