import type { SlotPrompt } from '../../core/slots/types';
import { examplesFrom } from '../parts/examples';
import { defineSlotType } from '../slotType';
import type { SlotType } from '../types';
import { choiceDisplay } from './display';
import { choiceFill } from './fill';
import { choiceOptions, type ChoiceOptions } from './options';
import { choiceIdOf, choiceQuestions } from './questions';

export {
  choiceOptions, CHOICE_PARTS, CHOICE_QUESTIONS, DEFAULT_INSTRUCTIONS, DEFAULT_MEANS, DEFAULT_NONE, FILL_AT, MAX_KEYPAD_OPTIONS, MEANS_VARS,
} from './options';
export type { ChoiceOptions, ChoiceOption } from './options';
export { choiceDisplay } from './display';

const examples = examplesFrom(new URL('./examples.yaml', import.meta.url));

/** The lines a choice slot may lead to, beyond ask_<slot> and ask_<slot>_retry. */
function promptsOf(id: string, o: ChoiceOptions): SlotPrompt[] {
  return o.keypad ? [{ id: `ask_${id}_dtmf`, why: 'it asks for the option on the keypad after spoken answers missed' }] : [];
}

/**
 * `choice`: one of a fixed list of options (a delivery speed, a branch, a colour). The model is
 * asked which option the caller names, with one criterion per option and one for none; the slot
 * fills with the option's key when the model is sure enough, so the value is always one of the
 * options and the model never writes it. See README.md beside this file.
 */
export const choiceType: SlotType<ChoiceOptions> = defineSlotType<ChoiceOptions>({
  type: 'choice',
  options: choiceOptions,
  build(id, o) {
    const questionId = choiceIdOf(id, o);
    const display = choiceDisplay(o);
    const keys = Object.keys(o.options);
    return {
      id,
      spokenConfirm: 'summary',
      questionIds: [questionId],
      prompts: promptsOf(id, o),
      questions: choiceQuestions(id, o),
      fill: choiceFill(o, questionId, display),
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
    notes: 'The model judges which option the caller names, or none; the slot takes the option only when the model is sure enough, so the value is always one of the options. Each option says how it is displayed, what the model is told it means, and (with the keypad on) which digit chooses it.',
  },
});
