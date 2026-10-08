import { confirmationHash } from '../gate/policy';
import { raise } from '../gate/principal';
import { isAnonymous, isParty, type GateDecision, type GateFacts, type ToolCall } from '../gate/types';
import { codeLengthOf, formOf, gateOf, hasCode, identityOf, isCheckAction, toolOf } from './app/lookup';
import { appOf } from './app/registry';
import type { AppContext, Completion, CompletionContext, FormId, Refused, SlotId, VerifyOutcome } from './app/types';
import { emptySlot, type Session } from './session';
import { askSlot, handoff, prompt, type Decision, type PromptDecision } from './decision';
import type { Ack } from './fia';
import type { TurnContext } from './turn';
import type { CheckReconfirmed, FormStopped } from './checks';
import { redactResult, redactedSummary, withheldFields } from './resultRedaction';
import { idempotencyKey } from './idempotency';
import { callerGateFacts } from './callerNumber';
import { bothScrubs, redactCall, registerScrub, scrubbedDecision, scrubberFor, scrubberOf, withheldScrubber, type Scrub } from './recording';

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

/**
 * The knowledge record: the passage an answer was read from (or withheld, when `fresh` is false),
 * as a turn reports it (TurnOut.kb). It is written to the trace, handed to a tool's audit hook
 * (ToolAuditInput.kb) and shown on the console's source card; it is never part of what the model
 * is asked, nor of a regression outcome. An app with a `kb/` folder builds it with `kbSourceOf`,
 * and records it with `kbAuditRow` (kb/record.ts).
 *
 * The hashes are short: the first 12 hex characters (KB_SHORT_HASH) of the SHA-256 digests the
 * approval recorded, enough to tell one approval from another in a trace or an audit row; the full
 * digests stay in the passage's own file.
 */
export interface KbSource {
  passageId: string;
  topic: string;
  version: string;
  /**
   * Who the passage answered: for each fact it depends on, the caller's value, as the gated tool
   * read it from the system of record (e.g. `{ card: 'junior' }`). Empty when it depends on none.
   */
  applies: Record<string, string>;
  /** The passage's language tag, where the app gives one. */
  locale?: string;
  /** The source document and section the answer was drawn from. */
  document: string;
  section: string;
  /** The days it is in force (ISO dates, both inclusive); no `effectiveTo`: open-ended. */
  effectiveFrom: string;
  effectiveTo?: string;
  /** Who approved it and on what day; absent when it has no approval. */
  approvedBy?: string;
  approvedOn?: string;
  /** The approval's digest of the source section's text, short (KB_SHORT_HASH hex characters). */
  sourceHash?: string;
  /** The approval's digest of everything it covers (kb/hash.ts approvalHashOf), short. */
  approvalHash?: string;
  /** Whether it may be said: approved, and nothing it was approved over has changed since. */
  fresh: boolean;
  /**
   * @deprecated Phase 6: one fact a passage depended on, from before `applies`. Use
   * `applies: { plan }` instead. Kept for one release so an app that still sets it compiles; the
   * engine never reads or shows it, and the next release removes it.
   */
  plan?: string;
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
  /** The form a check ended this turn (core/checks.ts), for the audit's `form_stopped` row. Absent on every other turn. */
  stopped?: FormStopped;
  /** The offer of the caller's number this turn settled (core/turn.ts), for the audit's `offer` row. Absent on every other turn. */
  offer?: OfferSettled;
  /** The check whose read-back the caller said no to this turn (core/turn.ts), for the audit's `check_reconfirmed` row. Absent on every other turn. */
  reconfirmed?: CheckReconfirmed;
  /**
   * What became of the caller-ID match this turn (identity.yaml's `callerId`), in order, for the
   * audit's `identity_caller_match` rows: asked (`offered`), then `verified`, `declined` or `failed`.
   * Absent on every other turn.
   */
  callerMatch?: CallerMatchOutcome[];
}

/** One step of the caller-ID match (TurnOut.callerMatch, Session.callerMatch). */
export type CallerMatchOutcome = 'offered' | 'verified' | 'declined' | 'failed';

/**
 * An offer settled: the number the caller is calling from (a slot's `callerNumber`), or a value
 * proposed from the facts (a slot's `offer: facts`). What was asked, as the line was said, and what
 * the caller answered. `yes`: the value offered; `no`: a no, with no value of their own; `other`: a
 * value of their own, said or keyed, with or without a no; `none`: no answer before the offer's retry
 * ladder ran out. The audit writes it as an `offer` row in the day's hash chain (core/audit.ts), with
 * how it was answered.
 */
export interface OfferSettled {
  readonly slot: SlotId;
  /** Where the value offered came from: the number the caller is calling from, or the app's facts. */
  readonly source: 'caller-number' | 'facts';
  readonly promptId: string;
  /**
   * The offer's line as rendered (the prompt manifest may change later). A value proposed from the
   * facts is written into it as the slot's value is recorded (its redact, else policy.yaml's `audit:`).
   */
  readonly said: string;
  readonly answer: 'yes' | 'no' | 'other' | 'none';
  /** The last four digits of the number offered, as the line said them; absent for a value from the facts. */
  readonly last4?: string;
  /** The language the line was said in. */
  readonly locale: string;
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
 * else (the attempts rule runs only for the identity tools the app's rulesFor gives it to). The
 * caller's number, where the session kept one, for the callerNumber rule (GateFacts.callerNumber).
 */
function gateFacts(s: Session, call: ToolCall, tc: TurnContext): GateFacts {
  const app = appOf(s);
  const attempts = call.tool === identityOf(app).codeTool ? s.identityAttempts.code : s.identityAttempts.factors;
  const facts = { attempts, confirmedHash: s.confirmedHash, todayIso: tc.todayIso };
  // The caller's number, only for a session that kept one (core/callerNumber.ts): every other
  // session's facts are as they were.
  return s.callerNumber === undefined ? facts : { ...facts, ...callerGateFacts(app, s.callerNumber) };
}

/**
 * Runs a call the gate allowed: the app's tool, against the turn's systems. A tool the app does not
 * define never gets here (the gate's unlisted line blocks it), so one that does is a bug and throws.
 */
function runTool(s: Session, call: ToolCall, tc: TurnContext, out: TurnOut, code: string | undefined): { value: unknown; summary: string; ref?: string } {
  const def = toolOf(appOf(s), call.tool);
  // A tool that writes is given its write's key (core/idempotency.ts); any other is called as it always was.
  return def.run(call, tc.tools.sys, def.idempotent === true ? { s, tc, out, code, idempotencyKey: idempotencyKey(s, call) } : { s, tc, out, code });
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
 * The reason a call the gate allowed is handed to a person when the tool's result cannot be withheld
 * from as the policy says (redactResult throws): the call ran and is recorded, its result goes nowhere.
 */
export const RESULT_UNREDACTABLE = 'result-unredactable';

/** How a call to a tool is made (callTool). */
export interface CallOptions {
  /** A tool that throws fails the call, recorded with TOOL_FAILED_SUMMARY, not the turn. Default false. */
  readonly failSoft?: boolean;
}

/** The summary recorded for a call made with `failSoft` whose tool threw: the error itself is never recorded. */
export const TOOL_FAILED_SUMMARY = 'the tool failed: nothing was returned';

/**
 * The only way a turn reaches a tool: evaluate the gate, and on ALLOW run the tool, withhold from
 * its result what the policy keeps from this caller (policy.yaml `redact:`), and record a summary
 * (no PHI). Every gate decision is recorded, allowed or not, with the call redacted. A probe
 * (PROBES) is evaluated and recorded only: its tool never runs, even on ALLOW. So is a form's check
 * (policy.yaml `check: true`), which has no tool: its ALLOW is recorded with no result.
 *
 * The summary and the record it names are masked as the call is (a raw value of a param recorded
 * masked or never) and as the result was (every text a withheld field held), and so are the params
 * of the side effects the tool queues as it runs, where they are recorded (the trace, the console),
 * never where they are sent. A result that cannot be
 * stripped as the policy says (a tool that declared fields its value does not have) never goes on:
 * the call that ran is still recorded, with a summary that says so, and its outcome is NEEDS_HUMAN
 * (RESULT_UNREDACTABLE), so the caller goes to a person.
 *
 * `code` is the keypad one-time code for verifyCode. It travels beside the call, never in its
 * params, so it reaches neither the gate event nor the trace.
 *
 * `opts.failSoft`: a tool that throws as it runs fails the call, not the turn (the call-start lookup,
 * core/turn.ts callerLookup, which must never keep the greeting from being said). The call is
 * recorded as allowed, with TOOL_FAILED_SUMMARY and nothing of the error (its message may hold a
 * param's raw value), the side effects it queued before it threw are dropped, and its value is null.
 * Without it, a throw goes up to the turn, as it always has.
 */
export function callTool(s: Session, call: ToolCall, tc: TurnContext, out: TurnOut, code?: string, opts: CallOptions = {}): ToolOutcome {
  // Nothing past this line holds the raw call: the event, the trace and the audit see the redacted one.
  const decision = evaluate(s, call, tc);
  // A form's check (policy.yaml `check: true`) has no tool: like a probe, the gate's answer is all there is.
  if (decision.verdict !== 'ALLOW' || (call.purpose !== undefined && PROBES.has(call.purpose)) || isCheckAction(appOf(s), call.tool)) {
    out.gateEvents.push({ decision, summary: null });
    return { decision, value: null };
  }
  // The side effects the tool queues as it runs: recorded with the call's scrub (recordedEffect), sent as they are.
  const effectsBefore = out.effects.length;
  let ran: ReturnType<typeof runTool>;
  try {
    ran = runTool(s, call, tc, out, code);
  } catch (err) {
    if (opts.failSoft !== true) throw err;
    out.effects.length = effectsBefore;
    out.gateEvents.push({ decision, summary: TOOL_FAILED_SUMMARY });
    return { decision, value: null };
  }
  // Redaction per principal, the one place it happens: nothing past this line holds the whole
  // result. The hooks, the facts and the lines get the stripped value; the event (so the trace, the
  // console and the audit) gets the summary with what was withheld.
  const fields = withheldFields(appOf(s), s.principal, call.tool);
  let stripped: ReturnType<typeof redactResult>;
  try {
    stripped = redactResult(call.tool, ran.value, fields);
  } catch {
    // The tool ran: its call is recorded, though nothing of what it returned is.
    scrubEffects(out, effectsBefore, scrubberOf(decision));
    out.gateEvents.push({ decision, summary: `result not recorded: the fields withheld from this caller (${fields.join(', ')}) could not be stripped from it` });
    return { decision: { ...decision, verdict: 'NEEDS_HUMAN', reason: RESULT_UNREDACTABLE }, value: null };
  }
  const { value, redacted, withheld } = stripped;
  // The summary and the record it names are recorded beside the call, so they are masked as it is, and as the result was.
  const scrub = bothScrubs(scrubberOf(decision), withheldScrubber(withheld));
  scrubEffects(out, effectsBefore, scrub);
  const said = scrub && typeof ran.summary === 'string' ? scrub(ran.summary) : ran.summary;
  const summary = redacted ? redactedSummary(said, fields) : said;
  const ref = scrub && typeof ran.ref === 'string' ? scrub(ran.ref) : ran.ref;
  out.gateEvents.push(ref === undefined ? { decision, summary } : { decision, summary, ref });
  return redacted ? { decision, value, redacted: fields } : { decision, value };
}

/** Registers `scrub` for the side effects queued since `from`, for their params as recorded (core/recording.ts recordedEffect). */
function scrubEffects(out: TurnOut, from: number, scrub: Scrub | null): void {
  if (scrub === null) return;
  for (const effect of out.effects.slice(from)) registerScrub(effect, scrub);
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

/** The caller-ID question (identity.yaml's `callerId`), said in place of the first factor it leaves to ask. */
export const CALLER_MATCH_PROMPT = 'identity_caller_match';

/**
 * The caller-ID match in force (identity.yaml's level 1 `callerId`, FactsConfig.callerMatch): the
 * value of each factor it identifies, or null when there is none to use. None for an app without
 * `callerId`, a caller already verified, a session with no number, a match set aside on this call
 * (a no or "different account", a failed check) or already used, one whose identifier the caller
 * said themselves, and when the app's hook finds no
 * single match: it returns null, leaves out a factor or gives one that is not a string with something
 * in it, or throws. Nothing of an error is kept, since its message may hold what the facts hold.
 */
export function callerMatchOf(s: Session): Readonly<Record<SlotId, string>> | null {
  const app = appOf(s);
  const callerId = app.identity?.callerId;
  const hook = app.facts?.callerMatch;
  if (callerId === undefined || hook === undefined || !isAnonymous(s.principal) || s.callerNumber === undefined) return null;
  if (s.callerMatch !== undefined && s.callerMatch !== 'offered') return null;
  // An identifier the caller said themselves ("my account is ...") is theirs to verify: the match does not replace it.
  if (callerId.identifies.some((id) => s.slots[id]?.value != null && s.slots[id]!.by !== 'caller-id')) return null;
  let found: Readonly<Record<SlotId, string>> | null;
  try {
    found = hook(s.facts);
  } catch {
    return null;
  }
  if (found === null || typeof found !== 'object') return null;
  const values: Record<SlotId, string> = {};
  for (const id of callerId.identifies) {
    const v: unknown = Object.hasOwn(found, id) ? found[id] : undefined;
    if (typeof v !== 'string' || v.trim() === '') return null;
    values[id] = v;
  }
  return values;
}

/** Records a step of the caller-ID match: on the session (Session.callerMatch) and for the turn's audit rows (TurnOut.callerMatch). */
export function noteCallerMatch(s: Session, out: TurnOut, outcome: CallerMatchOutcome): void {
  s.callerMatch = outcome;
  out.callerMatch = [...(out.callerMatch ?? []), outcome];
}

/**
 * The factors a step-up asks the caller for: every factor, or, with a caller-ID match in force
 * (callerMatchOf), those the match does not identify.
 */
function askedFactors(s: Session, match: Readonly<Record<SlotId, string>> | null): SlotId[] {
  const factors = identityOf(appOf(s)).factorSlots;
  return match === null ? [...factors] : factors.filter((id) => !Object.hasOwn(match, id));
}

/**
 * The caller-ID question: "I see an account associated with the number you're calling from. To
 * access it, please tell me your date of birth, or say different account." Asked for the first factor
 * the match leaves to ask, which reads the answer as its own, with no variables: the match is never
 * said. The first time it is asked on the call, the audit's `offered` row is written.
 */
export function askCallerMatch(s: Session, slot: SlotId, out: TurnOut, acks: Ack[]): PromptDecision {
  if (s.callerMatch !== 'offered') noteCallerMatch(s, out, 'offered');
  return prompt(CALLER_MATCH_PROMPT, slot, {}, acks);
}

/**
 * The next thing a step-up needs: an identity factor still missing, their check once both are in,
 * or, at level 1 with level 2 needed, the keypad code. On a web chat, the portal sign-in instead.
 * With a caller-ID match in force (identity.yaml's `callerId`), the factors it identifies are not
 * asked: the first factor left to ask is asked with the caller-ID question in place of its own
 * (unless it holds part of a value already), and once those are in, the identified ones are filled
 * from the match and the check runs as for factors said.
 */
function nextFactor(s: Session, tc: TurnContext, out: TurnOut, acks: Ack[]): Decision | Refused | null {
  if (awaitingSignIn(s)) {
    const again = s.lastPromptId === 'signin_required' || s.lastPromptId === 'signin_reminder';
    return prompt(again ? 'signin_reminder' : 'signin_required', 'intent', {}, acks);
  }
  if (signInImpossible(s)) return handoff(s, 'needs-human', acks);
  if (isAnonymous(s.principal)) {
    const match = callerMatchOf(s);
    const missing = askedFactors(s, match).find((id) => s.slots[id]!.value === null);
    if (missing) {
      const window = s.slots[missing]!.window;
      if (match !== null && window === null) return askCallerMatch(s, missing, out, acks);
      return askSlot(s, missing, window, acks);
    }
    if (match !== null) fillFromCallerMatch(s, match);
    // Verified to the level needed: the entry call is retried, now with the customer's own ID.
    return verifyFactors(s, tc, out, acks) ?? ensureEntry(s, tc, out, acks);
  }
  return sendCodeAndAsk(s, tc, out, acks);
}

/**
 * The factors the caller-ID match identifies, filled from it just before the check (SlotState.by
 * `caller-id`): the value only, never a display, so no line, prompt variable or model request says it,
 * and the trace masks the value as the slot's redact says, as it masks one said. The match is in use
 * (Session.callerMatch `offered`) whether or not the question was asked: a caller who gave the other
 * factors on the way in ("check my request, my birthday is ...") is checked with it.
 */
function fillFromCallerMatch(s: Session, match: Readonly<Record<SlotId, string>>): void {
  for (const [id, value] of Object.entries(match)) Object.assign(s.slots[id]!, { value, display: null, confirmed: false, window: null, by: 'caller-id' });
  s.callerMatch = 'offered';
}

/**
 * Identity asked for at the greeting (identity.yaml's `callerId` with `ask: greeting`), and what follows
 * it there with no form open: the next factor or the check, as a step-up would. Null once the caller is
 * verified (the open question follows); a request said instead ends it (core/turn.ts), and the factors
 * are asked again, if at all, when something needs them.
 */
export function continueIdentity(s: Session, tc: TurnContext, out: TurnOut, acks: Ack[]): Decision | null {
  return nextFactor(s, tc, out, acks) as Decision | null;
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
 * A step-up a check began (stepUp, from core/turn.ts stopForm) is pending with the form entered: it
 * goes on here too, and once it is done the form loop runs the check again.
 */
export function ensureEntry(s: Session, tc: TurnContext, out: TurnOut, acks: Ack[]): Decision | Refused | null {
  const form = s.form;
  if (form === null) return null;
  // A step-up waiting goes on first: the entry call's, or a check's once the form is entered (stepUp).
  if (s.stepUp) return nextFactor(s, tc, out, acks);
  if (s.entered === form) return null;
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
      return stepUp(s, call, decision.needLevel === 2 ? 2 : 1, tc, out, acks);
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
 * The gate said STEP_UP for `call`, to level `need`: the entry call of the open form (ensureEntry), or
 * one of its checks (core/turn.ts stopForm, which also asks for level 1 for a check that waits on an
 * identity factor). Identity is asked for (the next factor, their check, or the keypad code;
 * on a web chat, the portal sign-in), and the form loop goes on once the caller is verified to the
 * level the gate said: the entry call is made again, and a check runs again, since a check that has
 * not passed is not in Session.checked. A check's call is kept without its params: it is never made
 * again as it stands, but from what the slots then hold. An app without identity has no factors to
 * ask: validateApp keeps every tool at level 0, so only an app's own rule can get here, and it fails
 * closed, to a person.
 */
export function stepUp(s: Session, call: ToolCall, need: 1 | 2, tc: TurnContext, out: TurnOut, acks: Ack[]): Decision | Refused | null {
  if (!appOf(s).identity) return handoff(s, 'needs-human', acks);
  s.stepUp = { call, need };
  return nextFactor(s, tc, out, acks);
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
    // Verified with the caller-ID match standing in for the factors it identifies: the principal
    // says so (via), for the app's audit row and its own decisions. Every other principal is as the tool made it.
    const byCallerId = s.callerMatch === 'offered';
    const { via: _via, ...proven } = value.principal;
    s.principal = byCallerId ? { ...proven, via: 'caller-id' } : _via === undefined ? value.principal : proven;
    if (byCallerId) noteCallerMatch(s, out, 'verified');
    acks.push({ promptId: 'identity_verified', vars: { first: value.principal.first } });
    if (s.stepUp?.need === 2) return sendCodeAndAsk(s, tc, out, acks);
    s.stepUp = null;
    return null;
  }
  // No match: every factor is asked again from the first, keeping what each has cost. A caller-ID
  // match that took part is set aside for the call: the caller may be someone else on a shared phone,
  // and every factor lets them identify their own account.
  s.identityAttempts.factors += 1;
  if (s.callerMatch === 'offered') noteCallerMatch(s, out, 'failed');
  for (const id of factorSlots) {
    const st = s.slots[id]!;
    Object.assign(st, emptySlot(), { attempts: st.attempts });
    delete st.by;
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
