import type { SlotContext, SlotOutcome } from '../../core/slots/types';
import type { AnswerMap } from '../../jev/types';
import { isChoice, rankProbabilities } from '../../jev/types';
import { meetsThreshold } from '../parts/thresholds';
import type { RecordOptions } from './options';
import { keyMatcher } from './questions';

/** The key a label names (`labelPrefix` and a key that matches `keyPattern`), or null for `none` and any other label. */
export function keyOfLabel(o: Pick<RecordOptions, 'labelPrefix' | 'keyPattern'>): (label: string) => string | null {
  const valid = keyMatcher(o);
  return (label) => {
    if (label === 'none' || !label.startsWith(o.labelPrefix)) return null;
    const key = label.slice(o.labelPrefix.length);
    return valid.test(key) ? key : null;
  };
}

/**
 * A record slot's fill, read from the probabilities the model gives each label (not from its one pick):
 * - The question not answered at all (it was not asked, having nothing to offer): absent.
 * - The top label is not a key (none, or a label the slot never offers), or it is below
 *   SLOT_CHOICE_CONFIRM: nothing chosen. That is invalid with `missReason` when the slot was asked
 *   for, else absent.
 * - With `disambiguate`, the second label a key too and within SLOT_CHOICE_MARGIN of the top: ask
 *   which of the two.
 * - Below `fillAt`: nothing chosen.
 * - Otherwise filled with the key, never acknowledged (the summary reads it back).
 */
export function recordFill(
  o: RecordOptions,
  questionId: string,
  display: (value: string, locale?: string) => string,
): (answers: AnswerMap, ctx: SlotContext) => SlotOutcome {
  const keyOf = keyOfLabel(o);
  return (answers, ctx) => {
    const t = ctx.thresholds;
    const a = answers[questionId];
    if (a === undefined) return { kind: 'absent' };
    const miss: SlotOutcome = ctx.prompted ? { kind: 'invalid', reason: o.missReason, raw: '' } : { kind: 'absent' };
    if (!isChoice(a)) return miss;
    const probabilities = typeof a.probabilities === 'object' && a.probabilities !== null ? a.probabilities : {};
    const [top, second] = rankProbabilities(probabilities);
    const key = top ? keyOf(top.label) : null;
    if (!top || key === null || !meetsThreshold(t, 'SLOT_CHOICE_CONFIRM', top.p)) return miss;
    if (o.disambiguate) {
      const rival = second ? keyOf(second.label) : null;
      if (rival !== null && !meetsThreshold(t, 'SLOT_CHOICE_MARGIN', top.p - second!.p)) {
        return { kind: 'disambiguate', a: { value: key, display: display(key, ctx.locale) }, b: { value: rival, display: display(rival, ctx.locale) } };
      }
    }
    if (!meetsThreshold(t, o.fillAt, top.p)) return miss;
    return { kind: 'filled', value: key, display: display(key, ctx.locale), confidence: top.p, confirm: 'none' };
  };
}

/** The keypad: exactly `keypad` digits that match `keyPattern` are the key; anything else is no value. */
export function recordKeys(
  o: Pick<RecordOptions, 'keyPattern'> & { keypad: number },
  display: (value: string, locale?: string) => string,
): (digits: string, ctx: { locale?: string }) => { value: string; display: string } | null {
  const valid = keyMatcher(o);
  return (digits, ctx) => (digits.length === o.keypad && /^\d+$/.test(digits) && valid.test(digits) ? { value: digits, display: display(digits, ctx.locale) } : null);
}
