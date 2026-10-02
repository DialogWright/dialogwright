import type { ChoiceOptions } from './options';

/**
 * How a choice slot's value is said: the option's `say`, or the value itself when it is not one of
 * the options. The same in every locale; a per-locale `say` comes with the locale's slot texts. The
 * fill, the keypad and the spec's `display` all use this one function.
 */
export function choiceDisplay(o: Pick<ChoiceOptions, 'options'>): (value: string, locale?: string) => string {
  return (value) => (Object.hasOwn(o.options, value) ? o.options[value]!.say : value);
}
