import { describeDay } from '../../core/extract/date';

/**
 * How a date slot's value (an ISO date) is said: "Tuesday, September 22"; in Spanish (es, es-*)
 * "martes, 22 de septiembre". Any other locale, and none, is English. The fill, the keypad and the
 * spec's `display` all use this one function.
 */
export function dateDisplay(): (value: string, locale?: string) => string {
  return (value, locale) => describeDay(value, locale);
}
