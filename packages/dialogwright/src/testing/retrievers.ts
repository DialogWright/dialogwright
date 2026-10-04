import type { Nomination, NominationVia, Retriever } from '../kb/types';

/**
 * Test support: retrievers for a test of a topic slot or a knowledge app, deterministic and with no
 * index, so a test says exactly what is nominated (fixedRetriever) or nominates by plain keywords
 * (keywordRetriever). Neither is for a live call.
 */

/** A fixed retriever's nominations by the words, as a test writes them: whole nominations, or topic ids (each its own title, scored by its place). */
export type FixedNominations = Readonly<Record<string, readonly (Nomination | string)[]>>;

/**
 * A retriever that nominates what `map` gives for the words, exactly as written (the text as said,
 * not normalized), and nothing for words it does not list. A topic written as its id alone is
 * nominated with the id as its title, `via: app`, and a score that falls with its place (1, 0.9, ...).
 * Its calls are kept, in order, on `calls`.
 */
export function fixedRetriever(map: FixedNominations, id = 'fixed'): Retriever & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    id,
    calls,
    nominate({ text }) {
      calls.push(text);
      const listed = Object.hasOwn(map, text) ? map[text]! : [];
      return listed.map((n, i): Nomination => (typeof n === 'string' ? { topic: n, title: n, score: Math.max(0, 1 - i / 10), via: 'app' } : n));
    },
  };
}

/** A topic a keyword retriever nominates: its id, its title, and the words or phrases that nominate it (a knowledge base's KbTopic is one). */
export interface KeywordTopic {
  readonly id: string;
  readonly title: string;
  readonly keywords: readonly string[];
}

export interface KeywordRetrieverOptions {
  /** Its id in the trace. Default: "keywords". */
  id?: string;
  /** How many topics it nominates at most. Default: 8. */
  cap?: number;
  /** How its nominations say they were found. Default: keyword. */
  via?: NominationVia;
}

/** Words as a keyword retriever compares them: lower case, letters and digits only, each run of anything else one space, padded. */
const words = (s: string): string => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/**
 * A retriever over `topics` by their keywords: each keyword (a word or a phrase) the words say whole
 * scores 1. It nominates every topic that scores, best first, ties in the order `topics` lists them,
 * at most `cap`. Case and punctuation aside; no stemming, no synonyms.
 */
export function keywordRetriever(topics: readonly KeywordTopic[], options: KeywordRetrieverOptions = {}): Retriever {
  const cap = options.cap ?? 8;
  const via = options.via ?? 'keyword';
  const prepared = topics.map((t, order) => ({ topic: t, order, keys: t.keywords.map(words).filter((k) => k.trim() !== '') }));
  return {
    id: options.id ?? 'keywords',
    nominate({ text }) {
      const said = words(text);
      return prepared
        .map(({ topic, order, keys }) => ({ topic, order, score: keys.filter((k) => said.includes(k)).length }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score || a.order - b.order)
        .slice(0, cap)
        .map(({ topic, score }): Nomination => ({ topic: topic.id, title: topic.title, score, via }));
    },
  };
}
