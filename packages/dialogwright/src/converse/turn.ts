import type { AuditDraft } from '../audit/types';
import { chainDrafts, type AuditSink } from '../audit/sink';
import { RULE_ID, type CompiledPolicy } from '../gate/compiled';
import { confirmationHash } from '../gate/lines';
import { passed, type GateDecision, type GateFacts, type ToolCall } from '../gate/types';
import type { JevClient } from '../jev/types';
import { localDateIso } from '../core/localDate';
import type { Texts } from '../texts/types';
import { checkArgs, idempotencyKey } from './actions';
import type { ActionSpec, AgentBusiness } from './business/schema';
import { isConfirmed, readBackText, readYesNo, type PendingReadBack } from './confirm';
import type { ConverseModel, ModelContent, ModelEvent, ModelMessage, ModelRequest } from './model/types';
import { costUsd } from './model/price';
import { CALLER, confirmedFields, NO_LOOKUPS } from './policy';
import { systemPrompt, toolsOf } from './prompt';
import { SentenceBuffer } from './sentences';
import { businessZone, type ConverseState } from './state';
import { recordedArgs, scrubOf, type ConverseToolOutcome, type ConverseTraceRecord } from './trace';

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
 * - a model that errs, is slow or says nothing is asked once more while half its time is left; else the
 *   line says the recovery line, and once the call's failure budget is spent, the handoff line.
 */

/** Model rounds per turn of the caller: each round's tool results go back to the model for the next. */
export const MAX_ROUNDS = 4;

/** An action's code: it does the work with the checked params; the gate has already decided it may. */
export type ToolImpl = (params: Record<string, string>, ctx: { key: string; texts: Texts | null; caller: ConverseState['caller'] }) => Promise<unknown>;

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
  /** How long the decision model may take to read the caller's answer to a read-back. */
  jevTimeoutMs: number;
}

/** Where a turn's words go: each piece of a reply as it is ready (`final` on the last of the turn's), and the call's end. */
export interface Out {
  say(text: string, final: boolean): void;
  end(how: 'closing' | 'handoff'): void;
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
}

/** A reply's words to the caller: model text in sentences as it streams, and fixed lines whole. Exactly one piece of a turn is final. */
class Speaker {
  private sentences = new SentenceBuffer();
  /** What the current round has said so far. */
  private said = '';

  constructor(private readonly t: Turn) {}

  delta(d: string): void {
    if (this.t.model.firstTextMs === null) this.t.model.firstTextMs = Date.now() - this.t.t0;
    for (const s of this.sentences.push(d)) {
      this.t.out.say(s, false);
      this.said += s;
    }
  }

  /** Whether the current round has said anything yet. */
  get spoke(): boolean {
    return this.said !== '';
  }

  /** The round's text ends: what is left is said (final, when the reply ends with it); the round's whole text is returned. */
  endRound(final: boolean): string {
    const rest = this.sentences.rest();
    if (final) this.t.out.say(rest.trim() === '' ? '' : rest, true);
    else if (rest.trim() !== '') this.t.out.say(rest, false);
    const all = (this.said + rest).trim();
    this.said = '';
    if (all !== '') this.t.replies.push(all);
    return all;
  }

  /** The round failed: what was not yet said is dropped; what was said is returned. */
  abandon(): string {
    this.sentences.rest();
    const all = this.said.trim();
    this.said = '';
    if (all !== '') this.t.replies.push(all);
    return all;
  }

  /** A fixed line, said whole as the turn's final piece. */
  line(text: string): void {
    this.t.out.say(text, true);
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

/** Runs an action the gate allowed, with the call's key; a throw is the action's failure, said to the model. */
async function runTool(t: Turn, name: string, params: Record<string, string>): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const impl = Object.hasOwn(t.deps.tools, name) ? t.deps.tools[name] : undefined;
  if (impl === undefined) return { ok: false, error: `the action "${name}" has no code` };
  try {
    return { ok: true, result: await impl(params, { key: idempotencyKey(t.st.callId, name, params), texts: t.deps.texts, caller: t.st.caller }) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** A call in the turn's trace: its params as recorded, and its reason with any raw value of a masked param replaced as the params are. */
function traceTool(t: Turn, spec: ActionSpec | undefined, name: string, args: Record<string, unknown>, outcome: ConverseToolOutcome, reason?: string): void {
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) raw[k] = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  const scrub = scrubOf(spec, { tool: name, params: raw });
  t.tools.push({ name, args: recordedArgs(spec, args), outcome, ...(reason !== undefined ? { reason: scrub(reason) } : {}) });
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
    if (t.st.pending !== null) {
      const why = `Not run: one confirmation at a time. The caller is answering the read-back of "${t.st.pending.action}"; call this again after their answer.`;
      await record(t, { type: 'converse_refused', detail: { action: c.name, reason: 'one-confirmation-at-a-time', pending: t.st.pending.action } });
      traceTool(t, spec, c.name, c.args, 'refused', why);
      error(c.id, refused(t, c.name, why));
      continue;
    }
    let params: Record<string, string> = {};
    if (spec !== undefined) {
      const checked = checkArgs(spec, c.args, t.st.seen, t.todayIso);
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
      const text = readBackText(b, c.name, params, 'en', t.st.seen);
      t.st.pending = { action: c.name, params, hash: confirmationHash(params, confirmedFields(spec)), text, id: c.id };
      t.readBack = { text };
      traceTool(t, spec, c.name, params, 'readBack');
      readBack = text;
      continue;
    }
    if (d.verdict !== 'ALLOW') {
      const why = gateReason(d, spec, call, Object.keys(b.actions));
      traceTool(t, spec, c.name, spec === undefined ? c.args : params, 'refused', why);
      error(c.id, refused(t, c.name, why));
      continue;
    }
    const ran = await runTool(t, c.name, params);
    if (!ran.ok) {
      traceTool(t, spec, c.name, params, 'ran', `failed: ${ran.error}`);
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

type Round = { ok: true; calls: Extract<ModelEvent, { type: 'tool_call' }>[]; text: string } | { ok: false; error: string; spoke: boolean };

const TIMED_OUT = Symbol('timed out');

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
 * thrown stream, nothing at all, or no event within `firstWaitMs` at first and the model's time after.
 */
async function streamOnce(t: Turn, sp: Speaker, req: ModelRequest, firstWaitMs: number): Promise<Round> {
  const controller = new AbortController();
  const started = Date.now();
  const iter = t.deps.model.stream(req, controller.signal)[Symbol.asyncIterator]();
  const calls: Extract<ModelEvent, { type: 'tool_call' }>[] = [];
  let text = '';
  let wait = firstWaitMs;
  const fail = (error: string): Round => {
    controller.abort();
    void Promise.resolve(iter.return?.()).catch(() => undefined);
    return { ok: false, error, spoke: sp.spoke };
  };
  try {
    for (;;) {
      let next: IteratorResult<ModelEvent> | typeof TIMED_OUT;
      try {
        next = await within(iter.next(), wait);
      } catch (e) {
        return fail(`invalid: the stream threw (${e instanceof Error ? e.name : 'error'})`);
      }
      if (next === TIMED_OUT) return fail(`timeout: no answer within ${wait} ms`);
      if (next.done) break;
      wait = t.deps.business.model.timeoutMs;
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
        break;
      } else return fail(`${ev.kind}: ${ev.detail}`);
    }
  } finally {
    t.model.ms += Date.now() - started;
  }
  if (text.trim() === '' && calls.length === 0) return fail('empty: the model said nothing and called nothing');
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

/** One round: the request, and once more if it failed before saying anything while half the model's time is left. */
async function round(t: Turn, sp: Speaker): Promise<Round> {
  const b = t.deps.business;
  const req: ModelRequest = { system: systemPrompt(b, t.st, t.deps.now()), messages: requestMessages(t.st), tools: toolsOf(b), maxTokens: b.model.maxTokens };
  const budget = b.model.timeoutMs;
  const start = Date.now();
  let r = await streamOnce(t, sp, req, budget);
  if (r.ok) return r;
  t.model.error = r.error;
  if (!r.spoke && budget - (Date.now() - start) >= budget / 2) {
    // Nothing was said: the words of a sentence not yet finished are dropped, and the model asked again.
    sp.abandon();
    t.model.retried = true;
    r = await streamOnce(t, sp, req, budget - (Date.now() - start));
    if (!r.ok) t.model.error = r.error;
  }
  return r;
}

/** The model failed the turn: the recovery line, or past the call's budget the handoff line, and the call ends with a person. */
function failed(t: Turn, sp: Speaker): void {
  const lines = t.deps.business.lines;
  t.st.failures += 1;
  const handoff = t.st.failures >= t.deps.business.limits.failuresPerCall;
  const line = handoff ? lines.handoff.en : lines.recovery.en;
  sp.line(line);
  add(t.st, 'assistant', [{ type: 'text', text: line }]);
  if (handoff) {
    t.st.ended = 'handoff';
    t.out.end('handoff');
  }
}

/** The model asked, round after round, until it replies with no call, a change is read back, or it fails. */
async function converse(t: Turn, sp: Speaker): Promise<void> {
  for (let i = 0; i < MAX_ROUNDS; i++) {
    const r = await round(t, sp);
    if (!r.ok) {
      const said = sp.abandon();
      if (said !== '') add(t.st, 'assistant', [{ type: 'text', text: said }]);
      failed(t, sp);
      return;
    }
    const final = r.calls.length === 0;
    const said = sp.endRound(final);
    add(t.st, 'assistant', [...(said !== '' ? [{ type: 'text' as const, text: said }] : []), ...r.calls.map((c) => ({ type: 'tool_call' as const, id: c.id, name: c.name, args: c.args }))]);
    if (final) return;
    const { results, readBack } = await runCalls(t, r.calls);
    add(t.st, 'user', results);
    if (readBack !== null) {
      sp.line(readBack);
      return;
    }
  }
  failed(t, sp);
}

/** A confirmed action through the gate with the hash of its own values, run when allowed. */
async function runConfirmed(t: Turn, name: string, params: Record<string, string>, hash: string): Promise<{ ok: boolean; text: string; why?: string }> {
  const spec = t.deps.business.actions[name];
  const call: ToolCall = { tool: name, params };
  const d = await gate(t, spec, call, confirmedHashFor(call, { action: name, params, hash, text: '', id: '' }));
  if (d.verdict !== 'ALLOW') {
    const why = gateReason(d, spec, call, Object.keys(t.deps.business.actions));
    return { ok: false, text: refused(t, name, why), why };
  }
  const ran = await runTool(t, name, params);
  return ran.ok ? { ok: true, text: resultText(ran.result) } : { ok: false, text: `Failed: ${ran.error}`, why: `failed: ${ran.error}` };
}

/** The caller answered a read-back: a clear yes runs the action and its follow-ons; anything else goes back to the model. */
async function answered(t: Turn, said: string): Promise<void> {
  const p = t.st.pending!;
  t.st.pending = null;
  const b = t.deps.business;
  const spec = b.actions[p.action];
  const reading = await readYesNo(t.deps.jev, p.text, said, t.deps.jevTimeoutMs);
  const yes = isConfirmed(reading);
  t.readBack = { text: p.text, ...(reading !== null ? { yes: reading.yes, no: reading.no } : {}), confirmed: yes };
  const heard = `The line read back: "${p.text}"`;
  if (!yes) {
    traceTool(t, spec, p.action, p.params, 'notConfirmed');
    add(t.st, 'user', [{ type: 'tool_result', id: p.id, content: `${heard} The caller did not confirm; they said: '${said}'` }]);
    return;
  }
  await record(t, { type: 'confirmed', detail: { action: p.action, hash: p.hash, yes: reading!.yes, no: reading!.no } });
  const parent = await runConfirmed(t, p.action, p.params, p.hash);
  traceTool(t, spec, p.action, p.params, parent.ok ? 'confirmed' : 'refused', parent.why);
  const done = [`${p.action}: ${parent.text}`];
  // Follow-ons run only after their parent ran, each with the parent's confirmed values by name (agent.yaml's
  // check makes every param a follow-on takes one its parent has), its own hash, and a row naming the yes.
  for (const name of parent.ok ? spec?.then ?? [] : []) {
    const follow = b.actions[name];
    if (follow === undefined) continue;
    const checked = checkArgs(follow, Object.fromEntries(Object.keys(follow.params).map((k) => [k, p.params[k] ?? ''])), t.st.seen, t.todayIso);
    if (!checked.ok) {
      traceTool(t, follow, name, {}, 'invalid', checked.reason);
      done.push(`${name}: not run (${checked.reason})`);
      continue;
    }
    const hash = confirmationHash(checked.params, confirmedFields(follow));
    await record(t, { type: 'confirmed', detail: { action: name, parent: p.action, parentHash: p.hash, hash } });
    const ran = await runConfirmed(t, name, checked.params, hash);
    traceTool(t, follow, name, checked.params, ran.ok ? 'ran' : 'refused', ran.why);
    done.push(`${name}: ${ran.text}`);
  }
  add(t.st, 'user', [{ type: 'tool_result', id: p.id, content: `${heard} The caller confirmed; done: ${done.join('; ')}. They said: '${said}'`, ...(parent.ok ? {} : { isError: true }) }]);
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
  };
  const sp = new Speaker(t);
  if (input.kind === 'start') {
    const greeting = deps.business.lines.greeting.en;
    sp.line(greeting);
    add(st, 'assistant', [{ type: 'text', text: greeting }]);
  } else if (input.kind === 'left') {
    // The caller left: a read-back waiting for an answer is dropped, and nothing runs.
    const pending = st.pending?.action ?? null;
    st.pending = null;
    st.ended = 'left';
    await record(t, { type: 'converse_left', detail: { pending } });
  } else {
    if (st.pending !== null) await answered(t, input.text);
    else add(st, 'user', [{ type: 'text', text: input.text }]);
    await converse(t, sp);
  }
  deps.trace({
    v: 3,
    kind: 'converse',
    sessionId: st.callId,
    turnIndex: st.turnIndex,
    ts: now.toISOString(),
    said: input.kind === 'text' ? input.text : null,
    replies: t.replies,
    tools: t.tools,
    model: { ...t.model, costUsd: input.kind === 'text' ? costUsd(deps.model.id, t.model.usage) : null },
    ...(t.readBack !== undefined ? { readBack: t.readBack } : {}),
  });
  st.turnIndex += 1;
  return st;
}
