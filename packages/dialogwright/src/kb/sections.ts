import { dirname } from 'node:path';
import { DEFAULT_SECTIONS_CAP } from './schema';
import { LazyOnnxEmbedder, ONNX_DEFAULT_FLOOR } from './onnx';
import { fuse, HybridRetriever } from './hybrid';
import { KeywordRetriever } from './keyword';
import { MemoryVectorIndex } from './embed/memory';
import type { Embedder, VectorEntry } from './embed/types';
import type { KbIndexData } from './vectorIndex';
import { sentencesOf, summarizableSections, type KbSection } from './sectionTexts';
import type { KbTopic, KnowledgeBase, Nomination, NominateInput, Retriever } from './types';

export { sectionIndexTexts, sectionKeyOf, sectionOfKey, sentencesOf, summarizableSections, summarizing, type KbSection } from './sectionTexts';

/**
 * Answers from approved documents (kb.yaml documents, docs/designs/2026-10-17-kb-documents.md): which
 * sections of the documents in kb/sources may be summarized for a caller, the texts the index embeds
 * for them, and the retriever that nominates them for a caller's words.
 *
 * A section may be summarized when summarizing is on, its document is approved for it and unchanged
 * since (`fresh`), no passage of any locale cites it (the passage speaks for it: regulated content is
 * said as approved, a low-risk passage has its own fallback), and it is not marked `summarize: false`.
 * The index holds the sections of every document whatever its approval, so approving one changes no
 * vector; the retriever, built when the app is defined, nominates only those that may be summarized.
 */

/** The sections as topics the keyword retriever reads: the heading after its parents' its title, its questions (kb/sections.yaml) and sentences its example questions, its keywords its keywords. */
function asTopics(sections: readonly KbSection[]): Record<string, KbTopic> {
  return Object.fromEntries(sections.map((s) => [s.key, { id: s.key, title: s.path, keywords: [...s.keywords], asks: [...s.asks, ...s.sentences], risk: 'low', locales: {} } satisfies KbTopic]));
}

/**
 * The section retriever of a knowledge base with summarizing on (kb.yaml documents), beside its topic
 * retriever: by meaning too where that one is hybrid (its embedder and index; the floor
 * documents.floor, else retrieval.floor, else the embedder's own), else by keywords alone. With an
 * embedder of the sections' own (documents.embedder), by that model and its index (the floor
 * documents.floor, else ONNX_DEFAULT_FLOOR), the model loaded when the server starts (warm); by meaning alone
 * with documents.retrieval dense. Null with summarizing off, or when no section may be summarized
 * (none approved yet).
 */
export function defaultSectionRetriever(kb: KnowledgeBase, topics: Retriever | undefined): SectionRetriever | null {
  if (kb.settings.documents?.summarize !== 'on') return null;
  const settings = kb.settings.documents;
  let dense: SectionRetrieverOptions['dense'];
  let indexHash: string | undefined;
  if (settings.embedder !== undefined) {
    // The sections' own model (documents.embedder): its index, and the model loaded when the app starts.
    const index = kb.sectionsIndex;
    if (index && 'data' in index) {
      // The package is found from the app's folder (kb/'s parent, whose code the server already runs), never from inside kb/, which is data.
      const embedder = new LazyOnnxEmbedder(settings.embedder, index.data.embedder.dim, kb.folder !== undefined ? dirname(kb.folder) : undefined);
      dense = { embedder, vectors: index.data, floor: settings.floor ?? ONNX_DEFAULT_FLOOR };
      indexHash = index.hash;
    }
  } else {
    const hybrid = topics instanceof HybridRetriever ? topics : null;
    const index = kb.index;
    const vectors = index && 'data' in index ? index.data : null;
    if (hybrid && vectors) dense = { embedder: hybrid.dense.embedder, vectors, floor: settings.floor ?? kb.settings.retrieval.floor ?? hybrid.dense.floor };
    if (index && 'hash' in index) indexHash = index.hash;
  }
  const retriever = new SectionRetriever(kb, { ...(dense ? { dense } : {}), keywords: settings.retrieval !== 'dense' || dense === undefined, ...(indexHash !== undefined && dense ? { indexHash } : {}) });
  return retriever.sections.length > 0 ? retriever : null;
}

export interface SectionRetrieverOptions {
  /** Every section the index holds, approved or not: for measuring (kb:bakeoff --sections), never a call. */
  readonly all?: boolean;
  /** How many sections it nominates at most. Default: kb.yaml's documents.cap, else DEFAULT_SECTIONS_CAP. */
  readonly cap?: number;
  /** The embedder and the index's vectors, for meaning beside keywords; absent, keywords alone. */
  readonly dense?: { readonly embedder: Embedder; readonly vectors: KbIndexData; readonly floor: number };
  /** Whether keywords count beside meaning (kb.yaml documents.retrieval hybrid). Default true; false needs `dense`. */
  readonly keywords?: boolean;
  /** The hash of the index its vectors are from, recorded with its nominations. */
  readonly indexHash?: string;
}

/**
 * Nominates sections that may be summarized for a caller's words: keyword retrieval over each
 * section's heading and sentences, fused with retrieval by meaning (each section scored by its
 * closest heading or sentence) where an embedder and its index are given, as topics are nominated
 * (./hybrid.ts). Sections are read in the default locale. Deterministic.
 */
export class SectionRetriever implements Retriever {
  readonly id: string;
  readonly cap: number;
  readonly sections: readonly KbSection[];
  readonly indexHash?: string;
  private readonly keywords: boolean;
  private readonly keyword: KeywordRetriever;
  private readonly dense?: { readonly embedder: Embedder; readonly index: MemoryVectorIndex; readonly floor: number };
  private readonly titles: ReadonlyMap<string, string>;

  constructor(kb: Pick<KnowledgeBase, 'settings' | 'sources' | 'passages' | 'defaultLocale'> & Partial<Pick<KnowledgeBase, 'sectionHints' | 'glossary'>>, options: SectionRetrieverOptions = {}) {
    this.sections = summarizableSections(kb, { approved: options.all !== true });
    this.cap = options.cap ?? kb.settings.documents?.cap ?? DEFAULT_SECTIONS_CAP;
    this.titles = new Map(this.sections.map((s) => [s.key, s.heading]));
    this.keyword = new KeywordRetriever({ topics: asTopics(this.sections), defaultLocale: kb.defaultLocale }, { cap: this.cap, id: 'sections:keyword' });
    if (options.dense) {
      const keys = new Set(this.sections.map((s) => s.key));
      const entries: VectorEntry[] = options.dense.vectors.entries.filter((e) => keys.has(e.topic) && (e.field === 'section' || e.field === 'ask' || e.field === 'keyword'));
      this.dense = { embedder: options.dense.embedder, index: new MemoryVectorIndex(options.dense.embedder.dim, entries), floor: options.dense.floor };
    }
    this.keywords = options.keywords !== false || this.dense === undefined;
    this.id = this.dense ? `sections:${this.keywords ? 'hybrid' : 'dense'}:${this.dense.embedder.id}` : 'sections:keyword';
    if (options.indexHash !== undefined) this.indexHash = options.indexHash;
  }

  /** Loads an embedding model that loads on first use (the sections' own, documents.embedder): true once loaded (`wasm` where it runs on WebAssembly), false when there is none to load. */
  async warm(): Promise<boolean | 'wasm'> {
    const embedder = this.dense?.embedder as { warm?: () => Promise<unknown> } | undefined;
    if (embedder?.warm === undefined) return false;
    const loaded = (await embedder.warm()) as { runtime?: string } | undefined;
    return loaded?.runtime === 'wasm' ? 'wasm' : true;
  }

  /** Every section's keyword score for the words, best first, uncapped (kb:bakeoff's sweep). */
  keywordScores(text: string, locale: string): { topic: string; title: string; score: number }[] {
    return this.keyword.scores(text, locale);
  }

  /** Every section by meaning at `floor` or above, best first, uncapped; none without an embedder (kb:bakeoff's sweep). */
  async denseHits(text: string, floor: number): Promise<readonly { topic: string; score: number }[]> {
    const dense = this.dense;
    if (!dense) return [];
    const v = await dense.embedder.embed([text]);
    return dense.index.search({ vector: v[0]!, limit: this.sections.length, floor });
  }

  nominate({ text, locale }: NominateInput): Nomination[] | Promise<Nomination[]> {
    if (this.sections.length === 0) return [];
    const titleOf = (key: string): string => this.titles.get(key) ?? key;
    const dense = this.dense;
    if (!dense) return this.keyword.nominate({ text, locale, todayIso: '' });
    const kw = this.keyword.scores(text, locale);
    const search = (q: Float64Array) => fuse(this.keywords ? kw : [], dense.index.search({ vector: q, limit: this.sections.length, floor: dense.floor }) as readonly { topic: string }[], this.cap, titleOf);
    const embedded = dense.embedder.embed([text]);
    // A model that cannot be loaded (its package not installed) leaves the keywords.
    return embedded instanceof Promise ? embedded.then((v) => search(v[0]!), () => fuse(kw, [], this.cap, titleOf)) : search(embedded[0]!);
  }
}
