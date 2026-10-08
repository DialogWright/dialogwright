import { z } from 'zod';
import { checkAlways, identifier, name, unique } from './common';

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

/** How a form ends when a check refuses for a reason (forms.yaml `checks[].on`). */
export const CHECK_THEN = ['end', 'anything-else', 'handoff'] as const;
export type CheckThen = (typeof CHECK_THEN)[number];

const checkOutcome = z
  .strictObject({
    confirm: identifier()
      .optional()
      .describe('A yes-or-no line (a prompt in prompts.yaml) said before the refusal acts, when a slot the check reads has not been confirmed; it renders with the form\'s slot displays as variables, as `say` does. A yes confirms them and the refusal acts; a no empties them and asks again, and the check runs again when they fill. Skipped when every slot it reads is confirmed already (a read-back, or the summary\'s yes). Default: none, the refusal acts at once.'),
    say: identifier()
      .optional()
      .describe('The line said (a prompt in prompts.yaml); it renders with the form\'s slot displays as variables, as the summary does. Required for end and anything-else; for handoff, said before the handoff line.'),
    then: z
      .enum(CHECK_THEN)
      .describe('What follows the line: end (the call ends, the goodbye after it; with a request queued, the call goes on to it), anything-else (the form closes uncounted and the call carries on: the next queued request, or "anything else?"), or handoff (to a person, with the handoff line handoff_<reason>).'),
    reason: name()
      .optional()
      .describe('For then: handoff, the handoff reason, whose line is handoff_<reason>. Default: the reason the gate gave.'),
  })
  .check(checkAlways((value, ctx) => {
    const outcome = value as { say?: unknown; then?: unknown; reason?: unknown } | null;
    if (typeof outcome !== 'object' || outcome === null || Array.isArray(outcome)) return;
    if ((outcome.then === 'end' || outcome.then === 'anything-else') && outcome.say === undefined) {
      ctx.addIssue({ code: 'custom', path: [], message: `then: ${outcome.then} says a line first, and this outcome names none`, params: { fix: 'add "say: <a prompt id in prompts.yaml>" with the line the caller hears' } });
    }
    if (outcome.reason !== undefined && outcome.then !== 'handoff') {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'a reason names the handoff line, and this outcome does not hand off', params: { fix: 'delete "reason", or write "then: handoff"' } });
    }
  }))
  .describe('What a refusal for this reason does: a line, and how the form ends.');

const check = z
  .strictObject({
    action: identifier().describe('The action the gate decides on: an action in policy.yaml with check: true (no tool runs; the gate only answers).'),
    with: unique(identifier(), 'slot')
      .min(1, { error: 'must name at least one slot' })
      .describe('The form\'s slots the check reads, each sent as the param of the same name. The check runs once every one of them holds a value, and again whenever one of them changes.'),
    on: z
      .record(name(), checkOutcome)
      .optional()
      .describe('A refusal reason (the gate\'s reason) mapped to its line and how the form ends. A reason not listed gets the engine\'s refusal: a BLOCK with a line from the app\'s blockPromptId says it and the call carries on; anything else goes to a person. A STEP_UP always goes to a person.'),
  })
  .describe('One check: an action the gate decides on as soon as the slots it reads are filled.');

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
          'and `check` reports an action that no form reaches and the identity flow does not call. A check action is reached through `checks`, not listed here.',
      ),
    checks: z
      .array(check)
      .optional()
      .describe(
        'Actions the gate decides on part-way through the form, in the order written: each runs as soon as the slots it reads are filled (after the entry call, before the next question, and again at completion), and again whenever one of them changes. ' +
          'ALLOW lets the form go on; a refusal ends the form with the line and the ending `on` maps its reason to. Checks ask the model nothing.',
      ),
    checksPassed: identifier()
      .optional()
      .describe('A line said once, on the turn every check of the form has passed (never again after a correction). It renders with the form\'s slot displays as variables. Only with checks.'),
  })
  .check(checkAlways((value, ctx) => {
    const form = value as { hooks?: unknown; answers?: unknown; checks?: unknown; checksPassed?: unknown } | null;
    if (typeof form !== 'object' || form === null || Array.isArray(form)) return;
    const checks = Array.isArray(form.checks) ? form.checks : [];
    if (form.checksPassed !== undefined && checks.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['checksPassed'], message: 'the form has no checks, so checksPassed is never said', params: { fix: 'delete "checksPassed", or add "checks:" to the form' } });
    }
    const seen = new Set<string>();
    checks.forEach((c: unknown, i) => {
      const action = typeof c === 'object' && c !== null ? (c as { action?: unknown }).action : undefined;
      if (typeof action !== 'string') return;
      if (seen.has(action)) ctx.addIssue({ code: 'custom', path: ['checks', i, 'action'], message: `the check "${action}" is listed twice`, params: { fix: 'delete one of the two: a check runs once per change of what it reads' } });
      seen.add(action);
    });
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
