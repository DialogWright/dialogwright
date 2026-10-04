import { byScoreThenTopic, roundScore } from '../score';
import type { VectorEntry, VectorHit, VectorIndex } from './types';

/** The cosine similarity of a query and a stored vector, in float64, summed in index order (0 when either is all zeros). */
export function cosine(query: Float64Array, vector: Float32Array | Float64Array, queryNorm?: number): number {
  let dot = 0;
  let vv = 0;
  for (let i = 0; i < query.length; i++) {
    const v = vector[i]!;
    dot += query[i]! * v;
    vv += v * v;
  }
  let qq = 0;
  if (queryNorm === undefined) for (let i = 0; i < query.length; i++) qq += query[i]! * query[i]!;
  const qn = queryNorm ?? Math.sqrt(qq);
  const denominator = qn * Math.sqrt(vv);
  return denominator === 0 ? 0 : dot / denominator;
}

/**
 * A vector index in memory, searched by brute force: every entry's cosine with the query, each
 * topic scored by its closest entry. For a knowledge base's few thousand texts this is a fraction
 * of a millisecond. The entries are taken in the order given; the result does not depend on it.
 */
export class MemoryVectorIndex implements VectorIndex {
  readonly dim: number;
  private readonly entries: readonly VectorEntry[];

  constructor(dim: number, entries: readonly VectorEntry[]) {
    for (const e of entries) {
      if (e.vector.length !== dim) throw new Error(`the vector of topic "${e.topic}" (${e.locale}, ${e.field}) has ${e.vector.length} numbers; the index's have ${dim}`);
    }
    this.dim = dim;
    this.entries = entries;
  }

  get size(): number {
    return this.entries.length;
  }

  search({ vector, limit, floor }: { readonly vector: Float64Array; readonly limit: number; readonly floor: number }): VectorHit[] {
    if (vector.length !== this.dim) throw new Error(`the query vector has ${vector.length} numbers; the index's have ${this.dim}`);
    let qq = 0;
    for (let i = 0; i < vector.length; i++) qq += vector[i]! * vector[i]!;
    const qn = Math.sqrt(qq);
    if (qn === 0) return [];
    const best = new Map<string, number>();
    for (const e of this.entries) {
      const score = roundScore(cosine(vector, e.vector, qn));
      const had = best.get(e.topic);
      if (had === undefined || score > had) best.set(e.topic, score);
    }
    return [...best.entries()]
      .map(([topic, score]) => ({ topic, score }))
      .filter((h) => h.score >= floor && h.score > 0)
      .sort(byScoreThenTopic)
      .slice(0, limit);
  }
}
