import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startServer, type RunningServer } from './index';
import { loadConfig, type Env } from './config';
import { FakeRelay } from '../testing/fakeRelay';
import { useTestkit } from '../testing/apps';
import { verifyChain } from '../audit/verify';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { loadCorpus } from '../jev/corpus';
import { defaultCorpusFile } from '../run/fixtures';
import type { JevClient } from '../jev/types';
import type { ServerMessage } from '../channel/chat/protocol';
import { RESUMED_TEXT } from './adapter';
import { FileCallStateStore } from './stores/file';
import { testkitApp } from '../testing/testkit';
import { serviceResultEvent } from '../channel/events';
import type { ServiceResolveOptions } from '../core/app/types';

/**
 * The kill-the-server test: with SESSION_STORE=file:<dir>, a call partway through a form survives its
 * server going away (killed outright, closed, or drained for a planned restart). A new server on the
 * same folder takes the carrier's callback, loads the call, and the caller hears that they were lost
 * for a moment and the question they were asked, then finishes the form with the slots they had
 * given. The audit chain runs on across the restart without a break. The same for Telnyx and for a
 * web chat.
 */

useTestkit();

const PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url));
const LAUNCHER = fileURLToPath(new URL('./fixture/mainLauncher.ts', import.meta.url));

const ACCOUNT_ID = 'five five five zero one two three four';
const DOB = 'april twelfth nineteen eighty five';
const WINDOW_OPENER = 'can you deliver tomorrow morning';
const ASK_DOB = "And what's your date of birth?";
const ANYTHING_ELSE = 'Is there anything else I can help with?';
const ORIGIN = 'https://www.example.com';
const TELNYX_KEY = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

let stub: JevClient;
beforeAll(() => {
  stub = new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: 0.9, fallback: new HeuristicStubClient() });
}, 60_000);

const servers: RunningServer[] = [];
const children: ChildProcess[] = [];
const dirs: string[] = [];
const sockets: { close(): void }[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  for (const s of servers.splice(0)) await s.close().catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The settings both servers of a test share: one folder for sessions, traces and the audit. */
function settings(dir: string, extra: Record<string, string> = {}): Env {
  return {
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
    SESSION_STORE: `file:${join(dir, 'sessions')}`,
    ...extra,
  };
}

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), 'restart-'));
  dirs.push(d);
  return d;
}

async function boot(env: Env): Promise<{ server: RunningServer; base: string; logs: string[] }> {
  const logs: string[] = [];
  const server = await startServer(loadConfig(env), { host: '127.0.0.1', client: stub, log: (l) => logs.push(l) });
  servers.push(server);
  return { server, base: `http://127.0.0.1:${server.port}`, logs };
}

/** The server in a process of its own (the launcher an app's serve.ts is), so it can be killed outright. */
async function bootChild(env: Env): Promise<{ child: ChildProcess; base: string }> {
  const own: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) own[k] = v;
  for (const name of ['PATH', 'HOME', 'TMPDIR']) if (process.env[name] !== undefined) own[name] = process.env[name]!;
  const child = fork(LAUNCHER, [], { cwd: PACKAGE_DIR, execArgv: ['--import', 'tsx'], env: own, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.push(child);
  let out = '';
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no port in 20 s:\n${out}`)), 20_000);
    const take = (chunk: Buffer): void => {
      out += chunk.toString('utf8');
      const m = /listening on (\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    };
    child.stdout!.on('data', take);
    child.stderr!.on('data', take);
  });
  return { child, base: `http://127.0.0.1:${port}` };
}

const form = (params: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(params).toString(),
});

/** The carrier answering a call: the start document's socket URL, as the server wrote it. */
async function answer(base: string, provider: string, callSid: string): Promise<string> {
  const doc = await (await fetch(`${base}/voice/${provider}`, form({ CallSid: callSid, From: '+15555550110', To: '+15555550111', CallStatus: 'ringing' }))).text();
  return socketUrl(doc, base);
}

/** The socket a start document names, on the server under test (the document says wss://localhost). */
function socketUrl(doc: string, base: string): string {
  const m = /url="wss:\/\/localhost(\/conversation\/[a-z]+)\?token=([0-9a-f]{32})"/.exec(doc);
  if (!m) throw new Error(`not a start document: ${doc}`);
  return `${base.replace('http', 'ws')}${m[1]}?token=${m[2]}`;
}

/**
 * The relay's session failed while the call is live: the carrier's callback. Twilio's fields; Telnyx's
 * TeXML callback is read with the same names (voice/telnyx.ts, its assumption 1).
 */
function failed(_provider: string, callSid: string): Record<string, string> {
  return { CallSid: callSid, CallStatus: 'in-progress', SessionStatus: 'failed' };
}

/** The first part of the call: the window form entered, the account ID given, and the birth date asked for. */
async function firstHalf(url: string, callSid: string): Promise<FakeRelay> {
  const relay = await FakeRelay.connect(url);
  sockets.push(relay);
  relay.setup(callSid);
  await relay.waitForTexts(1);
  relay.prompt(WINDOW_OPENER);
  await relay.waitForTexts(3);
  relay.prompt(ACCOUNT_ID);
  expect((await relay.waitForTexts(4)).at(-1)).toBe(ASK_DOB);
  return relay;
}

/** After the restart: the callback, the new socket, the line that says what happened, and the rest of the call. */
async function secondHalf(base: string, provider: string, callSid: string): Promise<{ relay: FakeRelay; doc: string }> {
  const doc = await (await fetch(`${base}/cr-action/${provider}`, form(failed(provider, callSid)))).text();
  return { relay: await resumeAt(socketUrl(doc, base), callSid), doc };
}

/** The carrier's socket on the restarted server: the line that says what happened, and the rest of the call. */
async function resumeAt(url: string, callSid: string): Promise<FakeRelay> {
  const relay = await FakeRelay.connect(url);
  sockets.push(relay);
  relay.setup(callSid, 'VX-after');
  expect(await relay.waitForTexts(1)).toEqual([`${RESUMED_TEXT} ${ASK_DOB}`]);
  relay.prompt(DOB);
  const answered = await relay.waitForTexts(4);
  expect(answered.slice(1)).toEqual(['Thanks, Alex.', 'On Saturday, September 19, we can deliver in the morning.', ANYTHING_ELSE]);
  relay.prompt("no, that's all");
  const end = await relay.waitFor((m) => m.type === 'end');
  expect(end.handoffData).toBe('{"reasonCode":"completed","completed":["delivery_window"]}');
  relay.assertKnownTypes();
  return relay;
}

/** A callback's document for a planned restart's handover: a pause of `seconds`, then the carrier's own connect, and no person. */
function expectPauseThenConnect(doc: string, provider: string, seconds: number): void {
  expect(doc).toContain(`<Response><Pause length="${seconds}"/><Connect action="https://localhost/cr-action/${provider}">`);
  expect(doc).toContain('<ConversationRelay');
  expect(doc).not.toContain('<Dial>');
}

/** Every audit day file verifies, and the call's entries run from its start to its end in one chain. */
function expectAuditContinuous(dir: string, callSid: string): void {
  const auditDir = join(dir, 'audit');
  const files = readdirSync(auditDir);
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) expect(verifyChain(join(auditDir, f))).toMatchObject({ ok: true });
  const entries = files.flatMap((f) => readFileSync(join(auditDir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string; callId: string }));
  const own = entries.filter((e) => e.callId === callSid).map((e) => e.type);
  expect(own[0]).toBe('call_started');
  // The end, and after it at most the handoff summary, which is written once its note is back.
  expect(own.filter((t) => t !== 'handoff_summary').at(-1)).toBe('call_ended');
  expect(own.filter((t) => t === 'call_started')).toHaveLength(1);
  expect(own.filter((t) => t === 'call_ended')).toHaveLength(1);
}

/** The trace runs on in the same file, turn after turn, across the restart. */
function expectTraceContinuous(dir: string, callSid: string): void {
  const file = readdirSync(join(dir, 'traces')).find((f) => f.endsWith('.jsonl') && !f.endsWith('.frames.jsonl') && f.startsWith(callSid.replace(/[^A-Za-z0-9_-]/g, '_')))!;
  const turns = readFileSync(join(dir, 'traces', file), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { turnIndex: number }).turnIndex);
  expect(turns).toEqual(turns.map((_, i) => i + 1));
}

const storedCalls = (dir: string): string[] => (existsSync(join(dir, 'sessions', 'calls')) ? readdirSync(join(dir, 'sessions', 'calls')) : []);

describe('a restart with the file session store', () => {
  it('Twilio: the server killed outright mid-form; a new one resumes the call where it was and it completes', async () => {
    const dir = folder();
    const first = await bootChild(settings(dir));
    const callSid = 'CA0000000000000000000000000000kill';
    await firstHalf(await answer(first.base, 'twilio', callSid), callSid);
    // The call is on disk, saved after the turn that asked for the birth date.
    expect(storedCalls(dir)).toHaveLength(1);
    first.child.kill('SIGKILL');
    await new Promise((r) => first.child.once('exit', r));

    const second = await boot(settings(dir));
    const { server } = second;
    const { doc } = await secondHalf(second.base, 'twilio', callSid);
    expect(doc).toContain('<ConversationRelay');
    expect(second.logs).toContain(`${callSid}: restored from the session store (turn 3, reconnect 0)`);
    // The account ID given before the restart is still on the form.
    expect(server.store.get(callSid)!.session.slots.accountId!.value).toBe('55501234');
    expect(server.store.get(callSid)!.reconnects).toBe(1);
    await server.store.settled();
    expect(storedCalls(dir)).toEqual([]);
    expectAuditContinuous(dir, callSid);
    expectTraceContinuous(dir, callSid);
  }, 40_000);

  it('a value given after a restart is masked in the trace exactly as on a call with no restart', async () => {
    // The same call with no restart (the memory store), for what each record must say.
    const plain = folder();
    const callSid = 'CA0000000000000000000000000000mask';
    const live = await boot(settings(plain, { SESSION_STORE: 'memory' }));
    const relay = await firstHalf(await answer(live.base, 'twilio', callSid), callSid);
    relay.prompt(DOB);
    await relay.waitForTexts(7);
    relay.prompt("no, that's all");
    await relay.waitFor((m) => m.type === 'end');
    await live.server.close();

    const dir = folder();
    const first = await boot(settings(dir));
    await firstHalf(await answer(first.base, 'twilio', callSid), callSid);
    await first.server.close();
    const second = await boot(settings(dir));
    await secondHalf(second.base, 'twilio', callSid);
    await second.server.close();

    const records = (d: string): Record<string, unknown>[] => {
      const file = readdirSync(join(d, 'traces')).find((f) => f.endsWith('.jsonl') && !f.endsWith('.frames.jsonl'))!;
      return readFileSync(join(d, 'traces', file), 'utf8').trim().split('\n').map((l) => {
        const { timing: _timing, ts: _ts, ...rest } = JSON.parse(l) as Record<string, unknown>;
        return rest;
      });
    };
    const want = records(plain);
    const got = records(dir);
    expect(got).toHaveLength(want.length);
    // The birth date is given on the turn after the restart: its record, masked, is the live call's.
    expect(got[3]).toEqual(want[3]);
    expect(got).toEqual(want);
    // Its slots masked: the account ID given before the restart and the birth date given after it.
    const slots = got[3]!.slots as Record<string, { value: string }>;
    expect(slots.accountId!.value).toBe('...1234');
    expect(slots.dob!.value).toBe('••/••/1985');
    expect(JSON.stringify(got)).not.toContain('55501234');
    expect(JSON.stringify(got)).not.toContain('1985-04-12');
  }, 20_000);

  it('Telnyx: the server closed mid-form; a new one resumes the call on its Telnyx callback', async () => {
    const dir = folder();
    const env = settings(dir, { VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY: TELNYX_KEY });
    const first = await boot(env);
    const callSid = 'v2:telnyx-restart-call';
    await firstHalf(await answer(first.base, 'telnyx', callSid), callSid);
    await first.server.close();

    const second = await boot(env);
    await secondHalf(second.base, 'telnyx', callSid);
    expect(second.server.store.get(callSid)!.session.slots.accountId!.value).toBe('55501234');
    await second.server.store.settled();
    expect(storedCalls(dir)).toEqual([]);
    expectAuditContinuous(dir, callSid);
    expectTraceContinuous(dir, callSid);
  }, 20_000);

  it("does not resume a Twilio call on Telnyx's callback: it hangs up, and the call waits for its own carrier", async () => {
    const dir = folder();
    const env = settings(dir, { VOICE_PROVIDERS: 'twilio,telnyx', TELNYX_PUBLIC_KEY: TELNYX_KEY });
    const first = await boot(env);
    const callSid = 'CA0000000000000000000000000000carr';
    await firstHalf(await answer(first.base, 'twilio', callSid), callSid);
    await first.server.close();
    const second = await boot(env);
    expect(await (await fetch(`${second.base}/cr-action/telnyx`, form(failed('telnyx', callSid)))).text()).toContain('<Hangup/>');
    expect(storedCalls(dir)).toHaveLength(1);
    await secondHalf(second.base, 'twilio', callSid);
  }, 20_000);

  it('a planned restart with RESTART_PAUSE_S=0: the drain stops taking connections and leaves the live call saved, not sent to a person; the new server resumes it', async () => {
    const dir = folder();
    const first = await boot(settings(dir, { RESTART_PAUSE_S: '0' }));
    const callSid = 'CA0000000000000000000000000000plan';
    const relay = await firstHalf(await answer(first.base, 'twilio', callSid), callSid);
    await first.server.drain(0);
    // Going away: the socket is closed with 1001, so the carrier calls back, and nothing here answers it.
    expect((await relay.closed).code).toBe(1001);
    await expect(fetch(`${first.base}/health`)).rejects.toThrow();
    expect(first.logs).toContain('drain: 0 ms passed with 1 call and 0 chats live; the sessions are saved: the server stops listening, and the carrier calls the restarted server back');
    await first.server.close();
    expect(storedCalls(dir)).toHaveLength(1);

    const second = await boot(settings(dir));
    await secondHalf(second.base, 'twilio', callSid);
    expectAuditContinuous(dir, callSid);
  }, 20_000);

  it('Twilio, a planned restart (SIGTERM): the stopping server tells the carrier to wait and connect again, and the caller resumes on the restarted server with no one sent to a person', async () => {
    const dir = folder();
    const env = settings(dir, { DRAIN_MS: '0', RESTART_PAUSE_S: '4' });
    const first = await bootChild(env);
    const callSid = 'CA0000000000000000000000000000term';
    const relay = await firstHalf(await answer(first.base, 'twilio', callSid), callSid);
    let out = '';
    first.child.stdout!.on('data', (c: Buffer) => (out += c.toString('utf8')));
    const exited = new Promise<number | null>((r) => first.child.once('exit', (code) => r(code)));
    first.child.kill('SIGTERM');
    // Going away: the carrier calls back at once, and the stopping server is still there to answer.
    expect((await relay.closed).code).toBe(1001);
    const doc = await (await fetch(`${first.base}/cr-action/twilio`, form(failed('twilio', callSid)))).text();
    expectPauseThenConnect(doc, 'twilio', 4);
    // Every live call handed over: the server stops listening and exits, as a planned stop does.
    expect(await exited).toBe(0);
    expect(out).toContain('reconnect:1');
    expect(out).toContain('the carrier is told to wait 4 s and connect again');
    expect(out).not.toContain('dial:');
    expect(storedCalls(dir)).toHaveLength(1);

    // The restarted server takes the socket the pause led to: no callback reaches it first.
    const second = await boot(env);
    await resumeAt(socketUrl(doc, second.base), callSid);
    expect(second.logs).toContain(`${callSid}: restored from the session store (turn 3, reconnect 1)`);
    expect(second.server.store.get(callSid)!.session.slots.accountId!.value).toBe('55501234');
    await second.server.store.settled();
    expect(storedCalls(dir)).toEqual([]);
    expectAuditContinuous(dir, callSid);
    expectTraceContinuous(dir, callSid);
  }, 40_000);

  it('Telnyx, a planned restart: the same handover on its TeXML callback, and the caller resumes on the restarted server', async () => {
    const dir = folder();
    const env = settings(dir, { VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY: TELNYX_KEY });
    const first = await boot(env);
    const callSid = 'v2:telnyx-planned-restart';
    const relay = await firstHalf(await answer(first.base, 'telnyx', callSid), callSid);
    const drained = first.server.drain(0);
    expect((await relay.closed).code).toBe(1001);
    const doc = await (await fetch(`${first.base}/cr-action/telnyx`, form(failed('telnyx', callSid)))).text();
    // The default pause: five seconds.
    expectPauseThenConnect(doc, 'telnyx', 5);
    await drained;
    await expect(fetch(`${first.base}/health`)).rejects.toThrow();
    await first.server.close();

    const second = await boot(env);
    await resumeAt(socketUrl(doc, second.base), callSid);
    expect(second.server.store.get(callSid)!.session.slots.accountId!.value).toBe('55501234');
    await second.server.store.settled();
    expect(storedCalls(dir)).toEqual([]);
    expectAuditContinuous(dir, callSid);
    expectTraceContinuous(dir, callSid);
  }, 20_000);

  it('a planned restart: a carrier that connects while the stopping server still listens is refused, calls back, and is told to wait again; both calls resume on the restarted server', async () => {
    const dir = folder();
    const env = settings(dir, { RESTART_PAUSE_S: '3' });
    const first = await boot(env);
    const a = 'CA00000000000000000000000000000aaa';
    const b = 'CA00000000000000000000000000000bbb';
    const relayA = await firstHalf(await answer(first.base, 'twilio', a), a);
    const relayB = await firstHalf(await answer(first.base, 'twilio', b), b);
    const drained = first.server.drain(0);
    expect((await relayA.closed).code).toBe(1001);
    expect((await relayB.closed).code).toBe(1001);
    const docA = await (await fetch(`${first.base}/cr-action/twilio`, form(failed('twilio', a)))).text();
    expectPauseThenConnect(docA, 'twilio', 3);
    // B has not called back yet, so this server still listens: A's carrier, connecting early, is turned away
    // rather than put on a server about to stop.
    await expect(FakeRelay.connect(socketUrl(docA, first.base))).rejects.toThrow('503');
    expect(first.logs).toContain('upgrade refused: the server is restarting');
    // The carrier calls back for the socket it could not open, and is told to wait again.
    const againA = await (await fetch(`${first.base}/cr-action/twilio`, form(failed('twilio', a)))).text();
    expectPauseThenConnect(againA, 'twilio', 3);
    const docB = await (await fetch(`${first.base}/cr-action/twilio`, form(failed('twilio', b)))).text();
    expectPauseThenConnect(docB, 'twilio', 3);
    await drained;
    await first.server.close();
    expect(first.logs.filter((l) => l.includes('-> dial'))).toEqual([]);

    const second = await boot(env);
    // The first token was replaced by the second callback's: it opens nothing.
    await expect(FakeRelay.connect(socketUrl(docA, second.base))).rejects.toThrow('401');
    await resumeAt(socketUrl(againA, second.base), a);
    await resumeAt(socketUrl(docB, second.base), b);
    expect(second.server.store.get(a)!.reconnects).toBe(2);
    expectAuditContinuous(dir, a);
    expectAuditContinuous(dir, b);
  }, 30_000);

  it('a planned restart into a server that reads another session schema: the socket it takes is ended toward a person, never a fresh call', async () => {
    const dir = folder();
    const first = await boot(settings(dir));
    const callSid = 'CA0000000000000000000000000000upgr';
    const relay = await firstHalf(await answer(first.base, 'twilio', callSid), callSid);
    const drained = first.server.drain(0);
    await relay.closed;
    const doc = await (await fetch(`${first.base}/cr-action/twilio`, form(failed('twilio', callSid)))).text();
    await drained;
    await first.server.close();
    // The update raised SESSION_SCHEMA: the call on disk is in a shape the restarted server does not read.
    const callsDir = join(dir, 'sessions', 'calls');
    const [file] = readdirSync(callsDir);
    const stored = JSON.parse(readFileSync(join(callsDir, file!), 'utf8'));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(callsDir, file!), JSON.stringify({ ...stored, schema: 99 }));

    const second = await boot(settings(dir));
    const again = await FakeRelay.connect(socketUrl(doc, second.base));
    sockets.push(again);
    again.setup(callSid, 'VX-after');
    const end = await again.waitFor((m) => m.type === 'end');
    expect(JSON.parse(String(end.handoffData))).toEqual({ reasonCode: 'unreadable' });
    expect(again.texts()).toEqual([]);
    expect(second.logs).toContain(`${callSid}: not resumed: saved under session schema 99, and this server reads 1`);
    // The carrier's callback with that handoff puts the caller through.
    const dial = await (await fetch(`${second.base}/cr-action/twilio`, form({ ...failed('twilio', callSid), HandoffData: String(end.handoffData) }))).text();
    expect(dial).toContain('<Dial>+15551234567</Dial>');
    expect(second.server.store.get(callSid)).toBeUndefined();
  }, 20_000);

  it('a call saved under another session schema is put through to a person, with the reason in the log', async () => {
    const dir = folder();
    const first = await boot(settings(dir));
    const callSid = 'CA0000000000000000000000000000schm';
    await firstHalf(await answer(first.base, 'twilio', callSid), callSid);
    await first.server.close();
    const callsDir = join(dir, 'sessions', 'calls');
    const [file] = readdirSync(callsDir);
    const stored = JSON.parse(readFileSync(join(callsDir, file!), 'utf8'));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(callsDir, file!), JSON.stringify({ ...stored, schema: 99 }));

    const second = await boot(settings(dir));
    const doc = await (await fetch(`${second.base}/cr-action/twilio`, form(failed('twilio', callSid)))).text();
    expect(doc).toContain('<Dial>+15551234567</Dial>');
    expect(doc).toContain('Sorry');
    expect(second.logs).toContain(`${callSid}: not resumed: saved under session schema 99, and this server reads 1`);
    expect(second.logs.some((l) => l.includes(`${callSid}`) && l.includes('-> dial:unreadable'))).toBe(true);
    expect(storedCalls(dir)).toEqual([]);
  }, 20_000);

  it('a caller who hung up while the server was down: the callback after the restart records the end in the audit', async () => {
    const dir = folder();
    const first = await boot(settings(dir));
    const callSid = 'CA0000000000000000000000000000hang';
    await firstHalf(await answer(first.base, 'twilio', callSid), callSid);
    await first.server.close();
    const second = await boot(settings(dir));
    const doc = await (await fetch(`${second.base}/cr-action/twilio`, form({ CallSid: callSid, CallStatus: 'completed' }))).text();
    expect(doc).toContain('<Hangup/>');
    await second.server.store.settled();
    expect(storedCalls(dir)).toEqual([]);
    expectAuditContinuous(dir, callSid);
  }, 20_000);
});

describe('a write and a service request across a restart', () => {
  const depot = testkitApp.services!.depot!;
  const resolveBefore = depot.resolve;
  afterEach(() => {
    depot.resolve = resolveBefore;
  });

  it('a call waiting on a service when its server went away sends the request again after the restart, once, with the same key', async () => {
    const dir = folder();
    const asked: { server: string; params: Readonly<Record<string, string>>; opts: ServiceResolveOptions }[] = [];
    // The first server's depot never answers (the server goes away first); the second's answers at once.
    depot.resolve = (params, opts) => {
      asked.push({ server: 'first', params, opts });
      return new Promise(() => {});
    };
    const saves = vi.spyOn(FileCallStateStore.prototype, 'save');
    const first = await boot(settings(dir));
    const callSid = 'CA0000000000000000000000000000svc1';
    const relay = await FakeRelay.connect(await answer(first.base, 'twilio', callSid));
    sockets.push(relay);
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
    // Filed, and the depot asked: the request is saved with its key before it is sent.
    const deadline = Date.now() + 3000;
    while (asked.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(asked).toHaveLength(1);
    const key = asked[0]!.opts.idempotencyKey!;
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    const callsDir = join(dir, 'sessions', 'calls');
    const saved = JSON.parse(readFileSync(join(callsDir, readdirSync(callsDir)[0]!), 'utf8'));
    expect(saved.pending).toMatchObject({ effect: { kind: 'service', service: 'depot' }, idempotencyKey: key });
    expect(saved.session.pendingService).toBe('depot');
    // The turn that left the request saved it with its key: no save ever says the call waits on a
    // service without saying which request, so a crash between the two cannot lose the request.
    const waiting = saves.mock.calls.map(([c]) => c).filter((c) => c.session.pendingService === 'depot');
    expect(waiting.length).toBeGreaterThan(0);
    for (const c of waiting) expect(c.pending).toMatchObject({ idempotencyKey: key });
    saves.mockRestore();
    await first.server.close();

    depot.resolve = async (params, opts) => {
      asked.push({ server: 'second', params, opts });
      return serviceResultEvent('depot', { searchDays: 2 });
    };
    const second = await boot(settings(dir));
    const doc = await (await fetch(`${second.base}/cr-action/twilio`, form(failed('twilio', callSid)))).text();
    const again = await FakeRelay.connect(socketUrl(doc, second.base));
    sockets.push(again);
    again.setup(callSid, 'VX-after');
    // The line that says what happened, then the depot's answer as its own turn.
    const said = await again.waitForTexts(2);
    expect(said[0]).toMatch(new RegExp(`^${RESUMED_TEXT.replace('.', '\\.')}`));
    expect(said.join(' ')).toContain('call you within 2 days');
    expect(asked.map((a) => a.server)).toEqual(['first', 'second']);
    expect(asked[1]!.opts.idempotencyKey).toBe(key);
    expect(asked[1]!.params).toEqual(asked[0]!.params);
    await second.server.store.settled();
    const after = JSON.parse(readFileSync(join(callsDir, readdirSync(callsDir)[0]!), 'utf8'));
    expect(after.pending ?? null).toBeNull();
    // The depot's answer is in the audit, after the restart, in the same chain.
    for (const f of readdirSync(join(dir, 'audit'))) expect(verifyChain(join(dir, 'audit', f))).toMatchObject({ ok: true });
    const audit = readdirSync(join(dir, 'audit')).flatMap((f) => readFileSync(join(dir, 'audit', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string; callId: string; detail: Record<string, unknown> }));
    expect(audit.filter((e) => e.callId === callSid && e.type === 'a2a').map((e) => e.detail.phase)).toEqual(['sent', 'answered']);
  }, 20_000);
});

type Msg = ServerMessage;

/** A web chat client: its page's origin, the chat wire, and what has arrived. */
class Chat {
  readonly received: Msg[] = [];
  readonly closed: Promise<number>;
  private waiters: (() => void)[] = [];
  private constructor(private readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
    ws.on('message', (data) => {
      this.received.push(JSON.parse(data.toString()) as Msg);
      for (const w of this.waiters.splice(0)) w();
    });
  }

  static open(base: string): Promise<Chat> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/chat`, { origin: ORIGIN });
      ws.once('open', () => {
        const c = new Chat(ws);
        sockets.push(c);
        resolve(c);
      });
      ws.once('error', reject);
    });
  }

  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }

  async until(pred: (r: Msg[]) => boolean, ms = 4000): Promise<Msg[]> {
    const deadline = Date.now() + ms;
    while (!pred(this.received)) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out; received ${JSON.stringify(this.received)}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => (clearTimeout(t), resolve()));
      });
    }
    return this.received;
  }

  close(): void {
    this.ws.close();
  }
}

describe('a web chat across a restart with the file session store', () => {
  const OPENER = 'has parcel 7102 been delivered';
  const AGENT = 'i want to talk to a person';

  /** A chat's messages with no restart, for what the resumed one must say. */
  async function uninterrupted(dir: string): Promise<Msg[]> {
    const { base, server } = await boot(settings(dir, { CHAT: 'on', CHAT_ALLOWED_ORIGINS: ORIGIN, SESSION_STORE: 'memory' }));
    const c = await Chat.open(base);
    c.send({ type: 'start', v: 1 });
    await c.until((r) => r.some((m) => m.type === 'say'));
    c.send({ type: 'text', text: OPENER });
    const before = c.received.length;
    await c.until((r) => r.length > before && r.at(-1)!.type === 'say');
    const n = c.received.length;
    c.send({ type: 'text', text: AGENT });
    await c.until((r) => r.some((m) => m.type === 'end'));
    const after = c.received.slice(n);
    await server.close();
    return after;
  }

  it('resumes the chat on the restarted server with its resume token, and it goes on as if nothing happened', async () => {
    const expected = await uninterrupted(folder());
    const dir = folder();
    const env = settings(dir, { CHAT: 'on', CHAT_ALLOWED_ORIGINS: ORIGIN });
    const first = await boot(env);
    const c = await Chat.open(first.base);
    c.send({ type: 'start', v: 1 });
    await c.until((r) => r.some((m) => m.type === 'say'));
    c.send({ type: 'text', text: OPENER });
    const before = c.received.length;
    await c.until((r) => r.length > before && r.at(-1)!.type === 'say');
    const ready = c.received[0] as Extract<Msg, { type: 'ready' }>;
    await first.server.close();
    expect(await c.closed).toBe(1001);
    expect(readdirSync(join(dir, 'sessions', 'chats'))).toHaveLength(1);
    // The resume token is on disk only as its hash.
    expect(readFileSync(join(dir, 'sessions', 'chats', readdirSync(join(dir, 'sessions', 'chats'))[0]!), 'utf8')).not.toContain(ready.resume);

    const second = await boot(env);
    const d = await Chat.open(second.base);
    d.send({ type: 'start', v: 1, resume: ready.resume });
    const [back] = await d.until((r) => r.length >= 1);
    expect(back).toMatchObject({ type: 'ready', session: ready.session, locale: 'en-US' });
    expect((back as Extract<Msg, { type: 'ready' }>).resume).not.toBe(ready.resume);
    expect(second.logs).toContain(`chat ${ready.session}: restored from the session store`);
    d.send({ type: 'text', text: AGENT });
    await d.until((r) => r.some((m) => m.type === 'end'));
    expect(d.received.slice(1)).toEqual(expected);
    await new Promise((r) => setTimeout(r, 50));
    expect(readdirSync(join(dir, 'sessions', 'chats'))).toEqual([]);
    expectAuditContinuous(dir, ready.session);
    expectTraceContinuous(dir, ready.session);
  }, 20_000);

  it('a resume token used before the restart opens nothing after it', async () => {
    const dir = folder();
    const env = settings(dir, { CHAT: 'on', CHAT_ALLOWED_ORIGINS: ORIGIN });
    const first = await boot(env);
    const c = await Chat.open(first.base);
    c.send({ type: 'start', v: 1 });
    await c.until((r) => r.some((m) => m.type === 'say'));
    const ready = c.received[0] as Extract<Msg, { type: 'ready' }>;
    c.close();
    await c.closed;
    const d = await Chat.open(first.base);
    d.send({ type: 'start', v: 1, resume: ready.resume });
    await d.until((r) => r.length >= 1);
    await first.server.close();
    const second = await boot(env);
    const e = await Chat.open(second.base);
    e.send({ type: 'start', v: 1, resume: ready.resume });
    await e.until((r) => r.some((m) => m.type === 'ready'));
    expect(e.received[0]).toMatchObject({ type: 'error', code: 'session_unknown' });
  }, 20_000);
});
