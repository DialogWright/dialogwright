import { sameWords } from '../../core/extract/words';
import type { SlotValueCheck } from '../types';
import { wordsRefusal } from '../parts/check';
import type { ChoiceOptions } from './options';

/**
 * A choice value the slot did not fill: an option's key (without regard to case) or its `say` text
 * (or how the call's locale says it; punctuation and case ignored). A value that names more than one
 * option is refused (`shape`). The value is the key, shown as the display says it. It is not tied to
 * the words cited (they may be a synonym): the read-back confirms the option.
 */
export function choiceCheck(o: Pick<ChoiceOptions, 'options'>, display: (value: string, locale?: string) => string): SlotValueCheck {
  const keys = Object.keys(o.options);
  return (value, words, said, ctx) => {
    const given = value.trim();
    const named = keys.filter((k) => k.toLowerCase() === given.toLowerCase() || sameWords(o.options[k]!.say, given) || sameWords(display(k, ctx.locale), given));
    if (named.length !== 1) return { ok: false, reason: 'shape' };
    const key = named[0]!;
    return wordsRefusal(words, said) ?? { ok: true, value: key, shown: display(key, ctx.locale) };
  };
}
