import { NUMBER_WORDS, spokenToDigits, tokenize } from '../core/extract/spokenNumber';
import { MONTHS, normalizeYear } from '../core/extract/date';
import { candidateSpans } from '../core/spans';

/**
 * Building blocks for an app's heuristic answers (App.testing.heuristics): the readings the stub
 * shares across apps, of a number said aloud and of a date said in pieces. What an app does with
 * them (which question, which words) is the app's.
 */

export function numberWordCount(span: string): number {
  return span.split(' ').filter((tok) => /\d/.test(tok) || NUMBER_WORDS.has(tok)).length;
}

/**
 * Of the spans a question offers, the one that reads as a number of `length` digits (an ID said
 * aloud), or null when none does. Among the spans whose digits satisfy the length, prefer the most
 * number-bearing tokens, not the most tokens overall: a chunked group ("three hundred fifty five")
 * can read as `length` digits on a truncated prefix that drops trailing number words, so "fewest
 * tokens" picks that truncation over the full phrase. But raw "most tokens" over-corrects the other
 * way, letting non-number filler ("my id is ...") outweigh a shorter, complete phrase. Break
 * remaining ties toward fewer total tokens to shed that filler.
 */
export function digitSpanLabel(labels: readonly string[], length: number): string | null {
  const scored = labels
    .filter((l) => l !== 'none')
    .map((l) => ({ l, digits: spokenToDigits(l), numberWords: numberWordCount(l), tokens: l.split(' ').length }))
    .filter((x) => x.digits.length === length)
    .sort((a, b) => b.numberWords - a.numberWords || a.tokens - b.tokens);
  return scored[0]?.l ?? null;
}

const ORDINAL_IRREGULAR: Record<string, string> = {
  first: 'one', second: 'two', third: 'three', fifth: 'five', eighth: 'eight', ninth: 'nine', twelfth: 'twelve',
};

/** "fifth" -> "five", "twentieth" -> "twenty", "5th" -> "5": an ordinal as the number word it counts. */
export function cardinalWord(tok: string): string {
  const digits = /^(\d{1,2})(?:st|nd|rd|th)$/.exec(tok);
  if (digits) return digits[1]!;
  if (ORDINAL_IRREGULAR[tok]) return ORDINAL_IRREGULAR[tok]!;
  if (tok.endsWith('ieth')) return `${tok.slice(0, -4)}y`;
  if (tok.endsWith('th')) return tok.slice(0, -2);
  return tok;
}

const DAY_FILLER = new Set(['of', 'the', 'on']);

/** The day of the month said next to `month`: after it ("March fifth") or before it ("the fifth of March"). */
export function dayNearMonth(tokens: string[], at: number): string | null {
  for (const i of [at + 1, at + 2, at - 1, at - 2, at - 3]) {
    const tok = tokens[i];
    if (tok === undefined || DAY_FILLER.has(tok)) continue;
    const n = Number(spokenToDigits(cardinalWord(tok)));
    if (Number.isInteger(n) && n >= 1 && n <= 31) return String(n);
  }
  return null;
}

/**
 * The longest span that reads as a year a living caller could be born in, else null. Only spans
 * that are nothing but number words count: spokenToDigits reads straight through the words around
 * them, so "june third nineteen ninety" would otherwise normalize to 1990 and outrank the year
 * itself.
 */
export function birthYearSpan(spans: string[], todayIso: string): string | null {
  const thisYear = Number(todayIso.slice(0, 4));
  const years = spans.filter((span) => {
    if (numberWordCount(span) !== span.split(' ').length) return false;
    const y = normalizeYear(span, todayIso);
    return y !== null && y >= 1900 && y <= thisYear;
  });
  return years.sort((a, b) => b.split(' ').length - a.split(' ').length)[0] ?? null;
}

export interface DobParts { month: string | null; day: string | null; year: string | null }

export function dobParts(text: string, todayIso: string): DobParts {
  const tokens = tokenize(text);
  const at = tokens.findIndex((t) => (MONTHS as readonly string[]).includes(t));
  const month = at >= 0 ? tokens[at]! : null;
  return { month, day: at >= 0 ? dayNearMonth(tokens, at) : null, year: birthYearSpan(candidateSpans(text), todayIso) };
}

/**
 * A birthday, or a year offered on its own in answer to the year question. Two-digit years mean
 * almost any number span reads as a year, so a bare year counts only when it is the whole
 * utterance -- otherwise an ID said in digits would look like a date of birth.
 */
export function saysDob(text: string, parts: DobParts): boolean {
  if (parts.month !== null && parts.day !== null) return true;
  return parts.year !== null && parts.year === tokenize(text).join(' ');
}

/**
 * An explicit year: four digits, or a spoken year of two or more number words. A bare "12" in
 * "September 12" normalizes to a year too, so the length is what separates a year from a day.
 * An event's date is said without a year, so a year means the date is a birthday's and the
 * birthday questions own it.
 */
export function saysExplicitYear(text: string, todayIso: string): boolean {
  return candidateSpans(text).some((span) => {
    const words = span.split(' ');
    if (numberWordCount(span) !== words.length) return false;
    if (!/^\d{4}$/.test(span) && words.length < 2) return false;
    const y = normalizeYear(span, todayIso);
    return y !== null && y >= 1900;
  });
}
