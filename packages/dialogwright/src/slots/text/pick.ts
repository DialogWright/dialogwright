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
 *   "near", "by", "for"): "the power is out at 22 Alder Street" offers itself and "22 Alder Street",
 *   and "an outage for 22 Alder Street" (no punctuation, as a recognizer gives it) offers its tail too.
 * - Then, for two clauses side by side with only joining words between them (no punctuation), the
 *   two together as said, followed by the tails of that join that start in the first clause:
 *   "meet me at the corner of Elm and Third" offers "the corner of Elm and Third", since a joining
 *   word may sit inside the value. These come after every part of the first kind, so they never
 *   push one out of the cap and never move one to another letter.
 * - These parts split there: each once, in that order, at most MAX_PICK_SPLITS (8) of them, so the
 *   first eight letters are what they were before tails from each word were offered.
 * - Then the tails from each word: from each word of a clause to the clause's end, and from each
 *   word of the first of two joined clauses to the second's end, of MIN_TAIL_WORDS (2) spoken words
 *   or more, those not offered already, up to MAX_PICK_CANDIDATES (16) in all. A lead-in is cut off
 *   whatever its words, in any language with spaces between words: "yeah my address is seventy six
 *   twenty five oak hollow lane" (no punctuation, no preposition) offers "seventy six twenty five oak
 *   hollow lane", and "it's 22 Alder Street" offers "22 Alder Street". A tail starts only after a
 *   space, so "1,200" and "10:30" are never cut inside. When there are more than the cap leaves room
 *   for, a clause's tails are kept before a join's, and the shortest first: the value is mostly at
 *   the end of what is said, so what is dropped is the longest, a tail that starts near the start of
 *   a long clause, which is offered whole anyway. They are given in the order said: clause by clause,
 *   then join by join, the longest of each first.
 *
 * Only tails: a value is mostly said last, after a lead-in, and words after it are mostly a new
 * clause (cut at punctuation, at a joining word, or offered as a preposition's tail: "by the
 * school"). Heads (from the start to a word) and inner spans would multiply the candidates by the
 * words again for the rarer value with an aside after it and no word to cut at ("... lane I
 * think"); that value is the whole words, as before, when the model chooses none. One word alone is
 * not a tail: it is mostly the last word of a longer value ("lane"), a near miss the model could
 * choose; a one-word value is still offered when punctuation, a joining word or a preposition cuts
 * it out.
 *
 * The joining words and prepositions are a language's (PICK_WORDS: English, the list with no locale
 * too, and Spanish); a slot gives its own for any language in `pick.words`. A language with neither
 * splits at punctuation only (and offers the tails from each word), so another language's words
 * never split a caller's sentence. Words match whole (a word with an apostrophe or a hyphen inside
 * it is one word), case and accents aside, and a phrase ("parce que", "cerca de") matches word by
 * word. A script written without spaces between words (Chinese, Japanese, Thai) is one word per run
 * of letters, so it has no tails from each word; it is split at its punctuation as before.
 */

/** The most parts split at punctuation, joining words and prepositions the pick offers; those first in the order said are kept. */
export const MAX_PICK_SPLITS = 8;
/** The most candidates the pick question offers in all: the parts split there, then tails from each word. */
export const MAX_PICK_CANDIDATES = 16;
/** The fewest spoken words a tail from a word has: one word alone is mostly a piece of a longer value ("Lane"). */
export const MIN_TAIL_WORDS = 2;

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
  en: Object.freeze({ joiners: Object.freeze(['and', 'but', 'so', 'because']), prepositions: Object.freeze(['at', 'on', 'in', 'near', 'by', 'for']) }),
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

/**
 * A word as said: its folded form, where it starts and ends in the text, and how many spoken words
 * start at it or before it (`n`). A spoken word is a run of words with no space between them, so
 * "1,200", "10:30" and "22-24" are one each; a tail starts only where one does.
 */
interface Token {
  folded: string;
  start: number;
  end: number;
  n: number;
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
  const tokens: Token[] = [];
  let n = 0;
  for (const m of text.matchAll(WORD)) {
    const before = tokens.at(-1);
    if (before === undefined || /\s/u.test(text.slice(before.end, m.index))) n++;
    tokens.push({ folded: fold(m[0]), start: m.index, end: m.index + m[0].length, n });
  }
  const pieces: Token[][][] = [];
  let t = 0;
  for (const cut of [...[...text.matchAll(BOUNDARY)].map((m) => m.index), text.length]) {
    const piece: Token[] = [];
    while (t < tokens.length && tokens[t]!.start < cut) piece.push(tokens[t++]!);
    const clauses: Token[][] = [];
    let run: Token[] = [];
    for (let i = 0; i < piece.length; ) {
      const k = matchAt(piece, i, joiners);
      if (k === 0) {
        run.push(piece[i++]!);
        continue;
      }
      if (run.length > 0) clauses.push(run);
      run = [];
      i += k;
    }
    if (run.length > 0) clauses.push(run);
    if (clauses.length > 0) pieces.push(clauses);
  }
  return pieces;
}

/** The words of `head` a tail may start at: its first, and each that starts a spoken word. */
const tailStarts = (head: readonly Token[]): Token[] => head.filter((tok, i) => i === 0 || tok.n !== head[i - 1]!.n);

/**
 * The tails the cap leaves room for (`room`), not in `seen`: from each word of each clause to the
 * clause's end, then from each word of the first of two clauses side by side to the second's end,
 * each of MIN_TAIL_WORDS spoken words or more. Kept: a clause's tails before a join's, the shortest
 * first, then in the order said; given back in the order said (clause by clause, then join by join;
 * the longest of each first). Each kept is added to `seen`.
 */
function tailsOf(text: string, pieces: Token[][][], room: number, seen: Set<string>): string[] {
  // buckets[kind][words]: start, end and order of each tail, in the order said; kind 0 a clause's, 1 a join's.
  const buckets: number[][][] = [[], []];
  let order = 0;
  const put = (kind: 0 | 1, head: readonly Token[], last: Token) => {
    for (const from of tailStarts(head)) {
      const words = last.n - from.n + 1;
      if (words >= MIN_TAIL_WORDS) (buckets[kind]![words] ??= []).push(from.start, last.end, order);
      order++;
    }
  };
  for (const clauses of pieces) for (const clause of clauses) put(0, clause, clause.at(-1)!);
  for (const clauses of pieces) for (let k = 0; k + 1 < clauses.length; k++) put(1, clauses[k]!, clauses[k + 1]!.at(-1)!);
  const kept: { order: number; text: string }[] = [];
  for (const byWords of buckets) {
    for (const spans of byWords) {
      for (let i = 0; spans !== undefined && i < spans.length; i += 3) {
        if (kept.length >= room) break;
        const s = text.slice(spans[i], spans[i + 1]);
        if (seen.has(s)) continue;
        seen.add(s);
        kept.push({ order: spans[i + 2]!, text: s });
      }
    }
  }
  return kept.sort((a, b) => a.order - b.order).map((k) => k.text);
}

/**
 * The candidate parts of `text` for a pick, verbatim, in the order described at the top of this
 * file. One candidate means there is nothing to choose: the words are one clause of MIN_TAIL_WORDS
 * spoken words or fewer, with no tail after a preposition.
 */
export function pickCandidates(text: string, words: PickWords): string[] {
  const prepositions = phrasesOf(words.prepositions);
  const out: string[] = [];
  const seen = new Set<string>();
  const full = (): boolean => out.length >= MAX_PICK_SPLITS;
  /** The words from the start of `head` to the end of `last`, then each tail of them after a preposition in `head`. */
  const offer = (head: readonly Token[], last: Token) => {
    const add = (from: Token) => {
      const s = text.slice(from.start, last.end);
      if (!full() && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
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
  // Then the tails from each word, as many as the cap leaves room for.
  return [...out, ...tailsOf(text, pieces, MAX_PICK_CANDIDATES - out.length, seen)];
}

/** The labels the pick question offers its candidates under, in order: a, b, c, ... */
export const PICK_LABELS: readonly string[] = Array.from({ length: MAX_PICK_CANDIDATES }, (_, i) => String.fromCharCode(97 + i));
