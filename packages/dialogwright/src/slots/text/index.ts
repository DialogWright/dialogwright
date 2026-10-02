import { examplesFrom } from '../parts/examples';
import { defineSlotType } from '../slotType';
import type { SlotType } from '../types';
import { textDisplay } from './display';
import { textFill } from './fill';
import { textOptions, type TextOptions } from './options';
import { givenIdOf, textQuestions } from './questions';

export { textOptions, TEXT_PARTS, TEXT_QUESTIONS, DEFAULT_MAX_LENGTH, DEFAULT_SAY } from './options';
export type { TextOptions } from './options';

const examples = examplesFrom(new URL('./examples.yaml', import.meta.url));

/**
 * `text`: the caller's own words, kept as said (a description of a problem, a note for a courier).
 * One yes-or-no question asks whether the caller gives them; the value is the turn's words, never
 * a paraphrase. A summary reads the slot back by a stand-in, and the words leave the turn by their
 * length only. See README.md beside this file.
 */
export const textType: SlotType<TextOptions> = defineSlotType<TextOptions>({
  type: 'text',
  options: textOptions,
  build(id, o) {
    const givenId = givenIdOf(id, o);
    const display = textDisplay(o);
    return {
      id,
      // Never acknowledged or read back on its own: the stand-in says nothing a caller could correct.
      spokenConfirm: 'summary',
      ...(o.redact === 'length' ? { redact: 'length' as const } : {}),
      detect: true,
      questionIds: [givenId],
      prompts: [],
      questions: textQuestions(id, o),
      fill: textFill(o, givenId, display),
      display,
    };
  },
  get examples() {
    return examples();
  },
  describe: {
    summary: 'The caller\'s own words, kept as said: a description, a note, a reason.',
    notes: 'For a value no list holds and no code can check. The words are the value, so a summary reads the slot back by a stand-in (say) rather than repeating them, and redact keeps them out of the trace by default.',
  },
});
