import { MONTHS } from '../../core/extract/date';
import type { SlotContext } from '../../core/slots/types';
import type { QuestionMap } from '../../jev/types';
import { withDayFirst } from '../parts/locale';
import { BIRTHDATE_PARTS, BIRTHDATE_QUESTIONS, type BirthdateOptions } from './options';
import { birthdatePartialOf } from './partial';

/** The day-of-month labels the day question offers: "1" to "31". */
export const BIRTHDATE_DAYS: readonly string[] = Array.from({ length: 31 }, (_, i) => String(i + 1));

/** The ids of a birthdate slot's four questions. */
export interface BirthdateIds {
  given: string;
  month: string;
  day: string;
  year: string;
}

export const idsOf = (slot: string, o: Pick<BirthdateOptions, 'ids'>): BirthdateIds => ({
  given: BIRTHDATE_QUESTIONS.id(slot, 'given', o.ids),
  month: BIRTHDATE_QUESTIONS.id(slot, 'month', o.ids),
  day: BIRTHDATE_QUESTIONS.id(slot, 'day', o.ids),
  year: BIRTHDATE_QUESTIONS.id(slot, 'year', o.ids),
});

const labelsOf = (labels: readonly string[]): Record<string, string | null> => Object.fromEntries([...labels, 'none'].map((l) => [l, null]));
const capitalized = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
/** A sentence to end a question with: a space and the sentence, or nothing. */
const after = (sentence: string): string => (sentence === '' ? '' : ` ${sentence}`);

/**
 * A birthdate slot's questions, asked together on every turn: whether the caller states their date
 * of birth (a yes-or-no with a criterion for each answer), which month (the twelve months and none),
 * which day (1 to 31 and none), and which span of the caller's words is the year (the spans the
 * engine found, and none). While a month and day are on hand (the slot's pending partial), the year
 * question says the caller was asked for the year; the other three stay as they are, since the
 * caller may restate the whole date. In a day-first locale (Spanish) the default month and day
 * questions end with the day-first sentence (parts/locale.ts); a literal is as written.
 */
export function birthdateQuestions(slot: string, o: BirthdateOptions): (ctx: Pick<SlotContext, 'candidateSpans' | 'window' | 'locale'>) => QuestionMap {
  const ids = idsOf(slot, o);
  const notThis = o.notThisDate === undefined ? '' : ` This is the birth date, not ${o.notThisDate}.`;
  const others = o.notThisDate === undefined ? "Someone else's birth date" : `${capitalized(o.notThisDate)}, or someone else's birth date,`;
  const given = BIRTHDATE_PARTS.render('given', o.text, {});
  const givenTrue = BIRTHDATE_PARTS.render('givenTrue', o.text, {});
  const givenFalse = BIRTHDATE_PARTS.render('givenFalse', o.text, { others });
  const month = BIRTHDATE_PARTS.render('month', o.text, { notThis, hint: after(BIRTHDATE_PARTS.render('monthHint', o.text, {})) });
  const day = BIRTHDATE_PARTS.render('day', o.text, { notThis, hint: after(BIRTHDATE_PARTS.render('dayHint', o.text, {})) });
  const year = BIRTHDATE_PARTS.render('year', o.text, {});
  const yearAsked = BIRTHDATE_PARTS.render('yearAsked', o.text, {});
  const yearNone = BIRTHDATE_PARTS.render('yearNone', o.text, {});
  return (ctx) => {
    const years: Record<string, string | null> = {};
    for (const span of ctx.candidateSpans) years[span] = null;
    years.none = yearNone;
    return {
      [ids.given]: { type: 'noul', instructions: given, criteria: { true: givenTrue, false: givenFalse } },
      [ids.month]: { type: 'choice', instructions: withDayFirst(month, ctx.locale, o.text?.month !== undefined), criteria: labelsOf(MONTHS) },
      [ids.day]: { type: 'choice', instructions: withDayFirst(day, ctx.locale, o.text?.day !== undefined), criteria: labelsOf(BIRTHDATE_DAYS) },
      [ids.year]: { type: 'choice', instructions: birthdatePartialOf(ctx.window) ? yearAsked : year, criteria: years },
    };
  };
}
