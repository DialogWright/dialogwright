import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { startServer, type RunningServer } from './index';
import { loadConfig, type Env } from './config';
import { pgliteSql, type PgliteSql } from './stores/pgliteSql';
import { FakeRelay } from '../testing/fakeRelay';
import { startBalancer } from '../testing/multi/balancer';
import { useTestkit } from '../testing/apps';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { loadCorpus } from '../jev/corpus';
import { defaultCorpusFile } from '../run/fixtures';
import type { JevClient } from '../jev/types';
import { RESUMED_TEXT } from './adapter';
import { testkitApp } from '../testing/testkit';
import { serviceResultEvent } from '../channel/events';
import type { ServiceResolveOptions } from '../core/app/types';
import WebSocket from 'ws';
import { FakeS3 } from '../testing/fakeS3';
import { parseSegmentName, traceReaderOf } from '../trace/store';
import { verifyPostgresAudit } from '../audit/postgres';
import type { AuditEntry } from '../audit/types';
import type { PublishedEvent } from './dashboard/bus';
import type { ServerMessage } from '../channel/chat/protocol';

/**
 * Two servers, one Postgres (SESSION_STORE=postgres, here PGlite in the process), behind a load balancer
 * that sends the carrier's webhooks and sockets to whichever server is up and not draining: a deploy or
 * a failed server never drops a call (Phase 8b, decision 7's first half). A call runs on server A; A
 * dies mid-form (its sockets and its listener closed with no drain, its database cut, as a process that
 * crashed); the carrier's reconnect reaches B, which waits for A's hold on the call to lapse, takes it,
 * and resumes: the caller hears they were lost for a moment and the question they were on, and the
 * call completes with what they gave A. A write A had sent is sent again by B with the same key, so it
 * is done once. And a drain: A gives its call up as its socket closes, and B takes it at once.
 */

useTestkit();

const ACCOUNT_ID = 'five five five zero one two three four';
const DOB = 'april twelfth nineteen eighty five';
const WINDOW_OPENER = 'can you deliver tomorrow morning';
const ASK_DOB = "And what's your date of birth?";
const ANYTHING_ELSE = 'Is there anything else I can help with?';
const TELNYX_KEY = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
/** A connection string of the right shape: the servers are given PGlite in its place (ServerOverrides.sessionSql). */
const PLACEHOLDER_URL = 'postgres://dialogwright:not-a-password@db.invalid:5432/dialogwright';
/** Short, so a crashed server's hold lapses within the test. */
const LEASE_MS = 600;

let stub: JevClient;
beforeAll(() => {
  stub = new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: 0.9, fallback: new HeuristicStubClient() });
}, 60_000);

interface Node {
  readonly name: string;
  readonly server: RunningServer;
  readonly sql: PgliteSql;
  readonly logs: string[];
  readonly dir: string;
  /** Crashed: the balancer sends it nothing. */
  down: boolean;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), 'many-'));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** The trace store two servers share (TRACE_STORE=s3://...), in the process, and the keys it checks. */
const S3_KEYS = { accessKeyId: 'AKIDMANYSERVERS', secretAccessKey: 'a-secret-only-the-fake-store-knows' };
const TRACE_STORE = 's3://call-traces/many';
const s3Env = (s3: FakeS3): Env => ({
  TRACE_STORE, S3_ENDPOINT: s3.endpoint, S3_REGION: 'us-east-1', S3_ACCESS_KEY_ID: S3_KEYS.accessKeyId, S3_SECRET_ACCESS_KEY: S3_KEYS.secretAccessKey, S3_FORCE_PATH_STYLE: 'on',
});

async function traceStore(): Promise<FakeS3> {
  const s3 = await FakeS3.start({ bucket: 'call-traces', region: 'us-east-1', credentials: S3_KEYS });
  cleanups.push(() => s3.close());
  return s3;
}

/**
 * One server on the shared database. With `records`, its audit and traces are shared too (8b2): the
 * audit in the same database (AUDIT_STORE, on the same connection) and the traces on one S3 store
 * (TRACE_STORE); without, each server has its own audit day files and trace files, as in 8b1.
 */
async function boot(name: string, db: PGlite, extra: Env = {}, o: { client?: JevClient; sql?: PgliteSql; records?: FakeS3 } = {}): Promise<Node> {
  const dir = folder();
  const logs: string[] = [];
  const sql = o.sql ?? pgliteSql(db);
  if (o.records) extra = { AUDIT_STORE: PLACEHOLDER_URL, ...s3Env(o.records), ...extra };
  const env: Env = {
    PUBLIC_HOST: 'localhost',
    TWILIO_AUTH_TOKEN: 't',
    HANDOFF_NUMBER: '+15551234567',
    PORT: '0',
    SIGNATURE_CHECK: 'off',
    TODAY_OVERRIDE: '2026-09-18',
    TRACE_DIR: join(dir, 'traces'),
    AUDIT_DIR: join(dir, 'audit'),
    AUDIO_DIR: dir,
    NO_INPUT_MS: '0',
    SESSION_STORE: PLACEHOLDER_URL,
    CALL_LEASE_MS: String(LEASE_MS),
    SERVER_ID: name,
    ...extra,
  };
  const t0 = Date.now();
  // MANY_SERVERS_DEBUG=1 prints each server's log with its time, to follow a takeover.
  const log = (l: string): void => {
    logs.push(l);
    if (process.env.MANY_SERVERS_DEBUG) console.log(name, Date.now() - t0, l);
  };
  const server = await startServer(loadConfig(env), { host: '127.0.0.1', client: o.client ?? stub, log, sessionSql: sql, ...(o.records ? { auditSql: sql } : {}) });
  const node: Node = { name, server, sql, logs, dir, down: false };
  cleanups.push(() => server.close().catch(() => {}));
  return node;
}

/**
 * The load balancer (testing/multi/balancer.ts): each webhook and each socket goes to the first server
 * that is up and not draining (as a balancer reading /ready would). No stickiness: carrier webhooks are
 * stateless.
 */
async function balancer(nodes: () => Node[], o: { slow?: boolean } = {}): Promise<{ base: string; ws: string }> {
  // `slow`: a balancer that has not yet seen a draining server's /ready, and still sends it work.
  const lb = await startBalancer(() => nodes().find((n) => !n.down && (o.slow === true || !n.server.draining))?.server.port);
  cleanups.push(() => lb.close());
  return { base: lb.base, ws: lb.ws };
}

/** A connection to the database that, once `hang` is set, never answers (a database blackholed, not refusing). */
function hangable(db: PGlite): PgliteSql & { hang: boolean } {
  const base = pgliteSql(db);
  const never = new Promise<never>(() => {});
  const h = { ...base, hang: false } as PgliteSql & { hang: boolean };
  h.query = (text, params) => (h.hang ? never : base.query(text, params));
  h.transaction = (fn) => (h.hang ? never : base.transaction(fn));
  return h;
}

/** Until `pred` holds, looking every 10 ms, or fails after `ms`. */
async function until(pred: () => boolean, ms = 3000, what = 'the condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The server dies: its database cut first (nothing more of it lands), then its sockets and listener closed, with no drain. */
async function crash(n: Node): Promise<void> {
  n.down = true;
  n.sql.cut();
  await n.server.close();
}

const form = (params: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(params).toString(),
});

/** The socket a start document names, through the balancer (the document says wss://localhost). */
function socketUrl(doc: string, ws: string): string {
  const m = /url="wss:\/\/localhost(\/conversation\/[a-z]+)\?token=([0-9a-f]{32})"/.exec(doc);
  if (!m) throw new Error(`not a start document: ${doc}`);
  return `${ws}${m[1]}?token=${m[2]}`;
}

async function answer(lb: { base: string; ws: string }, provider: string, callSid: string): Promise<string> {
  const doc = await (await fetch(`${lb.base}/voice/${provider}`, form({ CallSid: callSid, From: '+15555550110', To: '+15555550111', CallStatus: 'ringing' }))).text();
  return socketUrl(doc, lb.ws);
}

const failed = (callSid: string): Record<string, string> => ({ CallSid: callSid, CallStatus: 'in-progress', SessionStatus: 'failed' });

const relays: FakeRelay[] = [];
afterEach(() => {
  for (const r of relays.splice(0)) r.close();
});

/** The window form entered on the first server, the account ID given, and the birth date asked for. */
async function firstHalf(url: string, callSid: string): Promise<FakeRelay> {
  const relay = await FakeRelay.connect(url);
  relays.push(relay);
  relay.setup(callSid);
  await relay.waitForTexts(1);
  relay.prompt(WINDOW_OPENER);
  await relay.waitForTexts(3);
  relay.prompt(ACCOUNT_ID);
  expect((await relay.waitForTexts(4)).at(-1)).toBe(ASK_DOB);
  return relay;
}

/**
 * The carrier's reconnect through the balancer: its callback, then, `waitMs` later, its socket, which
 * hears the question it was on, with the resumed line when `apologized` (a call its holder never let go,
 * or one let go cleanly whose caller was left in silence past RESUMED_AFTER_MS, 1500 by default), and
 * finishes the call.
 */
async function reconnect(lb: { base: string; ws: string }, provider: string, callSid: string, waitMs = 0, apologized = waitMs > 1500): Promise<{ relay: FakeRelay; ms: number }> {
  const doc = await (await fetch(`${lb.base}/cr-action/${provider}`, form(failed(callSid)))).text();
  expect(doc).toContain('<ConversationRelay');
  expect(doc).not.toContain('<Dial>');
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  const began = Date.now();
  const relay = await FakeRelay.connect(socketUrl(doc, lb.ws));
  relays.push(relay);
  relay.setup(callSid, 'VX-after');
  expect(await relay.waitForTexts(1, LEASE_MS * 4)).toEqual([apologized ? `${RESUMED_TEXT} ${ASK_DOB}` : ASK_DOB]);
  const ms = Date.now() - began;
  relay.prompt(DOB);
  const answered = await relay.waitForTexts(4);
  expect(answered.slice(1)).toEqual(['Thanks, Alex.', 'On Saturday, September 19, we can deliver in the morning.', ANYTHING_ELSE]);
  relay.prompt("no, that's all");
  const end = await relay.waitFor((m) => m.type === 'end');
  expect(end.handoffData).toBe('{"reasonCode":"completed","completed":["delivery_window"]}');
  relay.assertKnownTypes();
  return { relay, ms };
}

/** A server's trace of the call: the turn indexes it wrote. */
function turnsIn(n: Node, callSid: string): number[] {
  const traces = join(n.dir, 'traces');
  const file = readdirSync(traces).find((f) => f.endsWith('.jsonl') && !f.endsWith('.frames.jsonl') && f.startsWith(callSid.replace(/[^A-Za-z0-9_-]/g, '_')));
  if (file === undefined) return [];
  return readFileSync(join(traces, file), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { turnIndex: number }).turnIndex);
}


/** The call's one trace on the shared store, its segments joined: its turns, and the servers that wrote them. */
async function joinedTrace(s3: FakeS3, callSid: string): Promise<{ turns: number[]; servers: string[] }> {
  const stem = callSid.replace(/[^A-Za-z0-9_-]/g, '_');
  const joined = await traceReaderOf(TRACE_STORE, s3Env(s3))!.read(stem);
  const servers = [...s3.objects.keys()].filter((k) => /^many\/\d{4}-\d{2}-\d{2}\//.test(k) && k.includes(`/${stem}/`) && k.endsWith('.trace.jsonl'))
    .map((k) => parseSegmentName(k.split('/').at(-1)!)!.server.replace(/-[0-9a-f]{8}$/, ''));
  return { turns: (joined?.trace ?? []).map((l) => (JSON.parse(l) as { turnIndex: number }).turnIndex), servers: [...new Set(servers)] };
}

/** The call's one audit chain in the database, the whole audit verified (every chain, every day's anchors), and its newest entry anchored. */
async function sharedAudit(db: PGlite, callSid: string): Promise<AuditEntry[]> {
  expect((await verifyPostgresAudit(db)).breaks).toEqual([]);
  const chain = (await db.query<{ body: string }>('SELECT body FROM dw_audit_entries WHERE chain = $1 ORDER BY seq', [callSid])).rows.map((r) => JSON.parse(r.body) as AuditEntry);
  const anchors = (await db.query<{ body: string }>('SELECT body FROM dw_audit_anchors')).rows.map((r) => JSON.parse(r.body) as { callId: string; callSeq: number; callHash: string });
  expect(anchors).toContainEqual(expect.objectContaining({ callId: callSid, callSeq: chain.at(-1)!.seq, callHash: chain.at(-1)!.hash }));
  return chain;
}

/** A console's live feed on one server (its /dashboard/events), the events it has sent so far. */
async function consoleFeed(n: Node): Promise<{ events: PublishedEvent[]; close(): void }> {
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${n.server.port}/dashboard/events`, { signal: ac.signal });
  const events: PublishedEvent[] = [];
  const reader = res.body!.getReader();
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
          if (data) events.push(JSON.parse(data.slice('data: '.length)) as PublishedEvent);
        }
      }
    } catch {
      // closed
    }
  })();
  cleanups.push(() => ac.abort());
  return { events, close: () => ac.abort() };
}

async function storedCalls(db: PGlite): Promise<string[]> {
  return (await db.query<{ call_id: string }>('SELECT call_id FROM dw_calls')).rows.map((r) => r.call_id);
}

describe('two servers on one Postgres', () => {
  for (const carrier of ['twilio', 'telnyx'] as const) {
    it(`${carrier}: the server running a call dies mid-form; the carrier's reconnect reaches the other, which takes the call over and it completes`, async () => {
      const db = await PGlite.create();
      cleanups.push(() => db.close());
      const env: Env = carrier === 'telnyx' ? { VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY: TELNYX_KEY } : {};
      const s3 = await traceStore();
      const a = await boot('a', db, env, { records: s3 });
      const b = await boot('b', db, env, { records: s3 });
      const lb = await balancer(() => [a, b]);
      const callSid = carrier === 'telnyx' ? 'v2:telnyx-many-servers' : 'CA00000000000000000000000000000one';
      // A console open on B before the call, which A runs.
      const onB = await consoleFeed(b);

      const relay = await firstHalf(await answer(lb, carrier, callSid), callSid);
      // B's console has followed the call on A: its start and each of A's turns, as A's console would.
      await until(() => onB.events.some((e) => e.type === 'turn' && e.callSid === callSid && e.record.turnIndex === 3), 3000, "A's third turn on B's console");
      expect(onB.events.filter((e) => e.callSid === callSid).map((e) => e.type)).toContain('call_started');
      // A holds the call, and has saved it after the turn that asked for the birth date.
      expect((await db.query<{ owner: string }>('SELECT owner FROM dw_call_leases')).rows.map((r) => r.owner)).toEqual([a.server.store.owner]);
      expect(await storedCalls(db)).toEqual([callSid]);

      await crash(a);
      // The carrier sees its socket drop, not close.
      expect((await relay.closed).code).toBe(1006);
      // A holder that never let go: the caller's silence began before anything measured it, so the line is said.
      const { ms } = await reconnect(lb, carrier, callSid, 0, true);
      // A could not give it up; the carrier's reconnect, counted in the store, told B that A's socket was
      // abandoned, so B took it at once rather than wait for A's hold to lapse.
      expect(ms).toBeLessThan(LEASE_MS);
      expect(b.logs).toContain(`${callSid}: taken over from the session store (turn 3, reconnect 1, its carrier reconnected since) by ${b.server.store.owner}`);
      // The account ID given to A is on B's form, and the reconnect counted once.
      const held = b.server.store.get(callSid)!;
      expect(held.session.slots.accountId!.value).toBe('55501234');
      expect(held.reconnects).toBe(1);
      await b.server.store.settled();
      expect(await storedCalls(db)).toEqual([]);
      expect((await db.query('SELECT * FROM dw_call_leases')).rows).toEqual([]);
      // No turn dropped or run twice: one trace, A's segments then B's, joined in order.
      await b.server.close();
      expect(await joinedTrace(s3, callSid)).toEqual({ turns: [1, 2, 3, 4, 5], servers: ['a', 'b'] });
      // One audit chain for the call, begun by A and ended by B, verifying, its newest entry anchored in the day's chain.
      const chain = await sharedAudit(db, callSid);
      expect(chain[0]!.type).toBe('call_started');
      expect(chain.filter((e) => e.type !== 'handoff_summary').at(-1)!.type).toBe('call_ended');
      expect(chain.filter((e) => e.type === 'call_started')).toHaveLength(1);
      // B's console saw B's own turns of the call too.
      await until(() => onB.events.some((e) => e.type === 'turn' && e.callSid === callSid && e.record.turnIndex === 5), 3000, "B's last turn on its console");
      // Nothing of either server's own files: the records are shared.
      for (const n of [a, b]) expect(existsSync(join(n.dir, 'traces')) ? readdirSync(join(n.dir, 'traces')) : []).toEqual([]);
      for (const n of [a, b]) expect(existsSync(join(n.dir, 'audit')) ? readdirSync(join(n.dir, 'audit')) : []).toEqual([]);
    }, 30_000);
  }

  it('a crash whose carrier is slow to connect again: the resumed line, as for a quick one', async () => {
    const db = await PGlite.create();
    cleanups.push(() => db.close());
    const a = await boot('a', db);
    const b = await boot('b', db);
    const lb = await balancer(() => [a, b]);
    const callSid = 'CA0000000000000000000000000slowcrsh';
    await firstHalf(await answer(lb, 'twilio', callSid), callSid);
    await crash(a);
    await reconnect(lb, 'twilio', callSid, 1700, true);
    expect(b.logs).toContain(`${callSid}: resumed after a restart`);
  }, 30_000);

  for (const carrier of ['twilio', 'telnyx'] as const) {
    it(`${carrier}: a drain: the stopping server gives the call up as its socket closes, and the other takes it at once, with no wait for a hold to lapse`, async () => {
      const db = await PGlite.create();
      cleanups.push(() => db.close());
      // A hold far longer than the test: had A not given it up, B could not take the call in time.
      const env: Env = { CALL_LEASE_MS: '60000', RESTART_PAUSE_S: '0', ...(carrier === 'telnyx' ? { VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY: TELNYX_KEY } : {}) };
      const s3 = await traceStore();
      const a = await boot('a', db, env, { records: s3 });
      const b = await boot('b', db, env, { records: s3 });
      const lb = await balancer(() => [a, b]);
      const seenOnB: PublishedEvent[] = [];
      b.server.bus!.subscribe((e) => seenOnB.push(e));
      const callSid = carrier === 'telnyx' ? 'v2:telnyx-many-servers-drain' : 'CA0000000000000000000000000000drn';
      const relay = await firstHalf(await answer(lb, carrier, callSid), callSid);
      // B's console has the call A runs.
      await until(() => seenOnB.some((e) => e.type === 'turn' && e.callSid === callSid && e.record.turnIndex === 3), 3000, "A's third turn on B's console");
      const drained = a.server.drain(0);
      // Going away: the carrier calls back, and the balancer, which A's /ready now turns away, sends it to B.
      expect((await relay.closed).code).toBe(1001);
      const { ms } = await reconnect(lb, carrier, callSid);
      expect(ms).toBeLessThan(3000);
      await drained;
      expect(a.logs).toContain(`${callSid}: let go: its socket closed, and the server its carrier reconnects to takes it`);
      expect(a.logs.filter((l) => l.includes('-> dial'))).toEqual([]);
      expect(b.logs).toContain(`${callSid}: taken over from the session store (turn 3, reconnect 1, given up by a stopping server) by ${b.server.store.owner}`);
      await b.server.store.settled();
      expect(await storedCalls(db)).toEqual([]);
      await b.server.close();
      // One trace across the two servers, and one audit chain for the call, verifying and anchored.
      expect(await joinedTrace(s3, callSid)).toEqual({ turns: [1, 2, 3, 4, 5], servers: ['a', 'b'] });
      const chain = await sharedAudit(db, callSid);
      expect(chain[0]!.type).toBe('call_started');
      expect(chain.filter((e) => e.type !== 'handoff_summary').at(-1)!.type).toBe('call_ended');
    }, 30_000);
  }

  it('a drain whose callback still reaches the stopping server (a balancer slow to see it drain): the carrier is told to wait, and its socket then reaches the other server', async () => {
    const db = await PGlite.create();
    cleanups.push(() => db.close());
    const env: Env = { CALL_LEASE_MS: '60000', RESTART_PAUSE_S: '2' };
    const a = await boot('a', db, env);
    const b = await boot('b', db, env);
    const lb = await balancer(() => [a, b], { slow: true });
    const callSid = 'CA0000000000000000000000000000lag';
    const relay = await firstHalf(await answer(lb, 'twilio', callSid), callSid);
    const drained = a.server.drain(0);
    expect((await relay.closed).code).toBe(1001);
    const doc = await (await fetch(`${lb.base}/cr-action/twilio`, form(failed(callSid)))).text();
    expect(doc).toContain('<Response><Pause length="2"/><Connect action="https://localhost/cr-action/twilio">');
    expect(doc).not.toContain('<Dial>');
    // Every call handed over: A stops listening, and the balancer finds it gone. The carrier waits the pause.
    await drained;
    a.down = true;
    await new Promise((r) => setTimeout(r, 2000));
    const again = await FakeRelay.connect(socketUrl(doc, lb.ws));
    relays.push(again);
    again.setup(callSid, 'VX-after');
    // The caller waited out the pause in silence, past RESUMED_AFTER_MS: the resumed line.
    expect(await again.waitForTexts(1)).toEqual([`${RESUMED_TEXT} ${ASK_DOB}`]);
    expect(b.logs).toContain(`${callSid}: taken over from the session store (turn 3, reconnect 1, given up by a stopping server) by ${b.server.store.owner}`);
  }, 30_000);
});

describe('a chat across two servers', () => {
  const ORIGIN = 'https://www.example.com';

  /** A page's chat socket on one server: what it was sent, and how it closed. */
  async function chatOn(n: Node): Promise<{ received: ServerMessage[]; send(m: unknown): void; closed: Promise<{ code: number; reason: string }>; until(pred: (r: ServerMessage[]) => boolean): Promise<void> }> {
    const ws = new WebSocket(`ws://127.0.0.1:${n.server.port}/chat`, { origin: ORIGIN });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    cleanups.push(() => ws.close());
    const received: ServerMessage[] = [];
    ws.on('message', (data) => received.push(JSON.parse(data.toString()) as ServerMessage));
    const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    return { received, send: (m) => ws.send(JSON.stringify(m)), closed, until: (pred) => until(() => pred(received), 4000, 'the chat') };
  }

  it("a chat resumed on another server takes it over: the socket on the first is closed, wherever it is, and the first lets the chat go", async () => {
    const db = await PGlite.create();
    cleanups.push(() => db.close());
    const env: Env = { CHAT: 'on', CHAT_ALLOWED_ORIGINS: ORIGIN };
    const s3 = await traceStore();
    const a = await boot('a', db, env, { records: s3 });
    const b = await boot('b', db, env, { records: s3 });
    const first = await chatOn(a);
    first.send({ type: 'start', v: 1 });
    await first.until((r) => r.some((m) => m.type === 'say'));
    const ready = first.received[0] as Extract<ServerMessage, { type: 'ready' }>;
    // A has saved the chat with its resume token.
    await a.server.chat!.settled!();
    // The page opens a second socket, which the balancer sends to B, with the resume token (its first still open on A).
    const second = await chatOn(b);
    second.send({ type: 'start', v: 1, resume: ready.resume });
    await second.until((r) => r.some((m) => m.type === 'ready'));
    expect((second.received[0] as Extract<ServerMessage, { type: 'ready' }>).session).toBe(ready.session);
    // A hears of it through the database and closes its socket, as a resume on one server closes the one before it.
    expect(await first.closed).toEqual({ code: 1000, reason: 'resumed elsewhere' });
    expect(a.logs).toContain(`chat ${ready.session}: resumed on another server; let go here`);
    expect(a.server.chat!.liveCount()).toBe(0);
    expect(b.server.chat!.liveCount()).toBe(1);
    // The chat goes on on B.
    second.send({ type: 'ping' });
    await second.until((r) => r.some((m) => m.type === 'pong'));
    const n = second.received.length;
    second.send({ type: 'text', text: 'can you deliver tomorrow morning' });
    await second.until((r) => r.slice(n).some((m) => m.type === 'say'));
    await a.server.close();
    await b.server.close();
    // One trace: A's turns, then B's, in order by the chat's restores (A wrote at 0, B at 1), whatever the names;
    // A's lines after it let the chat go come before B's; nothing late.
    const joined = (await traceReaderOf(TRACE_STORE, s3Env(s3))!.read(ready.session))!;
    const records = joined.trace.map((l) => JSON.parse(l) as { turnIndex: number; outlivedHold?: true });
    expect(records.map((r) => r.turnIndex)).toEqual([...records.map((r) => r.turnIndex)].sort((x, y) => x - y));
    expect(records.some((r) => r.outlivedHold)).toBe(false);
    const frames = joined.frames.map((l) => JSON.parse(l) as { msg: Record<string, unknown> });
    const letGoAt = frames.findIndex((f) => f.msg.resumedElsewhere === true);
    const restoredAt = frames.findIndex((f) => f.msg.restored === true);
    expect(letGoAt).toBeGreaterThan(-1);
    expect(restoredAt).toBeGreaterThan(letGoAt);
  }, 20_000);

  it('a stale announcement (older than this server\'s own restore of the chat) lets nothing go; a newer one does', async () => {
    const db = await PGlite.create();
    cleanups.push(() => db.close());
    const env: Env = { CHAT: 'on', CHAT_ALLOWED_ORIGINS: ORIGIN, DASHBOARD: 'off' };
    const a = await boot('a', db, env);
    const b = await boot('b', db, env);
    const first = await chatOn(a);
    first.send({ type: 'start', v: 1 });
    await first.until((r) => r.some((m) => m.type === 'say'));
    const ready = first.received[0] as Extract<ServerMessage, { type: 'ready' }>;
    await a.server.chat!.settled!();
    // Resumed on B (B's announcement), then back on A (A's, later): B lets it go.
    const second = await chatOn(b);
    second.send({ type: 'start', v: 1, resume: ready.resume });
    await second.until((r) => r.some((m) => m.type === 'ready'));
    await first.closed;
    await b.server.chat!.settled!();
    await db.query("SELECT setval('dw_notices_id_seq', 10)");
    const third = await chatOn(a);
    third.send({ type: 'start', v: 1, resume: (second.received.find((m) => m.type === 'ready') as Extract<ServerMessage, { type: 'ready' }>).resume });
    await third.until((r) => r.some((m) => m.type === 'ready'));
    expect(await second.closed).toEqual({ code: 1000, reason: 'resumed elsewhere' });
    // A notice from B placed before A's own restore (id 5, A's being 11), arriving late: A keeps the chat.
    await db.query("INSERT INTO dw_notices (id, topic, origin, body, at_ms) VALUES (5, 'chat', $1, $2, 0)", [b.server.store.owner, ready.session]);
    await db.query("SELECT pg_notify('dw_notices', '5')");
    await new Promise((r) => setTimeout(r, 300));
    expect(a.server.chat!.liveCount()).toBe(1);
    third.send({ type: 'ping' });
    await third.until((r) => r.some((m) => m.type === 'pong'));
  }, 20_000);
});

describe('what a shared store cannot do goes to a person, never dead air', () => {
  it("a socket that reaches a server while another holds the call on (it never let go) ends toward a person, and the carrier's callback dials", async () => {
    const db = await PGlite.create();
    cleanups.push(() => db.close());
    const a = await boot('a', db, { CALL_LEASE_MS: '500' });
    const b = await boot('b', db, { CALL_LEASE_MS: '500' });
    const lb = await balancer(() => [a, b]);
    const callSid = 'CA000000000000000000000000000busy';
    await firstHalf(await answer(lb, 'twilio', callSid), callSid);
    // A token for the call that opens B, as a carrier's reconnect would get, while A still has the call.
    const token = b.server.tokens.mint(callSid, 'twilio');
    await b.server.tokens.settled!(callSid);
    const stray = await FakeRelay.connect(`ws://127.0.0.1:${b.server.port}/conversation/twilio?token=${token}`);
    relays.push(stray);
    stray.setup(callSid, 'VX-stray');
    const end = await stray.waitFor((m) => m.type === 'end', 3000);
    expect(JSON.parse(String(end.handoffData))).toEqual({ reasonCode: 'busy' });
    expect(stray.texts()).toEqual([]);
    expect(b.logs).toContain(`${callSid}: not taken over: ${a.server.store.owner} still holds it`);
    const doc = await (await fetch(`http://127.0.0.1:${b.server.port}/cr-action/twilio`, form({ ...failed(callSid), HandoffData: String(end.handoffData) }))).text();
    expect(doc).toContain('<Dial>+15551234567</Dial>');
    // A still has the call, untouched.
    expect(a.server.store.get(callSid)?.ended).toBe(false);
  }, 20_000);

  it('a new call whose relay token cannot be saved is put through to a person', async () => {
    const db = await PGlite.create();
    cleanups.push(() => db.close());
    const a = await boot('a', db);
    a.sql.cut();
    const doc = await (await fetch(`http://127.0.0.1:${a.server.port}/voice/twilio`, form({ CallSid: 'CA00000000000000000000000000notok', From: '+15555550110', To: '+15555550111', CallStatus: 'ringing' }))).text();
    expect(doc).toContain('<Dial>+15551234567</Dial>');
    expect(doc).not.toContain('<ConversationRelay');
    expect(a.logs.some((l) => l.startsWith('CA00000000000000000000000000notok: the relay token could not be saved'))).toBe(true);
    // A hangup's callback still hangs up: only a token the carrier is to use puts the caller through.
    const hangup = await (await fetch(`http://127.0.0.1:${a.server.port}/cr-action/twilio`, form({ CallSid: 'CA00000000000000000000000000notok', CallStatus: 'completed' }))).text();
    expect(hangup).toContain('<Hangup/>');
  }, 20_000);
});

describe('a write across a server that dies', () => {
  const depot = testkitApp.services!.depot!;
  const resolveBefore = depot.resolve;
  afterEach(() => {
    depot.resolve = resolveBefore;
  });

  it('a request the dead server had sent is sent again by the server that takes the call over, with the same key: done once', async () => {
    const db = await PGlite.create();
    cleanups.push(() => db.close());
    // The depot keeps what it is asked to do by key, as a system that takes idempotency keys does.
    const done = new Map<string, number>();
    const asked: { server: 'a' | 'b'; opts: ServiceResolveOptions }[] = [];
    let answering = false;
    depot.resolve = async (_params, opts) => {
      asked.push({ server: answering ? 'b' : 'a', opts });
      done.set(opts.idempotencyKey!, (done.get(opts.idempotencyKey!) ?? 0) + 1);
      // On A it never answers: A dies first.
      if (!answering) return new Promise(() => {});
      return serviceResultEvent('depot', { searchDays: 2 });
    };
    const a = await boot('a', db);
    const b = await boot('b', db);
    const lb = await balancer(() => [a, b]);
    const callSid = 'CA0000000000000000000000000000svc';
    const relay = await FakeRelay.connect(await answer(lb, 'twilio', callSid));
    relays.push(relay);
    relay.setup(callSid);
    await relay.waitForTexts(1);
    for (const said of ['my parcel never arrived', ACCOUNT_ID, DOB]) {
      const n = relay.texts().length;
      relay.prompt(said);
      await relay.waitFor(() => relay.texts().length > n);
    }
    relay.dtmf('123456');
    await relay.waitFor((m) => m.type === 'text' && /what happened|describe|missing/i.test(String(m.token)));
    for (const said of ['it was a small brown box left at the side gate', 'last tuesday']) {
      const n = relay.texts().length;
      relay.prompt(said);
      await relay.waitFor(() => relay.texts().length > n);
    }
    relay.prompt('yes');
    const deadline = Date.now() + 3000;
    while (asked.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(asked.map((x) => x.server)).toEqual(['a']);
    await a.server.store.settled();
    const saved = JSON.parse((await db.query<{ body: string }>('SELECT body FROM dw_calls')).rows[0]!.body) as { pending?: { idempotencyKey: string } };
    expect(saved.pending?.idempotencyKey).toBe(asked[0]!.opts.idempotencyKey);

    await crash(a);
    await relay.closed;
    answering = true;
    const doc = await (await fetch(`${lb.base}/cr-action/twilio`, form(failed(callSid)))).text();
    const again = await FakeRelay.connect(socketUrl(doc, lb.ws));
    relays.push(again);
    again.setup(callSid, 'VX-after');
    const said = await again.waitForTexts(2, LEASE_MS * 4);
    // Taken over from a server that died with the call: the resumed line, however quick.
    expect(said[0]!.startsWith(RESUMED_TEXT)).toBe(true);
    expect(said.join(' ')).toContain('call you within 2 days');
    // Asked twice, once by each server, with one key: the depot did it once.
    expect(asked.map((x) => x.server)).toEqual(['a', 'b']);
    expect(asked[1]!.opts.idempotencyKey).toBe(asked[0]!.opts.idempotencyKey);
    expect([...done.values()]).toEqual([2]);
    expect(done.size).toBe(1);
    expect(b.logs).toContain(`${callSid}: sending the depot request again, with the same key`);
  }, 30_000);
});

describe('what the caller hears when a socket moves', () => {
  /** The relay's session failed and the carrier called back: the first thing the new socket hears. */
  async function blip(via: { base: string; ws: string }, callSid: string): Promise<string> {
    const doc = await (await fetch(`${via.base}/cr-action/twilio`, form(failed(callSid)))).text();
    const again = await FakeRelay.connect(socketUrl(doc, via.ws));
    relays.push(again);
    again.setup(callSid, 'VX-after');
    return (await again.waitForTexts(1, LEASE_MS * 4))[0]!;
  }

  it('a relay blip back to the same server: the question again, no apology, as on one machine', async () => {
    // One machine, for what the caller hears there.
    const plain = await startServer(loadConfig({
      PUBLIC_HOST: 'localhost', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567', PORT: '0', SIGNATURE_CHECK: 'off', TODAY_OVERRIDE: '2026-09-18',
      TRACE_DIR: join(folder(), 't'), AUDIT_DIR: join(folder(), 'a'), AUDIO_DIR: folder(), NO_INPUT_MS: '0',
    }), { host: '127.0.0.1', client: stub, log: () => {} });
    cleanups.push(() => plain.close().catch(() => {}));
    const one = { base: `http://127.0.0.1:${plain.port}`, ws: `ws://127.0.0.1:${plain.port}` };
    const onOne = await firstHalf(await answer(one, 'twilio', 'CA0000000000000000000000000blip1'), 'CA0000000000000000000000000blip1');
    onOne.close();
    await onOne.closed;
    expect(await blip(one, 'CA0000000000000000000000000blip1')).toBe(ASK_DOB);

    const db = await PGlite.create();
    cleanups.push(() => db.close());
    const a = await boot('a', db);
    const direct = { base: `http://127.0.0.1:${a.server.port}`, ws: `ws://127.0.0.1:${a.server.port}` };
    const callSid = 'CA0000000000000000000000000blip2';
    const relay = await firstHalf(await answer(direct, 'twilio', callSid), callSid);
    relay.close();
    await relay.closed;
    expect(await blip(direct, callSid)).toBe(ASK_DOB);
  }, 20_000);

  it('a clean hand-off to another server (the socket closed, the call given up): the question again, no apology', async () => {
    const db = await PGlite.create();
    cleanups.push(() => db.close());
    const a = await boot('a', db);
    const b = await boot('b', db);
    const callSid = 'CA00000000000000000000000000moved';
    const relay = await firstHalf(await answer({ base: `http://127.0.0.1:${a.server.port}`, ws: `ws://127.0.0.1:${a.server.port}` }, 'twilio', callSid), callSid);
    relay.close();
    await relay.closed;
    await until(() => a.logs.includes(`${callSid}: let go: its socket closed, and the server its carrier reconnects to takes it`), 3000, 'A to give the call up');
    expect(await blip({ base: `http://127.0.0.1:${b.server.port}`, ws: `ws://127.0.0.1:${b.server.port}` }, callSid)).toBe(ASK_DOB);
    expect(b.logs).toContain(`${callSid}: taken over from the session store (turn 3, reconnect 1, given up as its socket closed) by ${b.server.store.owner}`);
    expect(b.logs).toContain(`${callSid}: resumed where its socket moved`);
  }, 20_000);

  it('a socket the carrier abandoned without closing it (half open): the other server takes the call at once on the carrier\'s reconnect, and the first lets it go', async () => {
    const db = await PGlite.create();
    cleanups.push(() => db.close());
    const a = await boot('a', db);
    const b = await boot('b', db);
    const callSid = 'CA000000000000000000000000000half';
    const onA = await firstHalf(await answer({ base: `http://127.0.0.1:${a.server.port}`, ws: `ws://127.0.0.1:${a.server.port}` }, 'twilio', callSid), callSid);
    // A's socket stays open; the carrier has given up on it and calls back on B.
    const doc = await (await fetch(`http://127.0.0.1:${b.server.port}/cr-action/twilio`, form(failed(callSid)))).text();
    const began = Date.now();
    const again = await FakeRelay.connect(socketUrl(doc, `ws://127.0.0.1:${b.server.port}`));
    relays.push(again);
    again.setup(callSid, 'VX-after');
    expect(await again.waitForTexts(1)).toEqual([`${RESUMED_TEXT} ${ASK_DOB}`]);
    expect(Date.now() - began).toBeLessThan(LEASE_MS);
    expect(b.logs).toContain(`${callSid}: taken over from the session store (turn 3, reconnect 1, its carrier reconnected since) by ${b.server.store.owner}`);
    // A's next renewal finds the lease is B's, and A closes the socket it was holding.
    expect((await onA.closed).reason).toBe('taken over');
    expect(a.server.store.get(callSid)).toBeUndefined();
  }, 20_000);
});

describe('a transfer held for its line to play, whose socket closes first', () => {
  const opener = 'i want to talk to a person';

  it('is put through by whichever server the carrier calls back, once', async () => {
    const db = await PGlite.create();
    cleanups.push(() => db.close());
    const a = await boot('a', db, { END_AFTER_PLAYBACK: 'on' });
    const b = await boot('b', db, { END_AFTER_PLAYBACK: 'on' });
    const callSid = 'CA000000000000000000000000000xfr';
    const relay = await FakeRelay.connect(await answer({ base: `http://127.0.0.1:${a.server.port}`, ws: `ws://127.0.0.1:${a.server.port}` }, 'twilio', callSid));
    relays.push(relay);
    relay.setup(callSid);
    await relay.waitForTexts(1);
    relay.prompt(opener);
    await relay.waitForTexts(2);
    // The socket closes while the `end` waits for its line to play.
    relay.close();
    await relay.closed;
    await a.server.store.settled();
    expect((await db.query<{ held: string | null }>('SELECT held_handoff AS held FROM dw_calls')).rows.map((r) => r.held !== null)).toEqual([true]);
    const viaB = await (await fetch(`http://127.0.0.1:${b.server.port}/cr-action/twilio`, form(failed(callSid)))).text();
    expect(viaB).toContain('<Dial>+15551234567</Dial>');
    // Owed once: another callback, on the server that held it, hangs up.
    const viaA = await (await fetch(`http://127.0.0.1:${a.server.port}/cr-action/twilio`, form(failed(callSid)))).text();
    expect(viaA).toContain('<Hangup/>');
    expect((await db.query('SELECT call_id FROM dw_calls')).rows).toEqual([]);
  }, 20_000);

  it('with the file store, across a restart in the hold: the restarted server puts the caller through', async () => {
    const dir = folder();
    const env = (): Env => ({
      PUBLIC_HOST: 'localhost', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567', PORT: '0', SIGNATURE_CHECK: 'off', TODAY_OVERRIDE: '2026-09-18',
      TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, NO_INPUT_MS: '0', SESSION_STORE: `file:${join(dir, 'sessions')}`, END_AFTER_PLAYBACK: 'on',
    });
    const first = await startServer(loadConfig(env()), { host: '127.0.0.1', client: stub, log: () => {} });
    const callSid = 'CA000000000000000000000000000xff';
    const relay = await FakeRelay.connect(await answer({ base: `http://127.0.0.1:${first.port}`, ws: `ws://127.0.0.1:${first.port}` }, 'twilio', callSid));
    relays.push(relay);
    relay.setup(callSid);
    await relay.waitForTexts(1);
    relay.prompt(opener);
    await relay.waitForTexts(2);
    await first.store.settled();
    // The server stops with the `end` still held; the carrier calls back once a server is there again.
    const stopped = first.close();
    await relay.closed;
    await stopped;
    const second = await startServer(loadConfig(env()), { host: '127.0.0.1', client: stub, log: () => {} });
    cleanups.push(() => second.close().catch(() => {}));
    const doc = await (await fetch(`http://127.0.0.1:${second.port}/cr-action/twilio`, form(failed(callSid)))).text();
    expect(doc).toContain('<Dial>+15551234567</Dial>');
    expect(readdirSync(join(dir, 'sessions', 'calls'))).toEqual([]);
  }, 20_000);
});

describe('a server that let a call go acts on it no more', () => {
  it('its turn that outlived its hold, ending the call, neither ends it nor revokes the token of the server that took it', async () => {
    const db = await PGlite.create();
    cleanups.push(() => db.close());
    let slowMs = 0;
    const slow: JevClient = { ask: async (r) => {
      if (slowMs) await new Promise((x) => setTimeout(x, slowMs));
      return stub.ask(r);
    } };
    const s3 = await traceStore();
    const a = await boot('a', db, {}, { client: slow, records: s3 });
    const b = await boot('b', db, {}, { records: s3 });
    const callSid = 'CA000000000000000000000000000slw';
    const relay = await firstHalf(await answer({ base: `http://127.0.0.1:${a.server.port}`, ws: `ws://127.0.0.1:${a.server.port}` }, 'twilio', callSid), callSid);
    relay.prompt(DOB);
    await relay.waitForTexts(7);
    // The turn that would end the call is slow on A, and the socket drops while it runs.
    slowMs = 1500;
    relay.prompt("no, that's all");
    await new Promise((x) => setTimeout(x, 100));
    relay.close();
    await relay.closed;
    const doc = await (await fetch(`http://127.0.0.1:${b.server.port}/cr-action/twilio`, form(failed(callSid)))).text();
    const again = await FakeRelay.connect(socketUrl(doc, `ws://127.0.0.1:${b.server.port}`));
    relays.push(again);
    again.setup(callSid, 'VX-after');
    const [back] = await again.waitForTexts(1);
    // The question A last asked, from A's last save: the turn A is still running never saved.
    expect(back!.startsWith(RESUMED_TEXT)).toBe(false);
    expect(back!.endsWith(ANYTHING_ELSE)).toBe(true);
    // A's turn finishes on a call it no longer holds.
    await until(() => a.logs.includes(`${callSid}: no socket, dropped end`), 4000, "A's late turn");
    // A let the call go (its renewal, or its refused save, found the lease B's).
    expect(a.logs.some((l) => l.startsWith(`${callSid}: let go:`))).toBe(true);
    await new Promise((x) => setTimeout(x, 100));
    expect(b.server.store.get(callSid)?.ended).toBe(false);
    expect((await db.query('SELECT call_id FROM dw_tokens')).rows).toEqual([{ call_id: callSid }]);
    expect((await db.query('SELECT call_id FROM dw_calls')).rows).toEqual([{ call_id: callSid }]);
    // And the call goes on, and ends, on B.
    again.prompt("no, that's all");
    const end = await again.waitFor((m) => m.type === 'end');
    expect(end.handoffData).toBe('{"reasonCode":"completed","completed":["delivery_window"]}');
    await a.server.close();
    await b.server.close();
    // A's late turn is in the call's one trace, marked as written after A let the call go, and not counted as a turn.
    const joined = (await traceReaderOf(TRACE_STORE, s3Env(s3))!.read(callSid))!;
    const records = joined.trace.map((l) => JSON.parse(l) as { turnIndex: number; outlivedHold?: true });
    expect(records.filter((r) => r.outlivedHold)).toHaveLength(1);
    const late = records.find((r) => r.outlivedHold)!;
    expect(records.filter((r) => !r.outlivedHold).map((r) => r.turnIndex)).toContain(late.turnIndex);
    const listed = (await traceReaderOf(TRACE_STORE, s3Env(s3))!.calls()).find((c) => c.id === callSid)!;
    expect(listed.turns).toBe(new Set(records.filter((r) => !r.outlivedHold).map((r) => r.turnIndex)).size);
    // Its audit entries are chained in the call's one chain, which verifies.
    await sharedAudit(db, callSid);
  }, 30_000);
});

describe('a database that stops answering', () => {
  it('sends the caller to a person within its time, at the socket and at the callback, never silence or a webhook timeout', async () => {
    const db = await PGlite.create();
    cleanups.push(() => db.close());
    const sql = hangable(db);
    const a = await boot('a', db, { SESSION_STORE_TIMEOUT_MS: '300' }, { sql });
    const direct = { base: `http://127.0.0.1:${a.server.port}`, ws: `ws://127.0.0.1:${a.server.port}` };
    const callSid = 'CA000000000000000000000000000hng';
    const relay = await firstHalf(await answer(direct, 'twilio', callSid), callSid);
    relay.close();
    await relay.closed;
    const doc = await (await fetch(`${direct.base}/cr-action/twilio`, form(failed(callSid)))).text();
    const again = await FakeRelay.connect(socketUrl(doc, direct.ws));
    relays.push(again);
    // The database goes quiet: no refusal, no answer.
    sql.hang = true;
    let t0 = Date.now();
    again.setup(callSid, 'VX-after');
    const end = await again.waitFor((m) => m.type === 'end', 3000);
    expect(JSON.parse(String(end.handoffData))).toEqual({ reasonCode: 'unavailable' });
    expect(Date.now() - t0).toBeLessThan(1500);
    t0 = Date.now();
    const cb = await (await fetch(`${direct.base}/cr-action/twilio`, form(failed(callSid)))).text();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(cb).toContain('<Dial>+15551234567</Dial>');
    // The carrier's callback with that handoff dials too.
    const dial = await (await fetch(`${direct.base}/cr-action/twilio`, form({ ...failed(callSid), HandoffData: String(end.handoffData) }))).text();
    expect(dial).toContain('<Dial>+15551234567</Dial>');
    sql.hang = false;
  }, 20_000);
});

describe('a write whose server died after it ran and before it saved', () => {
  it('is run again by the server that takes the call over, with the same key: done once', async () => {
    const { ParcelSystems } = await import('../testing/testkit/domain/systems');
    const db = await PGlite.create();
    cleanups.push(() => db.close());
    const a = await boot('a', db);
    const b = await boot('b', db);
    const keys: { server: string; key: string | undefined }[] = [];
    const original = ParcelSystems.prototype.createReport;
    let crashAfterWrite = true;
    ParcelSystems.prototype.createReport = function (this: InstanceType<typeof ParcelSystems>, r, key) {
      const report = original.call(this, r, key);
      keys.push({ server: crashAfterWrite ? 'a' : 'b', key });
      // A dies the moment the write is done: nothing after it reaches the database.
      if (crashAfterWrite) a.sql.cut();
      return report;
    };
    cleanups.push(() => {
      ParcelSystems.prototype.createReport = original;
    });
    const callSid = 'CA000000000000000000000000000wrt';
    const relay = await FakeRelay.connect(await answer({ base: `http://127.0.0.1:${a.server.port}`, ws: `ws://127.0.0.1:${a.server.port}` }, 'twilio', callSid));
    relays.push(relay);
    relay.setup(callSid);
    await relay.waitForTexts(1);
    for (const said of ['my parcel never arrived', ACCOUNT_ID, DOB]) {
      const n = relay.texts().length;
      relay.prompt(said);
      await relay.waitFor(() => relay.texts().length > n);
    }
    relay.dtmf('123456');
    await relay.waitFor((m) => m.type === 'text' && /what happened|describe|missing/i.test(String(m.token)));
    for (const said of ['it was a small brown box left at the side gate', 'last tuesday']) {
      const n = relay.texts().length;
      relay.prompt(said);
      await relay.waitFor(() => relay.texts().length > n);
    }
    const summary = relay.texts().at(-1)!;
    relay.prompt('yes');
    await until(() => keys.length === 1, 3000, 'the write on A');
    a.down = true;
    await a.server.close();
    await relay.closed;
    crashAfterWrite = false;
    const doc = await (await fetch(`http://127.0.0.1:${b.server.port}/cr-action/twilio`, form(failed(callSid)))).text();
    const again = await FakeRelay.connect(socketUrl(doc, `ws://127.0.0.1:${b.server.port}`));
    relays.push(again);
    again.setup(callSid, 'VX-after');
    // B resumes from A's last save: the summary, asked again, and the caller says yes again.
    expect((await again.waitForTexts(1, LEASE_MS * 4))[0]).toBe(`${RESUMED_TEXT} ${summary}`);
    again.prompt('yes');
    await until(() => keys.length === 2, 3000, 'the write on B');
    expect(keys.map((k) => k.server)).toEqual(['a', 'b']);
    expect(keys[0]!.key).toMatch(/^[0-9a-f]{32}$/);
    expect(keys[1]!.key).toBe(keys[0]!.key);
  }, 30_000);
});

describe('a turn still running when its socket closes', () => {
  /** A model the test can slow, turn by turn. */
  function slowable(): { client: JevClient; slowMs: number } {
    const o = { slowMs: 0, client: undefined as unknown as JevClient };
    o.client = { ask: async (r) => {
      if (o.slowMs) await new Promise((x) => setTimeout(x, o.slowMs));
      return stub.ask(r);
    } };
    return o;
  }

  it('is finished and saved by the server running it before the other takes the call: no turn run twice, and the caller hears where it got to', async () => {
    const db = await PGlite.create();
    cleanups.push(() => db.close());
    const model = slowable();
    // A hold long enough for the turn: the server waits for it, and the other waits for the server.
    const env: Env = { CALL_LEASE_MS: '3000' };
    const a = await boot('a', db, env, { client: model.client });
    const b = await boot('b', db, env);
    const callSid = 'CA0000000000000000000000000closing';
    const relay = await firstHalf(await answer({ base: `http://127.0.0.1:${a.server.port}`, ws: `ws://127.0.0.1:${a.server.port}` }, 'twilio', callSid), callSid);
    // The birth date's turn is slow, and the socket drops while it runs.
    model.slowMs = 1000;
    relay.prompt(DOB);
    await new Promise((x) => setTimeout(x, 100));
    relay.close();
    await relay.closed;
    const doc = await (await fetch(`http://127.0.0.1:${b.server.port}/cr-action/twilio`, form(failed(callSid)))).text();
    const again = await FakeRelay.connect(socketUrl(doc, `ws://127.0.0.1:${b.server.port}`));
    relays.push(again);
    again.setup(callSid, 'VX-after');
    // B waited for A to finish the turn and give the call up: the caller hears what that turn asked.
    const [back] = await again.waitForTexts(1, 5000);
    expect(back!.endsWith(ANYTHING_ELSE)).toBe(true);
    expect(back!.startsWith(RESUMED_TEXT)).toBe(false);
    expect(b.logs).toContain(`${callSid}: taken over from the session store (turn 4, reconnect 1, given up as its socket closed) by ${b.server.store.owner}`);
    // The birth date's turn ran once, on A; B has run none.
    expect(turnsIn(a, callSid)).toEqual([1, 2, 3, 4]);
    expect(turnsIn(b, callSid)).toEqual([]);
    again.prompt("no, that's all");
    expect((await again.waitFor((m) => m.type === 'end')).handoffData).toBe('{"reasonCode":"completed","completed":["delivery_window"]}');
    expect(turnsIn(b, callSid)).toEqual([5]);
  }, 30_000);

  const TRANSFER_LINE = 'Connecting you with a support specialist now.';

  for (const carrier of ['twilio', 'telnyx'] as const) {
    for (const ending of ['transfer', 'goodbye'] as const) {
      it(`${carrier}: that ends the call (${ending}) while the socket is gone: the server the carrier reaches next says its lines and sends its end, so the caller is ${ending === 'transfer' ? 'put through where the turn decided' : 'told goodbye'}, once`, async () => {
        const db = await PGlite.create();
        cleanups.push(() => db.close());
        const model = slowable();
        const env: Env = { CALL_LEASE_MS: '3000', ...(carrier === 'telnyx' ? { VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY: TELNYX_KEY } : {}) };
        const a = await boot('a', db, env, { client: model.client });
        const b = await boot('b', db, env);
        const callSid = carrier === 'telnyx' ? `v2:telnyx-unsent-${ending}` : `CA000000000000000000000000unsent${ending === 'transfer' ? 't' : 'g'}`;
        const onA = { base: `http://127.0.0.1:${a.server.port}`, ws: `ws://127.0.0.1:${a.server.port}` };
        const onB = { base: `http://127.0.0.1:${b.server.port}`, ws: `ws://127.0.0.1:${b.server.port}` };
        const relay = await firstHalf(await answer(onA, carrier, callSid), callSid);
        if (ending === 'goodbye') {
          relay.prompt(DOB);
          await relay.waitForTexts(7);
        }
        // The turn that ends the call is slow, and the socket drops while it runs.
        model.slowMs = 800;
        relay.prompt(ending === 'transfer' ? 'i want to talk to a person' : "no, that's all");
        await new Promise((x) => setTimeout(x, 100));
        relay.close();
        await relay.closed;
        const doc = await (await fetch(`${onB.base}/cr-action/${carrier}`, form(failed(callSid)))).text();
        const again = await FakeRelay.connect(socketUrl(doc, onB.ws));
        relays.push(again);
        again.setup(callSid, 'VX-after');
        const end = await again.waitFor((m) => m.type === 'end', 8000);
        expect(again.texts().length).toBeGreaterThan(0);
        if (ending === 'transfer') {
          expect(again.texts()).toEqual([TRANSFER_LINE]);
          expect(JSON.parse(String(end.handoffData))).toMatchObject({ reasonCode: 'live-agent' });
          // The carrier's callback with that handoff dials the app's target.
          const dial = await (await fetch(`${onB.base}/cr-action/${carrier}`, form({ ...failed(callSid), HandoffData: String(end.handoffData) }))).text();
          expect(dial).toContain('<Dial>+15551234567</Dial>');
        } else {
          expect(end.handoffData).toBe('{"reasonCode":"completed","completed":["delivery_window"]}');
        }
        expect(b.logs).toContain(`${callSid}: its last turn's lines and end reached no socket: sent on this one`);
        // Once: nothing is left for another server to send or dial.
        await b.server.store.settled();
        expect((await db.query('SELECT call_id FROM dw_calls')).rows).toEqual([]);
        const stray = await (await fetch(`${onA.base}/cr-action/${carrier}`, form(failed(callSid)))).text();
        expect(stray).toContain('<Hangup/>');
      }, 30_000);
    }
  }

  it('that transfers, on the same server the socket comes back to: the transfer line and its end, as on one machine', async () => {
    const db = await PGlite.create();
    cleanups.push(() => db.close());
    const model = slowable();
    const a = await boot('a', db, { CALL_LEASE_MS: '3000' }, { client: model.client });
    const onA = { base: `http://127.0.0.1:${a.server.port}`, ws: `ws://127.0.0.1:${a.server.port}` };
    const callSid = 'CA0000000000000000000000000samexfr';
    const relay = await firstHalf(await answer(onA, 'twilio', callSid), callSid);
    model.slowMs = 800;
    relay.prompt('i want to talk to a person');
    await new Promise((x) => setTimeout(x, 100));
    relay.close();
    await relay.closed;
    const doc = await (await fetch(`${onA.base}/cr-action/twilio`, form(failed(callSid)))).text();
    const again = await FakeRelay.connect(socketUrl(doc, onA.ws));
    relays.push(again);
    again.setup(callSid, 'VX-after');
    const end = await again.waitFor((m) => m.type === 'end', 5000);
    expect(again.texts()).toEqual([TRANSFER_LINE]);
    expect(JSON.parse(String(end.handoffData))).toMatchObject({ reasonCode: 'live-agent' });
  }, 30_000);

  it('the file store, one machine: a transfer decided while the socket was gone is said and sent on the next socket', async () => {
    const dir = folder();
    const model = slowable();
    const env: Env = {
      PUBLIC_HOST: 'localhost', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567', PORT: '0', SIGNATURE_CHECK: 'off', TODAY_OVERRIDE: '2026-09-18',
      TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, NO_INPUT_MS: '0', SESSION_STORE: `file:${join(dir, 'sessions')}`,
    };
    const server = await startServer(loadConfig(env), { host: '127.0.0.1', client: model.client, log: () => {} });
    cleanups.push(() => server.close().catch(() => {}));
    const one = { base: `http://127.0.0.1:${server.port}`, ws: `ws://127.0.0.1:${server.port}` };
    const callSid = 'CA0000000000000000000000000filexfr';
    const relay = await firstHalf(await answer(one, 'twilio', callSid), callSid);
    model.slowMs = 500;
    relay.prompt('i want to talk to a person');
    await new Promise((x) => setTimeout(x, 100));
    relay.close();
    await relay.closed;
    const doc = await (await fetch(`${one.base}/cr-action/twilio`, form(failed(callSid)))).text();
    // The carrier is slow to connect again: the turn has ended the call meanwhile, with no socket.
    await new Promise((x) => setTimeout(x, 800));
    const again = await FakeRelay.connect(socketUrl(doc, one.ws));
    relays.push(again);
    again.setup(callSid, 'VX-after');
    const end = await again.waitFor((m) => m.type === 'end', 5000);
    expect(again.texts()).toEqual([TRANSFER_LINE]);
    expect(JSON.parse(String(end.handoffData))).toMatchObject({ reasonCode: 'live-agent' });
    await server.store.settled();
    expect(readdirSync(join(dir, 'sessions', 'calls'))).toEqual([]);
  }, 30_000);
});

describe('a held transfer whose caller hangs up in the hold', () => {
  it('is dropped by the hangup\'s callback, wherever it lands, and said so', async () => {
    const db = await PGlite.create();
    cleanups.push(() => db.close());
    const a = await boot('a', db, { END_AFTER_PLAYBACK: 'on' });
    const b = await boot('b', db, { END_AFTER_PLAYBACK: 'on' });
    const callSid = 'CA00000000000000000000000000xhang';
    const relay = await FakeRelay.connect(await answer({ base: `http://127.0.0.1:${a.server.port}`, ws: `ws://127.0.0.1:${a.server.port}` }, 'twilio', callSid));
    relays.push(relay);
    relay.setup(callSid);
    await relay.waitForTexts(1);
    relay.prompt('i want to talk to a person');
    await relay.waitForTexts(2);
    relay.close();
    await relay.closed;
    await a.server.store.settled();
    expect((await db.query('SELECT call_id FROM dw_calls')).rows).toEqual([{ call_id: callSid }]);
    const doc = await (await fetch(`http://127.0.0.1:${b.server.port}/cr-action/twilio`, form({ CallSid: callSid, CallStatus: 'completed' }))).text();
    expect(doc).toContain('<Hangup/>');
    expect(b.logs).toContain(`${callSid}: a transfer held for its line is dropped: its caller hung up first`);
    expect((await db.query('SELECT call_id FROM dw_calls')).rows).toEqual([]);
  }, 20_000);
});

