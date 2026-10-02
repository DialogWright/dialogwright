import type { SlotContext, SlotOutcome } from '../../core/slots/types';
import type { AnswerMap } from '../../jev/types';
import { isChoice, noulValue } from '../../jev/types';
import { meetsThreshold } from '../parts/thresholds';
import { nameCandidates, type NameIds } from './questions';

/**
 * A name slot's fill. Not stated (below SLOT_DETECT): absent. Stated but no span chosen, or the
 * literal "none": invalid, "no_span". A span this turn's question never offered (one built against
 * other words, as a recording made before a word was excluded can be): invalid, "no_span", with the
 * span as raw. Otherwise filled with the span, its whitespace collapsed, at the probability the model
 * gave it; a name is never acknowledged or read back on its own.
 */
export function nameFill(
  ids: NameIds,
  excluded: ReadonlySet<string>,
  display: (value: string, locale?: string) => string,
): (answers: AnswerMap, ctx: SlotContext) => SlotOutcome {
  return (answers, ctx) => {
    if (!meetsThreshold(ctx.thresholds, 'SLOT_DETECT', noulValue(answers, ids.given))) return { kind: 'absent' };
    const span = answers[ids.span];
    if (!isChoice(span) || typeof span.choice !== 'string' || span.choice === 'none') return { kind: 'invalid', reason: 'no_span', raw: '' };
    const value = span.choice.trim().replace(/\s+/g, ' ');
    if (!nameCandidates(ctx, excluded).includes(value)) return { kind: 'invalid', reason: 'no_span', raw: value };
    return { kind: 'filled', value, display: display(value, ctx.locale), confidence: span.probabilities?.[span.choice] ?? span.confidence, confirm: 'none' };
  };
}
