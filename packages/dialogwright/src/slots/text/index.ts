import { examplesFrom } from '../parts/examples';
import { readBackOf, readBackPrompts } from '../parts/readBack';
import { defineSlotType } from '../slotType';
import type { SlotType } from '../types';
import { textDisplay } from './display';
import { textFill } from './fill';
import { textOptions, textWording, type TextOptions, type TextWording } from './options';
import { changedIdOf, givenIdOf, pickIdOf, textQuestions } from './questions';

export { textOptions, textWording, TEXT_PARTS, TEXT_QUESTIONS, DEFAULT_MAX_LENGTH, DEFAULT_SAY } from './options';
export type { TextOptions, TextWording } from './options';
export { WRITTEN_RULES, writtenForm, writtenRulesFor } from './written';
export type { WrittenCase, WrittenNumbers, WrittenRules } from './written';
export { MAX_PICK_CANDIDATES, MAX_PICK_SPLITS, MIN_TAIL_WORDS, PICK_LABELS, PICK_WORDS, pickCandidates, pickWordsFor } from './pick';
export type { PickWords, PickWordsByLocale } from './pick';

/**
 * What the other slots do on a turn that gives the slot its words while it is asked for (`others`):
 * the app's setting, else `quiet` for a slot that takes the whole answer as its content and `listen`
 * for one that picks part of a longer answer (`pick`).
 */
export function othersOf(o: Pick<TextOptions, 'others' | 'pick'>): NonNullable<TextOptions['others']> {
  return o.others ?? (o.pick !== undefined ? 'listen' : 'quiet');
}

/** What `others` makes of the slot (SlotSpec.quietsOthers, SlotSpec.listensWhileQuiet). */
function quietOf(others: NonNullable<TextOptions['others']>): { quietsOthers?: true; listensWhileQuiet?: readonly string[] } {
  if (others === 'listen') return {};
  if (others === 'quiet') return { quietsOthers: true };
  return { quietsOthers: true, listensWhileQuiet: [...others.listen] };
}

/** Whether a fill's display is the words as said while its value is written from them (SlotSpec.displayFrom). */
const displaysSaid = (o: TextOptions): boolean => o.say === null && (o.numbers === 'digits' || o.case === 'title');

const examples = examplesFrom(new URL('./examples.yaml', import.meta.url));

/**
 * `text`: the caller's own words, kept as said (a description of a problem, a note for a courier).
 * One yes-or-no question asks whether the caller gives them; the value is the turn's words, never
 * a paraphrase. With `pick`, a second question chooses which of the parts code split the words into
 * is the value, and the value is that part, as said. A summary reads the slot back by a stand-in,
 * and the words leave the turn by their length only. See README.md beside this file.
 */
export const textType: SlotType<TextOptions, TextWording> = defineSlotType<TextOptions, TextWording>({
  type: 'text',
  options: textOptions,
  wording: (o) => textWording(o),
  build(id, o, wording) {
    const givenId = givenIdOf(id, o);
    const pickId = pickIdOf(id, o);
    const changedId = changedIdOf(id, o);
    const display = textDisplay(o, wording);
    return {
      id,
      // Read back on its own only when the app says so (`confirm: always`): by default the summary
      // reads it, and the stand-in says nothing a caller could correct.
      ...readBackOf(o.confirm ?? 'summary'),
      ...(o.redact === 'length' ? { redact: 'length' as const } : {}),
      // Masked by its length everywhere, its display and the console too (a secret's masking), and the
      // one value a model may be sent though the records hide it: to summarize it (SlotSpec.summarized).
      ...(o.redact === 'length-summarized' ? { redact: 'length' as const, statement: false as const, summarized: true as const } : {}),
      // Shown as said while the value is written (written.ts): display(value) cannot give the words back.
      ...(displaysSaid(o) ? { displayFrom: 'said' as const } : {}),
      // A turn that gives its words while it is asked for is its content alone (others: quiet), but for
      // the slots the app lists (others: { listen }): the default for a slot that takes the whole
      // answer; one that picks part of it (pick) listens.
      ...quietOf(othersOf(o)),
      detect: true,
      questionIds: o.pick ? [givenId, pickId] : [givenId, changedId],
      // Asked only at a form's summary read-back (questions.ts changeableAtSummary), never with pick.
      ...(o.pick ? {} : { summaryQuestion: changedId }),
      prompts: readBackPrompts(id, o.confirm ?? 'summary'),
      questions: textQuestions(id, o),
      fill: textFill(o, { given: givenId, pick: pickId, changed: changedId }, display),
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
