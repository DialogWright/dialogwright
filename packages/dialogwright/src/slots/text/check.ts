import type { SlotValueCheck } from '../types';
import { wordsRefusal } from '../parts/check';
import type { TextOptions } from './options';
import { writtenForm } from './written';

/**
 * A text value the slot did not fill: not empty, and at most `maxLength` characters once written as
 * the slot writes its words (`numbers`, `case`). It need not be a part of the words cited (a short
 * version is allowed: the drift judge holds it), but the words cited must have been said. Shown as
 * the display says it; a slot that shows the words (`say: null`) shows them as given.
 */
export function textCheck(o: Pick<TextOptions, 'maxLength' | 'numbers' | 'case'>, display: (value: string, locale?: string) => string, showsWords: boolean): SlotValueCheck {
  return (value, words, said, ctx) => {
    const given = value.trim();
    const written = writtenForm(given, o, ctx.locale);
    if (given === '' || written.length > o.maxLength) return { ok: false, reason: 'shape' };
    return wordsRefusal(words, said) ?? { ok: true, value: written, shown: display(showsWords ? given : written, ctx.locale) };
  };
}
