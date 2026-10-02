import { z } from 'zod';
import { identifier, matching } from '../../define/schema/common';
import { placeholdersOf } from '../parts/template';
import { questionParts, questionText, textParts } from '../parts/text';

/**
 * The questions of a choice slot, by part: `choice` (which option; its id is the slot's own unless
 * `ids.choice` says otherwise), and with the advanced options `hedge` (is the caller unsure;
 * `<slot>Hedge`) and `help` (what the caller says instead of naming one; `<slot>Help`).
 */
export const CHOICE_QUESTIONS = questionParts({
  choice: 'which of the options the caller names',
  hedge: 'whether the caller is unsure which option they mean',
  help: 'what the caller says about the question without naming an option',
});

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

/** The text parts of the `hedge` question (`hedge.text`): a yes-or-no, is the caller unsure which option they mean? */
export const HEDGE_PARTS = textParts('choice', {
  instructions: {
    template: 'Read asr.text. Is the caller unsure which one they mean?',
    vars: [],
    about: 'The question that asks whether the caller is unsure which option they mean.',
  },
  true: {
    template: 'The caller hedges about which one they mean, as in it might be this one, or offers two for one, as in this one or that one, I am not sure',
    vars: [],
    about: 'What a yes means: the caller hedges.',
  },
  false: {
    template: 'The caller names one plainly, or names none. A caller correcting themselves, as in this one, not that one, is sure',
    vars: [],
    about: 'What a no means: the caller is sure, or names nothing.',
  },
});

/** The text part of the `help` question (`help.text`): what the caller says without naming an option. */
export const HELP_PARTS = textParts('choice', {
  instructions: {
    template: 'Read asr.text and node.promptJustPlayed. Do they answer the question without naming one of the options?',
    vars: [],
    about: 'The question that asks what the caller says about the question without naming an option; its labels are `help.labels`.',
  },
});

/** How the model's numbers are compared for a choice slot's own thresholds: a threshold's name, as the engine or the app's app.yaml has it. */
export const thresholdName = () =>
  matching(
    /^[A-Z][A-Z0-9_]*$/,
    'is not a threshold name: it must be upper case letters, digits and underscores, starting with a letter',
    'name a threshold the engine has (SLOT_HELP) or one under thresholds in app.yaml (PROVIDER_UNSURE)',
  );

/** One label of the `help` question: what the model is told it means, and the line it leads to (none: no help). */
export interface ChoiceHelpLabel {
  means: string;
  prompt?: string;
}
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

const helpLabel = z.strictObject({
  means: questionText().describe('What the model is told this label is: the text of its criterion, sent exactly as written.'),
  prompt: identifier()
    .optional()
    .describe('The line said when the model chooses this label (a help outcome). None: the label asks for no help (the slot is absent).'),
});

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
      .enum(['summary', 'by-confidence'])
      .default('summary')
      .describe('"summary": a chosen option is neither acknowledged nor read back on its own; the form\'s final confirm covers it. "by-confidence": it is acknowledged (ack_<slot>, given the option\'s display as {<slot>}) when `readBack` says so, and always when the caller hedged (`hedge`).'),
    readBack: z
      .enum(['implicit', 'below-fill', 'none'])
      .optional()
      .describe('With `confirm: by-confidence`, what a chosen option asks for: "implicit" (always acknowledged; the default), "below-fill" (only when the model is less sure of it than SLOT_CHOICE_FILL), "none" (never, unless the caller hedged).'),
    disambiguate: z
      .enum(['margin'])
      .optional()
      .describe('"margin": the slot reads the model\'s probability for every label, not only its pick, and when a second option is within SLOT_CHOICE_MARGIN of the top one (or, while the caller hedges, reaches SLOT_CHOICE_CONFIRM) it asks which of the two (disambiguate_<slot>, given {a} and {b}). The top option must then reach SLOT_CHOICE_CONFIRM before anything else is read. Default: off.'),
    hedge: z
      .strictObject({
        threshold: thresholdName().describe('The threshold the model\'s yes must reach for the caller to count as unsure: an engine threshold, or one of the app\'s own (app.yaml thresholds), read from the turn by name.'),
        byName: z
          .boolean()
          .default(false)
          .describe('While the caller hedges, ask which of two when their words name another option as a whole word (its key, underscores as spaces, case aside), though the model put its weight on one.'),
        text: HEDGE_PARTS.schema,
      })
      .optional()
      .describe('A second question, a yes-or-no: is the caller unsure which option they mean? A hedged option is read back however sure the model is (with `confirm: by-confidence`); with `disambiguate`, a hedged rival that reaches SLOT_CHOICE_CONFIRM is asked about. Its id is `ids.hedge` (default: <slot>Hedge).'),
    help: z
      .strictObject({
        threshold: thresholdName().default('SLOT_HELP').describe('The threshold the model\'s top label must reach to lead to its line.'),
        labels: z
          .record(z.string(), helpLabel)
          .describe('The labels of the help question, in order, as `label: { means, prompt? }`. The first must have no prompt: it is the answer that asks for no help, which a stub model chooses when nothing is said.'),
        text: HELP_PARTS.schema,
      })
      .optional()
      .describe('A third question, asked on every turn: what does the caller say without naming an option ("I do not know the name")? When no option is chosen and the model\'s top label reaches `threshold` and has a prompt, the slot asks for help with that line (a help outcome) instead of being absent. Its id is `ids.help` (default: <slot>Help).'),
    ids: CHOICE_QUESTIONS.schema.describe('Question ids in place of the defaults: `ids.choice` is the question\'s id (default: the slot\'s own id), `ids.hedge` and `ids.help` those of the hedge and help questions (default: <slot>Hedge, <slot>Help), to keep the ids an existing slot used.'),
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
    if (o.readBack !== undefined && o.confirm === 'summary') {
      ctx.addIssue({
        code: 'custom',
        path: ['readBack'],
        message: `readBack "${o.readBack}" has no effect with confirm "summary", which neither acknowledges nor reads back a chosen option`,
        params: { fix: 'set confirm: by-confidence, or delete readBack' },
      });
    }
    if (o.help) {
      const labels = Object.entries(o.help.labels);
      for (const [label] of labels) {
        if (!OPTION_KEY.test(label)) {
          ctx.addIssue({
            code: 'custom',
            path: ['help', 'labels', label],
            message: `the help label "${label}" is not valid: it must start with a letter and use only letters, digits and underscores`,
            params: { fix: 'rename it using only letters, digits and underscores, starting with a letter (for example "no_name")' },
          });
        }
      }
      if (labels.length === 0 || labels[0]![1].prompt !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['help', 'labels'],
          message: 'the first help label must have no prompt: it is the answer that asks for no help, which a stub model chooses when nothing is said',
          params: { fix: 'put first a label such as "neither: { means: Names one, or says nothing about it }"' },
        });
      }
      if (!labels.some(([, l]) => l.prompt !== undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: ['help', 'labels'],
          message: 'no help label has a prompt, so the help question could never lead to a line',
          params: { fix: 'give a label a prompt, such as "no_name: { means: ..., prompt: <slot>_list }"' },
        });
      }
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
