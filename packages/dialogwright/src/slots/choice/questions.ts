import type { QuestionMap } from '../../jev/types';
import { renderTemplate } from '../parts/template';
import type { ChoiceOptions } from './options';

/** The id of a choice slot's question: the slot's own id (a question named after its slot), unless `ids.choice` says otherwise. */
export const choiceIdOf = (slot: string, o: Pick<ChoiceOptions, 'ids'>): string => o.ids?.choice ?? slot;

/** The criterion of one option: its own `means` when it has one, else the slot's template filled from its key and `say`. */
export function meansOf(key: string, o: Pick<ChoiceOptions, 'options' | 'means'>): string {
  const option = o.options[key]!;
  return option.means ?? renderTemplate(o.means, { key, say: option.say }, `the choice slot's "means" for the option "${key}"`);
}

/**
 * A choice slot's one question, the same on every turn: which option does the caller name? The
 * labels are the options in the order written, then `none`, so the model's choice and a stub's first
 * pick follow the order the author gave.
 */
export function choiceQuestions(slot: string, o: ChoiceOptions): () => QuestionMap {
  const id = choiceIdOf(slot, o);
  const criteria: Record<string, string> = {};
  for (const key of Object.keys(o.options)) criteria[key] = meansOf(key, o);
  criteria.none = o.none;
  return () => ({ [id]: { type: 'choice', instructions: o.instructions, criteria: { ...criteria } } });
}
