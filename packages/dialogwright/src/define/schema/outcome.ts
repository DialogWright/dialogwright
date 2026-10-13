import { z } from 'zod';
import { checkAlways, identifier, name } from './common';
import type { Outcome } from '../../core/app/types';
import { CHECK_THEN, MAX_ATTEMPTS_SHORT, OUTCOME_THEN, SLOT_ATTEMPTS_MAX, SLOT_ATTEMPTS_MIN } from '../../core/slots/types';

/**
 * An outcome: what follows when a form's check refuses (forms.yaml `checks[].on`) or a slot runs out
 * of attempts (slots.yaml `onMaxAttempts`). One shape and one validator for both, so the two read and
 * act the same (core/outcome.ts runs them):
 * - `end`: `say` (required), then the call ends, the goodbye after the line unless `goodbye: false`
 *   (with a request queued, the call goes on to it);
 * - `anything-else`: `say` (required), the form closes uncompleted, and the call carries on;
 * - `handoff`: to a person, with the handoff line handoff_<reason>, after `say` if there is one;
 * - `form`: the form closes uncompleted and `form` is entered, as a `next:` is (the slots both list are
 *   kept), after `say` if there is one;
 * - `skip` (a slot's only): the slot is left empty and declined, and the form goes on, after `say`.
 */

export { CHECK_THEN, MAX_ATTEMPTS_SHORT, OUTCOME_THEN, SLOT_ATTEMPTS_MAX, SLOT_ATTEMPTS_MIN };
export type OutcomeThen = (typeof OUTCOME_THEN)[number];
export type CheckThen = (typeof CHECK_THEN)[number];

const THEN_WORDS: Record<OutcomeThen, string> = {
  end: 'end (the call ends after the line; with a request queued, the call goes on to it)',
  'anything-else': 'anything-else (the form closes uncompleted and the call carries on: the next queued request, or "anything else?")',
  handoff: 'handoff (to a person, with the handoff line handoff_<reason>)',
  form: 'form (the form closes uncompleted and the form named by `form` is entered, as a next: is, keeping the slots both list)',
  skip: 'skip (the slot is left empty and declined, and the form goes on to its next question)',
};

/** What `goodbye:` means on an ending outcome, as the JSON Schema and an editor say it (routes.yaml's too). */
export const GOODBYE_DESCRIPTION =
  'For then: end, whether the app\'s goodbye line follows `say`. false: the call ends on `say` alone, for a line that says goodbye itself ("... We\'re closed right now. Goodbye."), so the caller does not hear goodbye twice. Default true: the goodbye follows the line.';

/** What `then` says, for the thens an outcome of this kind takes. */
const thenDescription = (thens: readonly OutcomeThen[]): string => `What follows the line: ${thens.map((t) => THEN_WORDS[t]).join('; ')}.`;

/** The fields every outcome has, for the thens it takes. */
function outcomeFields<T extends readonly [OutcomeThen, ...OutcomeThen[]]>(thens: T) {
  return {
    say: identifier()
      .optional()
      .describe('The line said (a prompt in prompts.yaml); it renders with the form\'s slot displays as variables, as the summary does. Required for end and anything-else; for the others, said first.'),
    then: z.enum(thens).describe(thenDescription(thens)),
    reason: name()
      .optional()
      .describe('For then: handoff, the handoff reason, whose line is handoff_<reason>.'),
    form: identifier()
      .optional()
      .describe('For then: form, the form entered: a form in forms.yaml (an internal one too).'),
    goodbye: z
      .boolean()
      .optional()
      .describe(GOODBYE_DESCRIPTION),
  };
}

/** The rules every outcome is held to, whichever thens it takes. */
export const outcomeRules = checkAlways((value, ctx) => {
  const outcome = value as { say?: unknown; then?: unknown; reason?: unknown; form?: unknown; goodbye?: unknown } | null;
  if (typeof outcome !== 'object' || outcome === null || Array.isArray(outcome)) return;
  if ((outcome.then === 'end' || outcome.then === 'anything-else') && outcome.say === undefined) {
    ctx.addIssue({ code: 'custom', path: [], message: `then: ${outcome.then} says a line first, and this outcome names none`, params: { fix: 'add "say: <a prompt id in prompts.yaml>" with the line the caller hears' } });
  }
  if (outcome.reason !== undefined && outcome.then !== 'handoff') {
    ctx.addIssue({ code: 'custom', path: ['reason'], message: 'a reason names the handoff line, and this outcome does not hand off', params: { fix: 'delete "reason", or write "then: handoff"' } });
  }
  if (outcome.then === 'form' && outcome.form === undefined) {
    ctx.addIssue({ code: 'custom', path: [], message: 'then: form enters another form, and this outcome names none', params: { fix: 'add "form: <a form id in forms.yaml>"' } });
  }
  if (outcome.form !== undefined && outcome.then !== 'form') {
    ctx.addIssue({ code: 'custom', path: ['form'], message: 'a form is entered only by then: form, and this outcome does something else', params: { fix: 'delete "form", or write "then: form"' } });
  }
  goodbyeRule(outcome, ctx, ['goodbye'], 'outcome');
});

/**
 * `goodbye:` is the call's end's alone: on any other `then` the call does not end there, and no goodbye
 * is said for it to leave out. Shared with routes.yaml's outcomes.
 */
export function goodbyeRule(o: { then?: unknown; goodbye?: unknown }, ctx: z.core.$RefinementCtx, path: (string | number)[], what: 'outcome' | 'route'): void {
  if (o.goodbye !== undefined && o.then !== 'end') {
    ctx.addIssue({ code: 'custom', path, message: `goodbye says whether the goodbye follows the line a call ends on, and this ${what} does not end the call (then: ${String(o.then)})`, params: { fix: 'delete "goodbye", or write "then: end"' } });
  }
}

/** A check's outcome (forms.yaml `checks[].on.<reason>`): an outcome with its read-back, `confirm`. */
export const checkOutcomeSchema = z
  .strictObject({
    confirm: identifier()
      .optional()
      .describe('A yes-or-no line (a prompt in prompts.yaml) said before the refusal acts, when a slot the check reads has not been confirmed; it renders with the form\'s slot displays as variables, as `say` does. A yes confirms them and the refusal acts; a no empties them and asks again, and the check runs again when they fill. Skipped when every slot it reads is confirmed already (a read-back, or the summary\'s yes). Default: none, the refusal acts at once.'),
    ...outcomeFields(CHECK_THEN),
    reason: name()
      .optional()
      .describe('For then: handoff, the handoff reason, whose line is handoff_<reason>. Default: the reason the gate gave.'),
  })
  .check(outcomeRules)
  .describe('What a refusal for this reason does: a line, and how the form ends.');

/** A slot's outcome when it runs out of attempts, written out (slots.yaml `onMaxAttempts: { ... }`). */
export const slotOutcomeSchema = z
  .strictObject({
    ...outcomeFields(OUTCOME_THEN),
    reason: name()
      .optional()
      .describe('For then: handoff, the handoff reason, whose line is handoff_<reason>. Default: max-attempts.'),
  })
  .check(outcomeRules);

/** What `onMaxAttempts:` means, as the JSON Schema, the slot pages and an editor say it. */
export const ON_MAX_ATTEMPTS_DESCRIPTION =
  'What happens when the slot runs out of attempts (a missed answer, a silence, an unanswered read-back, or a second no to its read-back). ' +
  '"handoff" (the default): to a person, with handoff_max_attempts. "skip": the slot is left empty and declined, and the form goes on; never on an identity factor, nor on a slot its form\'s summary names. ' +
  'Or written out, { say, then, reason, form, goodbye }: then is handoff (reason names the handoff, default max-attempts), skip, end (say required; the call ends, the goodbye after the line unless goodbye: false), anything-else (say required; the form closes uncompleted and "anything else?" is asked) or form (the form closes uncompleted and `form` is entered, keeping the slots both list); say, a prompt said first. ' +
  'An offer of the caller\'s number with onNo: skip that runs out leaves the slot empty whatever this says; with no onNo: skip, the slot\'s ladder goes on to it.';

/** What `attempts:` means, as the JSON Schema, the slot pages and an editor say it. */
export const ATTEMPTS_DESCRIPTION =
  `How many failed answers the slot takes before onMaxAttempts, ${SLOT_ATTEMPTS_MIN} to ${SLOT_ATTEMPTS_MAX}. ` +
  'Each failure before the last but one re-asks: a missed answer with ask_<slot>_retry, or ask_<slot>_retry2 at the second failure (and so on) where prompts.yaml has it; a silence with ask_<slot>_noinput2 (and so on), else ask_<slot>_noinput, else no_input then the question (ask_<slot>) again (at the keypad rung of a slot that takes no keys, on a channel with a keypad, no_input then its retry line). ' +
  'The last but one is the keypad rung (ask_<slot>_dtmf) where the slot takes keys and the channel has a keypad, else another re-ask; the last runs onMaxAttempts. ' +
  'Default: the engine\'s MAX_ATTEMPTS (3).';

/** `attempts:` on one slot. */
export const slotAttemptsSchema = z
  .number({ error: `must be a whole number from ${SLOT_ATTEMPTS_MIN} to ${SLOT_ATTEMPTS_MAX}` })
  .int({ error: `must be a whole number from ${SLOT_ATTEMPTS_MIN} to ${SLOT_ATTEMPTS_MAX}` })
  .min(SLOT_ATTEMPTS_MIN, { error: `must be at least ${SLOT_ATTEMPTS_MIN}: a slot is asked at least once` })
  .max(SLOT_ATTEMPTS_MAX, { error: `must be at most ${SLOT_ATTEMPTS_MAX}: a caller asked more often than that is better helped another way` })
  .describe(ATTEMPTS_DESCRIPTION);

/** `onMaxAttempts:` on one slot: a short form, or the outcome written out. */
export const slotOnMaxAttemptsSchema = z.union([z.enum(MAX_ATTEMPTS_SHORT), slotOutcomeSchema]).describe(ON_MAX_ATTEMPTS_DESCRIPTION);

/** Either branch of `onMaxAttempts`, picked by the value's shape, so its problems name that branch alone (a union's would name both). */
const onMaxAttemptsParser = z.unknown().check(checkAlways((value, ctx) => {
  if (typeof value === 'string') {
    if ((MAX_ATTEMPTS_SHORT as readonly string[]).includes(value)) return;
    const long = (OUTCOME_THEN as readonly string[]).includes(value);
    ctx.addIssue({
      code: 'custom',
      path: [],
      message: long ? `"${value}" is written out, with what it needs (${value === 'form' ? 'the form entered' : 'the line said'})` : `"${value}" is not "handoff" or "skip"`,
      params: { fix: long ? (value === 'form' ? 'write { then: form, form: <a form id> }' : `write { say: <a prompt id>, then: ${value} }`) : 'write "handoff", "skip", or { say, then, reason, form } written out' },
    });
    return;
  }
  const parsed = slotOutcomeSchema.safeParse(value);
  if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ ...issue } as never);
}));

/** A slot's `onMaxAttempts` as written, checked: the short form or the outcome written out. */
export function parseOnMaxAttempts(value: unknown): { success: true; data: 'handoff' | 'skip' | Outcome } | { success: false; error: z.ZodError } {
  const checked = onMaxAttemptsParser.safeParse(value);
  if (!checked.success) return { success: false, error: checked.error };
  return { success: true, data: typeof value === 'string' ? (value as 'handoff' | 'skip') : outcomeFrom(slotOutcomeSchema.parse(value)) };
}

/**
 * An outcome as written (a parsed one, whose fields the validator above has held to its `then`) as the
 * engine's Outcome, discriminated on `then`: only a handoff keeps a `reason` and only `then: form` a
 * `form`. The keys keep the order they are written in, `say` first.
 */
export function outcomeFrom(o: { say?: string; then: OutcomeThen; reason?: string; form?: string; goodbye?: boolean }): Outcome {
  const say = o.say !== undefined ? { say: o.say } : {};
  switch (o.then) {
    case 'handoff':
      return { ...say, then: 'handoff', ...(o.reason !== undefined ? { reason: o.reason } : {}) };
    case 'form':
      if (o.form === undefined) throw new Error('then: form names no form (the outcome validator refuses this)');
      return { ...say, then: 'form', form: o.form };
    case 'skip':
      return { ...say, then: 'skip' };
    case 'end':
      // `goodbye: true` is the default written out: kept as absent, so the engine's outcome is as it was.
      return { ...say, then: 'end', ...(o.goodbye === false ? { goodbye: false as const } : {}) };
    default:
      return { ...say, then: o.then };
  }
}
