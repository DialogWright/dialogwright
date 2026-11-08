import { candidateWordSpans } from '../../core/spans';
import type { SlotValueCheck } from '../types';
import { wordsRefusal } from '../parts/check';
import { nameCandidates } from './questions';

/** The most characters a name may have. */
export const MAX_NAME_LENGTH = 60;

/**
 * A name value the slot did not fill: accepted as the fill accepts one. The value, its whitespace
 * collapsed and in lower case, must be among the spans offered as a name in the words cited
 * (nameCandidates over candidateWordSpans): so no digits or markup, no more words than a name may
 * have, and none of the slot's excluded words. At most MAX_NAME_LENGTH characters. Shown as the
 * fill shows it.
 */
export function nameCheck(display: (value: string, locale?: string) => string, excluded: ReadonlySet<string>): SlotValueCheck {
  return (value, words, said, ctx) => {
    const name = value.trim().replace(/\s+/g, ' ').toLowerCase();
    if (name === '' || name.length > MAX_NAME_LENGTH) return { ok: false, reason: 'shape' };
    const refused = wordsRefusal(words, said);
    if (refused) return refused;
    const offered = nameCandidates({ candidateWordSpans: candidateWordSpans(words, ctx.locale), ...(ctx.locale !== undefined ? { locale: ctx.locale } : {}) }, excluded);
    if (!offered.includes(name)) return { ok: false, reason: 'shape' };
    return { ok: true, value: name, shown: display(name, ctx.locale) };
  };
}
