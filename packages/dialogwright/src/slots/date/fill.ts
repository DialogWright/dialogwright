import { MONTHS, resolveDate, type ComponentPick, type DateResolution } from '../../core/extract/date';
import { resolvePastDate } from '../../core/extract/pastDate';
import type { SlotCandidate, SlotContext, SlotOutcome } from '../../core/slots/types';
import type { AnswerMap } from '../../jev/types';
import { isChoice } from '../../jev/types';
import { dayFirst } from '../parts/locale';
import { meetsThreshold } from '../parts/thresholds';
import type { DateOptions } from './options';
import { constrainToWindow, dateWindowOf, type DateWindowPartial } from './partial';
import type { DateIds } from './questions';

/** A part the slot does not ask about: read as said, with nothing in it. */
const NOT_ASKED: ComponentPick = { choice: 'none', p: 1 };

/** The label the model chose and its probability; "none" at 0 for an answer that is not a choice. */
function pick(answers: AnswerMap, id: string): ComponentPick {
  const a = answers[id];
  if (!isChoice(a) || typeof a.choice !== 'string') return { choice: 'none', p: 0 };
  return { choice: a.choice, p: a.probabilities?.[a.choice] ?? a.confidence };
}

/** The day the caller named, as the model's picks for each part (`NOT_ASKED` for a part the slot does not ask). */
interface Picks {
  mode: ComponentPick;
  relativeDay: ComponentPick;
  weekday: ComponentPick;
  weekdayQualifier: ComponentPick;
  month: ComponentPick;
  day: ComponentPick;
  window: ComponentPick;
}

function picksOf(answers: AnswerMap, ids: DateIds, o: DateOptions): Picks {
  return {
    mode: pick(answers, ids.mode),
    relativeDay: pick(answers, ids.relative),
    weekday: pick(answers, ids.weekday),
    weekdayQualifier: o.qualifier ? pick(answers, ids.qualifier) : NOT_ASKED,
    month: pick(answers, ids.month),
    day: pick(answers, ids.day),
    window: o.windows ? pick(answers, ids.window) : NOT_ASKED,
  };
}

/** The day (or, ahead, the span of days) the picks name, for the slot's range. */
function resolve(o: Pick<DateOptions, 'range'>, c: Picks, todayIso: string): DateResolution {
  return o.range === 'past' ? resolvePastDate(c, todayIso) : resolveDate(c, todayIso);
}

/**
 * A date slot's fill.
 * - The mode none, below SLOT_CHOICE_CONFIRM, or not answered at all: no day named (`whenUnsaid`).
 * - "weekday" with a month and a day each at SLOT_CHOICE_CONFIRM or above reads as "absolute"
 *   (`preferMonthDay`): the date said, not the next or last such weekday.
 * - The parts resolved against today for the range (core/extract resolveDate, resolvePastDate). No
 *   day: not resolved (`whenUnresolved`). A span of days (future only): the partial
 *   { kind: window, start, end, label } with `windows`, else not resolved.
 * - A day below the `fillAt` threshold: not resolved ("fill"), or invalid low_confidence with the
 *   day as raw ("confirm").
 * - Past only: a day after today (which the resolver never gives) is invalid "future" when asked,
 *   else absent.
 * - With `windows` and a span pending, a weekday is narrowed into it (constrainToWindow); one with no
 *   day left in it is invalid outside_window, the day first resolved as raw.
 * - Otherwise filled with the ISO day, its confidence the least of the parts read; `confirm` and
 *   `readBack` say whether it is acknowledged.
 */
export function dateFill(
  o: DateOptions,
  ids: DateIds,
  display: (value: string, locale?: string) => string,
): (answers: AnswerMap, ctx: SlotContext) => SlotOutcome {
  return (answers, ctx) => {
    const t = ctx.thresholds;
    const c = picksOf(answers, ids, o);
    if (c.mode.choice === 'none' || !meetsThreshold(t, 'SLOT_CHOICE_CONFIRM', c.mode.p)) {
      return o.whenUnsaid === 'invalid-if-prompted' && ctx.prompted ? { kind: 'invalid', reason: 'unresolvable', raw: '' } : { kind: 'absent' };
    }
    const named = (p: ComponentPick): boolean => p.choice !== 'none' && meetsThreshold(t, 'SLOT_CHOICE_CONFIRM', p.p);
    if (o.preferMonthDay && c.mode.choice === 'weekday' && named(c.month) && named(c.day)) c.mode = { choice: 'absolute', p: c.mode.p };
    const unresolved = (): SlotOutcome => {
      if (o.whenUnresolved === 'invalid') return { kind: 'invalid', reason: 'unresolvable', raw: c.mode.choice };
      return ctx.prompted ? { kind: 'invalid', reason: 'unresolvable', raw: '' } : { kind: 'absent' };
    };
    const resolved = resolve(o, c, ctx.todayIso);
    if (resolved.kind === 'none') return unresolved();
    if (resolved.kind === 'window') {
      if (!o.windows) return unresolved();
      const window: DateWindowPartial = { kind: 'window', start: resolved.start, end: resolved.end, label: resolved.label };
      return { kind: 'window', window, confidence: resolved.confidence };
    }
    const { confidence } = resolved;
    if (o.fillAt === 'fill') {
      if (!meetsThreshold(t, 'SLOT_CHOICE_FILL', confidence)) return unresolved();
    } else if (!meetsThreshold(t, 'SLOT_CHOICE_CONFIRM', confidence)) {
      return { kind: 'invalid', reason: 'low_confidence', raw: resolved.iso };
    }
    if (o.range === 'past' && resolved.iso > ctx.todayIso) {
      return ctx.prompted ? { kind: 'invalid', reason: 'future', raw: resolved.iso } : { kind: 'absent' };
    }
    let iso = resolved.iso;
    if (o.windows) {
      const narrowed = constrainToWindow(iso, c.mode.choice, dateWindowOf(ctx.window), ctx.todayIso);
      if (narrowed === null) return { kind: 'invalid', reason: 'outside_window', raw: resolved.iso };
      iso = narrowed;
    }
    const quiet = o.confirm === 'summary' || o.readBack === 'none' || (o.readBack === 'below-fill' && meetsThreshold(t, 'SLOT_CHOICE_FILL', confidence));
    return { kind: 'filled', value: iso, display: display(iso, ctx.locale), confidence, confirm: quiet ? 'none' : 'implicit' };
  };
}

/**
 * The keypad: four digits, the month then the day (MMDD), resolved as a spoken month and day are for
 * the range (ahead: this year's, or next year's once it is more than a month gone; back: the last
 * one, up to two years). In a day-first locale (Spanish), the day then the month (DDMM: 2209). Anything
 * else is no value. (The engine collects exactly four keys.)
 */
export function dateKeys(
  o: Pick<DateOptions, 'range'>,
  display: (value: string, locale?: string) => string,
): (digits: string, ctx: Pick<SlotContext, 'todayIso' | 'locale'>) => SlotCandidate | null {
  return (digits, ctx) => {
    if (!/^\d{4}$/.test(digits)) return null;
    const [month, day] = dayFirst(ctx.locale) ? [Number(digits.slice(2, 4)), Number(digits.slice(0, 2))] : [Number(digits.slice(0, 2)), Number(digits.slice(2, 4))];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const one = (choice: string): ComponentPick => ({ choice, p: 1 });
    const resolved = resolve(o, { ...NONE_PICKS, mode: one('absolute'), month: one(MONTHS[month - 1]!), day: one(String(day)) }, ctx.todayIso);
    if (resolved.kind !== 'day' || (o.range === 'past' && resolved.iso > ctx.todayIso)) return null;
    return { value: resolved.iso, display: display(resolved.iso, ctx.locale) };
  };
}

const NONE_PICKS: Picks = {
  mode: NOT_ASKED, relativeDay: NOT_ASKED, weekday: NOT_ASKED, weekdayQualifier: NOT_ASKED, month: NOT_ASKED, day: NOT_ASKED, window: NOT_ASKED,
};
