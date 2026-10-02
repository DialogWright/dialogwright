import type { QuestionMap } from '../../jev/types';
import { renderTemplate } from '../parts/template';
import { CHOICE_PARTS, CHOICE_QUESTIONS, HEDGE_PARTS, HELP_PARTS, type ChoiceOptions } from './options';

/** The id of a choice slot's question: the slot's own id (a question named after its slot), unless `ids.choice` says otherwise. */
export const choiceIdOf = (slot: string, o: Pick<ChoiceOptions, 'ids'>): string => o.ids?.choice ?? slot;

/** The ids of a choice slot's questions: the choice, and the hedge and help questions when it asks them. */
export interface ChoiceIds {
  choice: string;
  hedge?: string;
  help?: string;
}

/** The ids of the questions a choice slot asks, by part. */
export function choiceIdsOf(slot: string, o: Pick<ChoiceOptions, 'ids' | 'hedge' | 'help'>): ChoiceIds {
  return {
    choice: choiceIdOf(slot, o),
    ...(o.hedge ? { hedge: CHOICE_QUESTIONS.id(slot, 'hedge', o.ids) } : {}),
    ...(o.help ? { help: CHOICE_QUESTIONS.id(slot, 'help', o.ids) } : {}),
  };
}

/** The criterion of one option: its own `means` when it has one, else the slot's template filled from its key and `say`. */
export function meansOf(key: string, o: Pick<ChoiceOptions, 'options' | 'means'>): string {
  const option = o.options[key]!;
  return option.means ?? renderTemplate(o.means, { key, say: option.say }, `the choice slot's "means" for the option "${key}"`);
}

/**
 * A choice slot's questions, the same on every turn. Which option does the caller name? Its labels
 * are the options in the order written, then `none`, so the model's choice and a stub's first pick
 * follow the order the author gave. With `hedge`, a yes-or-no: is the caller unsure which they mean?
 * With `help`, a choice among `help.labels` in their order, with no `none` (a stub picks the first):
 * what does the caller say without naming one?
 */
export function choiceQuestions(slot: string, o: ChoiceOptions): () => QuestionMap {
  const ids = choiceIdsOf(slot, o);
  const criteria: Record<string, string> = {};
  for (const key of Object.keys(o.options)) criteria[key] = meansOf(key, o);
  criteria.none = CHOICE_PARTS.render('none', o.text, {});
  const instructions = CHOICE_PARTS.render('instructions', o.text, {});
  const hedge = o.hedge && {
    instructions: HEDGE_PARTS.render('instructions', o.hedge.text, {}),
    yes: HEDGE_PARTS.render('true', o.hedge.text, {}),
    no: HEDGE_PARTS.render('false', o.hedge.text, {}),
  };
  const help = o.help && {
    instructions: HELP_PARTS.render('instructions', o.help.text, {}),
    criteria: Object.fromEntries(Object.entries(o.help.labels).map(([label, l]) => [label, l.means])),
  };
  return () => {
    const out: QuestionMap = { [ids.choice]: { type: 'choice', instructions, criteria: { ...criteria } } };
    if (hedge && ids.hedge) out[ids.hedge] = { type: 'noul', instructions: hedge.instructions, criteria: { true: hedge.yes, false: hedge.no } };
    if (help && ids.help) out[ids.help] = { type: 'choice', instructions: help.instructions, criteria: { ...help.criteria } };
    return out;
  };
}
