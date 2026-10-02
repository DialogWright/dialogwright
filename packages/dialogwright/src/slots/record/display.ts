/**
 * How a record slot's value is said: the key as it is ("4711"), in every locale. The fill, the
 * keypad, the disambiguation candidates and the spec's `display` all use this one function.
 */
export function recordDisplay(): (value: string, locale?: string) => string {
  return (value) => value;
}
