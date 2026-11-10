import { ENGLISH, lexiconOf, type Lexicon } from './lexicon';

/** English number words (the en lexicon's), as the engine has always read them. */
export const NUMBER_WORDS: ReadonlySet<string> = ENGLISH.numberWords;

/** English multiplier words: "hundred", "thousand". */
export const MULTIPLIER_WORDS: ReadonlySet<string> = ENGLISH.weakWords;

/**
 * The caller's words as tokens, in lower case, for `locale` (core/extract/lexicon.ts): English (no
 * locale, or any but Spanish) keeps ASCII letters and digits only; Spanish keeps every letter with
 * its accents.
 */
export function tokenize(text: string, locale?: string): string[] {
  return lexiconOf(locale).tokenize(text);
}

/**
 * Convert spoken number words to a digit string. Groups compose the way
 * English does ("forty four" 44, "three hundred five" 305, "two thousand"
 * 2000, "one thousand two hundred thirty four" 1234) and consecutive
 * groups concatenate ("forty four, one eighty seven" 44187). Non-number
 * tokens close the current group and are otherwise ignored, so a loosely
 * chosen span still yields digits; the slot mask decides whether the
 * result is acceptable. A spoken zero always starts its own digit rather
 * than composing into a group. Only a table's own words count: "constructor" is no number word.
 *
 * In Spanish (`locale` es or es-*, core/extract/lexicon.ts) the words are Spanish and compared
 * without accents, a ten joins the unit after "y" ("cincuenta y cinco" 55), the hundreds are words
 * of their own ("trescientos cinco" 305), and "mil" said first is one thousand that stays open
 * ("mil novecientos noventa y uno" 1991), a million scales all said before it ("un millón doscientos
 * mil" 1200000), and "diez y" a unit of six to nine is one number ("diez y seis" 16). English reads as
 * it always has, but for a word an object inherits ("constructor"), which is now no number word.
 */
export function spokenToDigits(text: string, locale?: string): string {
  return spokenGroups(text, locale).join('');
}

/**
 * The groups spokenToDigits reads `text` as, in order, each as digits ("nine eleven" is 9 and 11, "two
 * eighty" 2 and 80, "one hundred fifty" 150, "double five" 55): what spokenToDigits writes one after the
 * other.
 */
export function spokenGroups(text: string, locale?: string): string[] {
  const lex = lexiconOf(locale);
  const parts: string[] = [];
  // The group being built: what a million or more scaled (high), what a thousand scaled (total), and the rest (small).
  let cur: { high: number; total: number; small: number } | null = null;
  let pendingTens: number | null = null;
  let repeat = 1;
  let open = false; // a multiplier was just applied

  const closeGroup = (): void => {
    if (cur) parts.push(String(cur.high + cur.total + cur.small));
    cur = null;
    open = false;
  };
  const add = (n: number): void => {
    if (repeat !== 1) {
      closeGroup();
      parts.push(String(n).repeat(repeat));
      repeat = 1;
      return;
    }
    // "three hundred" then "five" adds into the group; a spoken zero never does (it is its own digit).
    if (open && cur && n !== 0) {
      cur.small += n;
      open = false;
      return;
    }
    closeGroup();
    cur = { high: 0, total: 0, small: n };
  };
  const flush = (): void => {
    if (pendingTens !== null) {
      const n = pendingTens;
      pendingTens = null;
      add(n);
    }
  };
  const close = (): void => {
    flush();
    closeGroup();
    repeat = 1;
  };
  const multiply = (m: number): void => {
    flush();
    if (!cur) {
      if (lex.bareMultiplierOpens) {
        cur = m >= 1_000_000 ? { high: m, total: 0, small: 0 } : { high: 0, total: m, small: 0 };
        open = true;
        return;
      }
      add(m);
      return;
    }
    if (m >= 1_000_000) {
      // "dos millones trescientos mil": the millions stand apart, so the thousand scales only what follows them.
      cur.high += (cur.total + cur.small || 1) * m;
      cur.total = 0;
      cur.small = 0;
    } else if (m >= 1000) {
      cur.total = (cur.total + cur.small) * m;
      cur.small = 0;
    } else {
      cur.small = (cur.small || 1) * m;
    }
    open = true;
  };

  // A hundreds word ("doscientos"): a group of its own, or the hundreds of a thousand just said ("dos mil trescientos").
  const hundred = (n: number): void => {
    flush();
    if (open && cur && cur.small === 0) {
      cur.small = n;
    } else {
      closeGroup();
      repeat = 1;
      cur = { high: 0, total: 0, small: n };
    }
    open = true;
  };
  const { units: UNITS, teens: TEENS, tens: TENS, hundreds: HUNDREDS, repeats: REPEATS, multipliers: MULTIPLIERS, joinedTeens: JOINED } = lex;
  // A table's own words only: "constructor" or "toString" is no number word, whatever a plain object inherits.
  const has = (t: Readonly<Record<string, number>>, tok: string): boolean => Object.hasOwn(t, tok);

  const tokens = lex.tokenize(text).map((said) => lex.fold(said));
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    // "diez y seis": one number, 16, as "dieciséis" is (only a unit of six to nine joins it).
    const joined = has(JOINED, tok) && tokens[i + 1] === lex.joiner && has(UNITS, tokens[i + 2] ?? '') ? JOINED[tok]! + UNITS[tokens[i + 2]!]! : null;
    if (joined !== null && joined >= 16 && joined <= 19) {
      flush();
      add(joined);
      i += 2;
    } else if (/^\d+$/.test(tok)) {
      close();
      parts.push(tok.repeat(repeat));
      repeat = 1;
    } else if (has(REPEATS, tok)) {
      flush();
      repeat = REPEATS[tok]!;
    } else if (has(MULTIPLIERS, tok)) {
      multiply(MULTIPLIERS[tok]!);
    } else if (tok === lex.joiner) {
      // "cincuenta y cinco": the ten waits for its unit. Otherwise it is "and" inside a group, or a break.
      if (lex.joinsTens && pendingTens !== null) continue;
      if (!open) close();
    } else if (has(UNITS, tok)) {
      const unit = UNITS[tok]!;
      if (pendingTens !== null && unit !== 0) {
        const n = pendingTens + unit;
        pendingTens = null;
        add(n);
      } else {
        flush();
        add(unit);
      }
    } else if (has(TEENS, tok)) {
      flush();
      add(TEENS[tok]!);
    } else if (has(TENS, tok)) {
      flush();
      pendingTens = TENS[tok]!;
    } else if (has(HUNDREDS, tok)) {
      hundred(HUNDREDS[tok]!);
    } else {
      close();
    }
  }
  close();
  return parts;
}

/**
 * A year said in two pairs at `i` of `tokens` (lower case, as the lexicon tokenizes them): "twenty twenty
 * three" is 2023, "nineteen ninety nine" 1999, "nineteen oh five" 1905, "twenty twenty" 2020. Its value and
 * the index after it, or null. The first pair is one of the lexicon's year pairs' `firstPairs` (its
 * century); the second a teen, a tens word with or without its unit, or a nought and a unit (Lexicon.yearPairs,
 * data). A language with no year pairs reads none, and anything else at `i` is no year said in pairs
 * ("twenty one" is a count, "two thousand twenty three" a number said whole).
 */
export function yearPairAt(tokens: readonly string[], i: number, lex: Lexicon = ENGLISH): { value: number; next: number } | null {
  const pairs = lex.yearPairs;
  const head = tokens[i] === undefined ? undefined : lex.fold(tokens[i]!);
  if (pairs === null || head === undefined || !Object.hasOwn(pairs.firstPairs, head)) return null;
  const century = pairs.firstPairs[head]! * 100;
  const second = tokens[i + 1] === undefined ? undefined : lex.fold(tokens[i + 1]!);
  const third = tokens[i + 2] === undefined ? undefined : lex.fold(tokens[i + 2]!);
  if (second === undefined) return null;
  // A unit of one to nine (never a nought said as "oh", nor zero).
  const unit = (w: string | undefined): number | null => (w !== undefined && Object.hasOwn(lex.units, w) && !pairs.noughts.has(w) && lex.units[w]! > 0 ? lex.units[w]! : null);
  if (pairs.noughts.has(second)) {
    const u = unit(third);
    return u === null ? null : { value: century + u, next: i + 3 };
  }
  if (Object.hasOwn(lex.teens, second)) return { value: century + lex.teens[second]!, next: i + 2 };
  if (Object.hasOwn(lex.tens, second)) {
    const u = unit(third);
    return { value: century + lex.tens[second]! + (u ?? 0), next: u === null ? i + 2 : i + 3 };
  }
  return null;
}

/**
 * The numbers a text says in groups, read as the groups written together, for a language whose lexicon reads
 * them so (Lexicon.readsInGroups; English): within each run of number words, every two or more groups side by
 * side ("nine eleven" is 911, "two eighty" 280, "seven forty seven" 747, "three fifty" 350, "nine one one"
 * 91, 11 and 911, "nineteen ninety eight, nine eleven" 1998, 989, 911 and the rest), each as digits. A model,
 * a flight or a room is said so. Only another reading of what was said, beside the ones a text already has
 * (render/checks.ts sourceFiguresOf): never what a value's or a line's own figures are read as. A run ends
 * at any word that is no number word; a language with no such rule reads none.
 */
export function numbersInGroups(text: string, lex: Lexicon = ENGLISH): string[] {
  if (!lex.readsInGroups) return [];
  const tokens = lex.tokenize(text);
  const out = new Set<string>();
  let i = 0;
  while (i < tokens.length) {
    if (!lex.numberWords.has(lex.fold(tokens[i]!))) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < tokens.length && lex.numberWords.has(lex.fold(tokens[j]!))) j += 1;
    const groups = j - i > 1 ? spokenGroups(tokens.slice(i, j).join(' '), lex.language) : [];
    for (let a = 0; a < groups.length; a += 1) {
      for (let b = a + 2; b <= groups.length; b += 1) out.add(groups.slice(a, b).join(''));
    }
    i = j;
  }
  return [...out];
}
