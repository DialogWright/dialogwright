import { describeDay, describeDayWithYear } from '../../core/extract/date';
import type { DateOptions } from './options';

/**
 * How a date slot's value (an ISO date) is said: "Tuesday, September 22"; in Spanish (es, es-*)
 * "martes, 22 de septiembre". Any other locale, and none, is English. With `sayYear: other-year` (the
 * default), a day not in the year of `todayIso` (the call's day) is said with its year: "Wednesday,
 * October 22, 2025", "miércoles, 22 de octubre de 2025"; without a day to compare it to, as a day this
 * year. The fill, the keypad and the spec's `display` all use this one function.
 */
export function dateDisplay(o: Pick<DateOptions, 'sayYear'> = { sayYear: 'other-year' }): (value: string, locale?: string, todayIso?: string) => string {
  return (value, locale, todayIso) =>
    o.sayYear === 'other-year' && todayIso !== undefined && value.slice(0, 4) !== todayIso.slice(0, 4) ? describeDayWithYear(value, locale) : describeDay(value, locale);
}
