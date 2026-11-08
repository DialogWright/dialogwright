import type { SlotValueCheck } from '../types';
import { wordsRefusal } from '../parts/check';
import type { TextOptions } from './options';
import { writtenForm } from './written';

/**
 * A text value the slot did not fill: not empty and at most `maxLength` characters as given (before
 * the slot writes it). It need not be a part of the words cited (a short version is allowed: the
 * drift judge holds it), but the words cited must have been said. It is stored as the slot writes its
 * words (`numbers`, `case`), cut to `maxLength` as the fill cuts, and shown as the display says it; a
 * slot that shows the words shows them as given.
 */
export function textCheck(o: Pick<TextOptions, 'maxLength' | 'numbers' | 'case'>, display: (value: string, locale?: string) => string, showsWords: boolean): SlotValueCheck {
  return (value, words, said, ctx) => {
    const given = value.trim();
    if (given === '' || given.length > o.maxLength) return { ok: false, reason: 'shape' };
    const written = writtenForm(given, o, ctx.locale).slice(0, o.maxLength);
    return wordsRefusal(words, said) ?? { ok: true, value: written, shown: display(showsWords ? given : written, ctx.locale) };
  };
}
