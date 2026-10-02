import type { SlotPrompt } from '../../core/slots/types';
import { examplesFrom } from '../parts/examples';
import { defineSlotType } from '../slotType';
import type { SlotType } from '../types';
import { choiceDisplay } from './display';
import { choiceFill } from './fill';
import { choiceOptions, choiceWording, type ChoiceOptions, type ChoiceWording } from './options';
import { choiceIdsOf, choiceQuestions, type ChoiceIds } from './questions';

export {
  choiceOptions, choiceWording, CHOICE_PARTS, CHOICE_QUESTIONS, DEFAULT_INSTRUCTIONS, DEFAULT_MEANS, DEFAULT_NONE, FILL_AT, HEDGE_PARTS, HELP_PARTS, MAX_KEYPAD_OPTIONS, MEANS_VARS,
} from './options';
export type { ChoiceOptions, ChoiceOption, ChoiceHelpLabel, ChoiceWording } from './options';
export { choiceDisplay } from './display';
export { otherOptionNamed } from './fill';
export { choiceIdsOf } from './questions';
export type { ChoiceIds } from './questions';

const examples = examplesFrom(new URL('./examples.yaml', import.meta.url));

/** The lines a choice slot may lead to, beyond ask_<slot> and ask_<slot>_retry. */
function promptsOf(id: string, o: ChoiceOptions): SlotPrompt[] {
  const prompts: SlotPrompt[] = [];
  if (o.confirm === 'by-confidence') prompts.push({ id: `ack_${id}`, why: 'it acknowledges an option the model is less sure of, or one the caller hedged about', vars: [id] });
  if (o.disambiguate || o.hedge?.byName) {
    const why = o.disambiguate && o.hedge?.byName ? 'two options are close, or a hedging caller names two' : o.disambiguate ? 'two options are close' : 'a hedging caller names two options';
    prompts.push({ id: `disambiguate_${id}`, why: `it asks which of two when ${why}`, vars: ['a', 'b'] });
  }
  for (const [label, l] of Object.entries(o.help?.labels ?? {})) {
    if (l.prompt !== undefined && !prompts.some((p) => p.id === l.prompt)) prompts.push({ id: l.prompt, why: `the caller answers "${label}" without naming an option (help)` });
  }
  if (o.keypad) prompts.push({ id: `ask_${id}_dtmf`, why: 'it asks for the option on the keypad after spoken answers missed' });
  return prompts;
}

/** Every question id the slot may ask: the choice, then the hedge and help questions it has. */
const questionIdsOf = (ids: ChoiceIds): string[] => [ids.choice, ...(ids.hedge ? [ids.hedge] : []), ...(ids.help ? [ids.help] : [])];

/**
 * `choice`: one of a fixed list of options (a delivery speed, a branch, a colour). The model is
 * asked which option the caller names, with one criterion per option and one for none; the slot
 * fills with the option's key when the model is sure enough, so the value is always one of the
 * options and the model never writes it. See README.md beside this file.
 */
export const choiceType: SlotType<ChoiceOptions, ChoiceWording> = defineSlotType<ChoiceOptions, ChoiceWording>({
  type: 'choice',
  options: choiceOptions,
  wording: (o) => choiceWording(o),
  build(id, o, wording) {
    const ids = choiceIdsOf(id, o);
    const display = choiceDisplay(o, wording);
    const keys = Object.keys(o.options);
    return {
      id,
      spokenConfirm: o.confirm,
      questionIds: questionIdsOf(ids),
      prompts: promptsOf(id, o),
      questions: choiceQuestions(id, o),
      fill: choiceFill(o, ids, display),
      ...(o.keypad
        ? {
            dtmf: {
              length: 1,
              parse: (digits: string, ctx: { locale?: string }) => {
                const key = /^[1-9]$/.test(digits) ? keys[Number(digits) - 1] : undefined;
                return key === undefined ? null : { value: key, display: display(key, ctx.locale) };
              },
            },
          }
        : {}),
      display,
    };
  },
  get examples() {
    return examples();
  },
  describe: {
    summary: 'One of a fixed list of options: a delivery speed, a branch, a colour.',
    notes: 'The model judges which option the caller names, or none; the slot takes the option only when the model is sure enough, so the value is always one of the options. Each option says how it is displayed, what the model is told it means, and (with the keypad on) which digit chooses it. An advanced tier, off unless written, is for options a caller confuses or is unsure of: it reads back a less sure choice (confirm: by-confidence, readBack), asks which of two close ones (disambiguate), hears a hedge (hedge) and answers a caller who does not know the name (help).',
  },
});
