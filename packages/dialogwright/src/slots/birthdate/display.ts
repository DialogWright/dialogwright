import { describeDob } from '../../core/extract/date';

/**
 * How a birthdate slot's value (an ISO date) is said: "June 14th, 1975"; in Spanish (es, es-*)
 * "14 de junio de 1975". Any other locale, and none, is English. The fill, the keypad and the spec's
 * `display` all use this one function.
 */
export function birthdateDisplay(): (value: string, locale?: string) => string {
  return (value, locale) => describeDob(value, locale);
}
