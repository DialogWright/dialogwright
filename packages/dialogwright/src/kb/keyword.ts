import { DEFAULT_RETRIEVAL_CAP } from './schema';
import { byScoreThenTopic, roundScore } from './score';
import type { NominateInput, Nomination, Retriever } from './types';
import { stopwordsOf, termsOf, topicWordsFor, wordsOf, type RetrievalKb, type TopicWords } from './words';

/**
 * Keyword retrieval: Okapi BM25 over each topic's title, keywords and example questions (in the
 * caller's locale, ./words.ts), plus a boost for each keyword the caller says whole, as a phrase.
 * It finds what the caller names exactly (a code, a product, "late fee"), which a dense model may
 * blur; dense retrieval (./hybrid.ts) finds what they say in other words. Deterministic: terms are
 * counted, never sampled, and ties go to the topic id.
 *
 *   score(topic) = sum over the distinct terms t of the words said:
 *                    idf(t) * tf * (K1 + 1) / (tf + K1 * (1 - B + B * length / mean length))
 *                + PHRASE_BOOST * (words in the keyword), for each keyword said whole
 *   idf(t)       = ln(1 + (topics - df + 0.5) / (df + 0.5))
 *
 * A term is a word of the locale's lexicon with accents and common suffixes folded and its
 * stopwords (greetings, articles, yes and no) left out; a keyword phrase is matched on all its
 * words, stopwords included ("renew my card"). Every topic with a score above zero is nominated,
 * best first, at most `cap`. Scores are rounded to a millionth before they are compared.
 */

/** BM25's term-frequency saturation. */
export const BM25_K1 = 1.2;
/** BM25's length normalization. */
export const BM25_B = 0.75;
/** What each word of a keyword said whole adds to a topic's score. */
export const PHRASE_BOOST = 1;

interface Doc {
  readonly topic: string;
  readonly title: string;
  readonly locale: string;
  readonly tf: ReadonlyMap<string, number>;
  readonly length: number;
  readonly phrases: readonly (readonly string[])[];
}

interface Corpus {
  readonly docs: readonly Doc[];
  readonly df: ReadonlyMap<string, number>;
  readonly meanLength: number;
}

function docOf(words: TopicWords, title: string): Doc {
  const terms = [words.title, ...words.keywords, ...words.asks].flatMap((t) => termsOf(t, words.locale));
  const tf = new Map<string, number>();
  for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
  const stop = stopwordsOf(words.locale);
  // A keyword that is all stopwords would match any sentence with them: it is not a phrase.
  const phrases = words.keywords.map((k) => wordsOf(k, words.locale)).filter((p) => p.length > 0 && p.some((w) => !stop.has(w)));
  return { topic: words.topic, title, locale: words.locale, tf, length: terms.length, phrases };
}

/** Whether `phrase` occurs in `words` as consecutive words. */
function contains(words: readonly string[], phrase: readonly string[]): boolean {
  outer: for (let i = 0; i + phrase.length <= words.length; i++) {
    for (let j = 0; j < phrase.length; j++) if (words[i + j] !== phrase[j]) continue outer;
    return true;
  }
  return false;
}

export interface KeywordRetrieverOptions {
  /** How many topics it nominates at most. Default: kb.yaml's retrieval.cap, else DEFAULT_RETRIEVAL_CAP. */
  cap?: number;
  /** Its id in the trace. Default "keyword". */
  id?: string;
}

export class KeywordRetriever implements Retriever {
  readonly id: string;
  readonly cap: number;
  private readonly kb: RetrievalKb;
  private readonly corpora = new Map<string, Corpus>();

  constructor(kb: RetrievalKb, options: KeywordRetrieverOptions = {}) {
    this.kb = kb;
    this.cap = options.cap ?? DEFAULT_RETRIEVAL_CAP;
    this.id = options.id ?? 'keyword';
  }

  /** The topics as a caller in `locale` is matched against, built once per locale. */
  private corpusFor(locale: string): Corpus {
    const key = locale.toLowerCase();
    const had = this.corpora.get(key);
    if (had) return had;
    const docs = Object.values(this.kb.topics).map((t) => docOf(topicWordsFor(t, this.kb.defaultLocale, locale), t.title));
    const df = new Map<string, number>();
    for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    const meanLength = docs.length === 0 ? 0 : docs.reduce((n, d) => n + d.length, 0) / docs.length;
    const corpus = { docs, df, meanLength };
    this.corpora.set(key, corpus);
    return corpus;
  }

  /** Every topic's score for the words, rounded, best first (those above zero), not capped. */
  scores(text: string, locale: string): { topic: string; title: string; score: number }[] {
    const { docs, df, meanLength } = this.corpusFor(locale);
    const n = docs.length;
    // The words said, read with each wording locale's lexicon (a topic read in the default locale
    // and one read in the caller's may need different ones).
    const said = new Map<string, { words: string[]; terms: string[] }>();
    const saidIn = (tag: string): { words: string[]; terms: string[] } => {
      let s = said.get(tag);
      if (!s) {
        const stop = stopwordsOf(tag);
        const words = wordsOf(text, tag);
        s = { words, terms: [...new Set(words.filter((w) => !stop.has(w)))] };
        said.set(tag, s);
      }
      return s;
    };
    const out: { topic: string; title: string; score: number }[] = [];
    for (const d of docs) {
      const { words, terms } = saidIn(d.locale);
      let score = 0;
      for (const t of terms) {
        const tf = d.tf.get(t);
        if (tf === undefined) continue;
        const dft = df.get(t)!;
        const idf = Math.log(1 + (n - dft + 0.5) / (dft + 0.5));
        score += (idf * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * d.length) / (meanLength || 1)));
      }
      for (const p of d.phrases) if (contains(words, p)) score += PHRASE_BOOST * p.length;
      const rounded = roundScore(score);
      if (rounded > 0) out.push({ topic: d.topic, title: d.title, score: rounded });
    }
    return out.sort(byScoreThenTopic);
  }

  nominate({ text, locale }: NominateInput): Nomination[] {
    return this.scores(text, locale)
      .slice(0, this.cap)
      .map(({ topic, title, score }) => ({ topic, title, score, via: 'keyword' }));
  }
}
