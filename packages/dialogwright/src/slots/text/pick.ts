/**
 * A text slot's pick (the `pick` option): code splits the caller's words into candidate parts, the
 * model chooses which of them is the value, and the value is that part, copied as said. The model
 * never writes the value; it only selects among the parts code found.
 *
 * The candidates, in the order said:
 * - The words are split into clauses at punctuation (. ! ? ; : , followed by a space or the end;
 *   and the marks that always part words: ¿ ¡ and the full-width ones), so "1,200" and "10:30" stay
 *   whole, and at a joining word ("and", "but", "so", "because"), which is dropped.
 * - Each clause is a candidate, followed by its tail after each preposition in it ("at", "on",
 *   "in", "near", "by"): "the power is out at 22 Alder Street" offers itself and "22 Alder Street".
 * - Each candidate once, at most MAX_PICK_CANDIDATES of them; the rest are not offered.
 *
 * The joining words and prepositions are a language's (PICK_WORDS: English, the list with no locale
 * too, and Spanish); a slot gives its own for any language in `pick.words`. A language with neither
 * splits at punctuation only, so another language's words never split a caller's sentence. Words
 * match whole, case and accents aside, and a phrase ("parce que", "cerca de") matches word by word.
 */

/** The most candidates the pick question offers; the first ones said are kept. */
export const MAX_PICK_CANDIDATES = 8;

/** The words a language splits the caller's words at. */
export interface PickWords {
  /** Words that join two clauses ("and", "because"): the words split there, and the word is dropped. */
  joiners: readonly string[];
  /** Words after which a clause's tail may be the value ("at", "near"): the tail is offered too. */
  prepositions: readonly string[];
}

/** A slot's own words by language tag (`pick.words`), each list replacing the built-in one. */
export type PickWordsByLocale = Readonly<Record<string, Partial<PickWords>>>;

/** The built-in words, by language: English (also read with no locale) and Spanish. */
export const PICK_WORDS: Readonly<Record<string, PickWords>> = Object.freeze({
  en: Object.freeze({ joiners: Object.freeze(['and', 'but', 'so', 'because']), prepositions: Object.freeze(['at', 'on', 'in', 'near', 'by']) }),
  es: Object.freeze({ joiners: Object.freeze(['y', 'e', 'pero', 'porque', 'así que']), prepositions: Object.freeze(['en', 'cerca de', 'junto a']) }),
});

/** The language subtag of a locale, lower case; no locale reads as English. */
const languageOf = (locale: string | undefined): string => (locale === undefined ? 'en' : locale.trim().split(/[-_]/)[0]!.toLowerCase());

/** The entry of `byTag` for the locale's tag (letter case aside), else for its language alone. */
function entryFor<W>(byTag: Readonly<Record<string, W>> | undefined, locale: string | undefined): W | undefined {
  if (byTag === undefined) return undefined;
  const tags = Object.keys(byTag);
  const want = locale?.trim().replace(/_/g, '-').toLowerCase();
  const same = want === undefined ? undefined : tags.find((t) => t.toLowerCase() === want);
  const language = tags.find((t) => t.toLowerCase() === languageOf(locale));
  const tag = same ?? language;
  return tag === undefined ? undefined : byTag[tag];
}

/**
 * The words the pick splits at in `locale`: the slot's own for that tag or its language (`own`,
 * from `pick.words`), each list it gives replacing the built-in one; else the built-in list of the
 * language; else none (punctuation only).
 */
export function pickWordsFor(locale: string | undefined, own?: PickWordsByLocale): PickWords {
  const builtIn = PICK_WORDS[languageOf(locale)];
  const mine = entryFor(own, locale);
  return { joiners: mine?.joiners ?? builtIn?.joiners ?? [], prepositions: mine?.prepositions ?? builtIn?.prepositions ?? [] };
}

/** A word as it is compared: lower case, accents aside. */
const fold = (word: string): string => word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Words as said, each with where it starts and ends in the text. */
interface Token {
  word: string;
  start: number;
  end: number;
}

const WORD = /[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*/gu;
/** Punctuation that ends a clause: . ! ? ; : , before a space or the end, and marks that always part words. */
const BOUNDARY = /[.!?;:,](?=\s|$)|[¿¡、。！，：；？]/gu;

/** A list of words or phrases as folded word sequences, longest first so a phrase wins over a word it starts with. */
function phrasesOf(list: readonly string[]): string[][] {
  return list
    .map((p) => [...p.matchAll(WORD)].map((m) => fold(m[0])))
    .filter((p) => p.length > 0)
    .sort((a, b) => b.length - a.length);
}

/** How many tokens from `i` the first of `phrases` that starts there covers, or 0. */
function matchAt(tokens: readonly Token[], i: number, phrases: readonly string[][]): number {
  for (const phrase of phrases) {
    if (i + phrase.length > tokens.length) continue;
    if (phrase.every((w, k) => fold(tokens[i + k]!.word) === w)) return phrase.length;
  }
  return 0;
}

/**
 * The candidate parts of `text` for a pick, verbatim, in the order said (see the top of this file).
 * One candidate means there is nothing to choose: the words are one clause with no tail.
 */
export function pickCandidates(text: string, words: PickWords): string[] {
  const joiners = phrasesOf(words.joiners);
  const prepositions = phrasesOf(words.prepositions);
  const out: string[] = [];
  const add = (s: string) => {
    if (s !== '' && !out.includes(s) && out.length < MAX_PICK_CANDIDATES) out.push(s);
  };
  // The pieces between punctuation, by where they are in the text.
  const pieces: [number, number][] = [];
  let from = 0;
  for (const m of text.matchAll(BOUNDARY)) {
    pieces.push([from, m.index]);
    from = m.index + m[0].length;
  }
  pieces.push([from, text.length]);
  for (const [start, end] of pieces) {
    const tokens: Token[] = [...text.slice(start, end).matchAll(WORD)].map((m) => ({ word: m[0], start: start + m.index, end: start + m.index + m[0].length }));
    // Clauses: runs of tokens between joining words, each the text from its first word to its last.
    const clauses: Token[][] = [];
    let run: Token[] = [];
    for (let i = 0; i < tokens.length; ) {
      const n = matchAt(tokens, i, joiners);
      if (n > 0) {
        clauses.push(run);
        run = [];
        i += n;
      } else run.push(tokens[i++]!);
    }
    clauses.push(run);
    for (const clause of clauses) {
      if (clause.length === 0) continue;
      const last = clause[clause.length - 1]!.end;
      add(text.slice(clause[0]!.start, last));
      for (let i = 0; i < clause.length; i++) {
        const n = matchAt(clause, i, prepositions);
        if (n > 0 && i + n < clause.length) add(text.slice(clause[i + n]!.start, last));
      }
    }
  }
  return out;
}

/** The labels the pick question offers its candidates under, in order: a, b, c, ... */
export const PICK_LABELS: readonly string[] = Array.from({ length: MAX_PICK_CANDIDATES }, (_, i) => String.fromCharCode(97 + i));
