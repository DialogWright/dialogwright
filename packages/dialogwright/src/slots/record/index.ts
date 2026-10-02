import type { SlotPrompt } from '../../core/slots/types';
import { examplesFrom } from '../parts/examples';
import { defineSlotType } from '../slotType';
import type { SlotType } from '../types';
import { recordDisplay } from './display';
import { recordFill, recordKeys } from './fill';
import { recordOptions, type RecordOptions } from './options';
import { recordIdOf, recordQuestions } from './questions';

export {
  recordOptions, RECORD_PARTS, RECORD_QUESTIONS, DEFAULT_KEY, DEFAULT_KEY_PATTERN, DEFAULT_LABEL, DEFAULT_LABEL_PREFIX, DEFAULT_MISS_REASON,
  DEFAULT_SPOKEN_LABEL, FILL_AT, MAX_KEYPAD,
} from './options';
export type { RecordOptions } from './options';
export { recordDisplay } from './display';
export { recordCandidates, recordsOf } from './questions';
export type { RecordCandidate } from './questions';
export { LABEL_FILTERS, renderLabel } from './label';

const examples = examplesFrom(new URL('./examples.yaml', import.meta.url));

/** The lines a record slot may lead to, beyond ask_<slot> and ask_<slot>_retry. */
function promptsOf(id: string, o: RecordOptions): SlotPrompt[] {
  const out: SlotPrompt[] = [];
  if (o.disambiguate) out.push({ id: `disambiguate_${id}`, why: 'the caller could mean either of two records and is asked which', vars: ['a', 'b'] });
  if (o.keypad !== undefined) out.push({ id: `ask_${id}_dtmf`, why: 'it asks for the key on the keypad after spoken answers missed' });
  return out;
}

/**
 * `record`: one of the app's records (a parcel, an order, a booking), chosen by what the caller says
 * of it, its number or what it holds. The question offers each record of the list the slot reads
 * (the app's, from facts.forSlots), labelled from the record's fields, and, when `spoken` is set,
 * the numbers the caller says that no record has. The slot fills with the record's key, so the value
 * is always a key that matches keyPattern, never words the model wrote. See README.md beside this file.
 */
export const recordType: SlotType<RecordOptions> = defineSlotType<RecordOptions>({
  type: 'record',
  options: recordOptions,
  build(id, o) {
    const questionId = recordIdOf(id, o);
    const display = recordDisplay();
    return {
      id,
      // Never acknowledged: the final summary reads it back.
      spokenConfirm: 'summary',
      questionIds: [questionId],
      prompts: promptsOf(id, o),
      thresholds: [o.fillAt],
      questions: recordQuestions(id, o),
      fill: recordFill(o, questionId, display),
      ...(o.keypad !== undefined ? { dtmf: { length: o.keypad, parse: recordKeys({ keyPattern: o.keyPattern, keypad: o.keypad }, display) } } : {}),
      display,
    };
  },
  get examples() {
    return examples();
  },
  describe: {
    summary: 'One of the app\'s records, chosen by what the caller says of it: a parcel, an order, a booking.',
    notes: 'The model judges which of the offered records the caller means, or none; the code offers the records (labelled from their fields) and, optionally, the numbers the caller says, so the value is a key that matches keyPattern, never words the model wrote (the fill takes any such label, as the hand-written slots it replaced did, not only one offered on that turn). Two records the model cannot tell apart make the slot ask which one.',
  },
});
