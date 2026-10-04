import type { TopicField } from '../words';

export type { TopicField };

/**
 * Dense retrieval's two parts: an embedder turns text into a vector, and a vector index finds the
 * topics whose texts' vectors are closest to a query's. The engine has one embedder of each kind it
 * supports (./static.ts, a static Model2Vec model in TypeScript; ../onnx.ts, an optional ONNX model)
 * and one index (./memory.ts, brute force in memory); a database's vector search can implement
 * VectorIndex too, so the retriever above them (../hybrid.ts) does not change.
 */

/** What an embedder is, as the index file records it (kb/.index/<id>.json `embedder`). */
export interface EmbedderInfo {
  /** Its id, as kb.yaml's retrieval.embedder names it ("potion-base-8M"). */
  readonly id: string;
  /** The model's pinned revision (a commit of its repository), or "local" for one read from a folder. */
  readonly revision: string;
  /** SHA-256 over its files' own SHA-256s (`<file>:<sha256>` lines, sorted by file): a changed file changes it. */
  readonly sha256: string;
  /** How many numbers a vector has. */
  readonly dim: number;
}

/**
 * Turns texts into vectors, one per text, in order. A vector is compared by cosine similarity, so
 * its length does not matter; an embedder that normalizes gives unit vectors. It must be
 * deterministic: the same text, the same vector, so an index built on one machine serves another.
 */
export interface Embedder extends EmbedderInfo {
  embed(texts: readonly string[]): readonly Float64Array[] | Promise<readonly Float64Array[]>;
}

/** One vector an index holds: which topic's text it is (in which locale, from which field), and the text's hash. */
export interface VectorEntry {
  readonly topic: string;
  readonly locale: string;
  readonly field: TopicField;
  /** SHA-256 of the text embedded (kb/index.ts textHash). */
  readonly contentHash: string;
  readonly vector: Float32Array;
}

/** A topic a vector search finds: its id and its best text's cosine similarity with the query, rounded (kb/score.ts). */
export interface VectorHit {
  readonly topic: string;
  readonly score: number;
}

/**
 * Finds the topics closest to a query vector: each topic once (its closest text), those at `floor`
 * or above, best first, ties by topic id, at most `limit`. Deterministic, like an embedder.
 */
export interface VectorIndex {
  readonly dim: number;
  search(query: { readonly vector: Float64Array; readonly limit: number; readonly floor: number }): readonly VectorHit[] | Promise<readonly VectorHit[]>;
}
