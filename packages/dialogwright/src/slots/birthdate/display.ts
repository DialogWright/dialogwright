import { describeDob } from '../../core/extract/date';

/**
 * How a birthdate slot's value (an ISO date) is said: "June 14th, 1975". The same in every locale
 * for now. The fill, the keypad and the spec's `display` all use this one function.
 */
export function birthdateDisplay(): (value: string, locale?: string) => string {
  return (value) => describeDob(value);
}
