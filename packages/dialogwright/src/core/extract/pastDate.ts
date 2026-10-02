import { MONTHS, WEEKDAYS, addDays, daysInMonth, minP, parseIso, toIso, weekdayIndex, type ComponentPick } from './date';

/**
 * Dates that already happened: the day an event took place, such as a delivery that did not arrive. The same
 * components as `resolveDate` in date.ts, resolved backwards: a bare weekday or month and day is
 * the most recent one, never the next one. There are no windows: an event happened on one day.
 */
export const PAST_MODES = ['relative_day', 'weekday', 'absolute', 'none'] as const;
export const PAST_RELATIVE = ['today', 'yesterday', 'day_before_yesterday', 'none'] as const;

export interface PastDateComponents {
  mode: ComponentPick;        // relative_day | weekday | absolute | none
  relativeDay: ComponentPick; // today | yesterday | day_before_yesterday | none
  weekday: ComponentPick;     // monday..sunday | none
  month: ComponentPick;       // january..december | none
  day: ComponentPick;         // 1..31 | none
}

export type PastDateResolution = { kind: 'day'; iso: string; confidence: number } | { kind: 'none' };

/** How far back a past date may reach; anything older is none. */
export const MAX_PAST_DAYS = 730;

const DAY_MS = 86_400_000;

const RELATIVE_DAY_OFFSETS: Record<string, number> = { today: 0, yesterday: -1, day_before_yesterday: -2 };

/** A day-kind result, rejected as none if it falls after today or more than MAX_PAST_DAYS before it. Today itself is valid. */
export function pastDayResult(iso: string, confidence: number, todayIso: string): PastDateResolution {
  if (iso > todayIso) return { kind: 'none' };
  if (parseIso(iso) < parseIso(todayIso) - MAX_PAST_DAYS * DAY_MS) return { kind: 'none' };
  return { kind: 'day', iso, confidence };
}

/** The latest date on or before today that falls on day `day` of its month: this month's, or an earlier month's. */
function latestDayOfMonth(day: number, todayIso: string): string {
  const today = new Date(parseIso(todayIso));
  let year = today.getUTCFullYear();
  let month = today.getUTCMonth();
  // Every month has a 28th, so this looks back at most a few months ("the thirty-first" in March is January's).
  for (;;) {
    if (day <= daysInMonth(year, month)) {
      const iso = toIso(Date.UTC(year, month, day));
      if (iso <= todayIso) return iso;
    }
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
  }
}

/**
 * The most recent date on or before today the caller could mean: "yesterday", "on Saturday" (the most
 * recent Saturday strictly before today -- if today is itself a Saturday, that means a week back, not
 * today: a caller naming a weekday means a day that has already passed, and "today" is its own,
 * separate relative-day option), "September 12th" (this year if not after today, else last year),
 * "on the twelfth" with no month (this month's if not after today, else the latest month before it
 * that has one). Anything more than MAX_PAST_DAYS back is none.
 */
export function resolvePastDate(c: PastDateComponents, todayIso: string): PastDateResolution {
  switch (c.mode.choice) {
    case 'relative_day': {
      if (!Object.hasOwn(RELATIVE_DAY_OFFSETS, c.relativeDay.choice)) return { kind: 'none' };
      return pastDayResult(addDays(todayIso, RELATIVE_DAY_OFFSETS[c.relativeDay.choice]!), minP(c.mode, c.relativeDay), todayIso);
    }

    case 'weekday': {
      const target = WEEKDAYS.indexOf(c.weekday.choice as (typeof WEEKDAYS)[number]);
      if (target < 0) return { kind: 'none' };
      // Strictly before today: naming today's own weekday means a week back, not zero days back.
      // "today" is asked and resolved separately, as its own relative-day choice.
      const diff = (weekdayIndex(todayIso) - target + 7) % 7;
      const back = diff === 0 ? 7 : diff;
      return pastDayResult(addDays(todayIso, -back), minP(c.mode, c.weekday), todayIso);
    }

    case 'absolute': {
      const monthIdx = MONTHS.indexOf(c.month.choice as (typeof MONTHS)[number]);
      const day = Number(c.day.choice);
      if (!Number.isInteger(day) || day < 1 || day > 31) return { kind: 'none' };
      if (c.month.choice === 'none') return pastDayResult(latestDayOfMonth(day, todayIso), minP(c.mode, c.day), todayIso);
      if (monthIdx < 0) return { kind: 'none' };
      let year = new Date(parseIso(todayIso)).getUTCFullYear();
      if (day > daysInMonth(year, monthIdx) || toIso(Date.UTC(year, monthIdx, day)) > todayIso) {
        // Not yet this year (or not a day this year, as February 29th): the caller means last year's.
        year -= 1;
        if (day > daysInMonth(year, monthIdx)) return { kind: 'none' };
      }
      return pastDayResult(toIso(Date.UTC(year, monthIdx, day)), minP(c.mode, c.month, c.day), todayIso);
    }

    default:
      return { kind: 'none' };
  }
}
