import type { AuditDraft } from '../audit/types';
import { chainDrafts, type AuditSink } from '../audit/sink';
import { RULE_ID, type CompiledPolicy } from '../gate/compiled';
import { confirmationHash } from '../gate/lines';
import { passed, type GateDecision, type GateFacts, type ToolCall } from '../gate/types';
import type { JevClient, JsonValue } from '../jev/types';
import { localDateIso } from '../core/localDate';
import type { Texts } from '../texts/types';
import { scrubberOfValues } from '../audit/recording';
import { checkArgs, idempotencyKey } from './actions';
import { END_CALL, type ActionSpec, type AgentBusiness } from './business/schema';
import { checkNote, claimsState, neutralised, readClaims, type ClaimsReading } from './claims';
import { askWithinWhy, dayInWords, isConfirmed, readBackText, readYesNo, shownParams, type PendingReadBack } from './confirm';
import { completeJourney, decideRoute, hasJourneys, initialJourney, offeredActions, openJourneys, readRoute, routeQuestions, routeState } from './journeys';
import type { ConverseModel, ModelContent, ModelEvent, ModelMessage, ModelRequest } from './model/types';
import { costUsd } from './model/price';
import { CALLER, confirmedFields, NO_LOOKUPS } from './policy';
import { followOnsOf, systemPrompt, toolsOf } from './prompt';
import { SentenceBuffer } from './sentences';
import { businessZone, type ConverseState, type JourneyState } from './state';
import { recordedArgs, saidPairs, scrubOf, type ConverseToolOutcome, type ConverseTraceRecord } from './trace';

/**
 * The converse runtime's turn (docs/designs/2026-11-11-agent-runtime.md, "The conversation loop" and
 * "Tools, the gate and confirmation"). The model holds the conversation; the runtime owns what is said in
 * fixed words and what is done:
 *
 * - the greeting starts the call word for word;
 * - the model's reply is streamed to the caller in whole sentences as it is written;
 * - each action the model calls is checked by its params' types, then put to the gate, every decision
 *   written to the audit. A lookup runs and its result goes back to the model. A change is read back by
 *   the line, in the business's own words filled with exactly the call's values, and the turn ends there;
 *   the caller's answer is read by the decision model, and only a clear yes runs it (with its follow-on
 *   actions, each through the gate). Anything else goes back to the model with what the caller said;
 * - the model ends the call with the runtime's own action, end_call: the line says the closing line;
 * - a model that errs or says nothing is asked once more while half its time is left, and one that has
 *   not begun to answer within half its time is stopped and asked once more; else the line says the
 *   recovery line (the done line instead, where an action the caller confirmed has just run), and once
 *   the call's failure budget is spent, the handoff line;
 * - a model still calling actions after MAX_ROUNDS rounds fails the turn the same way, with the stuck line
 *   (lines.stuck) in place of the recovery line;
 * - an answer to a read-back the decision model could not read (it timed out or failed) runs nothing, and
 *   the model is told the answer could not be read;
 * - once the model's own words of a turn have been said, the decision model reads them (the check after
 *   speaking, docs/designs/2026-11-11-claims-check.md, agent.yaml `checks.claims`); a reply read as wrong
 *   goes back to the model with a note marked as the line's own, and its correction is said after the reply;
 *   while a read-back waits for the caller's yes, the note goes with the next message the model is sent. A
 *   correction the model declines (it answers with nothing at all) or that fails says nothing more and counts
 *   no failure: the reply was fine to leave as it was;
 * - the caller's words reach the model with the note's mark rewritten wherever they write it (neutralised),
 *   so a caller can never pass for the line's own check;
 * - with journeys (docs/designs/2026-11-12-journeys.md), the call starts in the journey its caller starts in
 *   (else the root), and each caller turn is routed by the decision model (but a turn whose read-back the
 *   caller confirmed and that ran: the yes is not routed). The model's first round is asked alongside the
 *   routing, with the journey as it stands, its sentences held until the route is known, then said; where the
 *   route changes the journey, that round is stopped unsaid and asked again with the new one. The model is offered the
 *   turn's journey's actions only, and a call to any other is refused as not offered, before the gate and
 *   counting toward no refusal. A journey's completing action, run on the caller's yes, moves it to its after
 *   phase. Routing never fails a turn: a decision model that errs or is late leaves the journey as it was.
 */

/** Model rounds per turn of the caller: each round's tool results go back to the model for the next. */
export const MAX_ROUNDS = 4;

/**
 * An action's code: it does the work with the checked params; the gate has already decided it may. `key` is
 * the write's idempotency key, `texts` the app's sender (null where the server has none), `caller` what is
 * known of the caller (the number whole), and `env` one of the app's settings by name, read at call time (on
 * a host its own settings file over the server's): the app's code reads its settings here, never process.env.
 */
export type ToolImpl = (params: Record<string, string>, ctx: { key: string; texts: Texts | null; caller: ConverseState['caller']; env: (name: string) => string | undefined }) => Promise<unknown>;

export interface ConverseDeps {
  business: AgentBusiness;
  model: ConverseModel;
  jev: JevClient;
  policy: CompiledPolicy;
  audit: AuditSink;
  tools: Record<string, ToolImpl>;
  texts: Texts | null;
  now: () => Date;
  trace: (r: ConverseTraceRecord) => void;
  /** How long the decision model may take to read the caller's answer to a read-back, and a reply after it is said. */
  jevTimeoutMs: number;
  /** The app's settings by name, as its actions' code reads them (ToolImpl's ctx.env); absent, none is set. */
  env?: (name: string) => string | undefined;
  /**
   * Told, right after a reply is read by the check after speaking, exactly what the decision model was sent
   * (the state of claimsState) and what it read, with the turn's index as the trace records it. Absent on a
   * deployment: the evaluation sets it to keep each reply's check input (eval --claims-cases). A hook that
   * throws is the caller's to catch (the chat runtime logs it); it is never the call's failure.
   */
  onClaimsRead?: (callId: string, read: { turn: number; state: JsonValue; reading: ClaimsReading | null }) => void;
}

/**
 * Where a turn's words go, and the call's end. `say` is given each piece of the turn's reply as it is
 * ready, never an empty one: whole sentences of the model's text (`final` false), and last the piece that
 * ends the turn's reply (`final` true: the rest of the model's text, or a fixed line). A turn that says
 * anything has one final piece, or two where the check after speaking corrects the reply: the correction's
 * pieces follow the reply's final one, its own last piece final again. A correction that fails after saying
 * part of itself leaves its pieces with no final one after them: the turn's end closes them. A turn that
 * says nothing (the caller left) calls neither. The chat runtime sends a `say` at each final piece (the
 * reply's at once, before the check reads it, and a correction's as a second `say`), and each piece as a
 * `say_delta` as it comes; the phone (plan 2 of the runtime's design) is to say a correction once the reply
 * has played, unless the caller has begun to speak. `scrubbed`, where a channel keeps what it sent, is given
 * at the turn's end how the trace masks what the line said (each value the records mask), before the
 * turn's trace record is written.
 */
export interface Out {
  say(text: string, final: boolean): void;
  end(how: 'closing' | 'handoff'): void;
  scrubbed?(scrub: (text: string) => string): void;
}

export type Input = { kind: 'start' } | { kind: 'text'; text: string } | { kind: 'left' };

/**
 * The confirmation hash a gate call carries: the read-back's, only when the read-back was of this very
 * action with exactly these params. The gate's hash covers the values alone, not the action, so a yes to
 * one action must never be carried to another that happens to take the same values.
 */
export function confirmedHashFor(call: { tool: string; params: Readonly<Record<string, string>> }, pending: PendingReadBack | null): string | null {
  if (pending === null || pending.action !== call.tool) return null;
  const a = Object.keys(pending.params);
  const b = Object.keys(call.params);
  if (a.length !== b.length) return null;
  return a.every((k) => Object.hasOwn(call.params, k) && call.params[k] === pending.params[k]) ? pending.hash : null;
}

/** What one turn gathers for its trace record, and the clock its times are read from. */
interface Turn {
  st: ConverseState;
  deps: ConverseDeps;
  out: Out;
  t0: number;
  todayIso: string;
  replies: string[];
  tools: ConverseTraceRecord['tools'];
  model: ConverseTraceRecord['model'];
  readBack?: ConverseTraceRecord['readBack'];
  /** The masked values of the turn's calls with their recorded forms, masked in what the trace keeps of what the line said. */
  masked: [string, string][];
  /** An action the caller confirmed ran this turn, and the caller has not yet heard a reply after it. */
  confirmedRan: boolean;
  /** The model called end_call this round. */
  ending: boolean;
  /** The model's own words said this turn, each round's whole (never a fixed line or a read-back): what the check after speaking reads. */
  own: string[];
  /** The check after speaking's reading of the turn's reply, where it was read. */
  check?: ConverseTraceRecord['check'];
  /** The model is being asked for the check after speaking's correction: its requests are marked so in the trace. */
  correcting: boolean;
  /** A note the check after speaking carried from an earlier turn went with this turn's message to the model. */
  carriedNote: boolean;
  /** The model answered the message carrying that note with nothing at all: the note was taken out and the model asked again without it. */
  carriedNoteDropped: boolean;
  /** How the caller's turn was routed among the journeys, where it was. */
  route?: ConverseTraceRecord['route'];
  /** The journey the turn's confirmed action completed. */
  journeyEnded?: ConverseTraceRecord['journeyEnded'];
}

/**
 * A reply's words to the caller: model text in sentences as it streams, and fixed lines whole. Exactly one piece
 * of a turn is final. While held (a routed turn's first round, until its route is known), the round's sentences
 * are kept rather than said: released, they are said in order and later ones go straight out; discarded, they
 * are never said.
 */
class Speaker {
  private sentences = new SentenceBuffer();
  /** What the current round has said so far. */
  private said = '';
  /** The sentences kept while held; null when not held. */
  private kept: string[] | null = null;
  /** Text came while held: the first text the caller could hear is at the release. */
  private heldText = false;

  constructor(private readonly t: Turn) {}

  delta(d: string): void {
    if (this.kept !== null) {
      this.heldText = true;
      this.kept.push(...this.sentences.push(d));
      return;
    }
    this.heard();
    for (const s of this.sentences.push(d)) {
      this.t.out.say(s, false);
      this.said += s;
    }
  }

  /** The first text the caller could hear, timed from the turn's start. */
  private heard(): void {
    if (this.t.model.firstTextMs === null) this.t.model.firstTextMs = Date.now() - this.t.t0;
  }

  /** Sentences pushed after this are kept, not said. */
  hold(): void {
    this.kept = [];
    this.heldText = false;
  }

  /** The kept sentences are said, in order, and later ones go straight out. */
  release(): void {
    const kept = this.kept;
    if (kept === null) return;
    this.kept = null;
    if (this.heldText) this.heard();
    for (const s of kept) {
      this.t.out.say(s, false);
      this.said += s;
    }
  }

  /** The kept sentences are dropped, with the one not yet finished (abandon's effect on the held part), and the hold ends. */
  discard(): void {
    this.kept = null;
    this.heldText = false;
    this.sentences.rest();
  }

  /** Whether the current round has said anything yet. */
  get spoke(): boolean {
    return this.said !== '';
  }

  /**
   * The round's text ends: what is left is said (final, when the reply ends with it); the round's whole
   * text is returned. The buffer holds back a reply's last sentence, so a round with any text has some
   * left to say final.
   */
  endRound(final: boolean): string {
    const rest = this.sentences.rest();
    if (rest.trim() !== '') this.t.out.say(rest, final);
    const all = (this.said + rest).trim();
    this.said = '';
    if (all !== '') this.t.replies.push(all);
    return all;
  }

  /** The round failed: what was not yet said is dropped (kept sentences too, the hold kept); what was said is returned. */
  abandon(): string {
    this.sentences.rest();
    if (this.kept !== null) {
      this.kept = [];
      this.heldText = false;
    }
    const all = this.said.trim();
    this.said = '';
    if (all !== '') this.t.replies.push(all);
    return all;
  }

  /** A fixed line, said whole: the turn's final piece unless another line follows it. */
  line(text: string, final = true): void {
    this.t.out.say(text, final);
    this.t.replies.push(text);
  }
}

/** Adds content to the conversation, into the last message where it is the same speaker's. */
function add(st: ConverseState, role: ModelMessage['role'], content: ModelContent[]): void {
  if (content.length === 0) return;
  const last = st.messages.at(-1);
  if (last?.role === role) last.content.push(...content);
  else st.messages.push({ role, content });
}

async function record(t: Turn, d: AuditDraft): Promise<void> {
  await chainDrafts(t.deps.audit, t.st.callId, t.st.channel, [d]);
}

const describe = (tool: string, args: Record<string, string>): string => `${tool}(${Object.entries(args).map(([k, v]) => `${k}=${v}`).join(', ')})`;

/** The gate's decision on a call, written to the audit with the params as the action records them. */
async function gate(t: Turn, spec: ActionSpec | undefined, call: ToolCall, confirmedHash: string | null): Promise<GateDecision> {
  const facts: GateFacts = { attempts: 0, confirmedHash, todayIso: t.todayIso, ...(t.st.caller.number ? { callerNumber: t.st.caller.number } : {}) };
  const d = t.deps.policy.evaluate(call, CALLER, facts, NO_LOOKUPS);
  const scrub = scrubOf(spec, call);
  await record(t, {
    type: 'gate',
    detail: {
      tool: call.tool,
      call: describe(call.tool, recordedArgs(spec, call.params)),
      verdict: d.verdict,
      reason: d.reason ?? null,
      rules: d.rules.map((r) => scrub(`${r.id} ${r.pass ? 'pass' : 'fail'}: ${r.compared}`)),
    },
  });
  return d;
}

/** Whether the gate held a change only for want of the caller's yes: every rule before the confirmation passed. */
function awaitsConfirmation(d: GateDecision): boolean {
  return d.verdict === 'BLOCK' && d.rules.some((r) => r.id === RULE_ID.confirmed) && !passed(d, RULE_ID.confirmed);
}

/** A refusal as the model is told it: the business's rule that failed, never a value the records hide; past the limit, to offer a person. */
function refused(t: Turn, action: string, why: string): string {
  const n = (t.st.refusals[action] = (t.st.refusals[action] ?? 0) + 1);
  const limit = t.deps.business.limits.refusalsPerAction;
  return n >= limit ? `${why} "${action}" has been refused ${n} times on this call: offer the caller a person rather than trying it again.` : why;
}

function gateReason(d: GateDecision, spec: ActionSpec | undefined, call: ToolCall, actions: string[]): string {
  if (spec === undefined) return `Refused: there is no action "${call.tool}". The actions are: ${actions.join(', ')}.`;
  const failed = d.rules.find((r) => !r.pass);
  return scrubOf(spec, call)(`Refused by the business's rules (${d.reason ?? d.verdict})${failed ? `: ${failed.description}` : ''}.`);
}

/** A tool's result as the model is sent it. */
const resultText = (r: unknown): string => (typeof r === 'string' ? r : r === undefined ? 'done' : JSON.stringify(r));

/** The most characters of a result the audit keeps. */
const RESULT_RECORDED_MAX = 600;

/**
 * Runs an action the gate allowed, with the call's key; a throw is the action's failure, said to the model.
 * Its result (or failure) is recorded in the audit beside the gate's row, as the model is sent it, the call's
 * values that are recorded masked masked, cut to RESULT_RECORDED_MAX.
 */
async function runTool(t: Turn, name: string, params: Record<string, string>): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const impl = Object.hasOwn(t.deps.tools, name) ? t.deps.tools[name] : undefined;
  let ran: { ok: true; result: unknown } | { ok: false; error: string };
  if (impl === undefined) ran = { ok: false, error: `the action "${name}" has no code` };
  else {
    try {
      ran = { ok: true, result: await impl(params, { key: idempotencyKey(t.st.callId, name, params), texts: t.deps.texts, caller: t.st.caller, env: t.deps.env ?? (() => undefined) }) };
    } catch (e) {
      ran = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const spec = Object.hasOwn(t.deps.business.actions, name) ? t.deps.business.actions[name] : undefined;
  const summary = scrubOf(spec, { tool: name, params })(ran.ok ? resultText(ran.result) : `Failed: ${ran.error}`);
  await record(t, { type: 'tool_result', detail: { tool: name, ok: ran.ok, summary: summary.length > RESULT_RECORDED_MAX ? `${summary.slice(0, RESULT_RECORDED_MAX - 1)}…` : summary } });
  return ran;
}

/** A call in the turn's trace: its params as recorded, and its reason with any raw value of a masked param replaced as the params are. */
function traceTool(t: Turn, spec: ActionSpec | undefined, name: string, args: Record<string, unknown>, outcome: ConverseToolOutcome, reason?: string): void {
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) raw[k] = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  const scrub = scrubOf(spec, { tool: name, params: raw });
  t.tools.push({ name, args: recordedArgs(spec, args), outcome, ...(reason !== undefined ? { reason: scrub(reason) } : {}) });
  t.masked.push(...saidPairs(spec, { tool: name, params: raw }, shownParams(t.deps.business, name, raw, 'en', t.st.seen, t.st.caller.number)));
}

/**
 * One round's calls, in order: each checked, put to the gate and run, or read back. Returns the results
 * the model is sent and the read-back said, if a change was read back. A call after a read-back in the
 * same round is refused: one confirmation at a time.
 */
async function runCalls(t: Turn, calls: Extract<ModelEvent, { type: 'tool_call' }>[]): Promise<{ results: ModelContent[]; readBack: string | null }> {
  const b = t.deps.business;
  const results: ModelContent[] = [];
  let readBack: string | null = null;
  const error = (id: string, content: string): void => void results.push({ type: 'tool_result', id, content, isError: true });
  for (const c of calls) {
    const spec = Object.hasOwn(b.actions, c.name) ? b.actions[c.name] : undefined;
    if (t.ending) {
      const why = 'Not run: the call is ending.';
      traceTool(t, spec, c.name, c.args, 'refused', why);
      error(c.id, why);
      continue;
    }
    if (t.st.pending !== null) {
      // One confirmation at a time: nothing else runs while the caller answers a read-back, and the call is
      // not ended under it. It counts toward no action's refusals: the action was only held, so calls made
      // together never steer the caller to a person.
      const why = `Not run: one confirmation at a time. The caller is answering the read-back of "${t.st.pending.action}"; ${c.name === END_CALL ? 'end the call after their answer' : 'call this again after their answer'}.`;
      await record(t, { type: 'converse_refused', detail: { action: c.name, reason: 'one-confirmation-at-a-time', pending: t.st.pending.action } });
      traceTool(t, spec, c.name, c.args, 'refused', why);
      error(c.id, why);
      continue;
    }
    if (c.name === END_CALL) {
      // The runtime's own action: no params, no confirmation, recorded; the line says the closing line once the round's calls are done.
      await record(t, { type: 'converse_end', detail: { by: END_CALL } });
      traceTool(t, undefined, c.name, {}, 'ran');
      t.ending = true;
      results.push({ type: 'tool_result', id: c.id, content: 'The call is ending: the line says the closing line.' });
      continue;
    }
    const follows = followOnsOf(b).get(c.name);
    if (follows !== undefined) {
      // A follow-on runs only after the action it follows, on the caller's yes to that one: never at the model's call.
      const why = `Not run: "${c.name}" runs only after ${follows}, once the caller has said yes to it; it is never called directly.`;
      traceTool(t, spec, c.name, c.args, 'refused', why);
      error(c.id, why);
      continue;
    }
    if (hasJourneys(b) && spec !== undefined && !offeredActions(b, t.st.journey).includes(c.name)) {
      // Not among the turn's journey's actions: a model's slip, or a caller's words naming it. Refused before
      // the gate, and counted toward no refusal, since nothing about the action itself was wrong.
      const why = `Not run: "${c.name}" is not available for what the caller is doing now.`;
      await record(t, { type: 'converse_refused', detail: { action: c.name, reason: 'not-offered', journey: t.st.journey?.active ?? 'root' } });
      traceTool(t, spec, c.name, c.args, 'refused', why);
      error(c.id, why);
      continue;
    }
    let params: Record<string, string> = {};
    if (spec !== undefined) {
      const checked = checkArgs(spec, c.args, t.st.seen, t.todayIso, t.st.caller.number);
      if (!checked.ok) {
        traceTool(t, spec, c.name, c.args, 'invalid', checked.reason);
        error(c.id, checked.reason);
        continue;
      }
      params = checked.params;
    }
    const call: ToolCall = { tool: c.name, params };
    const d = await gate(t, spec, call, confirmedHashFor(call, t.st.pending));
    if (spec !== undefined && spec.kind === 'change' && awaitsConfirmation(d)) {
      const text = readBackText(b, c.name, params, 'en', t.st.seen, t.st.caller.number);
      t.st.pending = { action: c.name, params, hash: confirmationHash(params, confirmedFields(spec)), text, id: c.id };
      t.readBack = { text };
      traceTool(t, spec, c.name, params, 'readBack');
      readBack = text;
      continue;
    }
    if (d.verdict !== 'ALLOW') {
      const why = gateReason(d, spec, call, hasJourneys(b) ? offeredActions(b, t.st.journey) : Object.keys(b.actions));
      traceTool(t, spec, c.name, spec === undefined ? c.args : params, 'refused', why);
      error(c.id, refused(t, c.name, why));
      continue;
    }
    const ran = await runTool(t, c.name, params);
    if (!ran.ok) {
      traceTool(t, spec, c.name, params, 'failed', ran.error);
      error(c.id, `Failed: ${ran.error}`);
      continue;
    }
    // Each lookup's latest results replace its earlier ones: a slot is held to what it returned last.
    if (spec?.kind === 'lookup') t.st.seen[c.name] = { results: Array.isArray(ran.result) ? ran.result : [ran.result], atMs: t.deps.now().getTime() };
    traceTool(t, spec, c.name, params, 'ran');
    results.push({ type: 'tool_result', id: c.id, content: resultText(ran.result) });
  }
  return { results, readBack };
}

/**
 * A request's outcome; a failure says whether anything of it was said, whether it never began (stalled), and
 * whether the provider refused it for its rate limit (`rateLimited`, with the wait it asked for where it named one).
 */
type Round =
  | { ok: true; calls: Extract<ModelEvent, { type: 'tool_call' }>[]; text: string }
  | { ok: false; error: string; spoke: boolean; stalled: boolean; rateLimited?: { retryAfterMs?: number } };

const TIMED_OUT = Symbol('timed out');
const STOPPED = Symbol('stopped');

/** A promise that resolves to STOPPED once `stop` is aborted. */
const stoppedBy = (stop: AbortSignal): Promise<typeof STOPPED> =>
  new Promise((resolve) => (stop.aborted ? resolve(STOPPED) : stop.addEventListener('abort', () => resolve(STOPPED), { once: true })));

/** `p`, or TIMED_OUT once `ms` have passed first. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<typeof TIMED_OUT>((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms))))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One request to the model, streamed: its text to the speaker until its first call (text after a call is
 * written without the call's result, and is dropped), its calls collected. It fails on an error event, a
 * thrown stream, nothing at all (but where `emptyOk`: the first answer to the check after speaking's note, for
 * which nothing at all is a correction declined), a reply cut off at the token limit, no event within
 * `firstWaitMs` at first and the model's time after, or `stop` aborted (the route changed the journey: the
 * request is aborted at once).
 */
async function streamOnce(t: Turn, sp: Speaker, req: ModelRequest, firstWaitMs: number, deadline: number, emptyOk: boolean, waitedMs = 0, stop?: AbortSignal): Promise<Round> {
  const controller = new AbortController();
  const stopped = stop === undefined ? null : stoppedBy(stop);
  const started = Date.now();
  const iter = t.deps.model.stream(req, controller.signal)[Symbol.asyncIterator]();
  const calls: Extract<ModelEvent, { type: 'tool_call' }>[] = [];
  let text = '';
  let first = true;
  let firstMs: number | null = null;
  let failed: string | undefined;
  const fail = (error: string, stalled = false, rateLimited?: { retryAfterMs?: number }): Round => {
    failed = error;
    controller.abort();
    void Promise.resolve(iter.return?.()).catch(() => undefined);
    return { ok: false, error, spoke: sp.spoke, stalled, ...(rateLimited !== undefined ? { rateLimited } : {}) };
  };
  try {
    for (;;) {
      // The first event within firstWaitMs, and every event before the attempt's deadline: a model that
      // trickles its answer is bounded as one that never starts.
      const wait = Math.min(first ? firstWaitMs : Infinity, deadline - Date.now());
      let next: IteratorResult<ModelEvent> | typeof TIMED_OUT | typeof STOPPED;
      try {
        next = await within(stopped === null ? iter.next() : Promise.race([iter.next(), stopped]), wait);
      } catch (e) {
        return fail(`invalid: the stream threw (${e instanceof Error ? e.name : 'error'})`);
      }
      if (next === STOPPED) return fail('aborted: the route changed the journey');
      if (next === TIMED_OUT) return first ? fail(`timeout: no answer began within ${Math.round(wait)} ms`, true) : fail(`timeout: the answer was not done within the model's ${t.deps.business.model.timeoutMs} ms`);
      if (next.done) break;
      if (first) firstMs = Date.now() - started;
      first = false;
      const ev = next.value;
      if (ev.type === 'text') {
        if (calls.length === 0) {
          text += ev.delta;
          sp.delta(ev.delta);
        }
      } else if (ev.type === 'tool_call') calls.push(ev);
      else if (ev.type === 'done') {
        t.model.usage.inputTokens += ev.usage.inputTokens;
        t.model.usage.outputTokens += ev.usage.outputTokens;
        // Cut off at the token limit: what it was writing is unfinished, so the turn fails (its last sentence, never said, is dropped).
        if (ev.stop === 'length') return fail(`length: the reply reached the ${t.deps.business.model.maxTokens}-token limit`);
        break;
      } else return fail(`${ev.kind}: ${ev.detail}`, false, ev.kind === 'rate_limited' ? (ev.retryAfterMs !== undefined ? { retryAfterMs: ev.retryAfterMs } : {}) : undefined);
    }
  } finally {
    const ms = Date.now() - started;
    t.model.ms += ms;
    (t.model.requests ??= []).push({ firstMs, ms, ...(waitedMs > 0 ? { waitedMs } : {}), ...(failed !== undefined ? { error: failed } : {}), ...(t.correcting ? { correction: true as const } : {}) });
  }
  if (text.trim() === '' && calls.length === 0 && !emptyOk) {
    const r = fail('empty: the model said nothing and called nothing');
    // The request is timed already; its failure is this.
    t.model.requests!.at(-1)!.error = failed;
    return r;
  }
  return { ok: true, calls, text };
}

/**
 * The conversation as the model is sent it. A conversation the line opened (the greeting) starts with a
 * note that the call is connected, on the caller's side: a provider may take a conversation only from
 * the user's side.
 */
function requestMessages(st: ConverseState): ModelMessage[] {
  const messages = structuredClone(st.messages);
  if (messages[0]?.role !== 'assistant') return messages;
  return [{ role: 'user', content: [{ type: 'text', text: st.channel === 'voice' ? '[The call is connected.]' : '[The chat is open.]' }] }, ...messages];
}

/** The most times a request refused for the provider's rate limit is asked again, within a round. */
export const RATE_LIMIT_RETRIES = 2;
/** The first wait before a request refused for its rate limit is asked again, where the provider names none or one too long; it doubles each time. */
export const RATE_LIMIT_BACKOFF_MS = 250;

/** Waits `ms`, or until `stop` is aborted. */
async function sleep(ms: number, stop?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slept = new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.max(0, ms))));
  try {
    await (stop === undefined ? slept : Promise.race([slept, stoppedBy(stop)]));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One round: the request, and again where it failed before saying anything. A request the provider refused
 * for its rate limit is asked again after a wait (its Retry-After where it named one that leaves half the
 * model's time, else RATE_LIMIT_BACKOFF_MS doubling), up to RATE_LIMIT_RETRIES more times, each only while half
 * the model's time is left after the wait; each such answer is counted in the trace (`model.rateLimited`), and
 * the time waited (`model.rateLimitedMs`, and each request's `waitedMs`, the wait before it). Any other failure
 * is asked once more with the time left, only while half the model's time is left: a request that had not
 * begun within half the model's time (it is stopped then) is asked again with the rest, as half is left then,
 * but not after a rate limit's wait, which has spent some of it. `emptyOk` is streamOnce's, for the round's
 * first request and its asks again alike. A round whose `stop` is aborted ends at once, asked no more, and
 * its failure is not the turn's (the round is asked again with the new journey: routedRound).
 */
async function round(t: Turn, sp: Speaker, emptyOk = false, stop?: AbortSignal): Promise<Round> {
  const b = t.deps.business;
  const req: ModelRequest = { system: systemPrompt(b, t.st, t.deps.now()), messages: requestMessages(t.st), tools: toolsOf(b, offeredActions(b, t.st.journey)), maxTokens: b.model.maxTokens, ...(b.model.effort !== undefined ? { effort: b.model.effort } : {}) };
  const budget = b.model.timeoutMs;
  const start = Date.now();
  const deadline = start + budget;
  let limited = 0;
  let retried = false;
  // Read at each use: the round's stop may be aborted while it waits.
  const stopped = (): boolean => stop?.aborted === true;
  let r = await streamOnce(t, sp, req, budget / 2, deadline, emptyOk, 0, stop);
  while (!r.ok) {
    if (stopped()) break;
    t.model.error = r.error;
    if (r.spoke) break;
    if (r.rateLimited !== undefined) {
      t.model.rateLimited = (t.model.rateLimited ?? 0) + 1;
      if (limited >= RATE_LIMIT_RETRIES) break;
      const left = (wait: number): number => deadline - Date.now() - wait;
      const asked = r.rateLimited.retryAfterMs;
      const wait = asked !== undefined && left(asked) >= budget / 2 ? asked : RATE_LIMIT_BACKOFF_MS * 2 ** limited;
      if (left(wait) < budget / 2) break;
      limited += 1;
      sp.abandon();
      t.model.retried = true;
      t.model.rateLimitedMs = (t.model.rateLimitedMs ?? 0) + wait;
      await sleep(wait, stop);
      if (stopped()) break;
      r = await streamOnce(t, sp, req, budget / 2, deadline, emptyOk, wait, stop);
      continue;
    }
    // Half the model's time left: a stall of the round's first request leaves just that, a stall after a wait less.
    const halfLeft = deadline - Date.now() >= budget / 2 || (r.stalled && limited === 0);
    if (retried || !halfLeft) break;
    // Nothing was said: the words of a sentence not yet finished are dropped, and the model asked again.
    retried = true;
    sp.abandon();
    t.model.retried = true;
    r = await streamOnce(t, sp, req, deadline - Date.now(), deadline, emptyOk, 0, stop);
  }
  return r;
}

/**
 * A routed turn's first round, asked alongside its routing (docs/designs/2026-11-12-journeys.md, "Keeping latency
 * flat"): the round starts at once with the journey as it stands, its sentences held, and its calls, if any, wait
 * for the route (the round's result is acted on only once it is known). When the route is known (or
 * routing.timeoutMs has passed, routeOf's limit), the call's journey is set to it and:
 *
 * - where it leaves the journey's active task and phase as they were, the held sentences are said and the
 *   rest of the round goes straight out; a round that has already failed says none of what it held (the
 *   caller has heard nothing of it), and fails as any round does;
 * - otherwise the round's request is aborted, what it held dropped, its calls never run and nothing of it
 *   put in the conversation, and the round asked again, once, with the new journey and the model's whole
 *   time from then (the route's `restarted`). The stopped round's error and retry are not the turn's.
 */
async function routedRound(t: Turn, sp: Speaker, emptyOk: boolean, routing: Promise<Routed>): Promise<Round> {
  const j = t.st.journey!;
  const before = { error: t.model.error, retried: t.model.retried };
  const stop = new AbortController();
  sp.hold();
  const first = round(t, sp, emptyOk, stop.signal);
  const settled: { round?: Round } = {};
  void first.then((r) => (settled.round = r));
  const routed = await routing;
  t.st.journey = routed.next;
  t.route = routed.route;
  if (routed.next.active === j.active && routed.next.phase === j.phase) {
    if (settled.round !== undefined && !settled.round.ok) sp.discard();
    else sp.release();
    return await first;
  }
  stop.abort();
  await first;
  sp.discard();
  if (before.error === undefined) delete t.model.error;
  else t.model.error = before.error;
  if (before.retried === undefined) delete t.model.retried;
  else t.model.retried = before.retried;
  t.route.restarted = true;
  return round(t, sp, emptyOk);
}

/**
 * The model failed the turn: the recovery line, or past the call's budget the handoff line, and the call
 * ends with a person. Where an action the caller confirmed has just run, the caller hears the done line
 * first, and it stands for the recovery line: they need not say anything again. A model that used up its
 * rounds (`stuck`: it kept calling actions) is not asked to be heard again: the stuck line stands for the
 * recovery line.
 */
function failed(t: Turn, sp: Speaker, why: 'failed' | 'stuck' = 'failed'): void {
  const lines = t.deps.business.lines;
  t.st.failures += 1;
  const handoff = t.st.failures >= t.deps.business.limits.failuresPerCall;
  const said: string[] = [];
  if (t.confirmedRan) {
    t.confirmedRan = false;
    said.push(lines.done.en);
  }
  if (handoff) said.push(lines.handoff.en);
  else if (said.length === 0) said.push(why === 'stuck' ? lines.stuck.en : lines.recovery.en);
  said.forEach((line, i) => sp.line(line, i === said.length - 1));
  add(t.st, 'assistant', said.map((text) => ({ type: 'text' as const, text })));
  if (handoff) {
    t.st.ended = 'handoff';
    t.out.end('handoff');
  }
}

/** Takes a carried note out of the conversation: the text block holding it, in the latest message on the caller's side. */
function dropNote(st: ConverseState, note: string): void {
  for (let m = st.messages.length - 1; m >= 0; m--) {
    const msg = st.messages[m]!;
    if (msg.role !== 'user') continue;
    const at = msg.content.findIndex((c) => c.type === 'text' && c.text === note);
    if (at < 0) return;
    msg.content.splice(at, 1);
    if (msg.content.length === 0) st.messages.splice(m, 1);
    return;
  }
}

/**
 * The model asked, round after round, until it replies with no call, a change is read back, or it fails.
 * A failure says the recovery line (failed), but `silent` (the check after speaking's correction): then
 * nothing more is said and nothing counted, and the failure is returned. With `silent`, a first answer of
 * nothing at all (no text and no call) is the correction declined: the model read its reply again and found
 * it right, so nothing is said or added to the conversation, and it is no failure (`declined`). With
 * `carried` (the turn's message carries a note from an earlier turn), a first answer of nothing at all is
 * the model taking the note's "say nothing of it" for the whole answer: the note is taken out of the
 * conversation and the model asked once more without it; that answer, empty or not, is taken as any is.
 * With `routing` (a routed caller turn), the first round is asked alongside it (routedRound); later rounds
 * are asked in the journey it decided.
 */
async function converse(t: Turn, sp: Speaker, silent = false, carried?: string, routing?: Promise<Routed>): Promise<{ ok: true; declined?: true } | { ok: false; error: string }> {
  let first = true;
  let route = routing;
  for (let i = 0; i < MAX_ROUNDS; i++) {
    const emptyOk = first && (silent || carried !== undefined);
    const r = route !== undefined ? await routedRound(t, sp, emptyOk, route) : await round(t, sp, emptyOk);
    route = undefined;
    first = false;
    if (r.ok && r.text.trim() === '' && r.calls.length === 0) {
      // Only a first answer may be empty (streamOnce's emptyOk).
      sp.abandon();
      if (silent) return { ok: true, declined: true };
      // The message's carried note answered with nothing: out with it, and asked again (no round spent).
      dropNote(t.st, carried!);
      t.carriedNoteDropped = true;
      i -= 1;
      continue;
    }
    if (!r.ok) {
      const said = sp.abandon();
      if (said !== '') {
        add(t.st, 'assistant', [{ type: 'text', text: said }]);
        t.own.push(said);
      }
      if (!silent) failed(t, sp);
      return { ok: false, error: r.error };
    }
    const final = r.calls.length === 0;
    const said = sp.endRound(final);
    add(t.st, 'assistant', [...(said !== '' ? [{ type: 'text' as const, text: said }] : []), ...r.calls.map((c) => ({ type: 'tool_call' as const, id: c.id, name: c.name, args: c.args }))]);
    // The caller has heard a reply after the action they confirmed.
    if (said !== '') {
      t.confirmedRan = false;
      t.own.push(said);
    }
    if (final) return { ok: true };
    const { results, readBack } = await runCalls(t, r.calls);
    add(t.st, 'user', results);
    if (readBack !== null) {
      sp.line(readBack);
      return { ok: true };
    }
    if (t.ending) {
      const closing = t.deps.business.lines.closing.en;
      sp.line(closing);
      add(t.st, 'assistant', [{ type: 'text', text: closing }]);
      t.st.ended = 'closing';
      t.out.end('closing');
      return { ok: true };
    }
  }
  // Its rounds used up on calls: the caller asked nothing that needs saying again.
  if (!silent) failed(t, sp, 'stuck');
  return { ok: false, error: `stuck: still calling actions after ${MAX_ROUNDS} rounds` };
}

/**
 * The check after speaking (docs/designs/2026-11-11-claims-check.md): once the turn's reply has been said,
 * the decision model reads the model's own words of it (never a fixed line or a read-back) against the
 * business information and the call's actions. A turn that ended the call, or in which the model said
 * nothing of its own, is not read, nor with agent.yaml's `checks.claims.mode` off. A reply read as
 * contradicted or not done at or over `correctAt` (with mode correct) goes back to the model with a note
 * marked as the line's own check, and the model is asked once more: its correction is said after the reply,
 * and may call actions, gated and read back as on any turn. The correction is not read again. A reading that
 * fails or comes late is an unread check: nothing is corrected.
 *
 * - **Declined:** the model, reading its reply again, may find it right after all and answer with nothing at
 *   all: nothing is said, it is no failure, the note is taken out of the conversation as if never sent (a
 *   model may not be sent an empty turn of its own), and the check says `declined`.
 * - **Failed:** a correction that fails (the model errs, is late, or keeps calling actions) is silent: no
 *   recovery line, no failure counted, no handoff, for the reply it would have corrected has been said and
 *   stands. Where it said nothing, the note (and whatever the correction called) is taken out of the
 *   conversation; where it said part of itself, what it said closes the conversation. The reply's own model
 *   error and retry stay the turn's: the correction's failure is the check's (`correctionFailed`,
 *   `correctionError`), and its requests are marked as the correction's.
 * - **Carried:** while a read-back waits for the caller's yes the model may not be asked now, so the note is
 *   kept in the call's state (ConverseState.carriedNote) and goes with the next message the model is sent
 *   (converseTurn), worded as about a reply said earlier; the check says `carried`.
 */
async function checkAfterSpeaking(t: Turn, sp: Speaker): Promise<void> {
  const claims = t.deps.business.checks.claims;
  if (claims.mode === 'off' || t.st.ended !== undefined || t.own.length === 0) return;
  const reply = t.own.join(' ');
  const started = Date.now();
  const state = claimsState(t.deps.business, t.st, t.todayIso, reply);
  const reading = await readClaims(t.deps.jev, state, t.deps.jevTimeoutMs);
  t.deps.onClaimsRead?.(t.st.callId, { turn: t.st.turnIndex, state, reading });
  const flagged: NonNullable<ConverseTraceRecord['check']>['flagged'] = [];
  if (reading !== null) {
    if (reading.contradicted >= claims.correctAt) flagged.push('contradicted');
    if (reading.notDone >= claims.correctAt) flagged.push('notDone');
    if (reading.gap >= claims.gapAt) flagged.push('gap');
  }
  const check: NonNullable<ConverseTraceRecord['check']> = { contradicted: reading?.contradicted ?? null, notDone: reading?.notDone ?? null, gap: reading?.gap ?? null, flagged, ms: Date.now() - started, corrected: false, correction: 0 };
  t.check = check;
  const wrong = flagged.includes('contradicted') || flagged.includes('notDone');
  if (reading === null || !wrong || claims.mode !== 'correct') return;
  if (t.st.pending !== null) {
    // A read-back waits for the caller's yes: the note goes with the next message the model is sent.
    t.st.carriedNote = checkNote(reply, reading, claims.correctAt, true);
    check.carried = true;
    return;
  }
  // The note is a message of its own on the caller's side (a model is sent a conversation that ends there),
  // marked as the line's own check; the system prompt says what such a note is.
  const before = { replies: t.replies.length, messages: t.st.messages.length, error: t.model.error, retried: t.model.retried };
  add(t.st, 'user', [{ type: 'text', text: checkNote(reply, reading, claims.correctAt) }]);
  t.correcting = true;
  const corrected = await converse(t, sp, true);
  t.correcting = false;
  check.corrected = true;
  check.correction = t.replies.length - before.replies;
  // The turn's model error and retry are the reply's own: the correction's go to the check.
  if (before.error === undefined) delete t.model.error;
  else t.model.error = before.error;
  if (before.retried === undefined) delete t.model.retried;
  else t.model.retried = before.retried;
  if (corrected.ok) {
    if (corrected.declined === true) {
      check.declined = true;
      t.st.messages.length = before.messages;
    }
    return;
  }
  check.correctionFailed = true;
  check.correctionError = corrected.error;
  if (check.correction === 0) t.st.messages.length = before.messages;
}

/** A confirmed action through the gate with the hash of exactly its own values (the read-back's, or a follow-on's own), run when allowed. */
async function runConfirmed(t: Turn, name: string, params: Record<string, string>, hash: string): Promise<{ outcome: 'ran' | 'refused' | 'failed'; text: string; why?: string }> {
  const spec = Object.hasOwn(t.deps.business.actions, name) ? t.deps.business.actions[name] : undefined;
  const call: ToolCall = { tool: name, params };
  const d = await gate(t, spec, call, hash);
  if (d.verdict !== 'ALLOW') {
    const why = gateReason(d, spec, call, Object.keys(t.deps.business.actions));
    return { outcome: 'refused', text: refused(t, name, why), why };
  }
  const ran = await runTool(t, name, params);
  return ran.ok ? { outcome: 'ran', text: resultText(ran.result) } : { outcome: 'failed', text: `Failed: ${ran.error}`, why: ran.error };
}

/**
 * What a read-back the caller did not confirm leaves the model to know: the goal (a yes to the read-back) and
 * what a yes elsewhere is worth, never words for it to say.
 */
const ONLY_THE_READ_BACK = 'Nothing is done until the line reads the action back and the caller says yes to that read-back: a yes to a question of your own confirms nothing, so when the caller wants it done, call the action again and the line reads it back to them.';

/**
 * The caller answered a read-back: a clear yes runs the action and its follow-ons; anything else goes back to
 * the model. Returns whether the action ran on the caller's yes. An action that completes the active journey
 * moves it to its after phase.
 */
async function answered(t: Turn, said: string): Promise<boolean> {
  const p = t.st.pending!;
  t.st.pending = null;
  const b = t.deps.business;
  const spec = b.actions[p.action];
  const reading = await readYesNo(t.deps.jev, p.text, said, t.deps.jevTimeoutMs, dayInWords(t.todayIso));
  const yes = isConfirmed(reading);
  t.readBack = { text: p.text, ...(reading !== null ? { yes: reading.yes, no: reading.no } : {}), confirmed: yes };
  const heard = `The line read back: "${p.text}"`;
  // The caller's words as the model is sent them: the note's mark rewritten wherever they wrote it.
  const words = neutralised(said);
  if (reading === null) {
    // The decision model timed out or failed: what the caller meant is not known, and nothing runs.
    traceTool(t, spec, p.action, p.params, 'notConfirmed', 'the answer could not be read');
    add(t.st, 'user', [{ type: 'tool_result', id: p.id, content: `${heard} Not done: nothing was changed, booked or sent. The caller's answer could not be read, so it is not known whether they confirmed. ${ONLY_THE_READ_BACK} They said: '${words}'` }]);
    return false;
  }
  if (!yes) {
    traceTool(t, spec, p.action, p.params, 'notConfirmed');
    add(t.st, 'user', [{ type: 'tool_result', id: p.id, content: `${heard} Not done: nothing was changed, booked or sent. The caller did not confirm. ${ONLY_THE_READ_BACK} They said: '${words}'` }]);
    return false;
  }
  await record(t, { type: 'confirmed', detail: { action: p.action, hash: p.hash, yes: reading!.yes, no: reading!.no } });
  const parent = await runConfirmed(t, p.action, p.params, p.hash);
  traceTool(t, spec, p.action, p.params, parent.outcome === 'ran' ? 'confirmed' : parent.outcome, parent.why);
  if (parent.outcome === 'ran') {
    t.confirmedRan = true;
    const j = t.st.journey;
    if (hasJourneys(b) && j !== undefined) {
      const next = completeJourney(b, j, p.action);
      if (next !== j) {
        t.st.journey = next;
        t.journeyEnded = { journey: j.active!, how: 'done' };
      }
    }
  }
  const done = [`${p.action}: ${parent.text}`];
  // Follow-ons run only after their parent ran, each with the parent's confirmed values by name (agent.yaml's
  // check makes every param a follow-on takes one its parent has), its own hash, and a row naming the yes.
  for (const name of parent.outcome === 'ran' ? spec?.then ?? [] : []) {
    const follow = Object.hasOwn(b.actions, name) ? b.actions[name] : undefined;
    if (follow === undefined) continue;
    const filled = Object.fromEntries(Object.keys(follow.params).map((k) => [k, p.params[k] ?? '']));
    const checked = checkArgs(follow, filled, t.st.seen, t.todayIso, t.st.caller.number);
    if (!checked.ok) {
      traceTool(t, follow, name, filled, 'invalid', checked.reason);
      done.push(`${name}: not run (${checked.reason})`);
      continue;
    }
    const hash = confirmationHash(checked.params, confirmedFields(follow));
    await record(t, { type: 'confirmed', detail: { action: name, parent: p.action, parentHash: p.hash, hash } });
    const ran = await runConfirmed(t, name, checked.params, hash);
    traceTool(t, follow, name, checked.params, ran.outcome, ran.why);
    done.push(`${name}: ${ran.text}`);
  }
  // The line's own record of what has been done, told to the model on every request from now on.
  if (parent.outcome === 'ran') (t.st.done ??= []).push({ action: p.action, readBack: p.text, results: done });
  add(t.st, 'user', [{ type: 'tool_result', id: p.id, content: `${heard} The caller confirmed; done: ${done.join('; ')}. They said: '${words}'`, ...(parent.outcome === 'ran' ? {} : { isError: true }) }]);
  return parent.outcome === 'ran';
}

/** The text of the line's last words before the caller's turn: a read-back waiting for its answer, else the last message of the line's with text. */
function lastReplyOf(st: ConverseState): string | null {
  if (st.pending !== null) return st.pending.text;
  for (let m = st.messages.length - 1; m >= 0; m--) {
    const msg = st.messages[m]!;
    if (msg.role !== 'assistant') continue;
    const text = msg.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join(' ').trim();
    if (text !== '') return text;
  }
  return null;
}

/** A caller turn's route: the journey it leaves the call in, and the route as the trace keeps it. */
interface Routed {
  next: JourneyState;
  route: NonNullable<Turn['route']>;
}

/**
 * Routes the caller's turn among the journeys from `j`, the journey as it stands (docs/designs/2026-11-12-journeys.md,
 * "Routing"): the decision model is asked which task the caller wants now, within routing.timeoutMs, and code
 * decides from its reading (decideRoute). A decision model that errs or is late leaves the journey as it was
 * (carry): routing never fails a turn, and `timedOut` says it was late. Nothing is set here: routedRound sets
 * the call's journey and the turn's route once it is known.
 */
async function routeOf(t: Turn, j: JourneyState, said: string, lastReply: string | null): Promise<Routed> {
  const b = t.deps.business;
  const started = Date.now();
  const asked = await askWithinWhy(t.deps.jev, routeState(b, j, said, lastReply), routeQuestions(b, j, t.st.caller), b.routing.timeoutMs);
  const ms = Date.now() - started;
  const reading = readRoute(asked.answers);
  const route = decideRoute(b, j, reading, openJourneys(b, t.st.caller));
  return {
    next: route.next,
    route: {
      from: j.active,
      to: route.next.active,
      outcome: route.outcome,
      task: reading.task,
      ...(reading.drops !== null ? { drops: reading.drops } : {}),
      ...(reading.again !== null ? { again: reading.again } : {}),
      ms,
      ...(asked.answers === null && asked.why === 'late' ? { timedOut: true as const } : {}),
      ...(route.droppedPaused !== undefined ? { droppedPaused: route.droppedPaused } : {}),
    },
  };
}

export async function converseTurn(s: ConverseState, input: Input, deps: ConverseDeps, out: Out): Promise<ConverseState> {
  if (s.ended !== undefined) return s;
  const st = structuredClone(s);
  const now = deps.now();
  const t: Turn = {
    st,
    deps,
    out,
    t0: Date.now(),
    todayIso: localDateIso(now.getTime(), businessZone(deps.business)),
    replies: [],
    tools: [],
    model: { id: deps.model.id, ms: 0, firstTextMs: null, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: null },
    masked: [],
    confirmedRan: false,
    ending: false,
    own: [],
    correcting: false,
    carriedNote: false,
    carriedNoteDropped: false,
  };
  const sp = new Speaker(t);
  if (input.kind === 'start') {
    if (hasJourneys(deps.business)) st.journey = initialJourney(deps.business, st.caller);
    const greeting = deps.business.lines.greeting.en;
    sp.line(greeting);
    add(st, 'assistant', [{ type: 'text', text: greeting }]);
  } else if (input.kind === 'left') {
    // The caller left: a read-back waiting for an answer is dropped, and nothing runs.
    const pending = st.pending?.action ?? null;
    st.pending = null;
    // A note carried for the model is dropped with the call.
    delete st.carriedNote;
    st.ended = 'left';
    await record(t, { type: 'converse_left', detail: { pending } });
  } else {
    const routed = hasJourneys(deps.business);
    // A state saved before journeys starts where its call would have.
    if (routed) st.journey ??= initialJourney(deps.business, st.caller);
    const lastReply = routed ? lastReplyOf(st) : null;
    let ran = false;
    if (st.pending !== null) ran = await answered(t, input.text);
    else add(st, 'user', [{ type: 'text', text: neutralised(input.text) }]);
    // A yes that ran its action is not routed: the caller answered the read-back, and the journey moved on by it.
    // Any other answer to a read-back is routed on the same words, alongside the model's first round.
    const routing = routed && !ran ? routeOf(t, st.journey!, input.text, lastReply) : undefined;
    const carried = st.carriedNote;
    if (carried !== undefined) {
      // The check after speaking's note carried from a turn that ended on a read-back: after this message's
      // own content (the caller's words, or what came of the read-back), in the same message, never neutralised.
      add(st, 'user', [{ type: 'text', text: carried }]);
      delete st.carriedNote;
      t.carriedNote = true;
    }
    await converse(t, sp, false, carried, routing);
    await checkAfterSpeaking(t, sp);
  }
  // What the line said, as the trace keeps it: every value of the turn's calls that is recorded masked, masked there too.
  const scrub = scrubberOfValues(t.masked);
  const scrubbed = (text: string): string => (scrub === null ? text : scrub(text));
  out.scrubbed?.(scrubbed);
  deps.trace({
    v: 3,
    kind: 'converse',
    sessionId: st.callId,
    turnIndex: st.turnIndex,
    ts: now.toISOString(),
    said: input.kind === 'text' ? input.text : null,
    replies: t.replies.map(scrubbed),
    tools: t.tools,
    model: { ...t.model, costUsd: input.kind === 'text' ? costUsd(deps.model.id, t.model.usage) : null },
    ...(t.readBack !== undefined ? { readBack: { ...t.readBack, text: scrubbed(t.readBack.text) } } : {}),
    ...(t.check !== undefined ? { check: t.check } : {}),
    ...(t.carriedNote ? { carriedNote: true as const } : {}),
    ...(t.carriedNoteDropped ? { carriedNoteDropped: true as const } : {}),
    ...(t.route !== undefined ? { route: t.route } : {}),
    ...(t.journeyEnded !== undefined ? { journeyEnded: t.journeyEnded } : {}),
  });
  st.turnIndex += 1;
  return st;
}
