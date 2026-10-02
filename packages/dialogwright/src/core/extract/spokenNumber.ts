import { ENGLISH, lexiconOf } from './lexicon';

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
 * than composing into a group.
 *
 * In Spanish (`locale` es or es-*, core/extract/lexicon.ts) the words are Spanish and compared
 * without accents, a ten joins the unit after "y" ("cincuenta y cinco" 55), the hundreds are words
 * of their own ("trescientos cinco" 305), and "mil" said first is one thousand that stays open
 * ("mil novecientos noventa y uno" 1991). English reads exactly as it always has.
 */
export function spokenToDigits(text: string, locale?: string): string {
  const lex = lexiconOf(locale);
  const parts: string[] = [];
  let cur: { total: number; small: number } | null = null; // the group being built
  let pendingTens: number | null = null;
  let repeat = 1;
  let open = false; // a multiplier was just applied

  const closeGroup = (): void => {
    if (cur) parts.push(String(cur.total + cur.small));
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
    cur = { total: 0, small: n };
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
        cur = { total: m, small: 0 };
        open = true;
        return;
      }
      add(m);
      return;
    }
    if (m >= 1000) {
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
      cur = { total: 0, small: n };
    }
    open = true;
  };
  const { units: UNITS, teens: TEENS, tens: TENS, hundreds: HUNDREDS, repeats: REPEATS, multipliers: MULTIPLIERS } = lex;

  for (const said of lex.tokenize(text)) {
    const tok = lex.fold(said);
    if (/^\d+$/.test(tok)) {
      close();
      parts.push(tok.repeat(repeat));
      repeat = 1;
    } else if (tok in REPEATS) {
      flush();
      repeat = REPEATS[tok]!;
    } else if (tok in MULTIPLIERS) {
      multiply(MULTIPLIERS[tok]!);
    } else if (tok === lex.joiner) {
      // "cincuenta y cinco": the ten waits for its unit. Otherwise it is "and" inside a group, or a break.
      if (lex.joinsTens && pendingTens !== null) continue;
      if (!open) close();
    } else if (tok in UNITS) {
      const unit = UNITS[tok]!;
      if (pendingTens !== null && unit !== 0) {
        const n = pendingTens + unit;
        pendingTens = null;
        add(n);
      } else {
        flush();
        add(unit);
      }
    } else if (tok in TEENS) {
      flush();
      add(TEENS[tok]!);
    } else if (tok in TENS) {
      flush();
      pendingTens = TENS[tok]!;
    } else if (Object.hasOwn(HUNDREDS, tok)) {
      hundred(HUNDREDS[tok]!);
    } else {
      close();
    }
  }
  close();
  return parts.join('');
}
