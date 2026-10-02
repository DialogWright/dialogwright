import type { AnswerMap } from '../../jev/types';
import { noulValue } from '../../jev/types';
import type { SlotContext, SlotOutcome } from '../../core/slots/types';
import { meetsThreshold } from '../parts/thresholds';
import type { TextOptions } from './options';

/**
 * A text slot's fill: when the model says the caller gives the text (SLOT_DETECT), the value is the
 * caller's words this turn, trimmed and cut to maxLength. A value already on file is kept as `keep`
 * says (a later aside must not overwrite a description; the engine hides `current` during a
 * correction, so one can still replace it).
 */
export function textFill(
  o: TextOptions,
  givenId: string,
  display: (value: string, locale?: string) => string,
): (answers: AnswerMap, ctx: SlotContext) => SlotOutcome {
  return (answers, ctx) => {
    const p = noulValue(answers, givenId);
    if (!meetsThreshold(ctx.thresholds, 'SLOT_DETECT', p)) return { kind: 'absent' };
    if (ctx.current !== null && (o.keep === 'first' || !ctx.prompted)) return { kind: 'absent' };
    const value = ctx.text.trim().slice(0, o.maxLength);
    if (!value) return { kind: 'absent' };
    return { kind: 'filled', value, display: display(value, ctx.locale), confidence: p, confirm: 'none' };
  };
}
