import { describeWindow } from '../../core/extract/date';
import type { SlotPartial, SlotPrompt } from '../../core/slots/types';
import { examplesFrom } from '../parts/examples';
import { defineSlotType } from '../slotType';
import type { SlotType } from '../types';
import { dateDisplay } from './display';
import { dateFill, dateKeys } from './fill';
import { dateOptions, type DateOptions } from './options';
import { dateWindowOf } from './partial';
import { dateQuestions, idsOf, questionIdsOf } from './questions';

export { dateOptions, DATE_PARTS, DATE_QUESTIONS, DEFAULT_CONTEXT } from './options';
export type { DateOptions } from './options';
export { DATE_DAYS } from './questions';
export { dateDisplay } from './display';
export { constrainToWindow, dateWindowOf } from './partial';
export type { DateWindowPartial } from './partial';

const examples = examplesFrom(new URL('./examples.yaml', import.meta.url));

/** The prompt that asks which day in a span of days: `narrowPrompt`, or ask_<slot>_narrow. */
export const narrowPromptOf = (id: string, o: Pick<DateOptions, 'narrowPrompt'>): string => o.narrowPrompt ?? `ask_${id}_narrow`;

/** The span a pending partial holds, as the narrowPrompt says it ("next week", "in December"; "la próxima semana", "en diciembre"); empty for none. */
function partialVars(window: SlotPartial, locale?: string): Record<string, string> {
  const span = dateWindowOf(window);
  return { window: span ? describeWindow(span, locale) : '' };
}

/** The lines a date slot may lead to, beyond ask_<slot> and ask_<slot>_retry. */
function promptsOf(id: string, o: DateOptions): SlotPrompt[] {
  const prompts: SlotPrompt[] = [];
  if (o.windows) prompts.push({ id: narrowPromptOf(id, o), why: 'the caller named a span of days without the day (the partialPromptId), said as {window}', vars: ['window'] });
  if (o.confirm === 'by-confidence') prompts.push({ id: `ack_${id}`, why: 'it acknowledges a day it is less sure of', vars: [id] });
  if (o.keypad) prompts.push({ id: `ask_${id}_dtmf`, why: 'it asks for the day on the keypad, as four digits (month then day; in Spanish day then month), after spoken answers missed' });
  return prompts;
}

/**
 * `date`: a calendar day, ahead (an appointment, a delivery) or back (when something happened). The
 * model is asked how the caller refers to the day and a choice for each part (a relative day, a
 * weekday, a month, a day of the month, and ahead, optionally, this or next and a span of days); the
 * code resolves the parts against today, so the value is always a real day in range. See README.md
 * beside this file.
 */
export const dateType: SlotType<DateOptions> = defineSlotType<DateOptions>({
  type: 'date',
  options: dateOptions,
  build(id, o) {
    const ids = idsOf(id, o);
    const display = dateDisplay();
    return {
      id,
      spokenConfirm: o.confirm,
      valueKind: 'date',
      ...(o.windows ? { partialPromptId: narrowPromptOf(id, o), partialVars } : {}),
      questionIds: questionIdsOf(id, o),
      prompts: promptsOf(id, o),
      questions: dateQuestions(id, o),
      fill: dateFill(o, ids, display),
      ...(o.keypad ? { dtmf: { length: 4, parse: dateKeys(o, display) } } : {}),
      display,
    };
  },
  get examples() {
    return examples();
  },
  describe: {
    summary: 'A calendar day, ahead or back: an appointment, a delivery, the day something happened.',
    notes: 'The model judges how the caller refers to the day and picks each part from a fixed list (a relative day, a weekday, a month, a day of the month, and ahead a span of days); the code resolves them against today, so the value is always a real day in the slot\'s range, never one the model wrote. Ahead, a span of days can be held and narrowed. For a date of birth, use birthdate.',
  },
});
