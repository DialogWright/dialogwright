import type { AnswerMap } from '../../jev/types';
import { isChoice } from '../../jev/types';
import type { SlotContext, SlotOutcome } from '../../core/slots/types';
import { meetsThreshold } from '../parts/thresholds';
import type { ChoiceOptions } from './options';

/**
 * A choice slot's fill: the option the model chose, when it is one of the options and the model's
 * probability for it reaches `fillAt`. "none", a label that is not an option, a missing answer and
 * a choice below the threshold are all `absent`: a slot that is not sure leaves the form to ask again.
 */
export function choiceFill(
  o: ChoiceOptions,
  questionId: string,
  display: (value: string, locale?: string) => string,
): (answers: AnswerMap, ctx: SlotContext) => SlotOutcome {
  return (answers, ctx) => {
    const a = answers[questionId];
    if (!isChoice(a) || typeof a.choice !== 'string' || !Object.hasOwn(o.options, a.choice)) return { kind: 'absent' };
    const p = a.probabilities?.[a.choice] ?? a.confidence;
    if (!meetsThreshold(ctx.thresholds, o.fillAt, p)) return { kind: 'absent' };
    return { kind: 'filled', value: a.choice, display: display(a.choice, ctx.locale), confidence: p, confirm: 'none' };
  };
}
