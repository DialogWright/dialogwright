/**
 * Date resolution in an explicit zone. "Today" is a wall-clock notion: a caller at 8pm Pacific on
 * the 18th means the 18th, not the 19th that `toISOString()` would report. Pure (Intl only), so any
 * part of the engine may use it.
 */

/** The date `ms` falls on in `timeZone`, as YYYY-MM-DD. `en-CA` formats exactly that way. */
export function localDateIso(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** The minutes since midnight at `ms` in `timeZone` (0 to 1439). */
export function localMinutes(ms: number, timeZone: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
}

/** The minutes since midnight of a 24-hour "HH:MM" time. */
export function minutesOfTime(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/** The host's IANA zone, used when nothing configures one. */
export function defaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
