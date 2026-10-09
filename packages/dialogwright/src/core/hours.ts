/**
 * Business hours (app.yaml's `hours`, App.hours): when the app's line is open, read by the `hours`
 * condition (core/conditions.ts) of a route (routes.yaml) or a transfer target (app.yaml's transfer).
 * One default schedule and, where an app needs more than one, schedules by name, each:
 * - `timezone`: an IANA name (America/New_York); a named schedule takes the default's unless it writes its own;
 * - `weekly`: day names (`mon` ... `sun`) or ranges of them (`mon-fri`, `fri-mon` going round the week)
 *   to lists of `HH:MM-HH:MM` ranges; a range whose end is before its start runs overnight, into the next
 *   day; `24:00` ends a range at midnight;
 * - `closed`: dates (`2026-12-25`) the line is closed all day; a named schedule takes the default's
 *   unless it writes its own (an empty list for none). A date closes the hours that start on it: a range
 *   the day before that runs overnight runs to its end.
 * It is judged against the turn's clock (TurnContext.nowMs), never the machine's, so a test, a scripted
 * call and a replay set the time. The time zone is the platform's (Intl.DateTimeFormat), with no new
 * dependency.
 */

/** One schedule as an app writes it (App.hours, a named one). */
export interface HoursSchedule {
  readonly timezone: string;
  readonly weekly: Readonly<Record<string, readonly string[]>>;
  readonly closed?: readonly string[];
}

/** A named schedule: its timezone and closed dates the default's unless written. */
export interface NamedHoursSchedule {
  readonly timezone?: string;
  readonly weekly: Readonly<Record<string, readonly string[]>>;
  readonly closed?: readonly string[];
}

/** app.yaml's `hours`: the default schedule, and schedules by name. */
export interface HoursConfig extends HoursSchedule {
  readonly schedules?: Readonly<Record<string, NamedHoursSchedule>>;
}

/** The days of the week by the names `weekly` writes them, Sunday first (Date.getUTCDay's order). */
export const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const END_OF_DAY = '24:00';
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The days a `weekly` key names (`mon`, `mon-fri`, `fri-mon`), by index (0 Sunday), or null when it names none. */
export function daysOf(key: string): number[] | null {
  const parts = key.trim().toLowerCase().split('-');
  const index = (d: string): number => (DAY_NAMES as readonly string[]).indexOf(d);
  if (parts.length === 1) {
    const d = index(parts[0]!);
    return d < 0 ? null : [d];
  }
  if (parts.length !== 2) return null;
  const from = index(parts[0]!);
  const to = index(parts[1]!);
  if (from < 0 || to < 0 || from === to) return null;
  const out: number[] = [];
  for (let d = from; ; d = (d + 1) % 7) {
    out.push(d);
    if (d === to) return out;
  }
}

/** A `HH:MM-HH:MM` range in minutes from midnight, or null when it is not one: the end may be `24:00`, and never the start. */
export function rangeOf(range: string): { start: number; end: number } | null {
  const [a, b, ...rest] = range.split('-');
  if (a === undefined || b === undefined || rest.length > 0) return null;
  const minutes = (t: string, end: boolean): number | null => {
    if (end && t.trim() === END_OF_DAY) return 24 * 60;
    const m = TIME.exec(t.trim());
    return m === null ? null : Number(m[1]) * 60 + Number(m[2]);
  };
  const start = minutes(a, false);
  const end = minutes(b, true);
  if (start === null || end === null || start === end) return null;
  return { start, end };
}

/** Whether `date` is a calendar date written `YYYY-MM-DD`. */
export function isDate(date: string): boolean {
  const m = DATE.exec(date);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** Whether `tz` is a time zone the platform knows. */
export function isTimezone(tz: string): boolean {
  if (tz.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The local date, day of the week and minute of the day at `nowMs` in `tz`. */
export function localTime(nowMs: number, tz: string): { date: string; day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(nowMs));
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '0';
  const date = `${part('year')}-${part('month')}-${part('day')}`;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return { date, day: new Date(Date.UTC(y, m - 1, d)).getUTCDay(), minute: (Number(part('hour')) % 24) * 60 + Number(part('minute')) };
}

/** The date before `date` (`YYYY-MM-DD`). */
function dayBefore(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** The ranges `weekly` gives day `day` (0 Sunday), every key that names it together. */
function rangesOn(weekly: Readonly<Record<string, readonly string[]>>, day: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const [key, ranges] of Object.entries(weekly)) {
    if (!(daysOf(key) ?? []).includes(day)) continue;
    for (const r of ranges) {
      const range = rangeOf(r);
      if (range !== null) out.push(range);
    }
  }
  return out;
}

/** The schedule `name` names, with what it takes from the default; the default for none; null for a name the app does not have. */
export function scheduleOf(hours: HoursConfig, name?: string): HoursSchedule | null {
  if (name === undefined) return hours;
  const own = hours.schedules !== undefined && Object.hasOwn(hours.schedules, name) ? hours.schedules[name]! : undefined;
  if (own === undefined) return null;
  return { timezone: own.timezone ?? hours.timezone, weekly: own.weekly, closed: own.closed ?? hours.closed ?? [] };
}

/**
 * Whether `schedule` is open at `nowMs`: today's ranges, unless today is closed, and the overnight
 * ranges of yesterday still running, unless yesterday was closed.
 */
export function isOpen(schedule: HoursSchedule, nowMs: number): boolean {
  const { date, day, minute } = localTime(nowMs, schedule.timezone);
  const closed = new Set(schedule.closed ?? []);
  if (!closed.has(date)) {
    for (const { start, end } of rangesOn(schedule.weekly, day)) {
      if (start < end ? minute >= start && minute < end : minute >= start) return true;
    }
  }
  if (!closed.has(dayBefore(date))) {
    for (const { start, end } of rangesOn(schedule.weekly, (day + 6) % 7)) {
      if (end < start && minute < end) return true;
    }
  }
  return false;
}

/** Whether the app's hours (`name`, a named schedule, or the default) are open at `nowMs`; null when there is no such schedule. */
export function hoursOpen(hours: HoursConfig | undefined, nowMs: number, name?: string): boolean | null {
  if (hours === undefined) return null;
  const schedule = scheduleOf(hours, name);
  return schedule === null ? null : isOpen(schedule, nowMs);
}

/** One thing wrong with app.yaml's hours, at its path under `hours`. */
export interface HoursProblem {
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly fix: string;
}

const SCHEDULE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * What is wrong with app.yaml's hours (`pnpm check` for a folder, validateApp for an app built in
 * code): a time zone the platform does not know, a day or a range that is not one, a date that is
 * not a calendar date, a schedule with a name that is not a plain word. Refusals only: when the line
 * is open is the app's choice.
 */
export function hoursProblems(hours: HoursConfig | undefined): HoursProblem[] {
  if (hours === undefined) return [];
  const out: HoursProblem[] = [];
  const schedule = (s: { timezone?: unknown; weekly?: unknown; closed?: unknown }, at: readonly (string | number)[], needsTimezone: boolean): void => {
    if (s.timezone === undefined) {
      if (needsTimezone) out.push({ path: [...at, 'timezone'], message: 'names no time zone', fix: 'write timezone: an IANA name, for example America/New_York' });
    } else if (typeof s.timezone !== 'string' || !isTimezone(s.timezone)) {
      out.push({ path: [...at, 'timezone'], message: `${JSON.stringify(s.timezone)} is not a time zone this platform knows`, fix: 'write an IANA name, for example America/New_York or Europe/London' });
    }
    if (typeof s.weekly !== 'object' || s.weekly === null || Array.isArray(s.weekly)) {
      out.push({ path: [...at, 'weekly'], message: 'is not a map of days to ranges', fix: 'write weekly: { mon-fri: ["08:00-18:00"], sat: ["09:00-13:00"] }' });
    } else {
      for (const [key, ranges] of Object.entries(s.weekly as Record<string, unknown>)) {
        if (daysOf(key) === null) out.push({ path: [...at, 'weekly', key], message: `"${key}" is not a day or a range of days`, fix: `write a day (${DAY_NAMES.join(', ')}) or a range of two (mon-fri)` });
        if (!Array.isArray(ranges)) {
          out.push({ path: [...at, 'weekly', key], message: 'is not a list of time ranges', fix: 'write a list, for example ["08:00-12:00", "13:00-18:00"]' });
          continue;
        }
        ranges.forEach((r, i) => {
          if (typeof r !== 'string' || rangeOf(r) === null) out.push({ path: [...at, 'weekly', key, i], message: `${JSON.stringify(r)} is not a time range`, fix: 'write HH:MM-HH:MM in 24-hour time, for example 08:00-18:00 (22:00-06:00 runs overnight; 24:00 ends at midnight), a start and an end that differ' });
        });
      }
    }
    if (s.closed !== undefined) {
      if (!Array.isArray(s.closed)) out.push({ path: [...at, 'closed'], message: 'is not a list of dates', fix: 'write closed: [2026-12-25, 2027-01-01]' });
      else s.closed.forEach((d, i) => {
        if (typeof d !== 'string' || !isDate(d)) out.push({ path: [...at, 'closed', i], message: `${JSON.stringify(d)} is not a date`, fix: 'write a calendar date as YYYY-MM-DD, for example 2026-12-25' });
      });
    }
  };
  schedule(hours, [], true);
  for (const [name, s] of Object.entries(hours.schedules ?? {})) {
    if (!SCHEDULE_NAME.test(name)) out.push({ path: ['schedules', name], message: `"${name}" is not a plain word`, fix: 'name the schedule with letters, digits and underscores, starting with a letter' });
    schedule(s, ['schedules', name], false);
  }
  return out;
}

/** The names of the app's named schedules. */
export function scheduleNames(hours: HoursConfig | undefined): string[] {
  return Object.keys(hours?.schedules ?? {});
}
