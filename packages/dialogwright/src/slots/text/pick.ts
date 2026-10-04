/**
 * A text slot's pick (the `pick` option): code splits the caller's words into candidate parts, the
 * model chooses which of them is the value, and the value is that part, copied as said. The model
 * never writes the value; it only selects among the parts code found.
 *
 * The candidates, each a slice of the words as said:
 * - The words are split into clauses at punctuation (a mark that ends a clause in any script, such
 *   as . ! ? ; : , and an ellipsis, followed by a space or the end, so "1,200" and "10:30" stay
 *   whole; and the marks that always part words: ¿ ¡ and the full-width ones) and at a joining word
 *   ("and", "but", "so", "because"), which is dropped.
 * - First, each clause, followed by its tail after each preposition in it ("at", "on", "in",
 *   "near", "by"): "the power is out at 22 Alder Street" offers itself and "22 Alder Street".
 * - Then, for two clauses side by side with only joining words between them (no punctuation), the
 *   two together as said, followed by the tails of that join that start in the first clause:
 *   "meet me at the corner of Elm and Third" offers "the corner of Elm and Third", since a joining
 *   word may sit inside the value. These come after every part of the first kind, so they never
 *   push one out of the cap and never move one to another letter.
 * - Each candidate once, in that order, at most MAX_PICK_CANDIDATES of them; the rest are not offered.
 *
 * The joining words and prepositions are a language's (PICK_WORDS: English, the list with no locale
 * too, and Spanish); a slot gives its own for any language in `pick.words`. A language with neither
 * splits at punctuation only, so another language's words never split a caller's sentence. Words
 * match whole (a word with an apostrophe or a hyphen inside it is one word), case and accents
 * aside, and a phrase ("parce que", "cerca de") matches word by word.
 */

/** The most candidates the pick question offers; those first in the order above are kept. */
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

/** The entries of `byTag` for the locale's whole tag, then for its language alone (letter case aside), those there are. */
function entriesFor<W>(byTag: Readonly<Record<string, W>> | undefined, locale: string | undefined): W[] {
  if (byTag === undefined) return [];
  const tags = Object.keys(byTag);
  const language = languageOf(locale);
  const whole = locale?.trim().replace(/_/g, '-').toLowerCase();
  const out: W[] = [];
  for (const key of whole === undefined || whole === language ? [language] : [whole, language]) {
    const tag = tags.find((t) => t.toLowerCase() === key);
    if (tag !== undefined) out.push(byTag[tag]!);
  }
  return out;
}

/**
 * The words the pick splits at in `locale`, list by list: the slot's own for the locale's tag
 * (`own`, from `pick.words`), else its own for the language alone, else the language's built-in
 * list, else none (punctuation only).
 */
export function pickWordsFor(locale: string | undefined, own?: PickWordsByLocale): PickWords {
  const lists: Partial<PickWords>[] = [...entriesFor(own, locale), PICK_WORDS[languageOf(locale)] ?? {}];
  const first = (k: keyof PickWords): readonly string[] => lists.find((l) => l[k] !== undefined)?.[k] ?? [];
  return { joiners: first('joiners'), prepositions: first('prepositions') };
}

/** A word as it is compared: lower case, accents aside. */
const fold = (word: string): string => word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** A word as said: its folded form and where it starts and ends in the text. */
interface Token {
  folded: string;
  start: number;
  end: number;
}

/** A word: letters, digits and marks, with an apostrophe or a hyphen inside it ("O'Neil", "22-24"). */
const WORD = /[\p{L}\p{N}\p{M}]+(?:['’\-‐‑][\p{L}\p{N}\p{M}]+)*/gu;
/** Punctuation that ends a clause: a script's clause mark or an ellipsis before a space or the end, and marks that always part words. */
const BOUNDARY = /[\p{Terminal_Punctuation}…](?=\s|$)|[¿¡、。！，：；？]/gu;

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
    if (phrase.every((w, k) => tokens[i + k]!.folded === w)) return phrase.length;
  }
  return 0;
}

/**
 * The clauses of `text`, piece by piece between punctuation: in each piece, the runs of words
 * between joining words, empty runs left out. Two clauses side by side in a piece have only joining
 * words between them.
 */
function clausesOf(text: string, joiners: readonly string[][]): Token[][][] {
  const pieces: Token[][][] = [];
  const piece = (start: number, end: number) => {
    const tokens = [...text.slice(start, end).matchAll(WORD)].map((m): Token => ({ folded: fold(m[0]), start: start + m.index, end: start + m.index + m[0].length }));
    const clauses: Token[][] = [];
    let run: Token[] = [];
    for (let i = 0; i < tokens.length; ) {
      const n = matchAt(tokens, i, joiners);
      if (n === 0) {
        run.push(tokens[i++]!);
        continue;
      }
      if (run.length > 0) clauses.push(run);
      run = [];
      i += n;
    }
    if (run.length > 0) clauses.push(run);
    if (clauses.length > 0) pieces.push(clauses);
  };
  let from = 0;
  for (const m of text.matchAll(BOUNDARY)) {
    piece(from, m.index);
    from = m.index + m[0].length;
  }
  piece(from, text.length);
  return pieces;
}

/**
 * The candidate parts of `text` for a pick, verbatim, in the order described at the top of this
 * file. One candidate means there is nothing to choose: the words are one clause with no tail.
 */
export function pickCandidates(text: string, words: PickWords): string[] {
  const prepositions = phrasesOf(words.prepositions);
  const out: string[] = [];
  const full = (): boolean => out.length >= MAX_PICK_CANDIDATES;
  /** The words from the start of `head` to the end of `last`, then each tail of them after a preposition in `head`. */
  const offer = (head: readonly Token[], last: Token) => {
    const add = (from: Token) => {
      const s = text.slice(from.start, last.end);
      if (!full() && !out.includes(s)) out.push(s);
    };
    add(head[0]!);
    for (let i = 0; i < head.length && !full(); i++) {
      const n = matchAt(head, i, prepositions);
      if (n > 0 && i + n < head.length) add(head[i + n]!);
    }
  };
  const pieces = clausesOf(text, phrasesOf(words.joiners));
  // First, each clause and its tails.
  for (const clauses of pieces) for (const clause of clauses) if (!full()) offer(clause, clause.at(-1)!);
  // Then each two clauses side by side, joined as said, and the join's tails that start in the first.
  for (const clauses of pieces) {
    for (let k = 0; k + 1 < clauses.length && !full(); k++) offer(clauses[k]!, clauses[k + 1]!.at(-1)!);
  }
  return out;
}

/** The labels the pick question offers its candidates under, in order: a, b, c, ... */
export const PICK_LABELS: readonly string[] = Array.from({ length: MAX_PICK_CANDIDATES }, (_, i) => String.fromCharCode(97 + i));
