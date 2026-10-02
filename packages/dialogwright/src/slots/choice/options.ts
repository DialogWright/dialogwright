import { z } from 'zod';
import { placeholdersOf } from '../parts/template';
import { questionParts, questionText, textParts } from '../parts/text';

/** The question id of a choice slot's one question: the slot's id unless `ids.choice` says otherwise. */
export const CHOICE_QUESTIONS = questionParts({ choice: 'which of the options the caller names' });

/** What the question says to the model, unless `text.instructions` says otherwise. */
export const DEFAULT_INSTRUCTIONS = 'Read asr.text. Which of these does the caller name?';
/** What each option's criterion says, unless `means` or the option's own `means` says otherwise. */
export const DEFAULT_MEANS = 'The caller names {say}';
/** What the criterion of the `none` label says, unless `text.none` says otherwise. */
export const DEFAULT_NONE = 'Names none of these';

/**
 * The text parts of a `choice` slot: its question and the criterion of its `none` label, each
 * replaced word for word by `text.<part>`. The options' criteria are not text parts: each is the
 * option's own `means`, or the `means` template filled from the option, so they are options of
 * their own (as a record slot's `label` is).
 */
export const CHOICE_PARTS = textParts('choice', {
  instructions: { template: DEFAULT_INSTRUCTIONS, vars: [], about: 'The question that asks which option the caller names, sent to the model in place of the default.' },
  none: { template: DEFAULT_NONE, vars: [], about: 'What the question\'s "none" label means: the caller names no option.' },
});
/** The variables `means` may use: the option's key and what it says. */
export const MEANS_VARS = ['key', 'say'] as const;
/** The most options a keypad can choose among (the digits 1 to 9). */
export const MAX_KEYPAD_OPTIONS = 9;
/** The thresholds `fillAt` may name: how sure the model must be of its choice. */
export const FILL_AT = ['SLOT_CHOICE_FILL', 'SLOT_CHOICE_CONFIRM'] as const;

const OPTION_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

/** One option as an app writes it: what it says (a bare string), or what it says and means. */
const optionEntry = z.union([
  questionText(),
  z.strictObject({
    say: questionText().describe('The display: how a line, the summary and the model\'s turn state say the option ("an express delivery").'),
    means: questionText()
      .optional()
      .describe('What the model is told this option is: the text of its criterion, sent exactly as written. Default: the slot\'s `means` template.'),
  }),
]);

/** One option, as parsed: always `say`, and `means` only when the option writes its own. */
export interface ChoiceOption {
  say: string;
  means?: string;
}

export const choiceOptions = z
  .strictObject({
    options: z
      .record(z.string(), optionEntry)
      .transform((entries): Record<string, ChoiceOption> =>
        Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, typeof entry === 'string' ? { say: entry } : { say: entry.say, ...(entry.means !== undefined ? { means: entry.means } : {}) }])),
      )
      .describe('The options the caller can choose, in order, as `key: Say` or `key: { say, means }`. The key is the value the slot takes and the label the model chooses; `say` is how it is said; the order is the order of the keypad (1, 2, 3, ...) and of the labels the model is offered.'),
    means: questionText()
      .default(DEFAULT_MEANS)
      .describe('The criterion the model is given for each option that has no `means` of its own, as a template over `{say}` and `{key}`.'),
    text: CHOICE_PARTS.schema,
    keypad: z.boolean().default(false).describe('Whether the caller can key the option, by its position (1 for the first), after spoken answers missed. At most 9 options. Needs an ask_<slot>_dtmf line.'),
    fillAt: z
      .enum(FILL_AT)
      .default('SLOT_CHOICE_FILL')
      .describe('The threshold the model\'s probability for the option must reach for the slot to fill; below it the slot stays empty.'),
    confirm: z
      .enum(['summary'])
      .default('summary')
      .describe('"summary": a chosen option is neither acknowledged nor read back on its own; the form\'s final confirm covers it.'),
    ids: CHOICE_QUESTIONS.schema.describe('Question ids in place of the default: `ids.choice` is the question\'s id (default: the slot\'s own id), to keep the id an existing slot used.'),
  })
  .superRefine((o, ctx) => {
    const keys = Object.keys(o.options);
    if (keys.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'a choice slot needs at least one option',
        params: { fix: 'add an option, such as "standard: Standard delivery"' },
      });
    }
    for (const key of keys) {
      if (key === 'none') {
        ctx.addIssue({
          code: 'custom',
          path: ['options', key],
          message: '"none" is the label the model chooses when the caller names no option, so an option cannot be called that',
          params: { fix: 'rename the option; set the criterion of "none" with `text.none`' },
        });
      } else if (!OPTION_KEY.test(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['options', key],
          message: `the option key "${key}" is not valid: it must start with a letter and use only letters, digits and underscores`,
          params: { fix: 'rename it using only letters, digits and underscores, starting with a letter (for example "next_day")' },
        });
      }
    }
    const unknown = placeholdersOf(o.means).filter((name) => !(MEANS_VARS as readonly string[]).includes(name));
    if (unknown.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['means'],
        message: `means uses ${unknown.map((v) => `{${v}}`).join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not one of its variables`,
        params: { fix: 'use {say} (what the option says) and {key} (its key), or write the criterion on the option itself' },
      });
    }
    if (o.keypad && keys.length > MAX_KEYPAD_OPTIONS) {
      ctx.addIssue({
        code: 'custom',
        path: ['keypad'],
        message: `keypad is true, but the slot has ${keys.length} options and the keypad has the digits 1 to ${MAX_KEYPAD_OPTIONS}`,
        params: { fix: `set keypad: false, or keep ${MAX_KEYPAD_OPTIONS} options or fewer` },
      });
    }
  });

export type ChoiceOptions = z.output<typeof choiceOptions>;
