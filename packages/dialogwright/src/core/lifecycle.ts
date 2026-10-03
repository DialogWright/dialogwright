import { confirmationHash } from '../gate/policy';
import { raise } from '../gate/principal';
import { isAnonymous, isParty, type GateDecision, type GateFacts, type ToolCall } from '../gate/types';
import { codeLengthOf, formOf, gateOf, hasCode, identityOf, toolOf } from './app/lookup';
import { appOf } from './app/registry';
import type { AppContext, Completion, CompletionContext, FormId, Refused, VerifyOutcome } from './app/types';
import { emptySlot, type Session } from './session';
import { askSlot, handoff, prompt, type Decision, type PromptDecision } from './decision';
import type { Ack } from './fia';
import type { TurnContext } from './turn';
import { redactResult, redactedSummary, withheldFields } from './resultRedaction';
import { redactCall, registerScrub, scrubbedDecision, scrubberFor, scrubberOf } from './recording';

export { redactCall };

/**
 * The form lifecycle: every tool a turn reaches goes through `callTool`, and so through the gate.
 * Identity is not a form's slot list: a form's entry call is proposed, the gate answers STEP_UP,
 * and the factors it needs are asked for here; each factor's check is itself a gated call. What a
 * form's entry and completion do is the app's (App.forms); they reach tools only through `appContext`.
 */

export interface GateEvent {
  /** The gate's decision, carrying a redacted copy of the call (redactCall): the raw values stay inside evaluation. */
  decision: GateDecision;
  /** One line about what the tool returned, never PHI; null when the gate did not allow the call. */
  summary: string | null;
  /** The id of a record the tool created (a new case's number, say), for the audit. */
  ref?: string;
}

/** The knowledge-base passage an answer was read from, for the console. */
export interface KbSource {
  passageId: string; topic: string; plan: string; document: string; section: string; version: string;
  effectiveFrom: string; effectiveTo: string | null; approvedBy: string; approvedOn: string; fresh: boolean;
}

/**
 * A side effect the runner or the server performs after the turn; `resolve` stays pure. `service`:
 * ask one of the app's downstream services (App.services), whose answer runs as the call's next turn.
 */
export type Effect = { kind: 'service'; service: string; params: Readonly<Record<string, string>> };

/** Per-turn outputs beside the decision. Collected here, returned on TurnResult. */
export interface TurnOut {
  gateEvents: GateEvent[];
  kb: KbSource | null;
  effects: Effect[];
}

export function newTurnOut(): TurnOut {
  return { gateEvents: [], kb: null, effects: [] };
}

/**
 * The gate's answer, and the tool's value when it was allowed to run (null otherwise). What the
 * value is, is the app's: the engine reads only its identity tools' (VerifyOutcome, a boolean).
 * `redacted`: the fields of the value the policy withheld from the caller (each now null;
 * core/resultRedaction.ts), present only when it withheld any.
 */
export interface ToolOutcome {
  decision: GateDecision;
  value: unknown;
  redacted?: readonly string[];
}

const IGNORE: Decision = { kind: 'ignore' };

/**
 * Whether the session's caller is a party who is not one of the app's subjects (one who acts for
 * subjects, or any other kind): no identity check is theirs. An anonymous caller is not one: the
 * gate decides what they may do.
 */
function isOtherParty(s: Session, subjectKind: string): boolean {
  return !isAnonymous(s.principal) && s.principal.kind !== subjectKind;
}

/**
 * What the gate may know of the session for this call. The attempts are the ones the call's own
 * identity check has failed: the one-time code's for the app's code tool, the factors' for anything
 * else (the attempts rule runs only for the identity tools the app's rulesFor gives it to).
 */
function gateFacts(s: Session, call: ToolCall, tc: TurnContext): GateFacts {
  const attempts = call.tool === identityOf(appOf(s)).codeTool ? s.identityAttempts.code : s.identityAttempts.factors;
  return { attempts, confirmedHash: s.confirmedHash, todayIso: tc.todayIso };
}

/**
 * Runs a call the gate allowed: the app's tool, against the turn's systems. A tool the app does not
 * define never gets here (the gate's unlisted line blocks it), so one that does is a bug and throws.
 */
function runTool(s: Session, call: ToolCall, tc: TurnContext, out: TurnOut, code: string | undefined): { value: unknown; summary: string; ref?: string } {
  return toolOf(appOf(s), call.tool).run(call, tc.tools.sys, { s, tc, out, code });
}

/**
 * Purposes that mark a call as a probe: the gate is asked what it would say, and the tool is never
 * run, whatever the answer. 'retry-check' asks before another identity attempt (the attempts rule); 'entry-check'
 * asks whether the principal's role may make a form's write at all (the role rule) before any of its questions.
 */
const PROBES: ReadonlySet<string> = new Set(['retry-check', 'entry-check']);

/**
 * The gate's decision as it may leave the lifecycle: the raw call is evaluated by the app's gate (its
 * policy's named rules, gateOf), and only its redacted copy (redactCall) is carried on, into the
 * event, the trace and the audit, with its rules' lines masked the same way (a raw value of a param
 * recorded masked or never, replaced where a line repeats it; core/recording.ts). The scrub is kept
 * beside the decision for the summary and the tool's own audit rows.
 */
function evaluate(s: Session, call: ToolCall, tc: TurnContext): GateDecision {
  const app = appOf(s);
  const evaluated = gateOf(app).evaluate(call, s.principal, gateFacts(s, call, tc), tc.tools.lookups);
  const scrub = scrubberFor(app, call);
  const decision = scrubbedDecision({ ...evaluated, call: redactCall(app, call) }, scrub);
  if (scrub !== null) registerScrub(decision, scrub);
  return decision;
}

/**
 * The only way a turn reaches a tool: evaluate the gate, and on ALLOW run the tool, withhold from
 * its result what the policy keeps from this caller (policy.yaml `redact:`), and record a summary
 * (no PHI). Every gate decision is recorded, allowed or not, with the call redacted. A probe
 * (PROBES) is evaluated and recorded only: its tool never runs, even on ALLOW.
 *
 * `code` is the keypad one-time code for verifyCode. It travels beside the call, never in its
 * params, so it reaches neither the gate event nor the trace.
 */
export function callTool(s: Session, call: ToolCall, tc: TurnContext, out: TurnOut, code?: string): ToolOutcome {
  // Nothing past this line holds the raw call: the event, the trace and the audit see the redacted one.
  const decision = evaluate(s, call, tc);
  if (decision.verdict !== 'ALLOW' || (call.purpose !== undefined && PROBES.has(call.purpose))) {
    out.gateEvents.push({ decision, summary: null });
    return { decision, value: null };
  }
  const ran = runTool(s, call, tc, out, code);
  // Redaction per principal, the one place it happens: nothing past this line holds the whole
  // result. The hooks, the facts and the lines get the stripped value; the event (so the trace, the
  // console and the audit) gets the summary with what was withheld.
  const fields = withheldFields(appOf(s), s.principal, call.tool);
  const { value, redacted } = redactResult(call.tool, ran.value, fields);
  // The summary and the record it names are recorded beside the call, so they are masked as it is.
  const scrub = scrubberOf(decision);
  const said = scrub && typeof ran.summary === 'string' ? scrub(ran.summary) : ran.summary;
  const summary = redacted ? redactedSummary(said, fields) : said;
  const ref = scrub && typeof ran.ref === 'string' ? scrub(ran.ref) : ran.ref;
  out.gateEvents.push(ref === undefined ? { decision, summary } : { decision, summary, ref });
  return redacted ? { decision, value, redacted: fields } : { decision, value };
}

/**
 * Before asking the caller for another try at a factor, ask the gate whether that try would be
 * allowed (the attempts rule). A refusal is recorded, its call redacted like every other event's, so the console
 * shows why the call went to a person; its purpose 'retry-check' tells the audit this was a probe,
 * not an attempt the caller made.
 */
function retryAllowed(s: Session, tool: string, tc: TurnContext, out: TurnOut): boolean {
  const decision = evaluate(s, { tool, params: {}, purpose: 'retry-check' }, tc);
  if (decision.verdict === 'ALLOW') return true;
  out.gateEvents.push({ decision, summary: null });
  return false;
}

/**
 * A call to one of the app's identity tools (App.identity), named by the app: through callTool like
 * any other, with the value the engine reads from it (VerifyOutcome for the verify tool, a boolean for
 * the code tool).
 */
function identityCall<V>(s: Session, tool: string, params: Record<string, string>, tc: TurnContext, out: TurnOut, code?: string): { decision: GateDecision; value: V | null } {
  return callTool(s, { tool, params }, tc, out, code) as { decision: GateDecision; value: V | null };
}

/**
 * Level 2 needs the one-time code: text it to the phone on file, through the gate, then ask for it.
 * Once per call: asking again (after a silence, say) reminds the caller of the text already sent. A
 * `reissue` (the code was said aloud, so it is exposed) always texts a new one. A ladder of one rung
 * has no code to send: nothing there needs level 2 (validateApp), so asking for one goes to a person.
 */
export function sendCodeAndAsk(s: Session, tc: TurnContext, out: TurnOut, acks: Ack[], reissue = false): Decision {
  const identity = identityOf(appOf(s));
  // Only one of the app's subjects is ever sent a code (the gate refuses any other party the identity
  // tools, gate/compiled.ts subjectOnlyDecision); no flow asks for one for such a party, and should
  // one, a person takes the call before anything is texted.
  if (isOtherParty(s, identity.subjectKind)) return handoff(s, 'needs-human', acks);
  if (!hasCode(identity)) return handoff(s, 'needs-human', acks);
  if (!s.codeSent || reissue) {
    const { sendCodeTool, sendCodeParams } = identity;
    const { decision, value } = identityCall<unknown>(s, sendCodeTool, sendCodeParams?.(s) ?? {}, tc, out);
    if (decision.verdict !== 'ALLOW' || value === null) return handoff(s, 'needs-human', acks);
    s.codeSent = true;
  }
  return reissue ? prompt('otp_spoken_reissued', 'otp', {}, acks) : askCode(s, acks);
}

/** "I've texted a six-digit code to the phone ending in 4212." (the app's line says the code's length). Only one of the app's subjects is ever asked for one. */
export function askCode(s: Session, acks: Ack[]): PromptDecision {
  const phoneLast4 = isAnonymous(s.principal) ? '' : s.principal.contact?.phoneLast4 ?? '';
  return prompt('ask_otp', 'otp', { phoneLast4 }, acks);
}

/**
 * What a refused call says, by the gate's reason and who asked (App.blockPromptId), or null when
 * there is no line for it (the caller then goes to a person).
 */
export function blockAck(s: Session, reason: string | undefined): Ack | null {
  const promptId = appOf(s).blockPromptId?.(reason, s.principal) ?? null;
  return promptId === null ? null : { promptId, vars: {} };
}

/**
 * A web chat customer proves who they are by signing in to the portal, never by typing their account
 * ID and birth date into a chat: while a request waits on identity, it waits for that sign-in
 * (the `signed_in` event). True for an anonymous chat session with a parked entry call, in an app
 * that takes a sign-in (identity.yaml's `signIn`, IdentityConfig.signInLevel): an app without one
 * ignores the event, so there is nothing to wait for (signInImpossible).
 */
export function awaitingSignIn(s: Session): boolean {
  return s.caps.signIn && identityOf(appOf(s)).signInLevel !== undefined && isAnonymous(s.principal) && s.stepUp !== null;
}

/**
 * A chat caller who needs identity in an app that takes no sign-in: the factors are never asked on
 * a channel that signs callers in, and the app ignores the sign-in, so no step-up can be finished
 * here, and a person takes the call.
 */
function signInImpossible(s: Session): boolean {
  return s.caps.signIn && identityOf(appOf(s)).signInLevel === undefined && isAnonymous(s.principal) && s.stepUp !== null;
}

/**
 * The next thing a step-up needs: an identity factor still missing, their check once both are in,
 * or, at level 1 with level 2 needed, the keypad code. On a web chat, the portal sign-in instead.
 */
function nextFactor(s: Session, tc: TurnContext, out: TurnOut, acks: Ack[]): Decision | Refused | null {
  if (awaitingSignIn(s)) {
    const again = s.lastPromptId === 'signin_required' || s.lastPromptId === 'signin_reminder';
    return prompt(again ? 'signin_reminder' : 'signin_required', 'intent', {}, acks);
  }
  if (signInImpossible(s)) return handoff(s, 'needs-human', acks);
  if (isAnonymous(s.principal)) {
    const missing = identityOf(appOf(s)).factorSlots.find((id) => s.slots[id]!.value === null);
    if (missing) return askSlot(s, missing, s.slots[missing]!.window, acks);
    // Verified to the level needed: the entry call is retried, now with the customer's own ID.
    return verifyFactors(s, tc, out, acks) ?? ensureEntry(s, tc, out, acks);
  }
  return sendCodeAndAsk(s, tc, out, acks);
}

/**
 * Called by continueForm before it asks a business slot. Returns null when the form may proceed
 * (its entry call has passed the gate and its facts are loaded), or what to do instead: the
 * Decision to speak (the next identity factor for a step-up, or a NEEDS_HUMAN handoff), or
 * `refused` with the BLOCK line, which continueForm finishes like a completion that did not complete.
 *
 * `acks` is the turn's acks so far, and it is written to: verifyFactors and handleCodeDigit push
 * their own acks into it ("Thanks, Alex.", "Thank you, you're verified."), so the caller passes a
 * copy it means to speak from. While a step-up is pending the gate is not asked again: it said
 * what it needs when the step-up began, and the entry call is retried once the factors are verified.
 */
export function ensureEntry(s: Session, tc: TurnContext, out: TurnOut, acks: Ack[]): Decision | Refused | null {
  const form = s.form;
  if (form === null || s.entered === form) return null;
  if (s.stepUp) return nextFactor(s, tc, out, acks);
  const app = appOf(s);
  const def = formOf(app, form);
  if (!def.entry) {
    // A form with no entry call is entered as it starts: there is nothing to ask the gate.
    s.entered = form;
    return null;
  }
  if (!isAnonymous(s.principal) && s.principal.kind !== identityOf(app).subjectKind && def.principalEntry) {
    // Someone acting for the app's subjects: the entry call is a subject's own, so it is not made,
    // and the form's principalEntry says whether the form may go on. A form without one makes its
    // entry call as for anyone else, and the gate decides.
    const instead = def.principalEntry({ ...appContext(s, tc, out), acks });
    if (instead) return instead;
    s.entered = form;
    return null;
  }
  const call = def.entry(s);
  const { decision, value } = callTool(s, call, tc, out);
  switch (decision.verdict) {
    case 'ALLOW':
      def.onEntry?.(s, value);
      s.entered = form;
      return null;
    case 'STEP_UP':
      // An app without identity has no factors to ask: validateApp keeps every tool at level 0, so
      // only an app's own rule can get here, and it fails closed, to a person.
      if (!app.identity) return handoff(s, 'needs-human', acks);
      s.stepUp = { call, need: decision.needLevel === 2 ? 2 : 1 };
      return nextFactor(s, tc, out, acks);
    case 'BLOCK': {
      const ack = blockAck(s, decision.reason);
      if (!ack) return handoff(s, 'needs-human', acks);
      return { kind: 'refused', acks: [...acks, ack] };
    }
    case 'NEEDS_HUMAN':
      return handoff(s, decision.reason === 'attempts' ? 'identity' : 'needs-human', acks);
  }
}

/**
 * Once the identity factors are all filled during a step-up: the app's verify tool through the gate. Pushes
 * `identity_verified` into `acks` on a match. Returns
 * null when the caller is now verified to the level the step-up needs (the entry call is then
 * retried), or the Decision to speak: the keypad code, another try, or a person.
 */
export function verifyFactors(s: Session, tc: TurnContext, out: TurnOut, acks: Ack[]): Decision | null {
  const { factorSlots, verifyTool, failedPromptId, subjectKind } = identityOf(appOf(s));
  const params = Object.fromEntries(factorSlots.map((id) => [id, s.slots[id]!.value ?? '']));
  const { decision, value } = identityCall<VerifyOutcome>(s, verifyTool, params, tc, out);
  if (decision.verdict === 'NEEDS_HUMAN') return handoff(s, 'identity', acks);
  if (decision.verdict !== 'ALLOW' || value === null || value === undefined) return handoff(s, 'needs-human', acks);
  if (value.ok === true) {
    // The factors prove the app's subject to level 1, never more and never anyone else: a verify
    // tool that says otherwise (or hands back something that is not a proven party) is not believed,
    // and the caller goes to a person.
    if (!isParty(value.principal) || value.principal.kind !== subjectKind || value.principal.level !== 1) return handoff(s, 'needs-human', acks);
    s.principal = value.principal;
    acks.push({ promptId: 'identity_verified', vars: { first: value.principal.first } });
    if (s.stepUp?.need === 2) return sendCodeAndAsk(s, tc, out, acks);
    s.stepUp = null;
    return null;
  }
  // No match: every factor is asked again from the first, keeping what each has cost.
  s.identityAttempts.factors += 1;
  for (const id of factorSlots) {
    const st = s.slots[id]!;
    Object.assign(st, emptySlot(), { attempts: st.attempts });
  }
  if (!retryAllowed(s, verifyTool, tc, out)) return handoff(s, 'identity', acks);
  return askSlot(s, factorSlots[0]!, null, [...acks, { promptId: failedPromptId ?? 'identity_failed', vars: {} }]);
}

/**
 * A keypad digit while promptedFor === 'otp': buffer to the code's length (codeLengthOf, 6 unless
 * identity.yaml says otherwise), then the app's code tool through the gate.
 * Returns `ignore` while collecting, null once the code is accepted (the caller is level 2 and the
 * entry call is retried; `otp_verified` is pushed into `acks`), or the Decision to speak.
 *
 * The buffer is cleared before the check, and the code goes to the verifier beside the call, never
 * in its params: it is in no gate event, trace, slot or model request.
 */
export function handleCodeDigit(s: Session, digit: string, tc: TurnContext, out: TurnOut, acks: Ack[]): Decision | null {
  const app = appOf(s);
  // A code is only ever a subject's to key (as sendCodeAndAsk): anyone else goes to a person.
  if (isOtherParty(s, identityOf(app).subjectKind)) {
    s.dtmfBuffer = '';
    return handoff(s, 'needs-human', acks);
  }
  if (!/^\d$/.test(digit)) return IGNORE;
  s.dtmfBuffer += digit;
  if (s.dtmfBuffer.length < codeLengthOf(app)) return IGNORE;
  const code = s.dtmfBuffer;
  s.dtmfBuffer = '';
  const identity = identityOf(app);
  if (!hasCode(identity)) return handoff(s, 'needs-human', acks);
  const { codeTool } = identity;
  const { decision, value } = identityCall<boolean>(s, codeTool, {}, tc, out, code);
  if (decision.verdict === 'NEEDS_HUMAN') return handoff(s, 'identity', acks);
  if (decision.verdict !== 'ALLOW') return handoff(s, 'needs-human', acks);
  if (value === true) {
    // The principal verified to level 1 is raised in place: no read of the subject's record outside the gate.
    const raised = raise(s.principal, 2, identity.subjectKind);
    if (!raised) return handoff(s, 'needs-human', acks);
    s.principal = raised;
    s.stepUp = null;
    s.codeReasks = 0;
    acks.push({ promptId: 'otp_verified', vars: {} });
    return null;
  }
  s.identityAttempts.code += 1;
  if (!retryAllowed(s, codeTool, tc, out)) return handoff(s, 'identity', acks);
  return prompt('otp_failed', 'otp', {}, acks);
}

/** A call the gate did not allow: its line where there is one, a person where there is not. */
function refusal(s: Session, decision: GateDecision, acks: Ack[]): Completion {
  const ack = decision.verdict === 'BLOCK' ? blockAck(s, decision.reason) : null;
  if (ack) return { kind: 'refused', acks: [...acks, ack] };
  return { kind: 'decision', decision: handoff(s, 'needs-human', acks) };
}

/**
 * Called each time a form's summary is spoken: the hash of exactly what it read back, which the
 * caller's yes arms (the confirmed rule). Only a form with confirmedParams (a confirmed write) holds one.
 */
export function takeSummaryHash(s: Session, form: FormId): void {
  const app = appOf(s);
  const params = formOf(app, form).confirmedParams?.(s);
  s.pendingHash = params ? confirmationHash(params, app.policy.confirmedFields) : null;
}

/**
 * What an app hook gets for this turn (App, FormDef): the session, the turn and its output, and
 * callTool bound to them. The only way an app's code reaches a tool.
 */
export function appContext(s: Session, tc: TurnContext, out: TurnOut): AppContext {
  return { s, tc, out, callTool: (call) => callTool(s, call, tc, out) };
}

/** A completion's context: an AppContext with the turn's acks so far, and refusal bound to them. */
function completionContext(s: Session, tc: TurnContext, out: TurnOut, acks: Ack[]): CompletionContext {
  return { ...appContext(s, tc, out), acks, refusal: (decision) => refusal(s, decision, acks) };
}

/** A full, confirmed form's completion: the app's answer for the form, through the gate. */
export function completion(s: Session, form: FormId, acks: Ack[], tc: TurnContext, out: TurnOut): Completion {
  return formOf(appOf(s), form).complete(completionContext(s, tc, out, acks));
}
