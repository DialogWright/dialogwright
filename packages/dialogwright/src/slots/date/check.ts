import { MAX_PAST_DAYS } from '../../core/extract/pastDate';
import { addDays } from '../../core/extract/date';
import type { SlotValueCheck } from '../types';
import { isRealIso, wordsRefusal } from '../parts/check';
import type { DateOptions } from './options';

/**
 * A date value the slot did not fill: a real ISO day in the slot's range, against today: ahead, today
 * or a later day; back, today or a day gone, no more than MAX_PAST_DAYS before it (the fill's bounds).
 */
export function dateCheck(o: Pick<DateOptions, 'range'>, display: (value: string, locale?: string, todayIso?: string) => string): SlotValueCheck {
  return (value, words, said, ctx) => {
    if (!isRealIso(value)) return { ok: false, reason: 'shape' };
    const inRange = o.range === 'past' ? value <= ctx.today && value >= addDays(ctx.today, -MAX_PAST_DAYS) : value >= ctx.today;
    if (!inRange) return { ok: false, reason: 'range' };
    return wordsRefusal(words, said) ?? { ok: true, value, shown: display(value, ctx.locale, ctx.today) };
  };
}
