import { DATE_MODES, MONTHS, QUALIFIERS, RELATIVE_DAYS, WEEKDAYS, WINDOWS } from '../../core/extract/date';
import { PAST_MODES, PAST_RELATIVE } from '../../core/extract/pastDate';
import type { SlotContext } from '../../core/slots/types';
import type { QuestionMap } from '../../jev/types';
import { withDayFirst } from '../parts/locale';
import { DATE_PARTS, DATE_QUESTIONS, DEFAULT_CONTEXT, type DateOptions } from './options';

/** The day-of-month labels the day question offers: "1" to "31". */
export const DATE_DAYS: readonly string[] = Array.from({ length: 31 }, (_, i) => String(i + 1));

/** The ids of a date slot's questions; `qualifier` and `window` are asked only with their options. */
export interface DateIds {
  mode: string;
  relative: string;
  weekday: string;
  qualifier: string;
  month: string;
  day: string;
  window: string;
}

type Part = keyof DateIds;

export const idsOf = (slot: string, o: Pick<DateOptions, 'ids'>): DateIds => ({
  mode: DATE_QUESTIONS.id(slot, 'mode', o.ids),
  relative: DATE_QUESTIONS.id(slot, 'relative', o.ids),
  weekday: DATE_QUESTIONS.id(slot, 'weekday', o.ids),
  qualifier: DATE_QUESTIONS.id(slot, 'qualifier', o.ids),
  month: DATE_QUESTIONS.id(slot, 'month', o.ids),
  day: DATE_QUESTIONS.id(slot, 'day', o.ids),
  window: DATE_QUESTIONS.id(slot, 'window', o.ids),
});

/**
 * The parts a slot asks about, in the order it asks them: with `windows`, the mode, the month and
 * day, the weekday and its qualifier, the relative day, the span; otherwise the mode, the relative
 * day, the weekday (and its qualifier), the month and the day. (The order is the one the slots the
 * type was drawn from asked in; the model reads each question on its own.)
 */
export function partsOf(o: Pick<DateOptions, 'windows' | 'qualifier'>): Part[] {
  const order: Part[] = o.windows ? ['mode', 'month', 'day', 'weekday', 'qualifier', 'relative', 'window'] : ['mode', 'relative', 'weekday', 'qualifier', 'month', 'day'];
  return order.filter((p) => (p !== 'qualifier' || o.qualifier) && (p !== 'window' || o.windows));
}

/** The ids the slot may ask, in the order it asks them. */
export const questionIdsOf = (slot: string, o: DateOptions): string[] => {
  const ids = idsOf(slot, o);
  return partsOf(o).map((p) => ids[p]);
};

/** The choices of the mode question: how a day can be referred to, with `windows` a span too. */
export const modesOf = (o: Pick<DateOptions, 'range' | 'windows'>): readonly string[] => (o.windows ? DATE_MODES : PAST_MODES);

/** The default description of each mode, for the slot's range. */
function modeWords(o: Pick<DateOptions, 'range' | 'windows'>): string {
  if (o.range === 'past') {
    return '"relative_day" is today, yesterday, or the day before yesterday. "weekday" names a day of the week. "absolute" names a day of the month, with or without its month.';
  }
  if (o.windows) {
    return '"relative_day" is today, tomorrow, or the day after tomorrow. "weekday" names a day of the week. "absolute" names a month, or a month and a day of the month. "window" is a span of days such as this week or next month.';
  }
  return '"relative_day" is today, tomorrow, or the day after tomorrow. "weekday" names a day of the week. "absolute" names a month and a day of the month.';
}

const labelsOf = (labels: readonly string[]): Record<string, string | null> => Object.fromEntries(labels.map((l) => [l, null]));
/** A sentence to end a question with: a space and the sentence, or nothing. */
const after = (sentence: string | undefined): string => (sentence === undefined || sentence === '' ? '' : ` ${sentence}`);

/**
 * A date slot's questions, the same on every turn: how the caller refers to the day (the mode), then
 * a choice for each part a day can be named by. Each choice offers its labels and none; only the
 * mode's none may carry a criterion (`text.modeNone`). In a day-first locale (Spanish) the default
 * month and day questions end with the day-first sentence (parts/locale.ts); a literal is as written.
 */
export function dateQuestions(slot: string, o: DateOptions): (ctx: Pick<SlotContext, 'locale'>) => QuestionMap {
  const ids = idsOf(slot, o);
  const context = o.context ?? DEFAULT_CONTEXT[o.range];
  const exclude = after(o.exclude);
  const relativeDays = o.range === 'past' ? 'today, yesterday, or the day before yesterday' : 'today, tomorrow, or the day after tomorrow';
  const modeNone = DATE_PARTS.render('modeNone', o.text, {});
  const modeCriteria = labelsOf(modesOf(o));
  if (modeNone !== '') modeCriteria.none = modeNone;
  const asked: Record<Part, { instructions: string; criteria: Record<string, string | null> }> = {
    mode: { instructions: DATE_PARTS.render('mode', o.text, { context, modes: modeWords(o), exclude }), criteria: modeCriteria },
    relative: { instructions: DATE_PARTS.render('relative', o.text, { context, relativeDays }), criteria: labelsOf(o.range === 'past' ? PAST_RELATIVE : RELATIVE_DAYS) },
    weekday: { instructions: DATE_PARTS.render('weekday', o.text, { context }), criteria: labelsOf([...WEEKDAYS, 'none']) },
    qualifier: { instructions: DATE_PARTS.render('qualifier', o.text, { context }), criteria: labelsOf(QUALIFIERS) },
    month: { instructions: DATE_PARTS.render('month', o.text, { context, exclude }), criteria: labelsOf([...MONTHS, 'none']) },
    day: { instructions: DATE_PARTS.render('day', o.text, { context, exclude }), criteria: labelsOf([...DATE_DAYS, 'none']) },
    window: { instructions: DATE_PARTS.render('window', o.text, { context }), criteria: labelsOf(WINDOWS) },
  };
  const parts = partsOf(o);
  const instructionsOf = (p: Part, locale: string | undefined): string =>
    p === 'month' || p === 'day' ? withDayFirst(asked[p].instructions, locale, o.text?.[p] !== undefined) : asked[p].instructions;
  return (ctx) =>
    Object.fromEntries(parts.map((p) => [ids[p], { type: 'choice' as const, instructions: instructionsOf(p, ctx?.locale), criteria: { ...asked[p].criteria } }]));
}
