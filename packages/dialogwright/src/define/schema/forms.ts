import { z } from 'zod';
import { checkAlways, identifier, name, text, unique } from './common';
import { checkOutcomeSchema } from './outcome';

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

/** How a form ends when a check refuses for a reason (forms.yaml `checks[].on`): the outcome's `then` (./outcome.ts). */
export { CHECK_THEN, type CheckThen } from './outcome';

const check = z
  .strictObject({
    action: identifier().describe('The action the gate decides on: an action in policy.yaml with check: true (no tool runs; the gate only answers).'),
    with: unique(identifier(), 'slot')
      .min(1, { error: 'must name at least one slot' })
      .describe('The form\'s slots the check reads, each sent as the param of the same name. The check runs once every one of them holds a value, and again whenever one of them changes. An identity factor may be named too (check warns): it holds a value only once the caller has given it during verification.'),
    on: z
      .record(name(), checkOutcomeSchema)
      .optional()
      .describe('A refusal reason (the gate\'s reason) mapped to its line and how the form ends. A reason not listed gets the engine\'s refusal: a BLOCK with a line from the app\'s blockPromptId says it and the call carries on; anything else goes to a person. A STEP_UP asks for identity, as an entry call\'s does, and the check runs again once the caller is verified (in an app without identity.yaml, it goes to a person).'),
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
        'The code hooks this form uses, written in the app\'s TypeScript; "complete" is required, unless the form `answers` from the knowledge base (its completion is then the engine\'s) or goes on to a `next` form (its completion is then that form). ' +
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
        subject: identifier()
          .optional()
          .describe(
            'A slot of this form that names the subject the answer is about, for a caller who is not one of the app\'s subjects (a delegate acting for them, asked it with the slot\'s askedOf): its value goes to the resolving action and an account line\'s tool as the subject param, and the gate\'s scope rule decides whether this caller may read that subject\'s answer. A subject is always answered about themselves. ' +
              'Default: none, and a caller who is not a subject is answered about no one (the scope rule refuses).',
          ),
        documents: z
          .strictObject({
            answer: identifier().optional().describe('The prompt an answer from documents is said through: its text says {answer}, the fallback (what onFail says), and its {answer} is a span generated `from: sections`. Default: kb_documents_answer.'),
            onFail: z
              .enum(['not-found', 'opening'])
              .optional()
              .describe('What is said when an answer from documents cannot be worded (a check fails, the wording is late or errs, or no model is configured): not-found (the default), the not-found line (kb_not_found, in turn through its variants; else the unavailable line); opening, the first sentences of the best section, word for word, in the kb_documents_opening frame where the app has it.'),
          })
          .optional()
          .describe('With kb.yaml documents: summarize on, how an answer drawn from sections of approved documents is said, where no topic answers. Default: kb_documents_answer, and the not-found line when it cannot be worded.'),
        midTask: z
          .enum(['aside', 'task'])
          .optional()
          .describe(
            'What asking for this form while another is open does to that form. aside (the default): the form in hand is set aside as it stands, the answer is said, and the form resumes where it was (its question, or its summary or confirmation asked again), ' +
              'whether the caller replaced the task with the question or added it; the topic said with the question is the one answered (the topic is asked in a second, small request on the same words). ' +
              'With no answer to give, the unavailable line is said and a person offered, once per call, as for an informational intent\'s passage; turned down, the form resumes. ' +
              'task: the form is a task like any other, as before this option: it replaces the form in hand or is queued after it, as the model reads the turn, and its topic is asked once it is open.',
          ),
      })
      .optional()
      .describe(
        'The form says an answer from the knowledge base, and its completion is the engine\'s: the answer resolved through the gate for the topic in `slot`, ' +
          'said word for word with the topic\'s account line where it has one (or, where the answer line frames its {answer} as a span `from: answer` and the topic is `risk: low`, the approved passage worded for the caller\'s question, the account line after it), or the unavailable line and a person offered, once per call. ' +
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
    next: identifier()
      .optional()
      .describe(
        'The form entered at once when this one completes (its complete hook answers `said`, or it has none, which `next` allows): the slots both forms list are kept, with their values and confirmations, and the next form is bridged into (bridge_next with its label), ahead of any request the caller queued. ' +
          'A completion that ends the call, a refusal, or a check that ends the form does not go on. Usually an internal form (a booking after a screen); it may be a form intent too.',
      ),
    internal: z
      .boolean()
      .optional()
      .describe('true: the form is not an intent. The model, the keypad menu and the queue never see it; it is reached only by another form\'s `next`, and it has no intent in intents.yaml. Needs a `label`. Default false.'),
    label: text()
      .optional()
      .describe('An internal form\'s spoken label ("book your free inspection"), as an intent\'s label is used: in bridge_next as {intentLabel}, and as the form the caller is in. Only on an internal form; a form intent\'s label is in intents.yaml.'),
    summary: z
      .strictObject({
        onNo: z
          .enum(['ask-change', 'read-back'])
          .optional()
          .describe(
            'What a bare no at the summary does (a no that changes nothing). ask-change (the default): "What should I change?" (ask_change), as always. read-back: the summary is read again word for word first, after read_back_exact (a line the app writes), never generated whatever its when says, and with no attempt counted; a second bare no goes on to ask_change, and the ladder continues as always. With read-back, asking to hear it again at ask_change reads the summary again, word for word.',
          ),
      })
      .optional()
      .describe('How the form\'s summary answers a caller who pushes back. Only on a form with a summary.'),
    wording: z
      .enum(['fixed', 'generative'])
      .optional()
      .describe(
        'How the form\'s lines are produced (generated wording). generative: each of its lines (its slots\' questions, ask_<slot> and their retry, no-input and partial lines, their read-backs, confirm_<slot>, and its summary) is generated as a prompt with mode: generative is, ' +
          'unless the line says mode: fixed or is prescribed (prescribed: true). A line without a goal of its own is worded to say what its fixed text says. Default fixed: every line word for word.',
      ),
    acknowledge: z
      .boolean({ error: 'must be true or false' })
      .optional()
      .describe(
        'With wording: generative: whether the lines its switch generates may begin by acknowledging what the caller just said. false: each only rewords its fixed line. Default true; a line\'s own `acknowledge` in prompts.yaml wins.',
      ),
    listenBeforeEntered: z
      .boolean()
      .optional()
      .describe(
        'Whether the form\'s slots fill from what the caller says before the form is open (on the turn that opens it, as `listen: up-front` does). ' +
          'false: a slot every form that lists it says false for behaves as `listen: form`, and is asked once its form is open, even when it was said earlier. A slot\'s own `listen` overrides it. ' +
          'Default true for a form intent, false for an internal form.',
      ),
  })
  .check(checkAlways((value, ctx) => {
    const form = value as { hooks?: unknown; answers?: unknown; checks?: unknown; checksPassed?: unknown; next?: unknown; internal?: unknown; label?: unknown } | null;
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
    if (form.internal === true && form.label === undefined) {
      ctx.addIssue({ code: 'custom', path: ['internal'], message: 'an internal form has no intent, so its label is its own, and this form names none', params: { fix: 'add "label: <what the caller is helped to do>" (for example "label: book your free inspection"), said as bridge_next\'s {intentLabel}' } });
    }
    if (form.internal !== true && form.label !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['label'], message: 'only an internal form has a label of its own: a form intent\'s label is in intents.yaml', params: { fix: 'delete "label", or write "internal: true" for a form reached only by another form\'s next' } });
    }
    const hooks = Array.isArray(form.hooks) ? form.hooks : [];
    const answers = form.answers !== undefined;
    // A form with `next` may have no complete hook: its completion is the next form.
    if (!answers && !hooks.includes('complete') && form.next === undefined) {
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
      .describe('Every form, by id. Each id must also be a form intent in intents.yaml, unless the form is internal (reached only by another form\'s next).'),
  })
  .describe('forms.yaml: the forms the app runs.');

export type FormsYaml = z.infer<typeof formsSchema>;
export type FormYaml = FormsYaml['forms'][string];

/**
 * locale/<tag>/forms.yaml: an internal form's spoken label in another locale (forms.yaml's `label`, said
 * as bridge_next's {intentLabel}), in the shape of forms.yaml (`forms:`, each with its `label`). Only an
 * internal form has a label of its own; a form intent's label in a locale is in locale/<tag>/intents.yaml.
 */
export const localeFormsSchema = z
  .strictObject({
    forms: z
      .record(
        identifier(),
        z
          .strictObject({
            label: text().describe('The internal form\'s spoken label in this locale ("preparar un plan de pago"), in place of forms.yaml\'s for a call in it.'),
          })
          .describe('One internal form, by its id in forms.yaml: its label in this locale.'),
      )
      .describe('The internal forms whose labels this locale says its own way, by id. A form left out is said by its label in forms.yaml.'),
  })
  .describe('locale/<tag>/forms.yaml: the internal forms\' spoken labels in this locale.');

/** A parsed locale/<tag>/forms.yaml. */
export type LocaleFormsYaml = z.infer<typeof localeFormsSchema>;
