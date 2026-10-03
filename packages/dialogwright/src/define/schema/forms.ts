import { z } from 'zod';
import { checkAlways, identifier, unique } from './common';

/**
 * forms.yaml: the forms (tasks that collect slots and then act). Mirrors App.forms (FormDef): the
 * data fields are here; the hooks are TypeScript, and a form declares which it has so `defineApp`
 * can check the code supplies exactly those.
 */

/** The FormDef hooks an app writes in TypeScript, in the order the contract documents them. */
export const FORM_HOOKS = [
  'entry',
  'onEntry',
  'principalEntry',
  'confirmedParams',
  'complete',
  'onAnswers',
  'onSummaryAnswer',
  'keepsSlot',
  'onSummaryRead',
] as const;
export type FormHook = (typeof FORM_HOOKS)[number];

const form = z
  .strictObject({
    slots: unique(identifier(), 'slot').describe("The form's business slots, in prompt priority order. Each is a slot the app's code defines."),
    summaryPromptId: identifier()
      .nullable()
      .describe('The prompt (an id in prompts.yaml) that reads the filled form back for a yes, or null for a form with no summary (it completes as soon as its slots are full).'),
    hooks: unique(z.enum(FORM_HOOKS), 'hook')
      .describe(
        'The code hooks this form uses, written in the app\'s TypeScript; "complete" is required. ' +
          'entry (the call made before the slots are asked), onEntry (applies its result), principalEntry (in its place for someone acting for subjects), ' +
          'confirmedParams (the values a confirmed write sends, for the gate\'s R3), complete (runs when the form is full and confirmed), ' +
          'onAnswers (hears every spoken turn), onSummaryAnswer (moves along what the summary offers), keepsSlot (keeps a slot the caller named when changing), ' +
          'onSummaryRead (looks at what the summary is about to name).',
      )
      .check(checkAlways((hooks, ctx) => {
        if (!Array.isArray(hooks)) return;
        if (!hooks.includes('complete')) {
          ctx.addIssue({
            code: 'custom',
            path: [],
            message: 'every form needs a "complete" hook: it says what the form does once its slots are full',
            params: { fix: 'add "complete" to the list and write the function in the app\'s code' },
          });
        }
      })),
    calls: unique(identifier(), 'action')
      .optional()
      .describe(
        'The actions (tools) this form\'s hooks call through the gate: its entry call and the calls its completion makes. ' +
          'Declare it for every form or for none (an empty list for a form that calls nothing): the app map draws each form to its actions, ' +
          'and `check` reports an action that no form reaches and the identity flow does not call.',
      ),
  })
  .describe('One form: the slots it collects, the summary it reads back, the code hooks it uses, and the actions it calls.');

export const formsSchema = z
  .strictObject({
    forms: z
      .record(identifier(), form, { error: 'must be a map from form id to its definition' })
      .describe('Every form, by id. Each id must also be a form intent in intents.yaml.'),
  })
  .describe('forms.yaml: the forms the app runs.');

export type FormsYaml = z.infer<typeof formsSchema>;
export type FormYaml = FormsYaml['forms'][string];
