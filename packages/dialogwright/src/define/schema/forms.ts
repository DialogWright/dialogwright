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
      .optional()
      .describe(
        'The code hooks this form uses, written in the app\'s TypeScript; "complete" is required, unless the form `answers` from the knowledge base (its completion is then the engine\'s). ' +
          'entry (the call made before the slots are asked), onEntry (applies its result), principalEntry (in its place for someone acting for subjects), ' +
          'confirmedParams (the values a confirmed write sends, for the gate\'s confirmed rule), complete (runs when the form is full and confirmed), ' +
          'onAnswers (hears every spoken turn), onSummaryAnswer (moves along what the summary offers), keepsSlot (keeps a slot the caller named when changing), ' +
          'onSummaryRead (looks at what the summary is about to name).',
      ),
    answers: z
      .strictObject({
        slot: identifier().describe('The form\'s topic slot: its value is the topic the caller asked about.'),
        via: identifier()
          .optional()
          .describe('The gated action that resolves the answer (a tool in the code, with an action in policy.yaml, returning an answer or why there is none). Default: kb/kb.yaml\'s action.'),
        answer: identifier().optional().describe('The prompt the answer is said through; its text says {answer}. Default: kb_answer.'),
        unavailable: identifier().optional().describe('The prompt said when there is no answer to give, before a person is offered. Default: kb_unavailable.'),
      })
      .optional()
      .describe(
        'The form says an answer from the knowledge base, and its completion is the engine\'s: the answer resolved through the gate for the topic in `slot`, ' +
          'said word for word with the topic\'s account line where it has one, or the unavailable line and a person offered, once per call. ' +
          'A form with `answers` has no "complete" hook.',
      ),
    calls: unique(identifier(), 'action')
      .optional()
      .describe(
        'The actions (tools) this form\'s hooks call through the gate: its entry call and the calls its completion makes. ' +
          'Declare it for every form or for none (an empty list for a form that calls nothing): the app map draws each form to its actions, ' +
          'and `check` reports an action that no form reaches and the identity flow does not call.',
      ),
  })
  .check(checkAlways((value, ctx) => {
    const form = value as { hooks?: unknown; answers?: unknown } | null;
    if (typeof form !== 'object' || form === null || Array.isArray(form)) return;
    const hooks = Array.isArray(form.hooks) ? form.hooks : [];
    const answers = form.answers !== undefined;
    if (!answers && !hooks.includes('complete')) {
      ctx.addIssue({
        code: 'custom',
        path: form.hooks === undefined ? [] : ['hooks'],
        message: 'every form needs a "complete" hook: it says what the form does once its slots are full',
        params: { fix: form.hooks === undefined ? 'add "hooks: [complete]" and write the function in the app\'s code, or "answers:" for a form that says an answer from the knowledge base' : 'add "complete" to the list and write the function in the app\'s code' },
      });
    }
    if (answers && hooks.includes('complete')) {
      ctx.addIssue({
        code: 'custom',
        path: ['hooks', hooks.indexOf('complete')],
        message: 'this form answers from the knowledge base, so its completion is the engine\'s, and it has a "complete" hook too',
        params: { fix: 'delete "complete" from hooks (and the function from the code), or delete "answers" to complete the form in code' },
      });
    }
  }))
  .describe('One form: the slots it collects, the summary it reads back, the code hooks it uses (or the knowledge answer it says), and the actions it calls.');

export const formsSchema = z
  .strictObject({
    forms: z
      .record(identifier(), form, { error: 'must be a map from form id to its definition' })
      .describe('Every form, by id. Each id must also be a form intent in intents.yaml.'),
  })
  .describe('forms.yaml: the forms the app runs.');

export type FormsYaml = z.infer<typeof formsSchema>;
export type FormYaml = FormsYaml['forms'][string];
