import type { AnswerMap } from '../../jev/types';
import { isChoice, noulValue } from '../../jev/types';
import type { SlotContext, SlotOutcome } from '../../core/slots/types';
import { matchesMask } from '../../core/extract/mask';
import { spokenToDigits } from '../../core/extract/spokenNumber';
import { meetsThreshold } from '../parts/thresholds';
import type { DigitsIds } from './questions';
import type { DigitsOptions } from './options';

/** The pattern the digits must match: `mask` when given, otherwise exactly `length` digits. */
export const maskOf = (o: Pick<DigitsOptions, 'mask' | 'length'>): RegExp => new RegExp(o.mask ?? `^\\d{${o.length}}$`);

/**
 * A digits slot's fill. Not stated (SLOT_DETECT): absent. Stated but not whole (SLOT_DETECT):
 * invalid, "incomplete". No span chosen: invalid, "no_span". The chosen span's probability below
 * `minConfidence`: invalid, "low_confidence". The span turned into digits and not matching the
 * pattern: invalid, "mask" ("length" when only `length` was given), with `lengthRetryPromptId` as
 * its re-ask. Otherwise filled with the digits, and `readBack` says what it asks for.
 */
export function digitsFill(
  o: DigitsOptions,
  ids: DigitsIds,
  display: (value: string, locale?: string) => string,
): (answers: AnswerMap, ctx: SlotContext) => SlotOutcome {
  const mask = maskOf(o);
  const reason = o.mask !== undefined ? 'mask' : 'length';
  const retry = o.lengthRetryPromptId !== undefined ? { retryPromptId: o.lengthRetryPromptId } : {};
  return (answers, ctx) => {
    const t = ctx.thresholds;
    if (!meetsThreshold(t, 'SLOT_DETECT', noulValue(answers, ids.given))) return { kind: 'absent' };
    if (!meetsThreshold(t, 'SLOT_DETECT', noulValue(answers, ids.complete))) return { kind: 'invalid', reason: 'incomplete', raw: '' };
    const span = answers[ids.span];
    if (!isChoice(span) || typeof span.choice !== 'string' || span.choice === 'none') return { kind: 'invalid', reason: 'no_span', raw: '' };
    const p = span.probabilities?.[span.choice] ?? span.confidence;
    if (o.minConfidence !== 'none' && !meetsThreshold(t, o.minConfidence, p)) return { kind: 'invalid', reason: 'low_confidence', raw: '' };
    // Read in the session's language: "cinco cinco cinco" is 555 in Spanish, as "five five five" is in English.
    const digits = spokenToDigits(span.choice, ctx.locale);
    if (!matchesMask(digits, mask)) return { kind: 'invalid', reason, raw: digits, ...retry };
    const confirm = o.readBack === 'none' || (o.readBack === 'below-fill' && meetsThreshold(t, 'SLOT_CHOICE_FILL', p)) ? 'none' : 'implicit';
    return { kind: 'filled', value: digits, display: display(digits, ctx.locale), confidence: p, confirm };
  };
}
