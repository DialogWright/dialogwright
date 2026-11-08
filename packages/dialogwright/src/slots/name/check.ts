import type { SlotValueCheck } from '../types';
import { wordsRefusal } from '../parts/check';

/** The most characters a name may have. */
export const MAX_NAME_LENGTH = 60;

/**
 * A name value the slot did not fill: not empty, at most MAX_NAME_LENGTH characters. It is stored as
 * a fill stores it, the words in lower case with single spaces, and shown as the display says it.
 */
export function nameCheck(display: (value: string, locale?: string) => string): SlotValueCheck {
  return (value, words, said, ctx) => {
    const name = value.trim().replace(/\s+/g, ' ').toLowerCase();
    if (name === '' || name.length > MAX_NAME_LENGTH) return { ok: false, reason: 'shape' };
    return wordsRefusal(words, said) ?? { ok: true, value: name, shown: display(name, ctx.locale) };
  };
}
