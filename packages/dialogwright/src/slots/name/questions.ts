import type { SlotContext } from '../../core/slots/types';
import type { QuestionMap } from '../../jev/types';
import { NAME_PARTS, NAME_QUESTIONS, type NameOptions } from './options';

/** The ids of a name slot's two questions. */
export interface NameIds {
  given: string;
  span: string;
}

export const idsOf = (slot: string, o: Pick<NameOptions, 'ids'>): NameIds => ({
  given: NAME_QUESTIONS.id(slot, 'given', o.ids),
  span: NAME_QUESTIONS.id(slot, 'span', o.ids),
});

/** The words a span may not hold, in lower case. */
export const excludedWordsOf = (o: Pick<NameOptions, 'exclude'>): ReadonlySet<string> => new Set(o.exclude.map((w) => w.toLowerCase()));

/**
 * The spans offered as the caller's own name, in the order the engine lists them: the word spans
 * of what the caller said, less the literal "none" and any span holding an excluded word.
 *
 * A literal "none" said aloud ("none of your business") is a word span like any other and would
 * collide with the question's own `none`, so the sentinel wins.
 *
 * A span holding an excluded word is withheld rather than argued away in the instructions: a caller
 * correcting the name of someone else ("not Chen, Cheng") can read to a model as the caller naming
 * themselves, and a name the caller never said is worse than no name. What is not on the ballot
 * cannot be chosen.
 */
export function nameCandidates(ctx: Pick<SlotContext, 'candidateWordSpans'>, excluded: ReadonlySet<string>): string[] {
  return ctx.candidateWordSpans.filter((span) => span !== 'none' && !span.split(' ').some((word) => excluded.has(word)));
}

/**
 * A name slot's questions, asked together on every turn: whether the caller states their own name
 * (a yes-or-no with a criterion for each answer), and which of the offered spans of their words it
 * is (the candidates, and none).
 */
export function nameQuestions(slot: string, o: NameOptions): (ctx: Pick<SlotContext, 'candidateWordSpans'>) => QuestionMap {
  const ids = idsOf(slot, o);
  const excluded = excludedWordsOf(o);
  const given = NAME_PARTS.render('given', o.text, {});
  const givenTrue = NAME_PARTS.render('givenTrue', o.text, {});
  const givenFalse = NAME_PARTS.render('givenFalse', o.text, {});
  const span = NAME_PARTS.render('span', o.text, { slot });
  const spanNone = NAME_PARTS.render('spanNone', o.text, {});
  return (ctx) => {
    const criteria: Record<string, string | null> = {};
    for (const s of nameCandidates(ctx, excluded)) criteria[s] = null;
    criteria.none = spanNone;
    return {
      [ids.given]: { type: 'noul', instructions: given, criteria: { true: givenTrue, false: givenFalse } },
      [ids.span]: { type: 'choice', instructions: span, criteria },
    };
  };
}
