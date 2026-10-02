import { ENGLISH, lexiconOf, type Lexicon } from './lexicon';
import { spokenToDigits } from './spokenNumber';

/**
 * Numbers of a fixed length the caller says, spoken ("four seven one one") or written ("4711"), for a
 * slot that offers what the caller said as something to choose (a reference number not on a list).
 */

export interface NumbersSaidOptions {
  /** How many digits a number has: a run that reads as more or fewer is not one. */
  digits: number;
  /** Drop a run that reads as a year (19xx or 20xx) said right after a month name ("march twenty twenty five"): a date, not a number. */
  skipYearAfterMonth?: boolean;
  /**
   * The locale the words are in (core/extract/lexicon.ts): Spanish number words ("cuarenta y siete",
   * the "y" inside a run) and month names ("marzo de dos mil veinticinco") for es and es-*; English
   * for any other locale and for none.
   */
  locale?: string;
}

const YEAR_LIKE = /^(19|20)\d{2}$/;

const isNumberish = (lex: Lexicon, token: string): boolean => lex.numberWords.has(lex.fold(token)) || /^\d+$/.test(token);

/** A maximal run of consecutive number words or digit tokens, as digits, and whether a month name comes right before it. */
interface NumberRun {
  digits: string;
  afterMonth: boolean;
}

/**
 * The maximal runs of consecutive number words and digit tokens in `text`. Any other word (or the
 * start of the text) ends one run and, when a number follows, starts the next; punctuation is never
 * a token of its own (tokenize drops it), so it breaks nothing on its own.
 */
function numberRuns(text: string, locale: string | undefined): NumberRun[] {
  const lex = lexiconOf(locale);
  const words = lex.tokenize(text);
  const months: ReadonlySet<string> = new Set(lex.months);
  const month = (at: number): boolean => at >= 0 && months.has(lex.fold(words[at]!));
  // In Spanish a "y" between two number words is inside the number ("cuarenta y siete").
  const joins = (at: number): boolean => lex.joinsTens && lex.fold(words[at]!) === lex.joiner && at + 1 < words.length && isNumberish(lex, words[at + 1]!);
  const runs: NumberRun[] = [];
  let i = 0;
  while (i < words.length) {
    if (!isNumberish(lex, words[i]!)) {
      i++;
      continue;
    }
    let j = i;
    while (j < words.length && (isNumberish(lex, words[j]!) || (j > i && joins(j)))) j++;
    // A month just before the run, or (Spanish) a month and "de" ("marzo de dos mil veinticinco").
    const afterMonth = lex === ENGLISH ? month(i - 1) : month(i - 1) || (i > 1 && lex.fold(words[i - 1]!) === 'de' && month(i - 2));
    runs.push({ digits: spokenToDigits(words.slice(i, j).join(' '), locale), afterMonth });
    i = j;
  }
  return runs;
}

/**
 * The numbers of `digits` digits the caller says, each once, in the order said: first every run of
 * number words (a run that reads as more digits, such as a longer identifier, gives none, but a
 * shorter run split off from it by an ordinary word still does), then every number written as digits
 * on its own. With `skipYearAfterMonth`, a spoken year right after a month name is dropped; a year
 * written as digits is still a number written on its own.
 */
export function numbersSaid(text: string, options: NumbersSaidOptions): string[] {
  const { digits, skipYearAfterMonth = false, locale } = options;
  if (!Number.isInteger(digits) || digits < 1) throw new Error(`numbersSaid: digits must be a whole number, at least 1 (got ${digits})`);
  const exact = new RegExp(`^\\d{${digits}}$`);
  const out = new Set<string>();
  for (const run of numberRuns(text, locale)) {
    if (!exact.test(run.digits)) continue;
    if (skipYearAfterMonth && run.afterMonth && YEAR_LIKE.test(run.digits)) continue;
    out.add(run.digits);
  }
  for (const m of text.matchAll(new RegExp(`\\b\\d{${digits}}\\b`, 'g'))) out.add(m[0]);
  return [...out];
}
