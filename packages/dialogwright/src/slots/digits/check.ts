import type { SlotValueCheck } from '../types';
import { wordsRefusal } from '../parts/check';
import { digitsFit } from './fill';
import type { DigitsOptions } from './options';

/** A digits value the slot did not fill: only digits, fitting the slot's length and pattern as a spoken number does (digitsFit). */
export function digitsCheck(o: Pick<DigitsOptions, 'mask' | 'length'>, display: (value: string, locale?: string) => string): SlotValueCheck {
  const fits = digitsFit(o);
  return (value, words, said, ctx) => {
    if (!/^\d+$/.test(value) || !fits(value)) return { ok: false, reason: 'shape' };
    return wordsRefusal(words, said) ?? { ok: true, value, shown: display(value, ctx.locale) };
  };
}
