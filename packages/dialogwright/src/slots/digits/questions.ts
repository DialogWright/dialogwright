import type { QuestionMap } from '../../jev/types';
import { DIGITS_PARTS, DIGITS_QUESTIONS, type DigitsOptions } from './options';

/** The ids of a digits slot's three questions. */
export interface DigitsIds {
  given: string;
  span: string;
  complete: string;
}

export const idsOf = (slot: string, o: DigitsOptions): DigitsIds => ({
  given: DIGITS_QUESTIONS.id(slot, 'given', o.ids),
  span: DIGITS_QUESTIONS.id(slot, 'span', o.ids),
  complete: DIGITS_QUESTIONS.id(slot, 'complete', o.ids),
});

/** "an" before a vowel, "a" otherwise, unless the option says. */
export const articleOf = (o: Pick<DigitsOptions, 'article' | 'noun'>): string => o.article ?? (/^[aeiou]/i.test(o.noun ?? '') ? 'an' : 'a');

/** What the number identifies, as a phrase: "a library card". "the number" when the questions are all literal. */
export const thingOf = (o: Pick<DigitsOptions, 'article' | 'noun'>): string => (o.noun === undefined ? 'the number' : `${articleOf(o)} ${o.noun}`);

/**
 * A digits slot's questions: whether the caller states the number, which span of the words is it
 * (the choices are the spans the engine found in the caller's words, and none), and whether it was
 * said whole. The same three on every turn; the model never writes the number.
 */
export function digitsQuestions(slot: string, o: DigitsOptions): (ctx: { candidateSpans: readonly string[] }) => QuestionMap {
  const ids = idsOf(slot, o);
  const vars = { article: articleOf(o), noun: o.noun ?? '' };
  const given = DIGITS_PARTS.render('given', o.text, vars);
  const span = DIGITS_PARTS.render('span', o.text, vars);
  const none = DIGITS_PARTS.render('none', o.text, vars);
  const complete = DIGITS_PARTS.render('complete', o.text, vars);
  return (ctx) => {
    const criteria: Record<string, string | null> = {};
    for (const s of ctx.candidateSpans) criteria[s] = null;
    criteria.none = none;
    return {
      [ids.given]: { type: 'noul', instructions: given },
      [ids.span]: { type: 'choice', instructions: span, criteria },
      [ids.complete]: { type: 'noul', instructions: complete },
    };
  };
}
