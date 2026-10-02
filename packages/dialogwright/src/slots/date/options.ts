import { z } from 'zod';
import { identifier } from '../../define/schema/common';
import { questionParts, questionText, textParts } from '../parts/text';

/**
 * The text parts of a `date` slot: its questions (how the day is referred to, then each part a day
 * can be named by), and the mode question's "none" criterion. Every question starts "Read asr.text."
 * and the `context` sentence; the mode, month and day questions end with the `exclude` sentence when
 * there is one. The defaults use no domain words; `text` replaces any part word for word.
 */
export const DATE_PARTS = textParts('date', {
  mode: {
    template: 'Read asr.text. {context} How do they refer to the day? {modes} "none" if no day is mentioned.{exclude}',
    vars: ['context', 'modes', 'exclude'],
    about: 'The question that asks how the caller refers to the day: a relative day, a weekday, a month and day, a span of days (with `windows`), or none. By default {modes} describes each choice for the slot\'s `range`, and the question ends with the `exclude` sentence.',
  },
  modeNone: {
    template: '',
    vars: [],
    about: 'What the mode question\'s "none" choice means (its criterion), such as which dates are not this day. Default: nothing (the label alone).',
  },
  relative: {
    template: 'Read asr.text. {context} Do they say {relativeDays}?',
    vars: ['context', 'relativeDays'],
    about: 'The question that asks which relative day the caller says: today, yesterday or the day before (`range: past`), or today, tomorrow or the day after (`range: future`).',
  },
  weekday: {
    template: 'Read asr.text. {context} Which day of the week do they name, if any?',
    vars: ['context'],
    about: 'The question that asks which day of the week the caller names.',
  },
  qualifier: {
    template: 'Read asr.text. {context} If they name a day of the week, do they say "this" or "next" before it?',
    vars: ['context'],
    about: 'With `qualifier`: the question that asks whether a weekday is "this" one or "next" one.',
  },
  month: {
    template: 'Read asr.text. {context} Which month do they name, if any?{exclude}',
    vars: ['context', 'exclude'],
    about: 'The question that asks which month the caller names. By default it ends with the `exclude` sentence.',
  },
  day: {
    template: 'Read asr.text. {context} Which day of the month do they name, if any?{exclude}',
    vars: ['context', 'exclude'],
    about: 'The question that asks which day of the month the caller names. By default it ends with the `exclude` sentence.',
  },
  window: {
    template: 'Read asr.text. {context} Do they name a span of days such as this week, next week, this month, or next month?',
    vars: ['context'],
    about: 'With `windows`: the question that asks which span of days the caller names.',
  },
});

/** The questions of a `date` slot, by part. */
export const DATE_QUESTIONS = questionParts({
  mode: 'how the caller refers to the day',
  relative: 'which relative day the caller says',
  weekday: 'which day of the week the caller names',
  qualifier: 'whether a weekday is this one or next one',
  month: 'which month the caller names',
  day: 'which day of the month the caller names',
  window: 'which span of days the caller names',
});

/** The `context` sentence each range has unless the option gives one. */
export const DEFAULT_CONTEXT = {
  past: 'The caller is saying the day something happened.',
  future: 'The caller is saying the day they want.',
} as const;

export const dateOptions = z
  .strictObject({
    range: z
      .enum(['future', 'past'])
      .describe('Which days the slot takes. "future": today or a day to come (an appointment, a delivery); "tomorrow" and "Monday" are the next ones. "past": today or a day gone, up to two years back (when something happened); "yesterday" and "Monday" are the last ones.'),
    windows: z
      .boolean()
      .default(false)
      .describe('`range: future` only. Whether the caller may name a span of days ("next week", "in December") rather than a day: the span is held as the partial { kind: window, start, end, label }, the `narrowPrompt` asks which day in it, and a bare weekday said next is looked for inside it. Adds the window question.'),
    qualifier: z
      .boolean()
      .default(false)
      .describe('`range: future` only. Whether to ask if a weekday is "this" one or "next" one ("next Tuesday" is in the next week). Adds the qualifier question.'),
    narrowPrompt: identifier()
      .optional()
      .describe('With `windows`: the prompt that asks which day in a span of days (the slot\'s partialPromptId), given {window} ("next week", "in December"). Default: ask_<slot>_narrow.'),
    preferMonthDay: z
      .boolean()
      .default(true)
      .describe('Whether a month and a day the model is sure of (SLOT_CHOICE_CONFIRM) win over a weekday reading of the mode: "Monday, September 28" names one day twice, and a weekday reading would land on the next or last Monday instead of the date said.'),
    fillAt: z
      .enum(['fill', 'confirm'])
      .default('fill')
      .describe('How sure the model must be of the day (the least of the parts it read) for it to count. "fill": SLOT_CHOICE_FILL; a day below it is treated as not resolved (`whenUnresolved`). "confirm": SLOT_CHOICE_CONFIRM; a day below it is invalid (reason low_confidence, raw the ISO day), and `readBack` says whether one below SLOT_CHOICE_FILL is acknowledged.'),
    whenUnsaid: z
      .enum(['invalid-if-prompted', 'absent'])
      .default('invalid-if-prompted')
      .describe('What a turn that names no day (the mode question answers none, or is below SLOT_CHOICE_CONFIRM) gives. "invalid-if-prompted": invalid (reason unresolvable, raw empty) when the caller was asked for the day, so the retry ladder moves on, else absent. "absent": always absent.'),
    whenUnresolved: z
      .enum(['invalid-if-prompted', 'invalid'])
      .default('invalid-if-prompted')
      .describe('What a day named but not resolved (no such day, out of range, a span without `windows`, or below the `fillAt` threshold under "fill") gives. "invalid-if-prompted": invalid (reason unresolvable, raw empty) when the caller was asked for the day, else absent. "invalid": always invalid (reason unresolvable), its raw the mode the caller used (absolute, weekday, ...).'),
    keypad: z
      .boolean()
      .default(false)
      .describe('Whether the caller can key the day on the keypad as four digits, month then day (MMDD: 0922), resolved as a spoken month and day are for the `range`. Needs an ask_<slot>_dtmf line.'),
    confirm: z
      .enum(['summary', 'by-confidence'])
      .default('summary')
      .describe('"summary": a spoken day is neither acknowledged nor read back on its own; the form\'s final confirm covers it. "by-confidence": it is acknowledged (ack_<slot>, given the day as {<slot>}) when `readBack` says so.'),
    readBack: z
      .enum(['implicit', 'below-fill', 'none'])
      .default('implicit')
      .describe('With `confirm: by-confidence`, what a filled day asks for: "implicit" (always acknowledged), "below-fill" (only when the model is less sure of it than SLOT_CHOICE_FILL), "none" (never).'),
    context: questionText()
      .optional()
      .describe('The sentence each default question starts with after "Read asr.text.", saying what day the caller is giving ("The caller is saying which day a parcel was due."). Default, by `range`: "The caller is saying the day something happened." (past), "The caller is saying the day they want." (future).'),
    exclude: questionText()
      .optional()
      .describe('A sentence naming a date the caller may also say that is not this day ("A date of birth is not the day the parcel was due."), which the default mode, month and day questions end with. Default: none.'),
    text: DATE_PARTS.schema,
    ids: DATE_QUESTIONS.schema,
  })
  .superRefine((o, ctx) => {
    const issue = (path: (string | number)[], message: string, fix: string): void => {
      ctx.addIssue({ code: 'custom', path, message, params: { fix } });
    };
    if (o.range === 'past') {
      if (o.windows) issue(['windows'], 'windows needs range "future": a day that already happened is one day, never a span', 'delete "windows", or set range: future');
      if (o.qualifier) issue(['qualifier'], 'qualifier needs range "future": "this" or "next" names a weekday to come', 'delete "qualifier", or set range: future');
    }
    if (!o.windows) {
      if (o.narrowPrompt !== undefined) issue(['narrowPrompt'], '"narrowPrompt" is not used, since windows is off and no span of days is held', 'delete "narrowPrompt", or set windows: true');
      if (o.text?.window !== undefined) issue(['text', 'window'], '"text.window" is not used, since windows is off and the window question is not asked', 'delete "window", or set windows: true');
    }
    if (!o.qualifier && o.text?.qualifier !== undefined) {
      issue(['text', 'qualifier'], '"text.qualifier" is not used, since qualifier is off and the qualifier question is not asked', 'delete "qualifier", or set qualifier: true');
    }
    const literal = (part: keyof NonNullable<typeof o.text>): boolean => o.text?.[part] !== undefined;
    const withContext: (keyof NonNullable<typeof o.text>)[] = ['mode', 'relative', 'weekday', 'month', 'day'];
    if (o.qualifier) withContext.push('qualifier');
    if (o.windows) withContext.push('window');
    if (o.context !== undefined && withContext.every(literal)) {
      issue(['context'], '"context" is not used, since text gives every question in its own words', 'delete "context", or write it into the text');
    }
    if (o.exclude !== undefined && (['mode', 'month', 'day'] as const).every(literal)) {
      issue(['exclude'], '"exclude" is not used, since text gives the mode, month and day questions in their own words', 'delete "exclude", or write it into the text');
    }
    if (o.readBack !== 'implicit' && o.confirm === 'summary') {
      issue(['readBack'], `readBack "${o.readBack}" has no effect with confirm "summary", which neither acknowledges nor reads back a spoken day`, 'set confirm: by-confidence, or delete readBack');
    }
  });

export type DateOptions = z.output<typeof dateOptions>;
