import { isSpanish } from './lexicon';
import { spokenToDigits } from './spokenNumber';

export interface ComponentPick {
  choice: string;
  p: number;
}

export interface DateComponents {
  mode: ComponentPick;            // absolute | relative_day | weekday | window | none
  month: ComponentPick;           // january..december | none
  day: ComponentPick;             // 1..31 | none
  weekday: ComponentPick;         // monday..sunday | none
  weekdayQualifier: ComponentPick; // this | next | none
  relativeDay: ComponentPick;     // today | tomorrow | day_after_tomorrow | none
  window: ComponentPick;          // this_week | next_week | this_month | next_month | none
}

export interface DateWindow {
  start: string;
  end: string;
  label: string;
}

export type DateResolution =
  | { kind: 'day'; iso: string; confidence: number }
  | ({ kind: 'window'; confidence: number } & DateWindow)
  | { kind: 'none' };

export const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
] as const;
export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export const DATE_MODES = ['absolute', 'relative_day', 'weekday', 'window', 'none'] as const;
export const RELATIVE_DAYS = ['today', 'tomorrow', 'day_after_tomorrow', 'none'] as const;
export const WINDOWS = ['this_week', 'next_week', 'this_month', 'next_month', 'none'] as const;
export const QUALIFIERS = ['this', 'next', 'none'] as const;

const DAY_MS = 86_400_000;

export function parseIso(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return toIso(parseIso(iso) + days * DAY_MS);
}

/** Monday = 0 ... Sunday = 6 */
export function weekdayIndex(iso: string): number {
  return (new Date(parseIso(iso)).getUTCDay() + 6) % 7;
}

/** The first day on or after `fromIso` that falls on the given weekday index. */
function weekdayOnOrAfter(fromIso: string, weekday: number): string {
  return addDays(fromIso, (((weekday - weekdayIndex(fromIso)) % 7) + 7) % 7);
}

/** The first day on or after `fromIso` that falls on the same weekday as `iso`. */
export function snapWeekdayOnOrAfter(iso: string, fromIso: string): string {
  return weekdayOnOrAfter(fromIso, weekdayIndex(iso));
}

export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function endOfMonth(year: number, monthIndex: number): string {
  return toIso(Date.UTC(year, monthIndex, daysInMonth(year, monthIndex)));
}

export function minP(...picks: ComponentPick[]): number {
  return Math.min(...picks.map((p) => p.p));
}

/** A day-kind result, rejected as none if it falls before today. Today itself is valid. */
function dayResult(iso: string, confidence: number, todayIso: string): DateResolution {
  if (iso < todayIso) return { kind: 'none' };
  return { kind: 'day', iso, confidence };
}

const RELATIVE_DAY_OFFSETS: Record<string, number> = { today: 0, tomorrow: 1, day_after_tomorrow: 2 };

export function resolveDate(c: DateComponents, todayIso: string): DateResolution {
  const today = new Date(parseIso(todayIso));
  const year = today.getUTCFullYear();

  switch (c.mode.choice) {
    case 'relative_day': {
      if (!Object.hasOwn(RELATIVE_DAY_OFFSETS, c.relativeDay.choice)) return { kind: 'none' };
      const offset = RELATIVE_DAY_OFFSETS[c.relativeDay.choice]!;
      return dayResult(addDays(todayIso, offset), minP(c.mode, c.relativeDay), todayIso);
    }

    case 'weekday': {
      const target = WEEKDAYS.indexOf(c.weekday.choice as (typeof WEEKDAYS)[number]);
      if (target < 0) return { kind: 'none' };
      const todayIdx = weekdayIndex(todayIso);
      let iso: string;
      if (c.weekdayQualifier.choice === 'next') {
        const nextMonday = addDays(todayIso, 7 - todayIdx);
        iso = addDays(nextMonday, target);
      } else if (c.weekdayQualifier.choice === 'this') {
        const monday = addDays(todayIso, -todayIdx);
        let candidate = addDays(monday, target);
        if (candidate < todayIso) candidate = addDays(candidate, 7);
        iso = candidate;
      } else {
        const ahead = ((target - todayIdx + 7) % 7) || 7;
        iso = addDays(todayIso, ahead);
      }
      const picks = [c.mode, c.weekday];
      if (c.weekdayQualifier.choice !== 'none') picks.push(c.weekdayQualifier);
      return dayResult(iso, minP(...picks), todayIso);
    }

    case 'window': {
      const todayIdx = weekdayIndex(todayIso);
      const monthIdx = today.getUTCMonth();
      const confidence = minP(c.mode, c.window);
      const label = c.window.choice;
      let start: string;
      let end: string;
      switch (label) {
        case 'this_week':
          start = todayIso;
          end = addDays(todayIso, 6 - todayIdx);
          break;
        case 'next_week': {
          start = addDays(todayIso, 7 - todayIdx);
          end = addDays(start, 6);
          break;
        }
        case 'this_month':
          start = todayIso;
          end = endOfMonth(year, monthIdx);
          break;
        case 'next_month': {
          const y = monthIdx === 11 ? year + 1 : year;
          const m = (monthIdx + 1) % 12;
          start = toIso(Date.UTC(y, m, 1));
          end = endOfMonth(y, m);
          break;
        }
        default:
          return { kind: 'none' };
      }
      if (start === end) return { kind: 'day', iso: start, confidence };
      // "Tuesday of next week" names a day, not a span: a weekday answered alongside a
      // window picks that weekday out of it. If it cannot fit, the window stands and the
      // narrowing prompt asks for a day.
      const named = WEEKDAYS.indexOf(c.weekday.choice as (typeof WEEKDAYS)[number]);
      if (named >= 0) {
        const iso = weekdayOnOrAfter(start > todayIso ? start : todayIso, named);
        if (iso <= end) return { kind: 'day', iso, confidence: minP(c.mode, c.window, c.weekday) };
      }
      return { kind: 'window', start, end, label, confidence };
    }

    case 'absolute': {
      const monthIdx = MONTHS.indexOf(c.month.choice as (typeof MONTHS)[number]);
      if (monthIdx < 0) return { kind: 'none' };
      if (c.day.choice === 'none') {
        const y = monthIdx < today.getUTCMonth() ? year + 1 : year;
        const isCurrentMonth = monthIdx === today.getUTCMonth() && y === year;
        return {
          kind: 'window',
          start: isCurrentMonth ? todayIso : toIso(Date.UTC(y, monthIdx, 1)),
          end: endOfMonth(y, monthIdx),
          label: c.month.choice,
          confidence: minP(c.mode, c.month),
        };
      }
      const day = Number(c.day.choice);
      if (!Number.isInteger(day) || day < 1) return { kind: 'none' };
      let y = year;
      if (day > daysInMonth(y, monthIdx)) return { kind: 'none' };
      let iso = toIso(Date.UTC(y, monthIdx, day));
      if (parseIso(iso) < parseIso(todayIso) - 31 * DAY_MS) {
        y += 1;
        if (day > daysInMonth(y, monthIdx)) return { kind: 'none' };
        iso = toIso(Date.UTC(y, monthIdx, day));
      }
      return dayResult(iso, minP(c.mode, c.month, c.day), todayIso);
    }

    default:
      return { kind: 'none' };
  }
}

function cap(s: string): string {
  return s[0]!.toUpperCase() + s.slice(1);
}

/** The months and weekdays as Spanish says them, in lower case (as a Spanish date is written), January and Monday first. */
export const MONTHS_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
] as const;
export const WEEKDAYS_ES = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'] as const;

/** A span of days as Spanish says it after the line's own words ("la próxima semana"). */
const WINDOWS_ES: Readonly<Record<string, string>> = {
  this_week: 'esta semana',
  next_week: 'la próxima semana',
  this_month: 'este mes',
  next_month: 'el próximo mes',
};

/**
 * Human-readable form for prompts, e.g. "Tuesday, September 22". In Spanish (`locale` es or es-*):
 * "martes, 22 de septiembre". Any other locale, or none, is English.
 */
export function describeDay(iso: string, locale?: string): string {
  const d = new Date(parseIso(iso));
  if (isSpanish(locale)) return `${WEEKDAYS_ES[weekdayIndex(iso)]!}, ${d.getUTCDate()} de ${MONTHS_ES[d.getUTCMonth()]!}`;
  const wd = WEEKDAYS[weekdayIndex(iso)]!;
  const mo = MONTHS[d.getUTCMonth()]!;
  return `${cap(wd)}, ${cap(mo)} ${d.getUTCDate()}`;
}

/**
 * A span of days, as a line says it: "next week", "in December". In Spanish: "la próxima semana",
 * "en diciembre", "esta semana", "este mes", "el próximo mes".
 */
export function describeWindow(w: DateWindow, locale?: string): string {
  const month = (MONTHS as readonly string[]).indexOf(w.label);
  if (isSpanish(locale)) {
    if (month >= 0) return `en ${MONTHS_ES[month]!}`;
    return WINDOWS_ES[w.label] ?? w.label.replace(/_/g, ' ');
  }
  if (month >= 0) return `in ${cap(w.label)}`;
  return w.label.replace(/_/g, ' ');
}

/** "1st", "2nd", "3rd", "4th" ... "11th", "12th", "13th" (teens are always "th"), "21st", "22nd", "23rd", ... */
export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'] as const;
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/**
 * Human-readable form of an ISO date of birth, e.g. "November 22nd, 1991". In Spanish: "22 de
 * noviembre de 1991" (Spanish says a day of the month without an ordinal suffix).
 */
export function describeDob(iso: string, locale?: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  if (isSpanish(locale)) return `${d} de ${MONTHS_ES[m - 1]!} de ${y}`;
  return `${cap(MONTHS[m - 1]!)} ${ordinal(d)}, ${y}`;
}

/**
 * A spoken year to a calendar year in the past: "nineteen ninety" -> 1990, "ninety" -> 1990,
 * "ten" -> 2010; null when the span carries no usable digits ("none", a name, etc). `locale` picks
 * the number words: "mil novecientos noventa" is 1990 in Spanish (es, es-*).
 */
export function normalizeYear(span: string, todayIso: string, locale?: string): number | null {
  const digits = spokenToDigits(span, locale);
  if (!/^\d{1,4}$/.test(digits)) return null;
  const thisYear = Number(todayIso.slice(0, 4));
  let y = Number(digits);
  if (digits.length <= 2) {
    y = 2000 + y;
    if (y > thisYear) y -= 100;
  }
  return y;
}
