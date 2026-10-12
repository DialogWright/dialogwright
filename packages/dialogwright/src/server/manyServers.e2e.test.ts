import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { startServer, type RunningServer } from './index';
import { loadConfig, type Env } from './config';
import { pgliteSql, type PgliteSql } from './stores/pgliteSql';
import { FakeRelay } from '../testing/fakeRelay';
import { useTestkit } from '../testing/apps';
import { verifyChain } from '../audit/verify';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { loadCorpus } from '../jev/corpus';
import { defaultCorpusFile } from '../run/fixtures';
import type { JevClient } from '../jev/types';
import { RESUMED_TEXT } from './adapter';
import { testkitApp } from '../testing/testkit';
import { serviceResultEvent } from '../channel/events';
import type { ServiceResolveOptions } from '../core/app/types';

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

/** One server on the shared database, with traces and an audit of its own (until 8b2 joins them). */
async function boot(name: string, db: PGlite, extra: Env = {}): Promise<Node> {
  const dir = folder();
  const logs: string[] = [];
  const sql = pgliteSql(db);
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
  const server = await startServer(loadConfig(env), { host: '127.0.0.1', client: stub, log, sessionSql: sql });
  const node: Node = { name, server, sql, logs, dir, down: false };
  cleanups.push(() => server.close().catch(() => {}));
  return node;
}

/**
 * The load balancer: each webhook and each socket goes to the first server that is up and not draining
 * (as a balancer reading /ready would), a socket piped through whole, so a server that dies closes its
 * sockets on the carrier's side too. No stickiness: carrier webhooks are stateless.
 */
async function balancer(nodes: () => Node[], o: { slow?: boolean } = {}): Promise<{ base: string; ws: string }> {
  // `slow`: a balancer that has not yet seen a draining server's /ready, and still sends it work.
  const pick = (): Node | undefined => nodes().find((n) => !n.down && (o.slow === true || !n.server.draining));
  const pipes = new Set<Socket>();
  const lb: Server = createServer((req, res) => {
    const to = pick();
    if (!to) {
      res.writeHead(502).end();
      return;
    }
    const up = request({ host: '127.0.0.1', port: to.server.port, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  lb.on('upgrade', (req, client: Socket, head: Buffer) => {
    const to = pick();
    if (!to) {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    const backend = connect(to.server.port, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      backend.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) backend.write(head);
      backend.pipe(client);
      client.pipe(backend);
    });
    pipes.add(backend).add(client);
    const close = (): void => {
      backend.destroy();
      client.destroy();
      pipes.delete(backend);
      pipes.delete(client);
    };
    backend.on('error', close).on('close', close);
    client.on('error', close).on('close', close);
  });
  await new Promise<void>((resolve) => lb.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => {
    for (const p of pipes) p.destroy();
    lb.closeAllConnections();
    lb.close(() => resolve());
  }));
  const port = (lb.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` };
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

/** The carrier's reconnect through the balancer: its callback, then its socket, which hears what happened and finishes the call. */
async function reconnect(lb: { base: string; ws: string }, provider: string, callSid: string): Promise<{ relay: FakeRelay; ms: number }> {
  const doc = await (await fetch(`${lb.base}/cr-action/${provider}`, form(failed(callSid)))).text();
  expect(doc).toContain('<ConversationRelay');
  expect(doc).not.toContain('<Dial>');
  const began = Date.now();
  const relay = await FakeRelay.connect(socketUrl(doc, lb.ws));
  relays.push(relay);
  relay.setup(callSid, 'VX-after');
  expect(await relay.waitForTexts(1, LEASE_MS * 4)).toEqual([`${RESUMED_TEXT} ${ASK_DOB}`]);
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

/** A server's audit entries for the call, its chains verified. */
function auditOf(n: Node, callSid: string): string[] {
  const dir = join(n.dir, 'audit');
  const files = readdirSync(dir);
  for (const f of files) expect(verifyChain(join(dir, f))).toMatchObject({ ok: true });
  return files.flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string; callId: string }))
    .filter((e) => e.callId === callSid).map((e) => e.type);
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
      const a = await boot('a', db, env);
      const b = await boot('b', db, env);
      const lb = await balancer(() => [a, b]);
      const callSid = carrier === 'telnyx' ? 'v2:telnyx-many-servers' : 'CA00000000000000000000000000000one';

      const relay = await firstHalf(await answer(lb, carrier, callSid), callSid);
      // A holds the call, and has saved it after the turn that asked for the birth date.
      expect((await db.query<{ owner: string }>('SELECT owner FROM dw_call_leases')).rows.map((r) => r.owner)).toEqual([a.server.store.owner]);
      expect(await storedCalls(db)).toEqual([callSid]);

      await crash(a);
      // The carrier sees its socket drop, not close.
      expect((await relay.closed).code).toBe(1006);
      const { ms } = await reconnect(lb, carrier, callSid);
      // B waited for A's hold to lapse (A could not give it up), and no longer than a hold and a half.
      expect(ms).toBeLessThan(LEASE_MS * 1.5 + 1000);
      expect(b.logs).toContain(`${callSid}: taken over from the session store (turn 3, reconnect 1) by ${b.server.store.owner}`);
      // The account ID given to A is on B's form, and the reconnect counted once.
      const held = b.server.store.get(callSid)!;
      expect(held.session.slots.accountId!.value).toBe('55501234');
      expect(held.reconnects).toBe(1);
      await b.server.store.settled();
      expect(await storedCalls(db)).toEqual([]);
      expect((await db.query('SELECT * FROM dw_call_leases')).rows).toEqual([]);
      // No turn dropped or run twice: A's turns, then B's, one after another.
      expect([...turnsIn(a, callSid), ...turnsIn(b, callSid)]).toEqual([1, 2, 3, 4, 5]);
      // Each server's audit chain verifies; the call starts in A's and ends in B's (8b2 joins them).
      expect(auditOf(a, callSid)[0]).toBe('call_started');
      expect(auditOf(a, callSid)).not.toContain('call_ended');
      expect(auditOf(b, callSid).filter((t) => t !== 'handoff_summary').at(-1)).toBe('call_ended');
      expect(auditOf(b, callSid)).not.toContain('call_started');
    }, 30_000);
  }

  for (const carrier of ['twilio', 'telnyx'] as const) {
    it(`${carrier}: a drain: the stopping server gives the call up as its socket closes, and the other takes it at once, with no wait for a hold to lapse`, async () => {
      const db = await PGlite.create();
      cleanups.push(() => db.close());
      // A hold far longer than the test: had A not given it up, B could not take the call in time.
      const env: Env = { CALL_LEASE_MS: '60000', RESTART_PAUSE_S: '0', ...(carrier === 'telnyx' ? { VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY: TELNYX_KEY } : {}) };
      const a = await boot('a', db, env);
      const b = await boot('b', db, env);
      const lb = await balancer(() => [a, b]);
      const callSid = carrier === 'telnyx' ? 'v2:telnyx-many-servers-drain' : 'CA0000000000000000000000000000drn';
      const relay = await firstHalf(await answer(lb, carrier, callSid), callSid);
      const drained = a.server.drain(0);
      // Going away: the carrier calls back, and the balancer, which A's /ready now turns away, sends it to B.
      expect((await relay.closed).code).toBe(1001);
      const { ms } = await reconnect(lb, carrier, callSid);
      expect(ms).toBeLessThan(3000);
      await drained;
      expect(a.logs).toContain(`${callSid}: let go: its socket closed, and the server its carrier reconnects to takes it`);
      expect(a.logs.filter((l) => l.includes('-> dial'))).toEqual([]);
      expect(b.logs).toContain(`${callSid}: taken over from the session store (turn 3, reconnect 1) by ${b.server.store.owner}`);
      expect([...turnsIn(a, callSid), ...turnsIn(b, callSid)]).toEqual([1, 2, 3, 4, 5]);
      await b.server.store.settled();
      expect(await storedCalls(db)).toEqual([]);
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
    // Every call handed over: A stops listening, and the balancer finds it gone.
    await drained;
    a.down = true;
    const again = await FakeRelay.connect(socketUrl(doc, lb.ws));
    relays.push(again);
    again.setup(callSid, 'VX-after');
    expect(await again.waitForTexts(1)).toEqual([`${RESUMED_TEXT} ${ASK_DOB}`]);
    expect(b.logs).toContain(`${callSid}: taken over from the session store (turn 3, reconnect 1) by ${b.server.store.owner}`);
  }, 30_000);
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
    expect(said[0]).toMatch(new RegExp(`^${RESUMED_TEXT.replace('.', '\\.')}`));
    expect(said.join(' ')).toContain('call you within 2 days');
    // Asked twice, once by each server, with one key: the depot did it once.
    expect(asked.map((x) => x.server)).toEqual(['a', 'b']);
    expect(asked[1]!.opts.idempotencyKey).toBe(asked[0]!.opts.idempotencyKey);
    expect([...done.values()]).toEqual([2]);
    expect(done.size).toBe(1);
    expect(b.logs).toContain(`${callSid}: sending the depot request again, with the same key`);
  }, 30_000);
});
