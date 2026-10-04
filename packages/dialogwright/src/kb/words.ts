import { createHash } from 'node:crypto';
import { foldAccents, lexiconOf } from '../core/extract/lexicon';
import { collapseWhitespace } from './hash';
import type { KbTopic, KnowledgeBase } from './types';

/**
 * A topic's words as retrieval reads them, in the caller's locale: which locale's wording a topic is
 * read in, its texts there, and how words are compared (the engine's lexicons, core/extract/lexicon.ts,
 * with accents folded and a light suffix folding). Both retrievers (./keyword.ts, ./hybrid.ts) and
 * the index (./vectorIndex.ts) read topics through here, so they agree on what a topic says.
 */

/** The topics and default locale retrieval reads from a knowledge base. */
export type RetrievalKb = Pick<KnowledgeBase, 'topics' | 'defaultLocale'>;

const language = (tag: string): string => tag.toLowerCase().split(/[-_]/)[0] ?? '';

/**
 * The locale a topic is read in for a caller in `locale`: the default locale when the caller speaks
 * it (or its language), else the topic's wording in the caller's locale (or language) when it has
 * one, else the default locale (a topic with no wording in the caller's language is read in the
 * default one). A tag as the knowledge base writes it.
 */
export function wordingLocaleOf(topic: KbTopic, defaultLocale: string, locale: string): string {
  const want = locale.toLowerCase();
  if (want === defaultLocale.toLowerCase()) return defaultLocale;
  const tags = Object.keys(topic.locales).sort();
  const exact = tags.find((t) => t.toLowerCase() === want);
  if (exact !== undefined) return exact;
  if (language(want) === language(defaultLocale)) return defaultLocale;
  return tags.find((t) => language(t) === language(want)) ?? defaultLocale;
}

/** A topic's texts in one locale: its title, keywords and example questions there. */
export interface TopicWords {
  readonly topic: string;
  /** The locale tag the texts are in. */
  readonly locale: string;
  readonly title: string;
  readonly keywords: readonly string[];
  readonly asks: readonly string[];
}

/** A topic's texts in a locale tag it has wording in (or the default locale): a locale's own, its title the default's when it gives none. */
export function wordsIn(topic: KbTopic, defaultLocale: string, tag: string): TopicWords {
  if (tag === defaultLocale || !Object.hasOwn(topic.locales, tag)) return { topic: topic.id, locale: defaultLocale, title: topic.title, keywords: topic.keywords, asks: topic.asks };
  const w = topic.locales[tag]!;
  return { topic: topic.id, locale: tag, title: w.title ?? topic.title, keywords: w.keywords, asks: w.asks };
}

/** A topic's texts as a caller in `locale` is matched against. */
export function topicWordsFor(topic: KbTopic, defaultLocale: string, locale: string): TopicWords {
  return wordsIn(topic, defaultLocale, wordingLocaleOf(topic, defaultLocale, locale));
}

/** The fields of a topic that are embedded: what callers' questions should match (not its answers). */
export type TopicField = 'title' | 'keyword' | 'ask';

/** One text the index embeds: a topic's title, a keyword or an example question, in one locale. */
export interface IndexText {
  readonly topic: string;
  readonly locale: string;
  readonly field: TopicField;
  readonly text: string;
  readonly contentHash: string;
}

/** The SHA-256 of a text as it is embedded (whitespace collapsed): what an index entry is keyed by. */
export function textHash(text: string): string {
  return createHash('sha256').update(collapseWhitespace(text), 'utf8').digest('hex');
}

const FIELD_ORDER: Readonly<Record<TopicField, number>> = { title: 0, keyword: 1, ask: 2 };

/**
 * Every text the index embeds, in a fixed order (topic id, locale, field, hash): each topic's title,
 * keywords and example questions in the default locale and in every locale it has wording in. Not
 * the answers: an index is for matching what callers ask. A text said twice in one field is one entry.
 */
export function indexTexts(kb: RetrievalKb): IndexText[] {
  const out = new Map<string, IndexText>();
  for (const topic of Object.values(kb.topics)) {
    for (const tag of [kb.defaultLocale, ...Object.keys(topic.locales)]) {
      const w = wordsIn(topic, kb.defaultLocale, tag);
      // A locale's title that is the default's (none given) is the default's entry, not another.
      const own = tag === kb.defaultLocale || topic.locales[tag]?.title !== undefined;
      const fields: [TopicField, readonly string[]][] = [['title', own ? [w.title] : []], ['keyword', w.keywords], ['ask', w.asks]];
      for (const [field, texts] of fields) {
        for (const raw of texts) {
          const text = collapseWhitespace(raw);
          if (text === '') continue;
          const contentHash = textHash(text);
          out.set(`${topic.id}\u0000${w.locale}\u0000${field}\u0000${contentHash}`, { topic: topic.id, locale: w.locale, field, text, contentHash });
        }
      }
    }
  }
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...out.values()].sort((a, b) => cmp(a.topic, b.topic) || cmp(a.locale, b.locale) || FIELD_ORDER[a.field] - FIELD_ORDER[b.field] || cmp(a.contentHash, b.contentHash));
}

// ---------------------------------------------------------------------------------------------
// Words compared
// ---------------------------------------------------------------------------------------------

/** A light suffix folding: plurals and the common verb endings, so "opening", "opens" and "open" are one word. Not a full stemmer. */
function fold(word: string, lang: string): string {
  let w = word;
  if (lang === 'es') {
    if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
    return w;
  }
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length >= 5 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** A text's words in a locale, in order, as retrieval compares them: the locale's lexicon's tokens, accents folded, suffixes folded. */
export function wordsOf(text: string, locale: string): string[] {
  const lex = lexiconOf(locale);
  return lex.tokenize(foldAccents(text)).map((t) => fold(lex.fold(t), lex.language));
}

/**
 * The words of a question that name no topic, beside a lexicon's fillers: question words, pronouns,
 * common verbs and prepositions. Every topic's example questions have them, so they would only add
 * noise to a score.
 */
const QUESTION_WORDS: Readonly<Record<string, readonly string[]>> = {
  en: [
    'how', 'what', 'when', 'where', 'why', 'who', 'which', 'do', 'does', 'did', 'can', 'could', 'would', 'should', 'will',
    'you', 'your', 'me', 'we', 'our', 'us', 'be', 'are', 'was', 'were', 'am', 'there', 'that', 'on', 'in', 'at', 'about',
    'much', 'many', 'get', 'need', 'want', 'know', 'like', 'tell', 'have', 'has', 'if', 'or', 'so', 'any', 'some',
  ],
  es: [
    'como', 'cuanto', 'cuanta', 'cuando', 'donde', 'quien', 'cual', 'puedo', 'puede', 'quiero', 'necesito', 'tengo', 'tiene',
    'son', 'esta', 'estan', 'hay', 'en', 'un', 'uno', 'sobre', 'te', 'nos', 'usted', 'ustedes', 'mis', 'tus', 'saber',
  ],
};

/** A locale's words that carry no topic (its lexicon's fillers, and QUESTION_WORDS), folded as wordsOf folds them. */
const stopwordCache = new Map<string, ReadonlySet<string>>();
export function stopwordsOf(locale: string): ReadonlySet<string> {
  const lex = lexiconOf(locale);
  let set = stopwordCache.get(lex.language);
  if (!set) {
    set = new Set([...lex.fillers, ...(QUESTION_WORDS[lex.language] ?? [])].map((w) => fold(lex.fold(w), lex.language)));
    stopwordCache.set(lex.language, set);
  }
  return set;
}

/** A text's terms: its words without the locale's stopwords. */
export function termsOf(text: string, locale: string): string[] {
  const stop = stopwordsOf(locale);
  return wordsOf(text, locale).filter((w) => !stop.has(w));
}
