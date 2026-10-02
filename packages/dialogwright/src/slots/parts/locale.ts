import { isSpanish } from '../../core/extract/lexicon';

/**
 * What a library type reads of the session's locale (SlotContext.locale, the `locale` of display and
 * partialVars). Every type formats en-US, and no locale at all, exactly as it always has; what
 * changes by locale is listed here, so it is gated in one place.
 */

/**
 * Whether a date said or keyed as numbers gives the day before the month in `locale`: Spanish
 * (es, es-*) does ("22/11" is November 22, keyed 2211), English does not (0922 is September 22).
 */
export const dayFirst = (locale: string | undefined): boolean => isSpanish(locale);

/**
 * The sentence a date's default month and day questions end with in a day-first locale, so the model
 * reads "22/11" or "el 22 del 11" as November 22. In English, like every question: the model reads the
 * questions, and their labels are keys, so they are not translated.
 */
export const DAY_FIRST_HINT = 'A date said as numbers gives the day before the month, as Spanish does: "22/11" and "el 22 del 11" are November 22.';

/** `instructions`, ending with the day-first sentence when `locale` puts the day first and the text is the type's own (not an app's literal). */
export function withDayFirst(instructions: string, locale: string | undefined, literal: boolean): string {
  return dayFirst(locale) && !literal ? `${instructions} ${DAY_FIRST_HINT}` : instructions;
}

/**
 * A slot's wording for `locale` (a locale's slots.yaml, SlotType.wording): the entry for the tag
 * itself, else for its language alone (`es` for `es-US`). Undefined: the slot says its values in the
 * default wording.
 */
export function wordingFor<W>(wording: Readonly<Record<string, W>> | undefined, locale: string | undefined): W | undefined {
  if (wording === undefined || locale === undefined) return undefined;
  if (Object.hasOwn(wording, locale)) return wording[locale];
  const language = locale.split(/[-_]/)[0]!.toLowerCase();
  const tag = Object.keys(wording).find((t) => t.toLowerCase() === language);
  return tag === undefined ? undefined : wording[tag];
}
