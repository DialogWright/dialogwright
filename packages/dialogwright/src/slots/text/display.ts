import { wordingFor } from '../parts/locale';
import type { SlotWording } from '../types';
import type { TextOptions, TextWording } from './options';

/**
 * How a text slot's value is said: the stand-in (`say`) when it has one, the words otherwise. In a
 * locale whose slots.yaml gives its own stand-in (`wording`), that one; every other locale, and
 * none, the option's.
 */
export function textDisplay(o: Pick<TextOptions, 'say'>, wording?: SlotWording<TextWording>): (value: string, locale?: string) => string {
  return (value, locale) => {
    if (o.say === null) return value;
    return wordingFor(wording, locale)?.say ?? o.say;
  };
}
