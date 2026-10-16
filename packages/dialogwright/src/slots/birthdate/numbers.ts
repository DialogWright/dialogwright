import { lexiconOf, type Lexicon } from '../../core/extract/lexicon';
import { spokenToDigits } from '../../core/extract/spokenNumber';
import { dayFirst } from '../parts/locale';

/**
 * A date of birth said only in numbers ("oh eight two one nineteen eighty four", "eight twenty one
 * eighty four", "08/21/1984"), read the way the keypad reads one: by the code, from the digits, never
 * from a model's guess at a month. What is read and what is refused is set out in README.md beside
 * this file ("A date said in numbers"); the tests hold every shape.
 */

/** The calendar day as an ISO date, or null when there is no such day (February 30th). */
export function isoOf(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * A piece of a turn said in numbers: single digits said one after another (or keyed one by one in a
 * chat, "0 8 2 1"), which run together as the keypad's keys do; a number written as digits ("21",
 * "1984"), a run of its own; a number from ten to ninety-nine said as one ("twenty one", "veintiuno");
 * or a year said with a thousand ("two thousand one", "mil novecientos ochenta y cuatro").
 */
export type NumberPiece =
  | { kind: 'run'; digits: string; oneByOne: boolean }
  | { kind: 'number'; value: number }
  | { kind: 'year'; value: number };

/** A turn said only in numbers: its pieces, and whether every number word in it found its place in one. */
export interface NumbersTurn {
  pieces: NumberPiece[];
  /** False when a number word fits no piece ("hundred" outside a year, a joiner out of place): such a turn is never read. */
  readable: boolean;
}

/** What the digits say: a whole date (an ISO date) or a month and a day without the year. */
export type NumbersReading = { kind: 'date'; iso: string } | { kind: 'monthDay'; month: number; day: number };

const has = (t: Readonly<Record<string, number>>, k: string | undefined): k is string => k !== undefined && Object.hasOwn(t, k);
const isDigits = (t: string | undefined): t is string => t !== undefined && /^\d+$/.test(t);

/** The end of a number under a hundred said at `j` ("eighty four", "nineteen", "ochenta y cuatro", "diez y seis", "five"), or `j` when none is. */
function belowHundred(lex: Lexicon, tokens: readonly string[], j: number): number {
  const tok = tokens[j];
  const unitAt = (k: number): boolean => has(lex.units, tokens[k]) && lex.units[tokens[k]!]! >= 1;
  if (has(lex.joinedTeens, tok) && tokens[j + 1] === lex.joiner && unitAt(j + 2) && lex.units[tokens[j + 2]!]! >= 6) return j + 3;
  if (has(lex.teens, tok)) return j + 1;
  if (has(lex.tens, tok)) {
    if (lex.joinsTens) return tokens[j + 1] === lex.joiner && unitAt(j + 2) ? j + 3 : j + 1;
    return unitAt(j + 1) ? j + 2 : j + 1;
  }
  if (unitAt(j)) return j + 1;
  return j;
}

/**
 * A year said with a thousand at `i`: "two thousand", "two thousand and one", "one thousand nine
 * hundred eighty four"; in Spanish "dos mil uno", "mil novecientos ochenta y cuatro". Null when no
 * such year starts there, or it is not four digits.
 */
function yearAt(lex: Lexicon, tokens: readonly string[], i: number, locale: string | undefined): { value: number; end: number } | null {
  const thousand = (t: string | undefined): boolean => has(lex.multipliers, t) && lex.multipliers[t] === 1000;
  const hundred = (t: string | undefined): boolean => has(lex.multipliers, t) && lex.multipliers[t] === 100;
  let j = i;
  // A year's thousands: one or two ("one thousand nine hundred", "two thousand"); in Spanish, where a
  // bare "mil" is one thousand, only "dos mil", so "ocho mil novecientos" is the eighth and then a year.
  const lowest = lex.bareMultiplierOpens ? 2 : 1;
  const thousands = has(lex.units, tokens[j]) ? lex.units[tokens[j]!]! : 0;
  if (thousands >= lowest && thousands <= 2 && thousand(tokens[j + 1])) j += 2;
  else if (lex.bareMultiplierOpens && thousand(tokens[j])) j += 1;
  else return null;
  if (has(lex.hundreds, tokens[j])) j += 1;
  else if (has(lex.units, tokens[j]) && hundred(tokens[j + 1])) j += 2;
  if (!lex.joinsTens && tokens[j] === lex.joiner) j += 1;
  j = belowHundred(lex, tokens, j);
  if (!lex.joinsTens && tokens[j - 1] === lex.joiner) j -= 1; // "two thousand and" with nothing after: the "and" is not the year's
  const digits = spokenToDigits(tokens.slice(i, j).join(' '), locale);
  return /^\d{4}$/.test(digits) ? { value: Number(digits), end: j } : null;
}

/**
 * The caller's words as pieces of numbers, when every word is a number word, a number written as
 * digits or the word that joins parts of a number ("and", "y"); null when any word is anything else
 * (a month name, "the", "it's", "first"), so a turn with words in it is never this path's.
 */
export function numberPiecesOf(text: string, locale?: string): NumbersTurn | null {
  const lex = lexiconOf(locale);
  const tokens = lex.tokenize(text).map((t) => lex.fold(t));
  if (tokens.length === 0) return null;
  if (!tokens.every((t) => lex.numberWords.has(t) || isDigits(t) || t === lex.joiner)) return null;
  const pieces: NumberPiece[] = [];
  let readable = true;
  const digits = (d: string): void => {
    const last = pieces.at(-1);
    if (last?.kind === 'run' && last.oneByOne) last.digits += d;
    else pieces.push({ kind: 'run', digits: d, oneByOne: true });
  };
  for (let i = 0; i < tokens.length; ) {
    const tok = tokens[i]!;
    const year = yearAt(lex, tokens, i, locale);
    if (year) {
      pieces.push({ kind: 'year', value: year.value });
      i = year.end;
    } else if (isDigits(tok)) {
      if (tok.length === 1) digits(tok);
      else pieces.push({ kind: 'run', digits: tok, oneByOne: false });
      i += 1;
    } else if (has(lex.repeats, tok) && has(lex.units, tokens[i + 1])) {
      digits(String(lex.units[tokens[i + 1]!]).repeat(lex.repeats[tok]!));
      i += 2;
    } else if (has(lex.units, tok)) {
      digits(String(lex.units[tok]));
      i += 1;
    } else {
      const end = belowHundred(lex, tokens, i);
      if (end > i) {
        pieces.push({ kind: 'number', value: Number(spokenToDigits(tokens.slice(i, end).join(' '), locale)) });
        i = end;
      } else {
        readable = false;
        i += 1;
      }
    }
  }
  return { pieces, readable };
}

/** How many digits the pieces hold: a run its own, a number two, a year four. */
const widthOf = (pieces: readonly NumberPiece[]): number => pieces.reduce((n, p) => n + (p.kind === 'run' ? p.digits.length : p.kind === 'number' ? 2 : 4), 0);

type Field = 'm' | 'd' | 'y';
interface At {
  p: number;
  off: number;
}

/**
 * The ways a field can be taken at `at`, each with its digits and where the next field starts. A
 * month or a day is one digit or two of a run, or a number said as one; a year is two or four digits
 * of a run, a number said as one ("eighty four"), two of them ("nineteen eighty four"), one and "oh"
 * and a digit ("nineteen oh five"), or a year said with a thousand. Inside a run, a field ends only
 * where the keypad's would, after a pair of digits (or at the run's end), but for a run of exactly two
 * digits said one by one, which may be a one-digit month and a one-digit day ("three nine").
 */
function takes(pieces: readonly NumberPiece[], at: At, field: Field): { digits: string; next: At }[] {
  const piece = pieces[at.p];
  if (!piece) return [];
  const after: At = { p: at.p + 1, off: 0 };
  const out: { digits: string; next: At }[] = [];
  if (piece.kind === 'run') {
    const len = piece.digits.length;
    for (const k of field === 'y' ? [2, 4] : [1, 2]) {
      const end = at.off + k;
      if (end > len) continue;
      const ok = end === len || end % 2 === 0 || (piece.oneByOne && len === 2 && k === 1 && at.off === 0);
      if (ok) out.push({ digits: piece.digits.slice(at.off, end), next: end === len ? after : { p: at.p, off: end } });
    }
    return out;
  }
  if (piece.kind === 'year') return field === 'y' ? [{ digits: String(piece.value), next: after }] : [];
  const two = String(piece.value).padStart(2, '0');
  out.push({ digits: two, next: after });
  if (field === 'y') {
    const following = pieces[at.p + 1];
    if (following?.kind === 'number') out.push({ digits: `${two}${String(following.value).padStart(2, '0')}`, next: { p: at.p + 2, off: 0 } });
    if (following?.kind === 'run' && following.digits.length >= 2 && following.digits[0] === '0') {
      const len = following.digits.length;
      out.push({ digits: `${two}${following.digits.slice(0, 2)}`, next: len === 2 ? { p: at.p + 2, off: 0 } : { p: at.p + 1, off: 2 } });
    }
  }
  return out;
}

/** Every way the pieces divide into `fields`, in order, using every piece: the digits of each field. */
function divisions(pieces: readonly NumberPiece[], fields: readonly Field[]): string[][] {
  const out: string[][] = [];
  const walk = (at: At, i: number, taken: string[]): void => {
    if (i === fields.length) {
      if (at.p === pieces.length) out.push(taken);
      return;
    }
    for (const t of takes(pieces, at, fields[i]!)) walk(t.next, i + 1, [...taken, t.digits]);
  };
  walk({ p: 0, off: 0 }, 0, []);
  return out;
}

/** The year two digits stand for: the latest one before today on which the day falls (so a birth date is in the past). */
function centuryOf(yy: number, m: number, d: number, todayIso: string): number {
  const thisYear = Number(todayIso.slice(0, 4));
  let y = thisYear - ((((thisYear - yy) % 100) + 100) % 100);
  const iso = isoOf(y, m, d);
  if (iso === null || iso >= todayIso) y -= 100;
  return y;
}

export interface NumbersOptions {
  minYear: number;
  todayIso: string;
  locale?: string;
}

/**
 * Whether a turn said only in numbers is one this path reads or answers with the example: at least
 * three digits, and not a year alone (a four-digit year from `minYear` to this year, said in any of
 * the year's ways), which is the model's to read as before (a year asked for once a month and day are
 * on hand, or one said with no month and day).
 */
export function isDateInNumbers(turn: NumbersTurn, o: Pick<NumbersOptions, 'minYear' | 'todayIso'>): boolean {
  if (widthOf(turn.pieces) < 3) return false;
  if (!turn.readable) return true;
  const thisYear = Number(o.todayIso.slice(0, 4));
  const yearAlone = divisions(turn.pieces, ['y']).some(([y]) => y!.length === 4 && Number(y) >= o.minYear && Number(y) <= thisYear);
  return !yearAlone;
}

/**
 * What a turn said in numbers says, when it says exactly one thing: every way its pieces divide into
 * a month, a day and a year (the day first in a day-first locale, as the keypad takes it), or into a
 * month and a day alone, that makes a real day from `minYear` to yesterday (a month and a day: a day
 * of some year), gives the same reading. Null when none does, or two readings differ ("one two
 * nineteen eighty four": January 2nd, 1984, or December 19th, 1984).
 */
export function readNumbers(turn: NumbersTurn, o: NumbersOptions): NumbersReading | null {
  if (!turn.readable) return null;
  const first = dayFirst(o.locale);
  const whole: Field[] = first ? ['d', 'm', 'y'] : ['m', 'd', 'y'];
  const part: Field[] = first ? ['d', 'm'] : ['m', 'd'];
  const found = new Map<string, NumbersReading>();
  const valueOf = (fields: readonly Field[], digits: readonly string[], f: Field): string => digits[fields.indexOf(f)]!;
  for (const digits of divisions(turn.pieces, whole)) {
    const m = Number(valueOf(whole, digits, 'm'));
    const d = Number(valueOf(whole, digits, 'd'));
    const yd = valueOf(whole, digits, 'y');
    if (m < 1 || m > 12 || d < 1 || d > 31) continue;
    const y = yd.length === 4 ? Number(yd) : centuryOf(Number(yd), m, d, o.todayIso);
    if (y < o.minYear) continue;
    const iso = isoOf(y, m, d);
    if (iso === null || iso >= o.todayIso) continue;
    found.set(iso, { kind: 'date', iso });
  }
  for (const digits of divisions(turn.pieces, part)) {
    const m = Number(valueOf(part, digits, 'm'));
    const d = Number(valueOf(part, digits, 'd'));
    if (m < 1 || m > 12 || isoOf(2000, m, d) === null) continue;
    found.set(`${m}-${d}`, { kind: 'monthDay', month: m, day: d });
  }
  return found.size === 1 ? [...found.values()][0]! : null;
}
