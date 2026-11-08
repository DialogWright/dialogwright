import { spokenToDigits } from '../../core/extract/spokenNumber';
import type { SlotValueCheck } from '../types';
import { wordsRefusal } from '../parts/check';
import { digitsFit } from './fill';
import type { DigitsOptions } from './options';

/**
 * A digits value the slot did not fill: only digits, fitting the slot's length and pattern as a spoken
 * number does (digitsFit), and the words cited must read to a number that holds the value, read as the
 * fill reads a span (spokenToDigits, in the call's language): "five five five ..." and "555-..." both
 * hold 555....
 */
export function digitsCheck(o: Pick<DigitsOptions, 'mask' | 'length'>, display: (value: string, locale?: string) => string): SlotValueCheck {
  const fits = digitsFit(o);
  return (value, words, said, ctx) => {
    if (!/^\d+$/.test(value) || !fits(value)) return { ok: false, reason: 'shape' };
    const refused = wordsRefusal(words, said);
    if (refused) return refused;
    if (!spokenToDigits(words, ctx.locale).includes(value)) return { ok: false, reason: 'words' };
    return { ok: true, value, shown: display(value, ctx.locale) };
  };
}
