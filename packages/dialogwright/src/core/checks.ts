import { confirmationHash } from '../gate/policy';
import type { GateDecision } from '../gate/types';
import { formOf } from './app/lookup';
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
 * refusal ends the form with the outcome its reason maps to (`on`).
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
  | { kind: 'refused'; check: FormCheck; decision: GateDecision };

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

/** Whether every check of the form has passed, with whatever params (Session.checked). */
function allPassed(s: Session, checks: readonly FormCheck[]): boolean {
  return checks.every((c) => s.checked !== undefined && Object.hasOwn(s.checked, c.action));
}

/**
 * Runs the open form's ready checks whose params changed since they last passed, in order, through
 * the gate. Each that passes is kept (Session.checked); the first refusal stops the run. A form
 * without checks runs nothing and changes nothing.
 */
export function runChecks(s: Session, form: FormId, tc: TurnContext, out: TurnOut): ChecksRun {
  const def = formOf(appOf(s), form);
  const checks = def.checks ?? [];
  if (checks.length === 0) return NOTHING;
  const before = allPassed(s, checks);
  for (const check of checks) {
    const params = paramsOf(s, check);
    if (params === null) continue;
    const hash = confirmationHash(params, check.with);
    if (s.checked?.[check.action] === hash) continue;
    const { decision } = callTool(s, { tool: check.action, params }, tc, out);
    if (decision.verdict !== 'ALLOW') return { kind: 'refused', check, decision };
    s.checked = { ...(s.checked ?? {}), [check.action]: hash };
  }
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
 * from the app's blockPromptId says it and carries on, anything else goes to a person. A STEP_UP goes
 * to a person whatever `on` says: a check never asks for identity (the entry call does that first).
 * `vars` are the variables the outcome's line renders with: the form's slot displays.
 */
export function checkEnding(s: Session, check: FormCheck, decision: GateDecision, acks: Ack[], vars: Record<string, string>): CheckEnding {
  const reason = decision.reason;
  const outcome = decision.verdict !== 'STEP_UP' && reason !== undefined && check.on !== undefined && Object.hasOwn(check.on, reason) ? check.on[reason]! : null;
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
