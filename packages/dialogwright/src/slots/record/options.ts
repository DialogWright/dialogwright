import { z } from 'zod';
import { repeatsARepeat } from '../parts/pattern';
import { identifier } from '../../define/schema/common';
import { questionParts, questionText, textParts } from '../parts/text';
import { checkLabelTemplate, LABEL_FILTERS } from './label';

/**
 * The text parts of a `record` slot: its one question and the criterion of its `none` label. The
 * labels of the records themselves are templates over each record's fields (`label`, and
 * `spoken.label` for a number the caller says), so they are options of their own, not text parts.
 */
export const RECORD_PARTS = textParts('record', {
  instructions: {
    template:
      'Read asr.text and node.promptJustPlayed. Which of these does the caller mean? They may name it by its number or by what the list says about it. Choose none only when they name none of these.',
    vars: [],
    about: 'The question that asks which record the caller means, sent to the model in place of the default.',
  },
  none: {
    template: 'Names none of these',
    vars: [],
    about: 'What the question\'s "none" label means: the caller names no record.',
  },
});

/** The question of a `record` slot: the slot's id followed by `Choice`, unless `ids.choice` says otherwise. */
export const RECORD_QUESTIONS = questionParts({ choice: 'which record the caller means' });

/** What each record's criterion says, unless `label` says otherwise. */
export const DEFAULT_LABEL = 'Number {key}';
/** What the criterion of a number the caller says says, unless `spoken.label` says otherwise. */
export const DEFAULT_SPOKEN_LABEL = 'Number {key}, as the caller said it';
/** The record field the slot's value is taken from, unless `key` says otherwise. */
export const DEFAULT_KEY = 'id';
/** What a key must be, unless `keyPattern` says otherwise: letters, digits, underscores and hyphens. */
export const DEFAULT_KEY_PATTERN = '[A-Za-z0-9_-]+';
/** What every label starts with, unless `labelPrefix` says otherwise. */
export const DEFAULT_LABEL_PREFIX = 'record_';
/** The invalid outcome's reason when the slot was asked for and nothing was chosen, unless `missReason` says otherwise. */
export const DEFAULT_MISS_REASON = 'no_match';
/** The thresholds `fillAt` may name: how sure the model must be of its choice. */
export const FILL_AT = ['SLOT_CHOICE_FILL', 'SLOT_CHOICE_CONFIRM'] as const;
/** The most keys a keypad rung collects. */
export const MAX_KEYPAD = 20;

const compiles = (source: string): boolean => {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
};

/** A label template, checked for its filters (its fields are the records', which only a turn knows). */
const labelTemplate = (what: string) =>
  questionText().describe(
    `${what} A template: {field} is the record's field of that name, {key} the record's key, and {field|day} formats an ISO date as a day ("Friday, September 18"). Nothing else is evaluated.`,
  );

export const recordOptions = z
  .strictObject({
    from: identifier()
      .optional()
      .describe('The list of records to choose among, by name: the app gives its lists by name from facts.forSlots ({ sources: { <name>: [...] } }), so two record slots can each read their own. Default: the app\'s one list (facts.forSlots records).'),
    key: identifier().default(DEFAULT_KEY).describe('The record field whose value the slot takes (a string or a number), and which the keypad and a spoken number give.'),
    keyPattern: questionText()
      .default(DEFAULT_KEY_PATTERN)
      .describe('A regular expression (its source, no slashes) the whole key must match, such as "\\d{4}" for four digits. A record whose key does not match is not offered, and a label or keys that do not match are no value. A key longer than 64 characters is never tried, and a group that repeats a repeat, such as (\\d+)+, is refused.'),
    labelPrefix: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/, { error: 'must start with a letter and use only letters, digits and underscores' })
      .default(DEFAULT_LABEL_PREFIX)
      .describe('What each label the model chooses starts with, before the key ("parcel_" gives parcel_4711). It keeps a key from being taken for the question\'s own "none".'),
    label: labelTemplate('The criterion the model is given for each record.').default(DEFAULT_LABEL),
    spoken: z
      .strictObject({
        digits: z.number().int().min(1).max(MAX_KEYPAD).describe('How many digits a number the caller says has.'),
        label: labelTemplate('The criterion the model is given for a number the caller says; {key} is the number.').default(DEFAULT_SPOKEN_LABEL),
        skipYearAfterMonth: z
          .boolean()
          .default(false)
          .describe('Whether a spoken year right after a month name ("March twenty twenty five") is a date rather than a number.'),
      })
      .optional()
      .describe('Numbers of `digits` digits the caller says (spoken or written) are offered too, after the records, even when no record has them, so a caller can name one that is not on their list. Default: off, only the records are offered.'),
    missReason: identifier()
      .default(DEFAULT_MISS_REASON)
      .describe('The reason of the invalid outcome when the slot was asked for and the caller chose nothing (or the model was not sure enough). Not asked for, that is absent.'),
    keypad: z
      .number()
      .int()
      .min(1)
      .max(MAX_KEYPAD)
      .optional()
      .describe('How many keys the caller keys the key with, after spoken answers missed; the keys are the value when they match keyPattern. Needs an ask_<slot>_dtmf line. Default: no keypad.'),
    disambiguate: z
      .boolean()
      .default(true)
      .describe('Whether two records the model cannot tell apart (the top two within SLOT_CHOICE_MARGIN) make the slot ask which one (disambiguate_<slot>, with {a} and {b}).'),
    fillAt: z
      .enum(FILL_AT)
      .default('SLOT_CHOICE_FILL')
      .describe('The threshold the model\'s probability for the record must reach for the slot to fill. Below SLOT_CHOICE_CONFIRM nothing was chosen.'),
    text: RECORD_PARTS.schema,
    ids: RECORD_QUESTIONS.schema.describe('Question ids in place of the default: `ids.choice` is the question\'s id (default: the slot\'s id followed by "Choice"), to keep the id an existing slot used.'),
  })
  .superRefine((o, ctx) => {
    if (!compiles(o.keyPattern)) {
      ctx.addIssue({
        code: 'custom',
        path: ['keyPattern'],
        message: `"${o.keyPattern}" is not a regular expression`,
        params: { fix: 'write the source of a regular expression without slashes, such as "\\d{4}"' },
      });
    }
    if (compiles(o.keyPattern) && repeatsARepeat(o.keyPattern)) {
      ctx.addIssue({
        code: 'custom',
        path: ['keyPattern'],
        message: `"${o.keyPattern}" repeats a group that itself repeats (as (\\d+)+ does), which can take minutes to refuse a key that almost matches`,
        params: { fix: 'write it without the repeat inside the repeat, such as "\\d+5" for "(\\d+)+5"' },
      });
    }
    const labels: [string, string, readonly string[] | undefined][] = [['label', o.label, undefined]];
    if (o.spoken) labels.push(['spoken.label', o.spoken.label, ['key']]);
    for (const [path, template, only] of labels) {
      for (const problem of checkLabelTemplate(template, only)) {
        ctx.addIssue({
          code: 'custom',
          path: path.split('.'),
          message: problem,
          params: { fix: only ? 'use {key}, the number said, with or without a filter' : `use {field} or {field|filter}; the filters are ${Object.keys(LABEL_FILTERS).join(', ')}` },
        });
      }
    }
  });

export type RecordOptions = z.output<typeof recordOptions>;
