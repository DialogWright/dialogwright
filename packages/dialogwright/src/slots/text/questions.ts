import type { SlotContext } from '../../core/slots/types';
import type { QuestionMap } from '../../jev/types';
import { TEXT_PARTS, TEXT_QUESTIONS, type TextOptions } from './options';
import { PICK_LABELS, pickCandidates, pickWordsFor } from './pick';

/** The question id that asks whether the caller gives the text. */
export const givenIdOf = (slot: string, o: TextOptions): string => TEXT_QUESTIONS.id(slot, 'given', o.ids);
/** The question id that asks which part of the words is the value (with `pick`). */
export const pickIdOf = (slot: string, o: TextOptions): string => TEXT_QUESTIONS.id(slot, 'pick', o.ids);

/** Whether a fill keeps the value on file whatever is said (see textFill), so a pick would not be read. */
export const keepsCurrent = (o: Pick<TextOptions, 'keep'>, ctx: Pick<SlotContext, 'current' | 'prompted'>): boolean =>
  ctx.current !== null && (o.keep === 'first' || !ctx.prompted);

/** The candidate parts of the turn's words a pick offers, in the session's language (see pick.ts). */
export function pickCandidatesOf(o: TextOptions, ctx: Pick<SlotContext, 'text' | 'locale'>): string[] {
  return o.pick ? pickCandidates(ctx.text, pickWordsFor(ctx.locale, o.pick.words)) : [];
}

/**
 * A text slot's questions. Does the caller give the text? The same on every turn. With `pick`, and
 * when the words make two candidates or more and a value would not be kept anyway, also: which of
 * these parts is the value? Each candidate is a letter's criterion, verbatim, then `none`.
 */
export function textQuestions(slot: string, o: TextOptions): (ctx: SlotContext) => QuestionMap {
  const id = givenIdOf(slot, o);
  const instructions = TEXT_PARTS.render('given', o.text, { what: o.what ?? '', instructions: o.instructions ? ` ${o.instructions}` : '' });
  if (!o.pick) return () => ({ [id]: { type: 'noul', instructions } });
  const pickId = pickIdOf(slot, o);
  const pick = TEXT_PARTS.render('pick', o.text, { what: o.pick.what });
  const none = TEXT_PARTS.render('pickNone', o.text, { what: o.pick.what });
  return (ctx) => {
    const out: QuestionMap = { [id]: { type: 'noul', instructions } };
    const candidates = keepsCurrent(o, ctx) ? [] : pickCandidatesOf(o, ctx);
    if (candidates.length < 2) return out;
    const criteria: Record<string, string> = {};
    candidates.forEach((c, i) => (criteria[PICK_LABELS[i]!] = c));
    criteria.none = none;
    out[pickId] = { type: 'choice', instructions: pick, criteria };
    return out;
  };
}
