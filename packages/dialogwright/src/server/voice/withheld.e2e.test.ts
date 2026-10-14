import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from '../index';
import { loadConfig } from '../config';
import { FakeRelay } from '../../testing/fakeRelay';
import type { JevClient } from '../../jev/types';
import type { DashboardEvent } from '../dashboard/events';
import type { TraceRecord } from '../../trace/types';
import { registerApp, resetAppsForTest } from '../../core/app/registry';
import { textingApp } from '../../testing/texting/app';
import type { App } from '../../core/app/types';
import { callerOf } from '../../core/callerNumber';
import { testkitApp } from '../../testing/testkit';
import { useTestkit } from '../../testing/apps';
import { WITHHELD_PARAMETER } from '../../channel/callData';

/**
 * A caller who withheld their number, on Telnyx, through the real path: the answer webhook, the start
 * document, the relay's setup and the call it starts. Seen on a live call (2026-10-13, dialled with *67):
 * Telnyx's answer webhook carried the caller's real number in `From`, with the marks of a withheld one
 * beside it (`CallerId` anonymous, `FromSipUri` anonymous@anonymous.invalid), and its setup carried the
 * number again as `telnyx_call_from`. Re-pinned (live findings item 26, the maintainer's decision: the
 * framework provides the call's data, limits are the app's): the marks are a flag carried with the
 * number, which reaches the session and the app (callerOf(s).withheld), used as any number by default
 * (app.yaml's callerNumber.withheld: use), and treated as no number with `withheld: ignore`. The records
 * write it by its last four as any caller's number, never whole, on a reconnect too and on one a
 * restarted server takes up (SESSION_STORE=file). Here the app is the texting fixture, which keeps the
 * number for a call-start lookup and offers it for texts. The number is fictional.
 */

const NUMBER = '+15555550142';
const DIGITS = '5550142';
const CALL_ID = 'v3:WITHHELDexampleCallIdForTestsOnly0000000000000000';
const TELNYX_PUBLIC_KEY = Buffer.alloc(32, 7).toString('base64');

const servers: RunningServer[] = [];
let running: RunningServer | null = null;
const dirs: string[] = [];
afterEach(async () => {
  serve(textingApp);
  for (const s of servers.splice(0)) await s.close().catch(() => {});
  running = null;
  await new Promise((r) => setTimeout(r, 20));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let client: JevClient | null = null;
/** The server's one app (its default), the testkit beside it. */
function serve(app: App): void {
  resetAppsForTest();
  registerApp(app);
  registerApp(testkitApp);
}

beforeAll(async () => {
  serve(textingApp);
  const { HeuristicStubClient } = await import('../../jev/heuristicStub');
  client = new HeuristicStubClient();
}, 60_000);
afterAll(() => useTestkit());

interface Started { base: string; ws: string; traceDir: string; lines: string[]; events: DashboardEvent[] }

/** A folder for one test's traces, audit, audio and (with a file store) sessions, shared by its servers. */
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'withheld-'));
  dirs.push(dir);
  return dir;
}

/** A server answering Telnyx on `dir`, with what it logged and published; `env` on top (a file store, say). */
async function start(dir = folder(), env: Record<string, string> = {}): Promise<Started> {
  const traceDir = join(dir, 'traces');
  const config = loadConfig({
    PUBLIC_HOST: 'localhost', VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY, SIGNATURE_CHECK: 'off',
    HANDOFF_NUMBER: '+15551234567', PORT: '0', TODAY_OVERRIDE: '2026-10-13', NO_INPUT_MS: '0',
    TRACE_DIR: traceDir, AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, ...env,
  });
  const lines: string[] = [];
  running = await startServer(config, { host: '127.0.0.1', client: client!, log: (l) => lines.push(l) });
  servers.push(running);
  const events: DashboardEvent[] = [];
  running.bus?.subscribe((e) => events.push(e));
  return { base: `http://127.0.0.1:${running.port}`, ws: `ws://127.0.0.1:${running.port}`, traceDir, lines, events };
}

async function post(base: string, path: string, fields: Record<string, string>): Promise<string> {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  expect(res.status).toBe(200);
  return res.text();
}

/** The fields a live call's TeXML webhooks carried: the real number in From, and the marks beside it. */
const MARKED = { From: NUMBER, To: '+15555550111', CallerId: 'anonymous', FromSipUri: 'anonymous@anonymous.invalid', CallSessionId: '0b6e1f2a-6f5d-11ef-9692-02420aeffb1f' };
const WITHHELD_WEBHOOK = { CallSid: CALL_ID, CallStatus: 'ringing', Direction: 'inbound', ...MARKED };
/** A relay that failed mid-call, as the action callback reports it, with the same fields. */
const FAILED_MARKED = { CallSid: CALL_ID, CallStatus: 'in-progress', SessionStatus: 'failed', ...MARKED };
/** The same callback with no marks: the number whole in From, nothing saying it was withheld. */
const FAILED_UNMARKED = { CallSid: CALL_ID, CallStatus: 'in-progress', SessionStatus: 'failed', From: NUMBER, To: '+15555550111' };

/** Telnyx's setup as a live call sends it: from and to null, the numbers in its custom parameters, with the ones the document named. */
function setupFor(document: string, withParameters = true): { type: string; customParameters: Record<string, string>; [k: string]: unknown } {
  const params = withParameters ? Object.fromEntries([...document.matchAll(/<Parameter name="([^"]+)" value="([^"]*)"\/>/g)].map((m) => [m[1]!, m[2]!])) : {};
  return {
    type: 'setup', sessionId: '05ff737c-0000-4000-8000-000000000000', callSid: '5e9fcc12-0000-4000-8000-000000000000', callControlId: CALL_ID,
    from: null, to: null, direction: null, callStatus: 'active', callerName: 'Jordan Avery',
    customParameters: { ...params, telnyx_call_from: NUMBER, telnyx_call_to: '+15555550111' },
  };
}

/** Everything the server wrote under the folder: traces, frame logs, the audit, and with a file store the saved calls. */
function written(dir: string): string {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => readFileSync(join(f.parentPath, f.name), 'utf8'))
    .join('\n');
}

/**
 * No whole copy of the number anywhere the server writes, publishes or logs: the records write a caller's
 * number by its last four (app.yaml's records, its default), a withheld one as any other.
 */
function expectNoWholeCopy(s: Started, dir: string): void {
  for (const where of [written(dir), JSON.stringify(s.events), s.lines.join('\n')]) {
    expect(where).not.toContain(DIGITS);
    expect(where).not.toContain('Jordan Avery');
  }
}

/** The trace records of the call, from its trace file. */
function records(traceDir: string): TraceRecord[] {
  const name = readdirSync(traceDir).find((n) => n.endsWith('.jsonl') && !n.includes('frames'))!;
  return readFileSync(join(traceDir, name), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TraceRecord);
}

/** A withheld call answered and started on `s`: its relay, after the greeting. */
async function withheldCall(s: Started): Promise<FakeRelay> {
  const document = await post(s.base, '/voice/telnyx', WITHHELD_WEBHOOK);
  // The start document carries the flag to the setup, beside the number the setup carries.
  expect(document).toContain(`<Parameter name="${WITHHELD_PARAMETER}" value="true"/>`);
  expect(document).not.toContain(DIGITS);
  const token = /token=([0-9a-f]{32})/.exec(document)![1]!;
  const relay = await FakeRelay.connect(`${s.ws}/conversation/telnyx?token=${token}`);
  relay.send(setupFor(document));
  await relay.waitForTexts(1);
  await running!.store.get(CALL_ID)?.tail;
  return relay;
}

/** The new socket a reconnect's document names, its setup sent as Telnyx would (with the document's parameters, or none). */
async function reconnect(s: Started, document: string, withParameters: boolean): Promise<FakeRelay> {
  const token = /token=([0-9a-f]{32})/.exec(document)![1]!;
  const relay = await FakeRelay.connect(`${s.ws}/conversation/telnyx?token=${token}`);
  relay.send(setupFor(document, withParameters));
  await relay.waitForTexts(1);
  await running!.store.get(CALL_ID)?.tail;
  return relay;
}

describe('a caller who withheld their number on Telnyx', () => {
  it('reaches the session and the app marked withheld, is used as any number by default, and is masked in every record', async () => {
    const dir = folder();
    const s = await start(dir);
    const relay = await withheldCall(s);

    // The number is the call's data, with the flag: the app's code reads it marked withheld.
    const session = running!.store.get(CALL_ID)!.session;
    expect(session).toMatchObject({ callerNumber: NUMBER, callerPrivacy: 'withheld' });
    expect(callerOf(session)).toEqual({ number: NUMBER, last4: '0142', withheld: true });
    // withheld: use (the default): the call-start lookup by the number ran, as for any number.
    const startRecord = records(s.traceDir).find((r) => r.event?.type === 'session.start')!;
    expect(startRecord.callerNumber).toBe('kept');
    expect(startRecord.event).toMatchObject({ callerNumber: '...0142', callerPrivacy: 'withheld' });
    expect(startRecord.gateEvents?.map((e) => e.decision.call.tool)).toEqual(['findCallerByPhone']);
    // The console and the log show the caller by their last four, marked withheld.
    expect(s.events.find((e) => e.type === 'call_started')).toMatchObject({ from: '…0142 (withheld)' });
    expect(s.lines.some((l) => l.includes(`${CALL_ID} from …0142 (withheld)`))).toBe(true);
    expectNoWholeCopy(s, dir);

    // A dropped relay's reconnect: the new document carries the flag again (the session knows it).
    relay.close();
    await new Promise((r) => setTimeout(r, 50));
    const again = await post(s.base, '/cr-action/telnyx', FAILED_MARKED);
    expect(again).toContain(`<Parameter name="${WITHHELD_PARAMETER}" value="true"/>`);
    const relay2 = await reconnect(s, again, true);
    expect(s.events.filter((e) => e.type === 'reconnect')).toEqual([expect.objectContaining({ call: expect.objectContaining({ from: '…0142 (withheld)' }) })]);
    expect(running!.store.get(CALL_ID)!.session).toMatchObject({ callerNumber: NUMBER, callerPrivacy: 'withheld' });
    // The callback's marks stay readable in the frame log; the number by its last four, as any caller's.
    expect(written(dir)).toContain('anonymous@anonymous.invalid');
    expectNoWholeCopy(s, dir);
    relay2.close();
  });

  it('with app.yaml callerNumber.withheld: ignore, is a call with no number for every feature, and still the app\'s data', async () => {
    serve({ ...textingApp, callerNumber: { ...textingApp.callerNumber!, withheld: 'ignore' } });
    const dir = folder();
    const s = await start(dir);
    const relay = await withheldCall(s);
    const session = running!.store.get(CALL_ID)!.session;
    expect(session).toMatchObject({ callerNumber: NUMBER, callerPrivacy: 'withheld' });
    const startRecord = records(s.traceDir).find((r) => r.event?.type === 'session.start')!;
    // Nothing looked up, and the record says why.
    expect(startRecord.callerNumber).toBe('ignored');
    expect(startRecord.gateEvents ?? []).toEqual([]);
    // Nothing offered: no line names the number's last four.
    expect(relay.texts().join(' ')).not.toContain('0142');
    expectNoWholeCopy(s, dir);
    relay.close();
  });

  it('stays marked withheld on a reconnect a restarted server takes up (SESSION_STORE=file), from a callback with no marks', async () => {
    const dir = folder();
    const store = { SESSION_STORE: `file:${join(dir, 'sessions')}`, RESUMED_AFTER_MS: '0' };
    const first = await start(dir, store);
    await withheldCall(first);
    await running!.store.settled();
    // The session is saved with the flag beside the number.
    expect(written(join(dir, 'sessions'))).toContain('"callerPrivacy":"withheld"');
    await running!.close();

    const second = await start(dir, store);
    // The callback says nothing of the number being withheld: the saved session does.
    const again = await post(second.base, '/cr-action/telnyx', FAILED_UNMARKED);
    expect(again).toContain(`<Parameter name="${WITHHELD_PARAMETER}" value="true"/>`);
    const relay = await reconnect(second, again, false);
    expect(second.events.filter((e) => e.type === 'reconnect')).toEqual([expect.objectContaining({ call: expect.objectContaining({ from: '…0142 (withheld)' }) })]);
    expect(running!.store.get(CALL_ID)!.session).toMatchObject({ callerNumber: NUMBER, callerPrivacy: 'withheld' });
    expect(written(join(dir, 'traces'))).not.toContain(DIGITS);
    expect(JSON.stringify([...first.events, ...second.events])).not.toContain(DIGITS);
    // The server's log, on both servers, writes the caller as the records do: by the last four, never whole.
    expect(first.lines.some((l) => l.includes(`${CALL_ID} from …0142 (withheld)`))).toBe(true);
    for (const s of [first, second]) {
      expect(s.lines.join('\n')).not.toContain(DIGITS);
      expect(s.lines.join('\n')).not.toContain('Jordan Avery');
    }
    // The saved session holds the number whole, as the app's code needs it on a reconnect (guide 14.7).
    expect(written(join(dir, 'sessions'))).toContain(NUMBER);
    relay.close();
  }, 20_000);

  it('a server refuses to start with records that keep the caller\'s number whole and a console with no sign-in', async () => {
    serve({ ...textingApp, records: { callerNumber: 'keep' } });
    await expect(start(folder())).rejects.toThrow(/records keeps the caller's number whole.*CONSOLE_AUTH=token/);
    // With no console at all it starts: the records are only on disk.
    const s = await start(folder(), { DASHBOARD: 'off' });
    expect(s.lines.some((l) => l.includes("records: the caller's number kept whole"))).toBe(true);
  });

  it('a call with its number given is as before: kept, looked up, and shown by its last four', async () => {
    const dir = folder();
    const s = await start(dir);
    const { CallerId: _c, FromSipUri: _f, ...given } = WITHHELD_WEBHOOK;
    const document = await post(s.base, '/voice/telnyx', given);
    expect(document).not.toContain(WITHHELD_PARAMETER);
    const token = /token=([0-9a-f]{32})/.exec(document)![1]!;
    const relay = await FakeRelay.connect(`${s.ws}/conversation/telnyx?token=${token}`);
    relay.send(setupFor(document));
    await relay.waitForTexts(1);
    await running!.store.get(CALL_ID)?.tail;
    expect(running!.store.get(CALL_ID)!.session.callerNumber).toBe(NUMBER);
    expect(running!.store.get(CALL_ID)!.session).not.toHaveProperty('callerPrivacy');
    expect(s.events.find((e) => e.type === 'call_started')).toMatchObject({ from: '…0142' });
    expect(records(s.traceDir).find((r) => r.event?.type === 'session.start')!.gateEvents?.map((e) => e.decision.call.tool)).toEqual(['findCallerByPhone']);
    // Its action callback, carrying the number in CallerId and both SIP addresses as Telnyx's do: the
    // frame log masks the caller's to its last four, and keeps the business's own number whole.
    relay.close();
    await new Promise((r) => setTimeout(r, 50));
    await post(s.base, '/cr-action/telnyx', {
      CallSid: CALL_ID, CallStatus: 'completed', SessionStatus: 'completed', From: NUMBER, To: '+15555550111',
      CallerId: NUMBER, FromSipUri: `${NUMBER}@sip.telnyx.com`, ToSipUri: '+15555550111@sip.telnyx.com', Asserted: `<sip:${NUMBER}@carrier.example.com>`,
    });
    const frames = readFileSync(join(s.traceDir, readdirSync(s.traceDir).find((n) => n.endsWith('.frames.jsonl'))!), 'utf8');
    const http = frames.split('\n').filter((l) => l.includes('"dir":"http"')).at(-1)!;
    expect(http).toContain('"CallerId":"…0142"');
    expect(http).toContain('"FromSipUri":"…0142@sip.telnyx.com"');
    expect(http).toContain('"ToSipUri":"+15555550111@sip.telnyx.com"');
    expect(http).toContain('"Asserted":"<sip:…0142@carrier.example.com>"');
    expect(written(dir)).not.toContain(DIGITS);
  });
});
