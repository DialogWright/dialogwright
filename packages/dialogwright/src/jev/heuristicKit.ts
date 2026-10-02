import { lexiconOf } from '../core/extract/lexicon';
import { spokenToDigits, tokenize } from '../core/extract/spokenNumber';
import { MONTHS, normalizeYear } from '../core/extract/date';
import { candidateSpans } from '../core/spans';

/**
 * Building blocks for an app's heuristic answers (App.testing.heuristics): the readings the stub
 * shares across apps, of a number said aloud, of a date said in pieces and of a relative day. What
 * an app does with them (which question, which words) is the app's. Each reads English unless given
 * a locale: Spanish words for es and es-* (core/extract/lexicon.ts), for the heuristic stub only (the
 * slots themselves never read relative words; the model answers those questions).
 */

export function numberWordCount(span: string, locale?: string): number {
  const lex = lexiconOf(locale);
  return span.split(' ').filter((tok) => /\d/.test(tok) || lex.numberWords.has(lex.fold(tok))).length;
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
export function digitSpanLabel(labels: readonly string[], length: number, locale?: string): string | null {
  const scored = labels
    .filter((l) => l !== 'none')
    .map((l) => ({ l, digits: spokenToDigits(l, locale), numberWords: numberWordCount(l, locale), tokens: l.split(' ').length }))
    .filter((x) => x.digits.length === length)
    .sort((a, b) => b.numberWords - a.numberWords || a.tokens - b.tokens);
  return scored[0]?.l ?? null;
}

const ORDINAL_IRREGULAR: Record<string, string> = {
  first: 'one', second: 'two', third: 'three', fifth: 'five', eighth: 'eight', ninth: 'nine', twelfth: 'twelve',
};

/** The ordinal Spanish says a day of the month with ("el primero de marzo"); every other day is a cardinal. */
const ES_ORDINAL: Record<string, string> = { primero: 'uno', 'primer': 'uno' };

/** "fifth" -> "five", "twentieth" -> "twenty", "5th" -> "5": an ordinal as the number word it counts. Spanish: "primero" -> "uno". */
export function cardinalWord(tok: string, locale?: string): string {
  const lex = lexiconOf(locale);
  if (lex.language === 'es') return ES_ORDINAL[lex.fold(tok)] ?? tok;
  const digits = /^(\d{1,2})(?:st|nd|rd|th)$/.exec(tok);
  if (digits) return digits[1]!;
  if (ORDINAL_IRREGULAR[tok]) return ORDINAL_IRREGULAR[tok]!;
  if (tok.endsWith('ieth')) return `${tok.slice(0, -4)}y`;
  if (tok.endsWith('th')) return tok.slice(0, -2);
  return tok;
}

const DAY_FILLER = new Set(['of', 'the', 'on']);
const DAY_FILLER_ES = new Set(['de', 'del', 'el']);

/**
 * The day of the month said next to `month`: after it ("March fifth") or before it ("the fifth of
 * March"; Spanish "el cinco de marzo").
 */
export function dayNearMonth(tokens: string[], at: number, locale?: string): string | null {
  const lex = lexiconOf(locale);
  const filler = lex.language === 'es' ? DAY_FILLER_ES : DAY_FILLER;
  for (const i of [at + 1, at + 2, at - 1, at - 2, at - 3]) {
    const tok = tokens[i];
    if (tok === undefined || filler.has(lex.fold(tok))) continue;
    const n = Number(spokenToDigits(cardinalWord(tok, locale), locale));
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
export function birthYearSpan(spans: string[], todayIso: string, locale?: string): string | null {
  const thisYear = Number(todayIso.slice(0, 4));
  const lex = lexiconOf(locale);
  // A Spanish year holds its "y" ("mil novecientos noventa y uno"), which counts as part of it.
  const counted = (span: string): number => numberWordCount(span, locale) + (lex.joinsTens ? span.split(' ').filter((t) => t === lex.joiner).length : 0);
  const years = spans.filter((span) => {
    if (counted(span) !== span.split(' ').length) return false;
    const y = normalizeYear(span, todayIso, locale);
    return y !== null && y >= 1900 && y <= thisYear;
  });
  return years.sort((a, b) => b.split(' ').length - a.split(' ').length)[0] ?? null;
}

export interface DobParts { month: string | null; day: string | null; year: string | null }

/** The month, the day of the month and the year span a caller says; the month as the questions' label (English: "march" for "marzo"). */
export function dobParts(text: string, todayIso: string, locale?: string): DobParts {
  const lex = lexiconOf(locale);
  const tokens = tokenize(text, locale);
  const at = tokens.findIndex((t) => lex.months.includes(lex.fold(t)));
  const month = at >= 0 ? MONTHS[lex.months.indexOf(lex.fold(tokens[at]!))]! : null;
  return { month, day: at >= 0 ? dayNearMonth(tokens, at, locale) : null, year: birthYearSpan(candidateSpans(text, locale), todayIso, locale) };
}

/**
 * A birthday, or a year offered on its own in answer to the year question. Two-digit years mean
 * almost any number span reads as a year, so a bare year counts only when it is the whole
 * utterance -- otherwise an ID said in digits would look like a date of birth.
 */
export function saysDob(text: string, parts: DobParts, locale?: string): boolean {
  if (parts.month !== null && parts.day !== null) return true;
  return parts.year !== null && parts.year === tokenize(text, locale).join(' ');
}

/**
 * An explicit year: four digits, or a spoken year of two or more number words. A bare "12" in
 * "September 12" normalizes to a year too, so the length is what separates a year from a day.
 * An event's date is said without a year, so a year means the date is a birthday's and the
 * birthday questions own it.
 */
export function saysExplicitYear(text: string, todayIso: string, locale?: string): boolean {
  const lex = lexiconOf(locale);
  return candidateSpans(text, locale).some((span) => {
    const words = span.split(' ');
    const joiners = lex.joinsTens ? words.filter((t) => t === lex.joiner).length : 0;
    if (numberWordCount(span, locale) + joiners !== words.length) return false;
    if (!/^\d{4}$/.test(span) && words.length < 2) return false;
    const y = normalizeYear(span, todayIso, locale);
    return y !== null && y >= 1900;
  });
}

/** How a caller names a day by its distance from today, in English and in Spanish, longest phrase first. */
const RELATIVE_WORDS: Readonly<Record<'en' | 'es', Readonly<Record<'future' | 'past', readonly (readonly [string, RegExp])[]>>>> = {
  en: {
    future: [['day_after_tomorrow', /\bday after tomorrow\b/], ['tomorrow', /\btomorrow\b/], ['today', /\btoday\b/]],
    past: [['day_before_yesterday', /\bday before yesterday\b/], ['yesterday', /\byesterday\b/], ['today', /\btoday\b/]],
  },
  es: {
    future: [['day_after_tomorrow', /(?:^|\s)pasado mañana(?:\s|$)/], ['tomorrow', /(?:^|\s)mañana(?:\s|$)/], ['today', /(?:^|\s)hoy(?:\s|$)/]],
    past: [['day_before_yesterday', /(?:^|\s)(?:anteayer|antier|antes de ayer)(?:\s|$)/], ['yesterday', /(?:^|\s)ayer(?:\s|$)/], ['today', /(?:^|\s)hoy(?:\s|$)/]],
  },
};

/**
 * The relative day a caller says, as a date question's label (today, tomorrow, day_after_tomorrow
 * ahead; today, yesterday, day_before_yesterday back), or null when they say none: "pasado mañana"
 * and "anteayer" in Spanish (es, es-*), "the day after tomorrow" in English. For an app's heuristic
 * answers to a date slot's relative-day question; the slot itself reads only the model's answer.
 */
export function relativeDaySaid(text: string, range: 'future' | 'past', locale?: string): string | null {
  const lex = lexiconOf(locale);
  const words = lex.tokenize(text).join(' ');
  for (const [label, re] of RELATIVE_WORDS[lex.language === 'es' ? 'es' : 'en'][range]) if (re.test(words)) return label;
  return null;
}
