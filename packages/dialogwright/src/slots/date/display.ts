import { describeDay } from '../../core/extract/date';

/**
 * How a date slot's value (an ISO date) is said: "Tuesday, September 22". The same in every locale
 * for now. The fill, the keypad and the spec's `display` all use this one function.
 */
export function dateDisplay(): (value: string, locale?: string) => string {
  return (value) => describeDay(value);
}
