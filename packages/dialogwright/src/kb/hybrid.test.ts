import { describe, expect, it } from 'vitest';
import { retrieve } from '../run/retrieve';
import { en, GOLDEN, libraryKb, paraphraseLines, shown } from './__fixtures__/library';
import { syntheticEmbedder } from './__fixtures__/syntheticModel';
import { loadPinnedModel, modelPresent, POTION_BASE_8M } from './embed/model';
import type { Embedder } from './embed/types';
import { DenseRetriever, fuse, HybridRetriever, RRF_K } from './hybrid';
import { roundScore } from './score';
import type { Nomination } from './types';
import { buildIndex } from './vectorIndex';

/**
 * Dense and hybrid retrieval over the library knowledge base: reciprocal rank fusion, the dense
 * half over an index's vectors, and the goldens of the hybrid's nominations for every line of the
 * paraphrase set, with the synthetic model and (when it is in the cache) with potion-base-8M.
 */

describe('reciprocal rank fusion', () => {
  it('sums 1 / (RRF_K + rank) over both rankings, each topic once, ties by topic id, `via` its better ranking, capped', () => {
    const fused = fuse([{ topic: 'a' }, { topic: 'b' }], [{ topic: 'b' }, { topic: 'c' }, { topic: 'a' }], 8, (t) => t.toUpperCase());
    expect(fused).toEqual([
      { topic: 'b', title: 'B', score: roundScore(1 / (RRF_K + 2) + 1 / (RRF_K + 1)), via: 'dense' },
      { topic: 'a', title: 'A', score: roundScore(1 / (RRF_K + 1) + 1 / (RRF_K + 3)), via: 'keyword' },
      { topic: 'c', title: 'C', score: roundScore(1 / (RRF_K + 2)), via: 'dense' },
    ]);
    expect(fuse([{ topic: 'z' }], [{ topic: 'y' }], 8, (t) => t).map((n) => [n.topic, n.via])).toEqual([['y', 'dense'], ['z', 'keyword']]);
    expect(fuse([{ topic: 'a' }], [{ topic: 'b' }], 1, (t) => t)).toHaveLength(1);
    expect(fuse([], [], 8, (t) => t)).toEqual([]);
  });
});

describe('dense and hybrid retrieval (the synthetic model)', async () => {
  const embedder = syntheticEmbedder();
  const built = await buildIndex(libraryKb(), embedder);

  it('dense: the topics whose texts are closest to the words, at the floor or above', () => {
    const dense = new DenseRetriever(libraryKb(), { embedder, vectors: built.data, floor: 0.9 });
    expect(dense.id).toBe('dense:synthetic');
    const out = dense.nominate(en('my card expired')) as Nomination[];
    expect(out[0]).toMatchObject({ topic: 'card_renewal', title: 'Renewing a library card', via: 'dense' });
    expect(out.every((n) => n.score >= 0.9)).toBe(true);
    expect(dense.nominate(en('xyzzy'))).toEqual([]);
  });

  it('refuses an index another embedder wrote', () => {
    expect(() => new DenseRetriever(libraryKb(), { embedder: { ...embedder, embed: embedder.embed.bind(embedder), sha256: '2'.repeat(64) }, vectors: built.data, floor: 0 })).toThrow('run pnpm kb:index');
  });

  it('hybrid: synchronous with a static embedder, with its id and index hash, and a golden for the paraphrase set', () => {
    const hybrid = new HybridRetriever(libraryKb(), { embedder, vectors: built.data, floor: 0.9, indexHash: built.hash });
    expect([hybrid.id, hybrid.indexHash, hybrid.cap]).toEqual(['hybrid:synthetic', built.hash, 8]);
    expect(hybrid.nominate(en('When are you open?'))).not.toBeInstanceOf(Promise);
    const got = Object.fromEntries(paraphraseLines().map((t) => [t, shown(hybrid.nominate(en(t)) as Nomination[])]));
    expect(got).toEqual(GOLDEN.hybridSynthetic);
  });

  it('hybrid: an embedder that answers later makes nominate a promise, with the same nominations', async () => {
    const later: Embedder = { id: embedder.id, revision: embedder.revision, sha256: embedder.sha256, dim: embedder.dim, embed: async (texts) => embedder.embed(texts) };
    const hybrid = new HybridRetriever(libraryKb(), { embedder: later, vectors: built.data, floor: 0.9 });
    const sync = new HybridRetriever(libraryKb(), { embedder, vectors: built.data, floor: 0.9 });
    const pending = hybrid.nominate(en('How much are the late charges?'));
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toEqual(sync.nominate(en('How much are the late charges?')));
  });

  it('the turn\'s retrieval step records its id and the index hash', async () => {
    const hybrid = new HybridRetriever(libraryKb(), { embedder, vectors: built.data, floor: 0.9, indexHash: built.hash });
    const got = await retrieve({ kb: libraryKb(), retriever: hybrid }, en('my card expired'));
    expect(got.record).toMatchObject({ retrieverId: 'hybrid:synthetic', indexHash: built.hash, nominated: [{ topic: 'card_renewal', via: 'keyword' }] });
  });
});

/** The real model, when it is in the cache (pnpm kb:model); CI sets DIALOGWRIGHT_REQUIRE_MODEL after restoring the cache, so its absence fails there. */
const REAL = modelPresent(POTION_BASE_8M) || process.env.DIALOGWRIGHT_REQUIRE_MODEL === '1';

describe.skipIf(!REAL)('hybrid retrieval with potion-base-8M (from the cache)', () => {
  it('builds the same index bytes on every machine, and its nominations for the paraphrase set are a golden', async () => {
    const embedder = loadPinnedModel(POTION_BASE_8M);
    const built = await buildIndex(libraryKb(), embedder);
    expect(built.hash).toBe('3d787d2b22f526af3eaf4b9f4683a53ef3e204ecaf8ce6b8356fd366cbfc9b6d');
    const hybrid = new HybridRetriever(libraryKb(), { embedder, vectors: built.data, floor: POTION_BASE_8M.floor });
    const got = Object.fromEntries(paraphraseLines().map((t) => [t, shown(hybrid.nominate(en(t)) as Nomination[])]));
    expect(got).toEqual(GOLDEN.hybridPotion);
  });
});
