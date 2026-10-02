import { z } from 'zod';
import { identifier } from '../../define/schema/common';
import { questionParts, questionText, textParts } from '../parts/text';

/**
 * The text parts of a `birthdate` slot: its four questions, the yes-or-no question's two criteria,
 * the year question's "none" label, the year question as it is asked once a month and day are on
 * hand, and two hints the month and day questions end with. The defaults are a known-good wording
 * (the one two recorded apps share), with nothing about any other date the caller might mention;
 * `notThisDate` adds that, and `text` replaces any part word for word.
 */
export const BIRTHDATE_PARTS = textParts('birthdate', {
  given: {
    template: 'Read asr.text. Does the caller state their date of birth or birthday, in whole or in part (a month and day, or a year alone when asked for it)?',
    vars: [],
    about: 'The yes-or-no question that asks whether the caller states their date of birth at all.',
  },
  givenTrue: {
    template: 'The caller gives their own birth date or part of it: a full date, a month and day, or a year on its own in answer to a question about their birth year',
    vars: [],
    about: 'What a yes to the first question means (its "true" criterion).',
  },
  givenFalse: {
    template: "No birth date. {others} is not the caller's date of birth",
    vars: ['others'],
    about: 'What a no to the first question means (its "false" criterion). By default it names `notThisDate`, when given, and someone else\'s birth date.',
  },
  month: {
    template: "Read asr.text. Which month is the caller's date of birth in, if they say one?{notThis}{hint}",
    vars: ['notThis', 'hint'],
    about: 'The question that asks which month the birth date is in. Its choices are the twelve months and none. By default it ends with the `notThisDate` sentence and `monthHint`.',
  },
  monthHint: {
    template: '',
    vars: [],
    about: 'A sentence the default month question ends with, such as how a month said as a number is read. Default: none.',
  },
  day: {
    template: "Read asr.text. Which day of the month is the caller's date of birth, if they say one?{notThis}{hint}",
    vars: ['notThis', 'hint'],
    about: 'The question that asks which day of the month the birth date is. Its choices are 1 to 31 and none. By default it ends with the `notThisDate` sentence and `dayHint`.',
  },
  dayHint: {
    template: '',
    vars: [],
    about: 'A sentence the default day question ends with, such as which number of a date said as numbers is the day. Default: none.',
  },
  year: {
    template:
      'Read asr.text. Which of these spans is the year of the caller\'s birth, if they say one, as in "nineteen seventy four", "seventy four", or "two thousand one"? Choose none when no year is said.',
    vars: [],
    about: 'The question that asks which span of the caller\'s words is the year, when no month and day are on hand. Its choices are the spans the engine finds, and none.',
  },
  yearAsked: {
    template:
      'Read asr.text. The caller was asked for the year of their birth. Which of these spans is that year, as in "nineteen seventy four", "seventy four", or "two thousand one"? Choose none when no year is said.',
    vars: [],
    about: 'The year question in place of `year` while a month and day are on hand, so the caller was just asked for the year alone (they may still restate the whole date).',
  },
  yearNone: {
    template: "No span of asr.text is a year of the caller's birth",
    vars: [],
    about: 'What the year question\'s "none" choice means.',
  },
});

/** The questions of a `birthdate` slot, by part. */
export const BIRTHDATE_QUESTIONS = questionParts({
  given: 'whether the caller states their date of birth',
  month: 'which month the date of birth is in',
  day: 'which day of the month the date of birth is',
  year: 'which span of the caller\'s words is the year of birth',
});

/** The earliest year a date of birth may be in, unless `minYear` says otherwise. */
export const DEFAULT_MIN_YEAR = 1900;

export const birthdateOptions = z
  .strictObject({
    keypad: z
      .boolean()
      .default(false)
      .describe('Whether the caller can key the date on the keypad as eight digits, month, day and year (MMDDYYYY). Needs an ask_<slot>_dtmf line.'),
    yearPrompt: identifier()
      .optional()
      .describe('The prompt that asks for the year alone once a month and day are heard without it (the slot\'s partialPromptId). Default: ask_<slot>_year.'),
    wholePrompt: identifier()
      .optional()
      .describe('The prompt that asks for the whole date again when a month or a day was not heard; the outcome is invalid, with the reason no_month_day, no_month or no_day. Absent: the outcome is invalid with the reason no_year and the slot\'s generic retry asks again.'),
    minYear: z
      .number()
      .int()
      .min(1)
      .default(DEFAULT_MIN_YEAR)
      .describe('The earliest year a date of birth may be in. An earlier one is invalid (reason impossible), and the keypad refuses it.'),
    notThisDate: questionText()
      .optional()
      .describe('Another date the caller is likely to mention, which the birth date is not, as a noun phrase ("an appointment date", "the date of the order"). The default month and day questions then say "This is the birth date, not <it>.", and the default "false" criterion names it.'),
    redact: z
      .enum(['mask', 'none'])
      .default('mask')
      .describe('How the value is masked wherever it leaves the turn (the trace, the console, a tool call\'s param of the same name): "mask" keeps the year only ("••/••/1985"); "none" keeps it as it is.'),
    handoff: z
      .enum(['display', 'verified'])
      .default('display')
      .describe('What a transfer to a person hands over: the date as it is said ("display"), or, for a birth date asked to verify identity, only whether the caller was "verified".'),
    confirm: z
      .enum(['summary'])
      .default('summary')
      .describe('"summary": a birth date is neither acknowledged nor read back on its own; the form\'s final confirm covers it.'),
    text: BIRTHDATE_PARTS.schema,
    ids: BIRTHDATE_QUESTIONS.schema,
  })
  .superRefine((o, ctx) => {
    const unused = (key: string, path: (string | number)[], why: string, fix: string): void => {
      ctx.addIssue({ code: 'custom', path, message: `"${key}" is not used, since ${why}`, params: { fix } });
    };
    if (o.notThisDate !== undefined && o.text?.month !== undefined && o.text?.day !== undefined && o.text?.givenFalse !== undefined) {
      unused('notThisDate', ['notThisDate'], 'text gives the month and day questions and the "false" criterion in their own words', 'delete "notThisDate", or write it into the text');
    }
    if (o.text?.monthHint !== undefined && o.text?.month !== undefined) {
      unused('text.monthHint', ['text', 'monthHint'], 'text.month gives the whole month question', 'delete "monthHint", or write it into text.month');
    }
    if (o.text?.dayHint !== undefined && o.text?.day !== undefined) {
      unused('text.dayHint', ['text', 'dayHint'], 'text.day gives the whole day question', 'delete "dayHint", or write it into text.day');
    }
  });

export type BirthdateOptions = z.output<typeof birthdateOptions>;
