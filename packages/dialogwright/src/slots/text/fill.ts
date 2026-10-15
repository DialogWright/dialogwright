import type { AnswerMap } from '../../jev/types';
import { isChoice, noulValue } from '../../jev/types';
import type { SlotContext, SlotOutcome } from '../../core/slots/types';
import { meetsThreshold } from '../parts/thresholds';
import type { TextOptions } from './options';
import { PICK_LABELS } from './pick';
import { changeableAtSummary, keepsCurrent, pickCandidatesOf } from './questions';
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
 * engine hides `current` during a correction, so one can still replace it), but at a form's summary
 * where the caller gives new or changed words for it (the `changed` question; without `pick`): those
 * are added after the words on file (appended), and the summary reads both back.
 */
/**
 * Words added at a form's summary after the words the caller accepted (the maintainer's decision,
 * 2026-10-14): the accepted words, then the turn's exactly as said, joined by ". ", or by a space where the
 * accepted words already end a sentence. Nothing is dropped or reworded.
 */
export function appended(accepted: string, added: string): string {
  const head = accepted.trimEnd();
  return /[.!?]$/.test(head) ? `${head} ${added}` : `${head}. ${added}`;
}

export function textFill(
  o: TextOptions,
  ids: { given: string; pick: string; changed: string },
  display: (value: string, locale?: string) => string,
): (answers: AnswerMap, ctx: SlotContext) => SlotOutcome {
  return (answers, ctx) => {
    const p = noulValue(answers, ids.given);
    // At a form's summary, a yes that gives new or changed words for the slot (its `changed` question at
    // SUMMARY_WORDS_CHANGED or more) adds them after the words on file; the summary is then read again. There
    // the changed question alone decides: a correction ("make it Friday not Thursday") need not read as words
    // given on its own (recording 5, 2026-10-14: changed 0.92, given 0.25).
    const changed = changeableAtSummary(o, ctx) && meetsThreshold(ctx.thresholds, 'SUMMARY_WORDS_CHANGED', noulValue(answers, ids.changed));
    if (!changed && !meetsThreshold(ctx.thresholds, 'SLOT_DETECT', p)) return { kind: 'absent' };
    if (keepsCurrent(o, ctx) && !changed) return { kind: 'absent' };
    const words = (pickedPart(o, ids.pick, answers, ctx) ?? ctx.text).trim();
    if (!words) return { kind: 'absent' };
    if (changed && ctx.current !== null) {
      // The accepted words, then the turn's exactly as said, cut to maxLength as any of the slot's values is.
      const value = appended(ctx.current, writtenForm(words, o, ctx.locale)).slice(0, o.maxLength);
      const said = appended(ctx.current, words).slice(0, o.maxLength);
      return { kind: 'filled', value, display: o.say === null ? said : display(value, ctx.locale), confidence: noulValue(answers, ids.changed) ?? p, confirm: 'none' };
    }
    const said = words.slice(0, o.maxLength);
    const value = writtenForm(said, o, ctx.locale);
    return { kind: 'filled', value, display: o.say === null ? said : display(value, ctx.locale), confidence: p, confirm: 'none' };
  };
}
