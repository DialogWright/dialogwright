/**
 * Each run of letters with its first letter in capitals and the rest in lower case ("mary kate o
 * neil" is "Mary Kate O Neil"). `locale` is where a Unicode-aware version for other languages
 * attaches (accented letters, a particle kept in lower case); for now every locale is formatted
 * the one way, and en-US is byte-for-byte what a name has always been said as.
 */
export function titleCase(value: string, _locale?: string): string {
  return value.replace(/[a-z]+/gi, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());
}

/**
 * How a name slot's value (the words as the caller said them, lower case) is said: title-cased. The
 * fill and the spec's `display` use this one function.
 */
export function nameDisplay(): (value: string, locale?: string) => string {
  return (value, locale) => titleCase(value, locale);
}
