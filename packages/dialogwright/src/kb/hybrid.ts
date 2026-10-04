import { MemoryVectorIndex } from './embed/memory';
import { loadPinnedModel, modelDir, modelPresent, STATIC_MODELS, type PinnedModel } from './embed/model';
import type { Embedder, VectorEntry, VectorHit, VectorIndex } from './embed/types';
import { KeywordRetriever } from './keyword';
import { DEFAULT_RETRIEVAL_CAP } from './schema';
import { byScoreThenTopic, roundScore } from './score';
import type { KnowledgeBase, NominateInput, Nomination, Retriever } from './types';
import { sameEmbedder, type KbIndexData } from './vectorIndex';
import { textHash, topicWordsFor, type RetrievalKb } from './words';
import { collapseWhitespace } from './hash';

/**
 * Hybrid retrieval, the engine's default for an app with a knowledge base: keyword retrieval
 * (./keyword.ts) and dense retrieval (the caller's words embedded and compared with the index's
 * vectors) run side by side, and their rankings are merged by reciprocal rank fusion:
 *
 *   fused(topic) = sum over the two rankings that have it of 1 / (RRF_K + its rank there)   (rank 1 is the best)
 *
 * so a topic both find ranks above one only one finds, and neither retriever's own scale matters.
 * Every keyword hit counts; a dense hit counts only at the floor or above (its cosine similarity),
 * which keeps a sentence about nothing in the knowledge base from nominating its nearest topics.
 * The fused scores are rounded to a millionth, sorted best first with ties by topic id, and capped.
 * Each topic is nominated once, `via` the ranking it ranked better in (keyword on a tie).
 *
 * It is deterministic end to end: BM25 counts, the static embedder is bit-deterministic, the index
 * is searched by brute force, and every comparison is of rounded scores with a fixed tie-break. So
 * the same words, locale and knowledge base nominate the same topics, in the same order, with the
 * same scores, on any machine: what a cassette replay needs.
 */

/** Reciprocal rank fusion's constant: how much a first place outweighs a tenth. The usual 60. */
export const RRF_K = 60;

/** Where dense retrieval's vectors come from: an index (as read from kb/.index, or built in memory), with the embedder that made them. */
export interface DenseOptions {
  readonly embedder: Embedder;
  /** The index's vectors (KbIndexData): those whose text is still a topic's are searched; others are ignored. */
  readonly vectors: KbIndexData;
  /** The similarity below which a dense hit is not counted. */
  readonly floor: number;
  /** How many topics it nominates on its own. Default: kb.yaml's cap. */
  readonly cap?: number;
  /** The index file's SHA-256 (Retriever.indexHash). */
  readonly indexHash?: string;
  readonly id?: string;
  /** A VectorIndex for a locale's entries, in place of the in-memory one (a database's, say). */
  readonly makeIndex?: (dim: number, entries: readonly VectorEntry[]) => VectorIndex;
}

/** Dense retrieval alone: the caller's words embedded, the index searched, hits at the floor or above. The bake-off's "static" retriever, and half of the hybrid. */
export class DenseRetriever implements Retriever {
  readonly id: string;
  readonly indexHash?: string;
  readonly cap: number;
  readonly floor: number;
  readonly embedder: Embedder;
  private readonly kb: RetrievalKb;
  private readonly byHash: ReadonlyMap<string, Float32Array>;
  private readonly makeIndex: (dim: number, entries: readonly VectorEntry[]) => VectorIndex;
  private readonly indexes = new Map<string, VectorIndex>();

  constructor(kb: RetrievalKb & { settings?: KnowledgeBase['settings'] }, options: DenseOptions) {
    if (!sameEmbedder(options.vectors.embedder, options.embedder)) {
      throw new Error(`the index was written by ${options.vectors.embedder.id} (${options.vectors.embedder.sha256.slice(0, 12)}), not by ${options.embedder.id} (${options.embedder.sha256.slice(0, 12)}): run pnpm kb:index`);
    }
    this.kb = kb;
    this.embedder = options.embedder;
    this.floor = options.floor;
    this.cap = options.cap ?? kb.settings?.retrieval.cap ?? DEFAULT_RETRIEVAL_CAP;
    this.id = options.id ?? `dense:${options.embedder.id}`;
    if (options.indexHash !== undefined) this.indexHash = options.indexHash;
    this.byHash = new Map(options.vectors.entries.map((e) => [e.contentHash, e.vector]));
    this.makeIndex = options.makeIndex ?? ((dim, entries) => new MemoryVectorIndex(dim, entries));
  }

  /** The index a caller in `locale` is searched in: each topic's texts in the locale it is read in there, with their vectors. */
  private indexFor(locale: string): VectorIndex {
    const key = locale.toLowerCase();
    const had = this.indexes.get(key);
    if (had) return had;
    const entries: VectorEntry[] = [];
    for (const topic of Object.values(this.kb.topics)) {
      const w = topicWordsFor(topic, this.kb.defaultLocale, locale);
      const seen = new Set<string>();
      const fields = [['title', [w.title]], ['keyword', w.keywords], ['ask', w.asks]] as const;
      for (const [field, texts] of fields) {
        for (const raw of texts) {
          const text = collapseWhitespace(raw);
          if (text === '') continue;
          const contentHash = textHash(text);
          const vector = this.byHash.get(contentHash);
          if (!vector || seen.has(contentHash)) continue;
          seen.add(contentHash);
          entries.push({ topic: topic.id, locale: w.locale, field, contentHash, vector });
        }
      }
    }
    const index = this.makeIndex(this.embedder.dim, entries);
    this.indexes.set(key, index);
    return index;
  }

  /** Every topic at the floor (its own, or `floor`) or above, best first (not capped): from the caller's words' vector. */
  hitsFor(vector: Float64Array, locale: string, floor: number = this.floor): readonly VectorHit[] | Promise<readonly VectorHit[]> {
    return this.indexFor(locale).search({ vector, limit: Object.keys(this.kb.topics).length, floor });
  }

  /** The caller's words' vector. */
  embedQuery(text: string): Float64Array | Promise<Float64Array> {
    const out = this.embedder.embed([text]);
    return out instanceof Promise ? out.then((v) => v[0]!) : out[0]!;
  }

  /** Every topic at the floor or above for the words, best first. */
  hits(text: string, locale: string): readonly VectorHit[] | Promise<readonly VectorHit[]> {
    return then(this.embedQuery(text), (v) => this.hitsFor(v, locale));
  }

  nominate({ text, locale }: NominateInput): Nomination[] | Promise<Nomination[]> {
    return then(this.hits(text, locale), (hits) =>
      hits.slice(0, this.cap).map((h): Nomination => ({ topic: h.topic, title: this.kb.topics[h.topic]?.title ?? h.topic, score: h.score, via: 'dense' })),
    );
  }
}

/** `f(value)`, synchronously when the value is not a promise: a static embedder's retrieval never waits on the event loop. */
function then<T, U>(value: T | Promise<T>, f: (v: T) => U | Promise<U>): U | Promise<U> {
  return value instanceof Promise ? value.then(f) : f(value);
}

/** Merges two rankings by reciprocal rank fusion (RRF_K): each topic once, rounded, best first, ties by topic id, at most `cap`. */
export function fuse(
  keyword: readonly { readonly topic: string }[],
  dense: readonly { readonly topic: string }[],
  cap: number,
  titleOf: (topic: string) => string,
): Nomination[] {
  const at = new Map<string, { kw: number; dense: number }>();
  keyword.forEach((h, i) => at.set(h.topic, { kw: i + 1, dense: at.get(h.topic)?.dense ?? Infinity }));
  dense.forEach((h, i) => {
    const had = at.get(h.topic);
    if (had) {
      if (had.dense === Infinity) had.dense = i + 1;
    } else at.set(h.topic, { kw: Infinity, dense: i + 1 });
  });
  return [...at.entries()]
    .map(([topic, r]) => {
      const raw = (r.kw === Infinity ? 0 : 1 / (RRF_K + r.kw)) + (r.dense === Infinity ? 0 : 1 / (RRF_K + r.dense));
      return { topic, score: roundScore(raw), via: r.kw <= r.dense ? ('keyword' as const) : ('dense' as const) };
    })
    .sort(byScoreThenTopic)
    .slice(0, cap)
    .map(({ topic, score, via }) => ({ topic, title: titleOf(topic), score, via }));
}

export interface HybridOptions extends DenseOptions {
  /** The keyword half. Default: a KeywordRetriever over the same topics. */
  readonly keyword?: KeywordRetriever;
}

/** Keyword and dense retrieval, fused (see the top of this file). */
export class HybridRetriever implements Retriever {
  readonly id: string;
  readonly indexHash?: string;
  readonly cap: number;
  readonly keyword: KeywordRetriever;
  readonly dense: DenseRetriever;
  private readonly kb: RetrievalKb;

  constructor(kb: RetrievalKb & { settings?: KnowledgeBase['settings'] }, options: HybridOptions) {
    this.kb = kb;
    this.cap = options.cap ?? kb.settings?.retrieval.cap ?? DEFAULT_RETRIEVAL_CAP;
    this.keyword = options.keyword ?? new KeywordRetriever(kb, { cap: this.cap });
    this.dense = new DenseRetriever(kb, { ...options, cap: this.cap });
    this.id = options.id ?? `hybrid:${options.embedder.id}`;
    if (options.indexHash !== undefined) this.indexHash = options.indexHash;
  }

  nominate({ text, locale }: NominateInput): Nomination[] | Promise<Nomination[]> {
    const kw = this.keyword.scores(text, locale);
    return then(this.dense.hits(text, locale), (dense) => fuse(kw, dense, this.cap, (topic) => this.kb.topics[topic]?.title ?? topic));
  }
}

/** Loaded pinned models, by folder: an app built twice (or two apps) read the weights once. */
const loaded = new Map<string, Embedder>();

export interface DefaultRetrieverOptions {
  /** Where the model cache is read from (DIALOGWRIGHT_MODEL_DIR). Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** The embedder to use in place of the pinned model kb.yaml names (a test's). */
  embedder?: Embedder;
}

/** Why the default retriever of a knowledge base is what it is: hybrid, or keyword alone and why. */
export type DefaultRetrieverKind = 'hybrid' | 'keyword: no embedder' | 'keyword: no index' | 'keyword: index of another embedder' | 'keyword: no weights';

/**
 * The retriever an app with a knowledge base gets when its code gives none (App.knowledge.retriever):
 *
 *  - kb.yaml names no embedder: keyword retrieval alone (id "keyword").
 *  - It names one, the index (kb/.index/<id>.json) was read and is that model's, and the model's
 *    weights are in the cache: hybrid retrieval (id "hybrid:<embedder>", with the index's hash),
 *    capped at kb.yaml's cap, the floor kb.yaml's or the model's own.
 *  - Otherwise keyword retrieval alone, so a call still nominates; `pnpm check` reports a missing
 *    or stale index (kb/rules.ts), and `pnpm kb:model` puts the weights in the cache. The trace's
 *    retrieverId says which ran.
 *
 * Weights are read from the cache once, when the app is defined (about 30 ms), never at call time.
 */
export function defaultRetriever(kb: KnowledgeBase, options: DefaultRetrieverOptions = {}): { retriever: Retriever; kind: DefaultRetrieverKind } {
  const cap = kb.settings.retrieval.cap;
  const keyword = new KeywordRetriever(kb, { cap });
  const id = kb.settings.retrieval.embedder;
  if (id === undefined) return { retriever: keyword, kind: 'keyword: no embedder' };
  const index = kb.index;
  if (!index || !('data' in index)) return { retriever: keyword, kind: 'keyword: no index' };
  const model: PinnedModel | undefined = Object.hasOwn(STATIC_MODELS, id) ? STATIC_MODELS[id] : undefined;
  let embedder = options.embedder;
  if (!embedder) {
    if (!model) return { retriever: keyword, kind: 'keyword: no weights' };
    const env = options.env ?? process.env;
    const dir = modelDir(model, env);
    embedder = loaded.get(dir);
    if (!embedder) {
      if (!modelPresent(model, env)) return { retriever: keyword, kind: 'keyword: no weights' };
      try {
        embedder = loadPinnedModel(model, env);
      } catch {
        return { retriever: keyword, kind: 'keyword: no weights' };
      }
      loaded.set(dir, embedder);
    }
  }
  if (!sameEmbedder(index.data.embedder, embedder)) return { retriever: keyword, kind: 'keyword: index of another embedder' };
  const floor = kb.settings.retrieval.floor ?? model?.floor ?? 0;
  return { retriever: new HybridRetriever(kb, { embedder, vectors: index.data, floor, cap, indexHash: index.hash, keyword }), kind: 'hybrid' };
}
