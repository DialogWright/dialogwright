import { lexiconOf, SPANISH } from '../../core/extract/lexicon';

/**
 * Each run of letters with its first letter in capitals and the rest in lower case ("mary kate o
 * neil" is "Mary Kate O Neil"). en-US, any locale but Spanish, and no locale are byte-for-byte what a
 * name has always been said as.
 *
 * In Spanish (`locale` es or es-*) a letter is any Unicode letter, accents kept ("maría josé" is
 * "María José"), and a particle between two words of the name stays in lower case ("muñoz de la
 * cruz" is "Muñoz de la Cruz"); one that starts the name is capitalized like any word.
 */
export function titleCase(value: string, locale?: string): string {
  if (lexiconOf(locale) !== SPANISH) return value.replace(/[a-z]+/gi, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());
  let first = true;
  return value.normalize('NFC').replace(/[\p{L}\p{M}]+/gu, (w) => {
    const lower = w.toLowerCase();
    const particle = !first && SPANISH.nameParticles.has(SPANISH.fold(lower));
    first = false;
    if (particle) return lower;
    const [head, ...rest] = [...lower];
    return head!.toUpperCase() + rest.join('');
  });
}

/**
 * How a name slot's value (the words as the caller said them, lower case) is said: title-cased, in
 * the session's locale. The fill and the spec's `display` use this one function.
 */
export function nameDisplay(): (value: string, locale?: string) => string {
  return (value, locale) => titleCase(value, locale);
}
