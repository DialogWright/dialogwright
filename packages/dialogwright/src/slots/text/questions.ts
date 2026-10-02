import type { QuestionMap } from '../../jev/types';
import { TEXT_PARTS, TEXT_QUESTIONS, type TextOptions } from './options';

/** The question id that asks whether the caller gives the text. */
export const givenIdOf = (slot: string, o: TextOptions): string => TEXT_QUESTIONS.id(slot, 'given', o.ids);

/**
 * A text slot's one question, the same on every turn: does the caller give the text? The words
 * themselves are the value, so nothing is picked from a list.
 */
export function textQuestions(slot: string, o: TextOptions): () => QuestionMap {
  const id = givenIdOf(slot, o);
  const instructions = TEXT_PARTS.render('given', o.text, { what: o.what ?? '', instructions: o.instructions ? ` ${o.instructions}` : '' });
  return () => ({ [id]: { type: 'noul', instructions } });
}
