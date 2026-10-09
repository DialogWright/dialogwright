import { confirmationHash } from '../gate/policy';
import type { GateDecision } from '../gate/types';
import { formOf, identityOf } from './app/lookup';
import { appOf } from './app/registry';
import type { CheckOutcome, FormCheck, FormId, ToolName } from './app/types';
import { blockAck, callTool, type TurnOut } from './lifecycle';
import type { Ack } from './fia';
import type { Session } from './session';
import type { TurnContext } from './turn';

/**
 * A form's checks (forms.yaml `checks`, FormDef.checks): actions the gate decides on part-way through
 * the form, so an answer that rules the caller out ends the form before the rest is asked. Each check
 * names a `check: true` action of the policy and the form's slots it reads (`with`, each sent as the
 * param of the same name). A check is ready when every slot it reads holds a value; a ready check runs
 * when the params differ from the ones it last passed with (Session.checked keeps their hash), so it
 * runs once its slots are filled and again whenever one of them changes, and an unchanged yes at the
 * summary asks the gate nothing. They run in the order written, after the entry call and before the
 * next question (turn.ts continueForm), and again first thing at completion (completeForm); the first
 * refusal ends the form with the outcome its reason maps to (`on`). An outcome with `confirm` reads the
 * refusal back first, when a slot the check reads is not confirmed (turn.ts stopForm): a yes acts on
 * it as written, a no empties those slots to be asked again.
 *
 * A check is a call through the gate like any other (lifecycle.ts callTool): recorded as a gate event,
 * masked as every call is, and, since a check action has no tool, nothing runs on its ALLOW. Checks ask
 * the model nothing.
 */

/** What a form's checks made of this turn: all that were ready passed, or the first refusal. */
export type ChecksRun =
  | {
    kind: 'passed';
    /** The form's checksPassed line, when this run is the one that passed the last of its checks: said once per form. */
    passedPromptId: string | null;
  }
  | { kind: 'refused'; check: FormCheck; decision: GateDecision; hash: string }
  /**
   * A check that waits on nothing but an identity factor it reads (`with: [dob]`), empty until the
   * caller is verified: the form loop asks for identity for it (turn.ts stopForm), so a form never
   * completes with a check that never ran.
   */
  | { kind: 'identity'; check: FormCheck };

const NOTHING: ChecksRun = { kind: 'passed', passedPromptId: null };

/** The params a check sends, or null while one of the slots it reads is empty (it is not ready). */
function paramsOf(s: Session, check: FormCheck): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (const id of check.with) {
    const value = s.slots[id]?.value ?? null;
    if (value === null) return null;
    params[id] = value;
  }
  return params;
}

/**
 * The hash of the params `check` sends as the slots stand (what Session.checked keeps of a pass, and a
 * check's pending read-back of its refusal), or null while one of the slots it reads is empty.
 */
export function checkHash(s: Session, check: FormCheck): string | null {
  const params = paramsOf(s, check);
  return params === null ? null : confirmationHash(params, check.with);
}

/**
 * Whether `check` is not ready only because an identity factor it reads is empty: every other slot
 * it reads holds a value. It is never ready until the caller is verified (the factors are filled by
 * verification), so it must not be left to wait.
 */
function waitsOnIdentity(s: Session, check: FormCheck): boolean {
  const factors = identityOf(appOf(s)).factorSlots;
  const empty = check.with.filter((id) => (s.slots[id]?.value ?? null) === null);
  return empty.length > 0 && empty.every((id) => factors.includes(id));
}

/**
 * The checks that run in `form`: its own, after those of the forms it was reached through by `next`
 * on this call (Session.via, earliest first) that read only slots `form` lists too and that `form`
 * does not list itself, so a value the screen checked and the booking changes ("no, it's in
 * Lakeview" at the booking's summary) is checked again, with the screen's own outcome. For a form
 * reached any other way, exactly its own.
 */
export function checksOf(s: Session, form: FormId): readonly FormCheck[] {
  const app = appOf(s);
  const def = formOf(app, form);
  const own = def.checks ?? [];
  if (s.form !== form || s.via === undefined) return own;
  const listed = new Set(own.map((c) => c.action));
  const earlier: FormCheck[] = [];
  for (const before of s.via) {
    for (const check of formOf(app, before).checks ?? []) {
      if (listed.has(check.action) || !check.with.every((id) => def.slots.includes(id))) continue;
      listed.add(check.action);
      earlier.push(check);
    }
  }
  return earlier.length === 0 ? own : [...earlier, ...own];
}

/** Whether every check of the form has passed, with whatever params (Session.checked). */
function allPassed(s: Session, checks: readonly FormCheck[]): boolean {
  return checks.every((c) => s.checked !== undefined && Object.hasOwn(s.checked, c.action));
}

/**
 * Runs the open form's ready checks whose params changed since they last passed, in order, through
 * the gate. Each that passes is kept (Session.checked); the first refusal stops the run. With none
 * refused, the first check that waits only on an identity factor (waitsOnIdentity) is returned for the
 * form loop to ask for identity. A form without checks runs nothing and changes nothing.
 */
export function runChecks(s: Session, form: FormId, tc: TurnContext, out: TurnOut): ChecksRun {
  const def = formOf(appOf(s), form);
  const checks = checksOf(s, form);
  if (checks.length === 0) return NOTHING;
  const before = allPassed(s, checks);
  let waiting: FormCheck | null = null;
  for (const check of checks) {
    const params = paramsOf(s, check);
    if (params === null) {
      if (waiting === null && waitsOnIdentity(s, check)) waiting = check;
      continue;
    }
    const hash = confirmationHash(params, check.with);
    if (s.checked?.[check.action] === hash) continue;
    const { decision } = callTool(s, { tool: check.action, params }, tc, out);
    if (decision.verdict !== 'ALLOW') return { kind: 'refused', check, decision, hash };
    s.checked = { ...(s.checked ?? {}), [check.action]: hash };
  }
  if (waiting !== null) return { kind: 'identity', check: waiting };
  const passedPromptId = def.checksPassed !== undefined && !before && allPassed(s, checks) ? def.checksPassed : null;
  return { kind: 'passed', passedPromptId };
}

/** The audit's record of a form a check ended (the `form_stopped` row, core/audit.ts). */
export interface FormStopped {
  form: FormId;
  action: ToolName;
  /** The gate's reason; null when it gave none (a STEP_UP). */
  reason: string | null;
  then: CheckOutcome['then'];
  /** The refusal was read back first (the outcome's `confirm`) and the caller said yes. Absent otherwise. */
  confirmed?: true;
}

/**
 * The audit's record of a check's read-back the caller said no to (the `check_reconfirmed` row): the
 * slots it reads were emptied to be asked again, so an auditor sees the deciding answer corrected.
 */
export interface CheckReconfirmed {
  form: FormId;
  action: ToolName;
  reason: string;
}

/**
 * The outcome `on` gives a refusal's reason, or null for a reason it does not list and for a
 * STEP_UP, which never takes one (checkEnding).
 */
export function outcomeOf(check: FormCheck, decision: Pick<GateDecision, 'verdict' | 'reason'>): CheckOutcome | null {
  const reason = decision.reason;
  return decision.verdict !== 'STEP_UP' && reason !== undefined && check.on !== undefined && Object.hasOwn(check.on, reason) ? check.on[reason]! : null;
}

/**
 * How a check's refusal ends the form:
 * - `end`: the line (`say`) is said, then the call ends (or goes on to a queued request);
 * - `anything-else`: the lines are said and the form closes uncounted, the call carrying on;
 * - `handoff`: to a person, for `reason`, after the lines.
 * `acks` are the turn's acks with the outcome's own line last, except for `end`, whose line is `line`.
 */
export type CheckEnding =
  | { then: 'end'; acks: Ack[]; line: Ack }
  | { then: 'anything-else'; acks: Ack[] }
  | { then: 'handoff'; reason: string; acks: Ack[] };

/**
 * The ending a check's refusal maps to: the outcome `on` gives the gate's reason, or, for a reason it
 * does not list, what a completion's refusal gives (CompletionContext.refusal): a BLOCK with a line
 * from the app's blockPromptId says it and carries on, anything else goes to a person. A STEP_UP gets
 * here only in an app without identity, and goes to a person whatever `on` says: in an app with
 * identity, a check's STEP_UP asks for it instead (turn.ts stopForm), and the check runs again once the
 * caller is verified. `vars` are the variables the outcome's line renders with: the form's slot displays.
 */
export function checkEnding(s: Session, check: FormCheck, decision: Pick<GateDecision, 'verdict' | 'reason'>, acks: Ack[], vars: Record<string, string>): CheckEnding {
  const reason = decision.reason;
  const outcome = outcomeOf(check, decision);
  if (outcome === null) {
    const ack = decision.verdict === 'BLOCK' ? blockAck(s, reason) : null;
    if (ack) return { then: 'anything-else', acks: [...acks, ack] };
    return { then: 'handoff', reason: 'needs-human', acks };
  }
  const said: Ack[] = outcome.say === undefined ? [] : [{ promptId: outcome.say, vars }];
  switch (outcome.then) {
    case 'end':
      return { then: 'end', acks, line: said[0]! };
    case 'anything-else':
      return { then: 'anything-else', acks: [...acks, ...said] };
    case 'handoff':
      return { then: 'handoff', reason: outcome.reason ?? reason!, acks: [...acks, ...said] };
  }
}
