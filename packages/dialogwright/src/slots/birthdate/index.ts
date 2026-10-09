import type { SlotPrompt } from '../../core/slots/types';
import { examplesFrom } from '../parts/examples';
import { readBackOf, readBackPrompts } from '../parts/readBack';
import { defineSlotType } from '../slotType';
import type { SlotType } from '../types';
import { birthdateDisplay } from './display';
import { birthdateFill, birthdateKeys } from './fill';
import { birthdateOptions, type BirthdateOptions } from './options';
import { birthdateQuestions, idsOf } from './questions';

export { birthdateOptions, BIRTHDATE_PARTS, BIRTHDATE_QUESTIONS, DEFAULT_MIN_YEAR } from './options';
export type { BirthdateOptions } from './options';
export { BIRTHDATE_DAYS } from './questions';
export { birthdateDisplay } from './display';
export { birthdatePartialOf } from './partial';
export type { BirthdatePartial } from './partial';

const examples = examplesFrom(new URL('./examples.yaml', import.meta.url));

/** The prompt that asks for the year alone: `yearPrompt`, or ask_<slot>_year. */
export const yearPromptOf = (id: string, o: Pick<BirthdateOptions, 'yearPrompt'>): string => o.yearPrompt ?? `ask_${id}_year`;

/** The lines a birthdate slot may lead to, beyond ask_<slot> and ask_<slot>_retry. */
function promptsOf(id: string, o: BirthdateOptions): SlotPrompt[] {
  const prompts: SlotPrompt[] = [{ id: yearPromptOf(id, o), why: 'the caller gave the month and day of their birth without the year (the partialPromptId)' }];
  if (o.wholePrompt !== undefined) prompts.push({ id: o.wholePrompt, why: 'a month or a day of the birth date was not heard (the fill\'s retryPromptId)' });
  if (o.keypad) prompts.push({ id: `ask_${id}_dtmf`, why: 'it asks for the date of birth on the keypad, as eight digits, after spoken answers missed' });
  prompts.push(...readBackPrompts(id, o.confirm));
  return prompts;
}

/**
 * `birthdate`: a caller's date of birth. The model is asked whether a birth date is stated, which
 * month and which day (each a choice from a fixed list), and which span of the caller's words is the
 * year; the code puts them together and checks the day is real and in the past. A month and day
 * without the year are held as a partial and the year is asked for alone. See README.md beside this
 * file.
 */
export const birthdateType: SlotType<BirthdateOptions> = defineSlotType<BirthdateOptions>({
  type: 'birthdate',
  options: birthdateOptions,
  build(id, o) {
    const ids = idsOf(id, o);
    const display = birthdateDisplay();
    return {
      id,
      ...readBackOf(o.confirm),
      ...(o.redact === 'mask' ? { redact: 'mask' as const } : {}),
      ...(o.handoff === 'verified' ? { handoff: 'verified' as const } : {}),
      valueKind: 'date',
      detect: true,
      partialPromptId: yearPromptOf(id, o),
      questionIds: [ids.given, ids.month, ids.day, ids.year],
      prompts: promptsOf(id, o),
      questions: birthdateQuestions(id, o),
      fill: birthdateFill(o, ids, display),
      ...(o.keypad ? { dtmf: { length: 8, parse: birthdateKeys(o, display) } } : {}),
      display,
    };
  },
  get examples() {
    return examples();
  },
  describe: {
    summary: 'A caller\'s date of birth: a month, a day and a year, heard whole or in part.',
    notes: 'The model judges whether a birth date is stated and picks the month, the day and the span of the words that is the year; the code puts them together and checks the day is real and in the past, so the value is always a day the caller said. A month and day without the year are held, and the year is asked for alone. Masked to its year by default.',
  },
});
