import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRelay } from '../fakeRelay';
import { RESUMED_TEXT } from '../../server/adapter';
import { verifyPostgresAudit } from '../../audit/postgres';
import type { AuditEntry } from '../../audit/types';
import type { SqlQueryable } from '../../server/stores/sql';
import { parseSegmentName, type S3TraceReader } from '../../trace/store';

/**
 * The takeover driver: a carrier's call placed through a load balancer onto two servers sharing one
 * Postgres and one S3-compatible store, the server holding it made to go (killed, or stopped and drained),
 * and the carrier's reconnect, which another server takes over. It asserts what the in-process test
 * (server/manyServers.e2e.test.ts) asserts: no turn dropped or run twice, the question the caller was on
 * asked again, no tool run (and no write made) twice, one trace joined from both servers' segments, one audit chain that
 * verifies with its newest entry anchored, and the surviving server's console having followed the call.
 *
 * It runs against any `Stack`: two servers in this process (inProcess.ts, the engine's tests and
 * `pnpm multi:test --in-process`) or the compose stack's containers (compose.ts, `pnpm multi:test`), so
 * what the compose run does is what the suite has already run. The call is the app's own: a scripted
 * call from its fixtures (`scriptFromScenario`), each line in its corpus so the stub client answers it.
 */

export type Carrier = 'twilio' | 'telnyx';
export const CARRIERS: readonly Carrier[] = ['twilio', 'telnyx'];
/** How the server holding the call goes: `crash` (killed, no drain) or `drain` (stopped: SIGTERM, the drain). */
export type Going = 'crash' | 'drain';
export const GOINGS: readonly Going[] = ['crash', 'drain'];

/**
 * The settings every server of the two-server stack runs with, beside its stores, its keys and its
 * name: the compose file's app services carry exactly these (a test holds them to it), and the
 * in-process stack starts its servers with them, so the two run alike.
 */
export const MULTI_SERVER_ENV: Readonly<Record<string, string>> = {
  // A placeholder: the carrier's start document names it, and the driver sends its sockets to the balancer.
  PUBLIC_HOST: 'voice.example.com',
  VOICE_PROVIDERS: 'twilio,telnyx',
  // The driver signs nothing: it is the carrier.
  SIGNATURE_CHECK: 'off',
  HANDOFF_NUMBER: '+15555550100',
  // The day the apps' scripted calls are written for.
  TODAY_OVERRIDE: '2026-09-18',
  // No re-prompt while the driver waits on a server: every turn is a line the script says.
  NO_INPUT_MS: '0',
  // The driver reads each server's console from outside it (a test stack, its ports on 127.0.0.1 only).
  CONSOLE_LOCAL_ONLY: 'off',
  CALL_LEASE_MS: '5000',
  // A stopping server says 503 on /ready for this long while still answering new calls, before its drain:
  // longer than HAProxy takes to see it (a check every 500 ms, down at the first failure).
  DRAIN_UNREADY_MS: '2000',
  // How long the drain waits for live calls before it hands them on.
  DRAIN_MS: '4000',
  // With several servers a drained call goes straight to another.
  RESTART_PAUSE_S: '0',
  TRACE_STORE: 's3://call-traces/multi',
  S3_REGION: 'us-east-1',
  S3_FORCE_PATH_STYLE: 'on',
};

/** The servers of the stack, by the name each runs as (SERVER_ID). */
export const MULTI_SERVERS: readonly string[] = ['app-a', 'app-b'];

/** A call, as the driver places it. */
export interface CallScript {
  /** What the caller says, one turn each, in order. */
  says: readonly string[];
  /** How many of them are said before the server holding the call goes: at least one, and fewer than all. */
  goAfter: number;
  /** The `end`'s reasonCode the call finishes with; default `completed`. */
  endReason?: string;
  /** The line a call taken over after a crash hears before the question; default the engine's RESUMED_TEXT. */
  resumed?: string;
}

/** The two servers, the balancer in front of them, and what they share. */
export interface Stack {
  /** The balancer: where the carrier sends webhooks (`base`) and sockets (`ws`). */
  readonly lb: { readonly base: string; readonly ws: string };
  /** The servers' names (SERVER_ID), two. */
  readonly servers: readonly string[];
  /** A server's own address, past the balancer: its console. */
  direct(name: string): string;
  /** The database the servers share. */
  readonly sql: SqlQueryable;
  /** The trace store the servers share. */
  readonly traces: S3TraceReader;
  /** The server dies, with no drain; resolves once it is gone. */
  kill(name: string): Promise<void>;
  /** The server is stopped as a deploy stops it (SIGTERM): it drains and exits; resolves once it has. */
  stop(name: string): Promise<void>;
  /** The server is started again; resolves once its /ready says 200. */
  start(name: string): Promise<void>;
  /** Everything the server has logged, every run of it. */
  logs(name: string): Promise<string>;
}

export interface DriverOptions {
  /** A turn's reply is over once nothing more has come for this long; default 400 ms. */
  quietMs?: number;
  /** The longest any one wait may take; default 20 s. */
  timeoutMs?: number;
  /** Where the driver says each step. */
  log?: (line: string) => void;
}

/** What one takeover found. */
export interface TakeoverReport {
  callSid: string;
  carrier: Carrier;
  going: Going;
  /** The server that held the call and went. */
  holder: string;
  /** The server that took it over. */
  survivor: string;
  /** The first line the caller heard on the survivor. */
  heard: string;
}

/** A check that failed: what was expected and what was found. */
export class TakeoverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TakeoverError';
  }
}

function expectThat(ok: boolean, what: string): asserts ok {
  if (!ok) throw new TakeoverError(what);
}

/** The server a lease owner names: its SERVER_ID, without the random suffix each process adds. */
export function serverOf(owner: string): string {
  return owner.replace(/-[0-9a-f]{8}$/, '');
}

/** A call's id as its trace folder is named. */
export const stemOf = (callSid: string): string => callSid.replace(/[^A-Za-z0-9_-]/g, '_');

/**
 * A scripted call from an app's fixtures (`<app>/fixtures/scenarios/*.json`) as the driver places it:
 * its spoken steps, in order. Refused when the call has a silence or keys (the driver speaks only), when
 * it does not end the call (its `expect.decision` is not `complete`), or when `goAfter` leaves no turn
 * on one side of the takeover.
 */
export function scriptFromScenario(appDir: string, id: string, goAfter: number): CallScript {
  const dir = join(appDir, 'fixtures', 'scenarios');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const scenarios = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { id: string; steps?: Record<string, unknown>[]; expect?: { decision?: string } }[];
    const found = scenarios.find((s) => s.id === id);
    if (found === undefined) continue;
    const steps = found.steps ?? [];
    const says = steps.map((s) => s.say);
    if (says.some((s) => typeof s !== 'string') || steps.some((s) => Object.keys(s).some((k) => k !== 'say'))) {
      throw new TakeoverError(`scenario ${id} (${file}) has a step that is not a line said (a silence or keys): the driver speaks only`);
    }
    if (found.expect?.decision !== 'complete') throw new TakeoverError(`scenario ${id} (${file}) does not end the call (expect.decision is ${found.expect?.decision ?? 'unset'}, not complete)`);
    if (!Number.isInteger(goAfter) || goAfter < 1 || goAfter >= says.length) {
      throw new TakeoverError(`--go-after ${goAfter}: scenario ${id} has ${says.length} lines; the server goes after 1 to ${says.length - 1} of them`);
    }
    return { says: says as string[], goAfter };
  }
  throw new TakeoverError(`no scenario ${id} in ${dir}`);
}

/** A call id of the carrier's shape, new each time. */
export function newCallSid(carrier: Carrier): string {
  const hex = randomBytes(16).toString('hex');
  return carrier === 'telnyx' ? `v2:multi-${hex}` : `CA${hex}`;
}

const form = (params: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(params).toString(),
});

/** The socket a start document names, reached through the balancer (the document says wss://PUBLIC_HOST). */
export function socketUrl(doc: string, ws: string): string {
  const m = /url="wss:\/\/[^/"]+(\/conversation\/[a-z]+)\?token=([0-9a-f]{32})"/.exec(doc);
  if (!m) throw new TakeoverError(`not a start document: ${doc.slice(0, 300)}`);
  return `${ws}${m[1]}?token=${m[2]}`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Until `probe` answers something other than undefined, every 100 ms, or a TakeoverError naming `what` after `ms`. */
export async function until<T>(probe: () => Promise<T | undefined> | T | undefined, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown = null;
  for (;;) {
    try {
      const v = await probe();
      if (v !== undefined) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new TakeoverError(`timed out after ${ms} ms waiting for ${what}${last instanceof Error ? ` (last: ${last.message})` : ''}`);
    await sleep(100);
  }
}

/** A turn's reply: once at least one more line has come, and then nothing for `quietMs`; the lines it said. */
async function reply(relay: FakeRelay, before: number, o: Required<Pick<DriverOptions, 'quietMs' | 'timeoutMs'>>, what: string): Promise<string[]> {
  try {
    await relay.waitFor(() => relay.texts().length > before, o.timeoutMs);
  } catch {
    throw new TakeoverError(`no reply to ${what} within ${o.timeoutMs} ms; heard so far: ${JSON.stringify(relay.texts())}`);
  }
  let seen = relay.received.length;
  for (;;) {
    await sleep(o.quietMs);
    if (relay.received.length === seen) break;
    seen = relay.received.length;
  }
  return relay.texts().slice(before);
}

/** A console's live feed on one server (its /dashboard/events): the events it has sent so far. */
interface Feed {
  events: { type: string; callSid?: string; record?: { turnIndex?: number } }[];
  close(): void;
}

async function consoleFeed(base: string): Promise<Feed> {
  const ac = new AbortController();
  const res = await fetch(`${base}/dashboard/events`, { signal: ac.signal });
  expectThat(res.ok && res.body !== null, `the console's live feed at ${base}/dashboard/events answered ${res.status}`);
  const events: Feed['events'] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let at: number;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const data = block.split('\n').find((l) => l.startsWith('data: ') && !block.startsWith('event:'));
          if (data) events.push(JSON.parse(data.slice('data: '.length)) as Feed['events'][number]);
        }
      }
    } catch {
      // Closed.
    }
  })();
  return { events, close: () => ac.abort() };
}

/** The turn indexes of a call's joined trace (a record written after its server let the call go left out), and the servers whose segments it joins. */
export async function joinedTurns(traces: S3TraceReader, callSid: string): Promise<{ turns: number[]; servers: string[] }> {
  const stem = stemOf(callSid);
  const joined = await traces.read(stem);
  const records = (joined?.trace ?? []).map((l) => JSON.parse(l) as { turnIndex: number; outlivedHold?: true });
  const { objects } = await traces.client.list(traces.prefix);
  const servers = objects
    .filter((o) => o.key.includes(`/${stem}/`) && o.key.endsWith('.trace.jsonl'))
    .map((o) => parseSegmentName(o.key.split('/').at(-1)!))
    .filter((s) => s !== null)
    .map((s) => serverOf(s.server));
  return { turns: records.filter((r) => !r.outlivedHold).map((r) => r.turnIndex), servers: [...new Set(servers)].sort() };
}

/** Whether `turns` is 1 to `n`, each once, in order. */
export function turnsAreWhole(turns: readonly number[], n: number): boolean {
  return turns.length === n && turns.every((t, i) => t === i + 1);
}

/** The call's audit chain, after the whole audit has verified: every chain, every server's anchors for every day, every roster. */
export async function verifiedChain(sql: SqlQueryable, callSid: string): Promise<AuditEntry[]> {
  const { breaks } = await verifyPostgresAudit(sql);
  expectThat(breaks.length === 0, `the audit does not verify: ${breaks.slice(0, 5).join('; ')}`);
  const chain = (await sql.query<{ body: string }>('SELECT body FROM dw_audit_entries WHERE chain = $1 ORDER BY seq', [callSid])).rows.map((r) => JSON.parse(r.body) as AuditEntry);
  expectThat(chain.length > 0, `no audit chain for ${callSid}`);
  const newest = chain.at(-1)!;
  const anchored = await sql.query<{ body: string }>('SELECT body FROM dw_audit_anchors');
  expectThat(
    anchored.rows.some((r) => {
      const a = JSON.parse(r.body) as { callId?: string; callSeq?: number; callHash?: string };
      return a.callId === callSid && a.callSeq === newest.seq && a.callHash === newest.hash;
    }),
    `the newest entry of ${callSid}'s audit chain (seq ${newest.seq}) is not anchored`,
  );
  return chain;
}

/**
 * The tool results the call's audit chain holds more than once: a turn run twice (by the server that went
 * and again by the one that took it over) would run its tools, and write, twice. The scripted calls the
 * stack places run each tool once (an app whose call runs one tool twice on purpose needs another script).
 */
export function repeatedResults(chain: readonly AuditEntry[]): string[] {
  const seen = new Map<string, number>();
  for (const e of chain.filter((x) => x.type === 'tool_result')) {
    const key = JSON.stringify(e.detail);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen].filter(([, n]) => n > 1).map(([k]) => k);
}

/**
 * One takeover: a call placed through the balancer, `goAfter` lines said, the server holding it made to
 * go, the carrier's reconnect taken by the other, the rest said, and every check made. The stack is left
 * with the server that went still down: `start` it for the next.
 */
export async function takeover(stack: Stack, carrier: Carrier, going: Going, script: CallScript, o: DriverOptions = {}): Promise<TakeoverReport> {
  const opts = { quietMs: o.quietMs ?? 400, timeoutMs: o.timeoutMs ?? 20_000 };
  const say = (line: string): void => o.log?.(`[${carrier} ${going}] ${line}`);
  expectThat(stack.servers.length === 2, `the stack has ${stack.servers.length} servers, not two`);
  expectThat(script.goAfter >= 1 && script.goAfter < script.says.length, `goAfter ${script.goAfter} leaves no turn on one side of the takeover (${script.says.length} lines)`);
  const relays: FakeRelay[] = [];
  const feeds: Feed[] = [];
  try {
    // A console open on every server before the call, as an operator's would be.
    const feedOf = new Map<string, Feed>();
    for (const name of stack.servers) {
      const feed = await consoleFeed(stack.direct(name));
      feeds.push(feed);
      feedOf.set(name, feed);
    }
    const callSid = newCallSid(carrier);
    say(`call ${callSid}`);
    const start = await fetch(`${stack.lb.base}/voice/${carrier}`, form({ CallSid: callSid, From: '+15555550110', To: '+15555550111', CallStatus: 'ringing' }));
    const relay = await FakeRelay.connect(socketUrl(await start.text(), stack.lb.ws));
    relays.push(relay);
    relay.setup(callSid);
    await reply(relay, 0, opts, 'the setup (the greeting)');
    for (const line of script.says.slice(0, script.goAfter)) {
      const n = relay.texts().length;
      relay.prompt(line);
      await reply(relay, n, opts, JSON.stringify(line));
    }
    const question = relay.texts().at(-1)!;
    say(`asked: ${question}`);

    // Which server holds it, and that its turns so far are saved and traced before it goes.
    const owner = await until(async () => (await stack.sql.query<{ owner: string }>('SELECT owner FROM dw_call_leases WHERE call_id = $1', [callSid])).rows[0]?.owner, opts.timeoutMs, `${callSid}'s lease`);
    const holder = serverOf(owner);
    expectThat(stack.servers.includes(holder), `the lease's owner ${owner} is none of the servers (${stack.servers.join(', ')})`);
    const survivor = stack.servers.find((n) => n !== holder)!;
    await until(async () => ((await stack.sql.query('SELECT call_id FROM dw_calls WHERE call_id = $1', [callSid])).rows.length === 1 ? true : undefined), opts.timeoutMs, `${callSid} saved`);
    const before = script.goAfter + 1;
    await until(async () => (turnsAreWhole((await joinedTurns(stack.traces, callSid)).turns, before) ? true : undefined), opts.timeoutMs, `turns 1 to ${before} in the trace store`);
    say(`${holder} holds it; ${going === 'crash' ? 'killing' : 'stopping'} ${holder}`);

    let stopped: Promise<void> | null = null;
    if (going === 'crash') await stack.kill(holder);
    else {
      stopped = stack.stop(holder);
      await newCallsWhileStopping(stack.direct(holder), carrier, say, opts.timeoutMs);
    }
    const closed = await Promise.race([relay.closed, sleep(opts.timeoutMs).then(() => null)]);
    expectThat(closed !== null, `the carrier's socket was not closed within ${opts.timeoutMs} ms of ${holder} going`);
    // A crash drops the socket with no close frame (1006); a drain closes it as going away (1001).
    const code = going === 'crash' ? 1006 : 1001;
    expectThat(closed.code === code, `the carrier's socket closed with ${closed.code}, not ${code}`);

    // The carrier's reconnect: its callback, then its socket, each through the balancer.
    const callback = await (await fetch(`${stack.lb.base}/cr-action/${carrier}`, form({ CallSid: callSid, CallStatus: 'in-progress', SessionStatus: 'failed' }))).text();
    expectThat(callback.includes('<ConversationRelay') && !callback.includes('<Dial>'), `the callback did not connect the call again: ${callback.slice(0, 300)}`);
    const again = await FakeRelay.connect(socketUrl(callback, stack.lb.ws));
    relays.push(again);
    again.setup(callSid, 'VX-after');
    const [heard] = await reply(again, 0, opts, 'the reconnect');
    const resumed = `${script.resumed ?? RESUMED_TEXT} ${question}`;
    // A crash always hears the line (its caller's silence began before anything measured it); a drain's
    // quick hand-off may pass unnoticed (RESUMED_AFTER_MS).
    if (going === 'crash') expectThat(heard === resumed, `after the crash the caller heard ${JSON.stringify(heard)}, not ${JSON.stringify(resumed)}`);
    else expectThat(heard === question || heard === resumed, `after the drain the caller heard ${JSON.stringify(heard)}, not the question again (${JSON.stringify(question)})`);
    say(`heard on ${survivor}: ${heard}`);

    const rest = script.says.slice(script.goAfter);
    for (const [i, line] of rest.entries()) {
      const n = again.texts().length;
      again.prompt(line);
      if (i < rest.length - 1) await reply(again, n, opts, JSON.stringify(line));
    }
    const end = await again.waitFor((m) => m.type === 'end', opts.timeoutMs).catch(() => null);
    expectThat(end !== null, `the call did not end; heard: ${JSON.stringify(again.texts())}`);
    const reason = (JSON.parse(String(end.handoffData ?? '{}')) as { reasonCode?: string }).reasonCode;
    expectThat(reason === (script.endReason ?? 'completed'), `the call ended with ${String(end.handoffData)}, not ${script.endReason ?? 'completed'}`);
    relay.assertKnownTypes();
    again.assertKnownTypes();
    if (stopped !== null) await stopped;

    // The call is over: nothing of it left in the tables.
    await until(async () => {
      const calls = await stack.sql.query('SELECT call_id FROM dw_calls WHERE call_id = $1', [callSid]);
      const leases = await stack.sql.query('SELECT call_id FROM dw_call_leases WHERE call_id = $1', [callSid]);
      return calls.rows.length === 0 && leases.rows.length === 0 ? true : undefined;
    }, opts.timeoutMs, `${callSid} gone from dw_calls and dw_call_leases`);

    // The survivor took it over, as the holder's going says; a drained holder let it go itself.
    const why = going === 'crash' ? 'its carrier reconnected since' : 'given up by a stopping server';
    const tookOver = `${callSid}: taken over from the session store (turn ${before}, reconnect 1, ${why}) by ${survivor}-`;
    await until(async () => ((await stack.logs(survivor)).includes(tookOver) ? true : undefined), opts.timeoutMs, `${survivor}'s log to say "${tookOver}..."`);
    if (going === 'drain') {
      const letGo = `${callSid}: let go: its socket closed, and the server its carrier reconnects to takes it`;
      expectThat((await stack.logs(holder)).includes(letGo), `${holder}'s log does not say "${letGo}"`);
    }

    // One trace, both servers' segments joined, every turn once and in order.
    const all = script.says.length + 1;
    const joined = await until(async () => {
      const t = await joinedTurns(stack.traces, callSid);
      return turnsAreWhole(t.turns, all) ? t : undefined;
    }, opts.timeoutMs, `the joined trace to hold turns 1 to ${all}, each once`);
    expectThat(JSON.stringify(joined.servers) === JSON.stringify([holder, survivor].sort()), `the trace's segments are from ${joined.servers.join(', ')}, not ${holder} and ${survivor}`);

    // One audit chain for the call, begun by the holder and ended by the survivor, that verifies.
    const chain = await verifiedChain(stack.sql, callSid);
    expectThat(chain[0]!.type === 'call_started', `${callSid}'s audit chain begins with ${chain[0]!.type}, not call_started`);
    expectThat(chain.filter((e) => e.type === 'call_started').length === 1, `${callSid}'s audit chain has more than one call_started`);
    expectThat(chain.filter((e) => e.type !== 'handoff_summary').at(-1)!.type === 'call_ended', `${callSid}'s audit chain does not end with call_ended`);
    const twice = repeatedResults(chain);
    expectThat(twice.length === 0, `a tool ran twice in ${callSid}'s audit: ${twice.join('; ')}`);
    const tools = chain.filter((e) => e.type === 'tool_result').map((e) => String(e.detail.tool));
    say(`tools run, once each: ${tools.length > 0 ? tools.join(', ') : 'none'}`);

    // The survivor's console followed the whole call: its start, and every turn, the holder's among them.
    const feed = feedOf.get(survivor)!;
    await until(() => {
      const mine = feed.events.filter((e) => e.callSid === callSid);
      const turns = new Set(mine.filter((e) => e.type === 'turn').map((e) => e.record?.turnIndex));
      return mine.some((e) => e.type === 'call_started') && Array.from({ length: all }, (_, i) => i + 1).every((t) => turns.has(t)) ? true : undefined;
    }, opts.timeoutMs, `${survivor}'s console to show the call's start and turns 1 to ${all}`);
    say(`ok: taken over by ${survivor}, ${all} turns once each across both servers, the audit verifies, ${survivor}'s console followed it`);
    return { callSid, carrier, going, holder, survivor, heard };
  } finally {
    for (const r of relays) r.close();
    for (const f of feeds) f.close();
  }
}

/** What a server's /ready says now: its status and body, or null when it does not answer. */
async function readiness(base: string): Promise<{ status: number; body: { ready?: boolean; stopping?: boolean; draining?: boolean } } | null> {
  try {
    const res = await fetch(`${base}/ready`, { signal: AbortSignal.timeout(2000) });
    return { status: res.status, body: (await res.json()) as { ready?: boolean; stopping?: boolean; draining?: boolean } };
  } catch {
    return null;
  }
}

/**
 * A stopping server, asked for a new call directly (past the balancer, which has stopped sending it
 * any): while /ready says it is stopping (DRAIN_UNREADY_MS) it answers the call as usual, and once it
 * drains it puts the caller through to the handoff number. With DRAIN_UNREADY_MS=0 the first is skipped.
 */
async function newCallsWhileStopping(base: string, carrier: Carrier, say: (line: string) => void, timeoutMs: number): Promise<void> {
  const ring = async (): Promise<string> => (await fetch(`${base}/voice/${carrier}`, form({ CallSid: newCallSid(carrier), From: '+15555550110', To: '+15555550111', CallStatus: 'ringing' }))).text();
  const unreadyMs = Number(MULTI_SERVER_ENV.DRAIN_UNREADY_MS ?? 0);
  if (unreadyMs > 0) {
    const first = await until(async () => {
      const r = await readiness(base);
      return r === null || r.status !== 200 ? r : undefined;
    }, timeoutMs, `${base}/ready to say 503 once the stop began`);
    expectThat(first !== null && first.body.stopping === true, `before its drain, the stopping server's /ready said ${JSON.stringify(first)}, not 503 {"ready":false,"stopping":true}`);
    const doc = await ring();
    expectThat(doc.includes('<ConversationRelay') && !doc.includes('<Dial>'), `a new call reaching the server while /ready said it was stopping was not answered as usual: ${doc.slice(0, 300)}`);
    say('a new call while /ready said 503, before the drain: answered as usual');
  }
  await until(async () => ((await readiness(base))?.body.draining === true ? true : undefined), timeoutMs, `${base}/ready to say it is draining`);
  const doc = await ring();
  expectThat(doc.includes('<Dial>') && !doc.includes('<ConversationRelay'), `a new call reaching the draining server was not put through to the handoff number: ${doc.slice(0, 300)}`);
  say('a new call while draining: put through to the handoff number');
}

/** Every takeover (each carrier, a crash and a drain), each server that went started again after; the reports. */
export async function takeovers(stack: Stack, script: CallScript, o: DriverOptions & { carriers?: readonly Carrier[]; goings?: readonly Going[] } = {}): Promise<TakeoverReport[]> {
  const reports: TakeoverReport[] = [];
  for (const going of o.goings ?? GOINGS) {
    for (const carrier of o.carriers ?? CARRIERS) {
      const report = await takeover(stack, carrier, going, script, o);
      reports.push(report);
      o.log?.(`starting ${report.holder} again`);
      await stack.start(report.holder);
    }
  }
  // The whole audit, every call's chain and every server's anchors, once more at the end.
  const { breaks } = await verifyPostgresAudit(stack.sql);
  expectThat(breaks.length === 0, `the audit does not verify at the end: ${breaks.slice(0, 5).join('; ')}`);
  return reports;
}
