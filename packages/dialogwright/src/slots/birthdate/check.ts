import type { SlotValueCheck } from '../types';
import { isRealIso, wordsRefusal } from '../parts/check';
import type { BirthdateOptions } from './options';

/** A birthdate value the slot did not fill: a real ISO day, in `minYear` or later and before today (the fill's bounds). */
export function birthdateCheck(o: Pick<BirthdateOptions, 'minYear'>, display: (value: string, locale?: string) => string): SlotValueCheck {
  return (value, words, said, ctx) => {
    if (!isRealIso(value)) return { ok: false, reason: 'shape' };
    if (Number(value.slice(0, 4)) < o.minYear || value >= ctx.today) return { ok: false, reason: 'range' };
    return wordsRefusal(words, said) ?? { ok: true, value, shown: display(value, ctx.locale) };
  };
}
