import { wordingFor } from '../parts/locale';
import type { SlotWording } from '../types';
import type { ChoiceOptions, ChoiceWording } from './options';

/**
 * How a choice slot's value is said: the option's `say`, or the value itself when it is not one of
 * the options. In a locale whose slots.yaml says the option its own way (`wording`), that locale's
 * words; every other locale, and none, the options' own. The fill, the keypad and the spec's
 * `display` all use this one function.
 */
export function choiceDisplay(o: Pick<ChoiceOptions, 'options'>, wording?: SlotWording<ChoiceWording>): (value: string, locale?: string) => string {
  return (value, locale) => {
    if (!Object.hasOwn(o.options, value)) return value;
    const own = wordingFor(wording, locale)?.options;
    const said = own !== undefined && Object.hasOwn(own, value) ? own[value] : undefined;
    return said ?? o.options[value]!.say;
  };
}
