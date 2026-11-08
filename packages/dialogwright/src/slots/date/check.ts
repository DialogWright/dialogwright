import { MAX_PAST_DAYS } from '../../core/extract/pastDate';
import { addDays, MONTHS, resolveDate, type ComponentPick, type DateComponents } from '../../core/extract/date';
import type { SlotValueCheck } from '../types';
import { isRealIso, wordsRefusal } from '../parts/check';
import type { DateOptions } from './options';

const none: ComponentPick = { choice: 'none', p: 1 };

/**
 * A date value the slot did not fill: a real ISO day in the slot's range against today. Ahead, the day
 * the fill would give for the value's month and day said outright (resolveDate, absolute): this year's,
 * or next year's once it is more than a month gone, so "October 2nd" on 2026-09-18 is 2026-10-02 and
 * 2027-10-02 is refused (`range`). Back, today or a day gone, up to MAX_PAST_DAYS before it. It is not
 * tied to the words cited ("Thursday" names a day the words do not spell): the read-back confirms it.
 */
export function dateCheck(o: Pick<DateOptions, 'range'>, display: (value: string, locale?: string, todayIso?: string) => string): SlotValueCheck {
  return (value, words, said, ctx) => {
    if (!isRealIso(value)) return { ok: false, reason: 'shape' };
    let inRange: boolean;
    if (o.range === 'past') inRange = value <= ctx.today && value >= addDays(ctx.today, -MAX_PAST_DAYS);
    else {
      const c: DateComponents = {
        mode: { choice: 'absolute', p: 1 },
        month: { choice: MONTHS[Number(value.slice(5, 7)) - 1]!, p: 1 },
        day: { choice: String(Number(value.slice(8, 10))), p: 1 },
        weekday: none, weekdayQualifier: none, relativeDay: none, window: none,
      };
      const resolved = resolveDate(c, ctx.today);
      inRange = resolved.kind === 'day' && resolved.iso === value;
    }
    if (!inRange) return { ok: false, reason: 'range' };
    return wordsRefusal(words, said) ?? { ok: true, value, shown: display(value, ctx.locale, ctx.today) };
  };
}
