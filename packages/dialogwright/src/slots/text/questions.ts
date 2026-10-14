import type { SlotContext } from '../../core/slots/types';
import type { QuestionMap } from '../../jev/types';
import { TEXT_PARTS, TEXT_QUESTIONS, type TextOptions } from './options';
import { PICK_LABELS, pickCandidates, pickWordsFor } from './pick';

/** The question id that asks whether the caller gives the text. */
export const givenIdOf = (slot: string, o: TextOptions): string => TEXT_QUESTIONS.id(slot, 'given', o.ids);
/** The question id that asks which part of the words is the value (with `pick`). */
export const pickIdOf = (slot: string, o: TextOptions): string => TEXT_QUESTIONS.id(slot, 'pick', o.ids);
/** The question id that asks, at a form's summary, whether the caller gives new or changed words for the slot (without `pick`). */
export const changedIdOf = (slot: string, o: TextOptions): string => TEXT_QUESTIONS.id(slot, 'changed', o.ids);

/** What the `changed` question names the slot's words by: `what`, or for a slot whose question is its own words (text.given), what any slot holds. */
const WORDS_GIVEN = 'the words they gave';

/**
 * Whether the turn answers the read-back of a form's summary that holds the slot, with words on file the
 * slot keeps against it (keepsCurrent; never with `pick`): only then is the `changed` question asked, and
 * only then does its answer let the turn's words replace them (textFill).
 */
export const changeableAtSummary = (o: TextOptions, ctx: Pick<SlotContext, 'current' | 'prompted' | 'summary'>): boolean =>
  o.pick === undefined && ctx.summary === true && keepsCurrent(o, ctx);

/** Whether a fill keeps the value on file whatever is said (see textFill), so a pick would not be read. */
export const keepsCurrent = (o: Pick<TextOptions, 'keep'>, ctx: Pick<SlotContext, 'current' | 'prompted'>): boolean =>
  ctx.current !== null && (o.keep === 'first' || !ctx.prompted);

/** The candidate parts of the turn's words a pick offers, in the session's language (see pick.ts). */
export function pickCandidatesOf(o: TextOptions, ctx: Pick<SlotContext, 'text' | 'locale'>): string[] {
  return o.pick ? pickCandidates(ctx.text, pickWordsFor(ctx.locale, o.pick.words)) : [];
}

/**
 * A text slot's questions. Does the caller give the text? The same on every turn. Without `pick`, at the
 * read-back of a form's summary that holds the slot and once it has words (changeableAtSummary), also:
 * besides agreeing, does the caller add to or change them? With `pick`, and
 * when the words make two candidates or more and a value would not be kept anyway, also: which of
 * these parts is the value? Each candidate is a letter's criterion, verbatim, then `none`.
 */
export function textQuestions(slot: string, o: TextOptions): (ctx: SlotContext) => QuestionMap {
  const id = givenIdOf(slot, o);
  const instructions = TEXT_PARTS.render('given', o.text, { what: o.what ?? '', instructions: o.instructions ? ` ${o.instructions}` : '' });
  if (!o.pick) {
    // At a form's summary, with words on file: whether the caller, besides agreeing, adds to or changes them.
    const changedId = changedIdOf(slot, o);
    const changed = TEXT_PARTS.render('changed', o.text, { what: o.what ?? WORDS_GIVEN });
    return (ctx) => (changeableAtSummary(o, ctx)
      ? { [id]: { type: 'noul', instructions }, [changedId]: { type: 'noul', instructions: changed } }
      : { [id]: { type: 'noul', instructions } });
  }
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
