import type { SlotValueCheck } from '../types';
import { wordsRefusal } from '../parts/check';
import type { ChoiceOptions } from './options';

/**
 * A choice value the slot did not fill: an option's key or its `say` text (or how the call's locale
 * says it), matched without regard to case; the value is the key, shown as the display says it.
 */
export function choiceCheck(o: Pick<ChoiceOptions, 'options'>, display: (value: string, locale?: string) => string): SlotValueCheck {
  const keys = Object.keys(o.options);
  return (value, words, said, ctx) => {
    const given = value.trim().toLowerCase();
    const key = keys.find((k) => k.toLowerCase() === given) ?? keys.find((k) => o.options[k]!.say.toLowerCase() === given || display(k, ctx.locale).toLowerCase() === given);
    if (key === undefined) return { ok: false, reason: 'shape' };
    return wordsRefusal(words, said) ?? { ok: true, value: key, shown: display(key, ctx.locale) };
  };
}
