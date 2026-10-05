import type { AnswerMap } from '../../jev/types';
import { isChoice, noulValue } from '../../jev/types';
import type { SlotContext, SlotOutcome } from '../../core/slots/types';
import { meetsThreshold } from '../parts/thresholds';
import type { TextOptions } from './options';
import { PICK_LABELS } from './pick';
import { keepsCurrent, pickCandidatesOf } from './questions';
import { writtenForm } from './written';

/**
 * The part of the words the pick question chose: the candidate under the model's label, when the
 * words offered two or more, the label is one of theirs (not none) and its probability reaches
 * SLOT_DETECT. Otherwise null, and the value is the whole words.
 */
function pickedPart(o: TextOptions, pickId: string, answers: AnswerMap, ctx: SlotContext): string | null {
  const a = answers[pickId];
  if (!o.pick || !isChoice(a) || typeof a.choice !== 'string') return null;
  const candidates = pickCandidatesOf(o, ctx);
  const at = PICK_LABELS.indexOf(a.choice);
  if (candidates.length < 2 || at < 0 || at >= candidates.length) return null;
  const probabilities = typeof a.probabilities === 'object' && a.probabilities !== null ? a.probabilities : {};
  const p = Object.hasOwn(probabilities, a.choice) ? probabilities[a.choice] : a.confidence;
  return typeof p === 'number' && meetsThreshold(ctx.thresholds, 'SLOT_DETECT', p) ? candidates[at]! : null;
}

/**
 * A text slot's fill: when the model says the caller gives the text (SLOT_DETECT), the value is the
 * caller's words this turn, trimmed and cut to maxLength; with `pick`, the part of them the pick
 * question chose, as said, when it chose one (see pickedPart). With `numbers: digits` or
 * `case: title`, code then writes that part (written.ts): the value is the written form, and the
 * display of a slot shown as said (`say: null`) is the words as said, which a line reads back. A
 * value already on file is kept as `keep` says (a later aside must not overwrite a description; the
 * engine hides `current` during a correction, so one can still replace it).
 */
export function textFill(
  o: TextOptions,
  ids: { given: string; pick: string },
  display: (value: string, locale?: string) => string,
): (answers: AnswerMap, ctx: SlotContext) => SlotOutcome {
  return (answers, ctx) => {
    const p = noulValue(answers, ids.given);
    if (!meetsThreshold(ctx.thresholds, 'SLOT_DETECT', p)) return { kind: 'absent' };
    if (keepsCurrent(o, ctx)) return { kind: 'absent' };
    const words = pickedPart(o, ids.pick, answers, ctx) ?? ctx.text;
    const said = words.trim().slice(0, o.maxLength);
    if (!said) return { kind: 'absent' };
    const value = writtenForm(said, o, ctx.locale);
    return { kind: 'filled', value, display: o.say === null ? said : display(value, ctx.locale), confidence: p, confirm: 'none' };
  };
}
