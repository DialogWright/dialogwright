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
import { testkitApp } from '../../testing/testkit';
import { useTestkit } from '../../testing/apps';
import { WITHHELD_PARAMETER } from '../../channel/callData';

/**
 * A caller who withheld their number, on Telnyx, through the real path: the answer webhook, the start
 * document, the relay's setup and the call it starts. Seen on a live call (2026-10-13, dialled with *67):
 * Telnyx's answer webhook carried the caller's real number in `From`, with the marks of a withheld one
 * beside it (`CallerId` anonymous, `FromSipUri` anonymous@anonymous.invalid), and its setup carried the
 * number again as `telnyx_call_from`; the engine kept it and offered it back. Here the app is the texting
 * fixture, which keeps the number for a call-start lookup and offers it for texts: with the number
 * withheld, nothing is kept, looked up, offered, logged or shown. The number is fictional.
 */

const NUMBER = '+15555550142';
const DIGITS = '5550142';
const CALL_ID = 'v3:WITHHELDexampleCallIdForTestsOnly0000000000000000';
const TELNYX_PUBLIC_KEY = Buffer.alloc(32, 7).toString('base64');

let running: RunningServer | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let client: JevClient | null = null;
beforeAll(async () => {
  // The texting app is the server's one app (its default), the testkit beside it.
  resetAppsForTest();
  registerApp(textingApp);
  registerApp(testkitApp);
  const { HeuristicStubClient } = await import('../../jev/heuristicStub');
  client = new HeuristicStubClient();
}, 60_000);
afterAll(() => useTestkit());

/** A server answering Telnyx, with what it logged and published. */
async function start(): Promise<{ base: string; ws: string; traceDir: string; lines: string[]; events: DashboardEvent[] }> {
  const traceDir = mkdtempSync(join(tmpdir(), 'withheld-'));
  const audioDir = mkdtempSync(join(tmpdir(), 'audio-'));
  dirs.push(traceDir, audioDir);
  const config = loadConfig({
    PUBLIC_HOST: 'localhost', VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY, SIGNATURE_CHECK: 'off',
    HANDOFF_NUMBER: '+15551234567', PORT: '0', TODAY_OVERRIDE: '2026-10-13',
    TRACE_DIR: traceDir, AUDIT_DIR: join(traceDir, 'audit'), AUDIO_DIR: audioDir,
  });
  const lines: string[] = [];
  running = await startServer(config, { host: '127.0.0.1', client: client!, log: (l) => lines.push(l) });
  const events: DashboardEvent[] = [];
  running.bus?.subscribe((e) => events.push(e));
  return { base: `http://127.0.0.1:${running.port}`, ws: `ws://127.0.0.1:${running.port}`, traceDir, lines, events };
}

async function post(base: string, path: string, fields: Record<string, string>): Promise<string> {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  expect(res.status).toBe(200);
  return res.text();
}

/** The answer webhook as the live call's carried it: the real number in From, and the marks beside it. */
const WITHHELD_WEBHOOK = {
  CallSid: CALL_ID, CallStatus: 'ringing', Direction: 'inbound', From: NUMBER, To: '+15555550111',
  CallerId: 'anonymous', FromSipUri: 'anonymous@anonymous.invalid', CallSessionId: '0b6e1f2a-6f5d-11ef-9692-02420aeffb1f',
};

/** Telnyx's setup as a live call sends it: from and to null, the numbers in its custom parameters, with the ones the document named. */
function setupFor(document: string): { type: string; customParameters: Record<string, string>; [k: string]: unknown } {
  const params = Object.fromEntries([...document.matchAll(/<Parameter name="([^"]+)" value="([^"]*)"\/>/g)].map((m) => [m[1]!, m[2]!]));
  return {
    type: 'setup', sessionId: '05ff737c-0000-4000-8000-000000000000', callSid: '5e9fcc12-0000-4000-8000-000000000000', callControlId: CALL_ID,
    from: null, to: null, direction: null, callStatus: 'active', callerName: 'Jordan Avery',
    customParameters: { ...params, telnyx_call_from: NUMBER, telnyx_call_to: '+15555550111' },
  };
}

/** Everything the server wrote of the call: its trace and frame log files. */
function written(traceDir: string): string {
  return readdirSync(traceDir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => readFileSync(join(f.parentPath, f.name), 'utf8'))
    .join('\n');
}

describe('a caller who withheld their number on Telnyx', () => {
  it('is a call with no number: nothing kept, looked up, offered, logged or shown, from the webhook to the call', async () => {
    const { base, ws, traceDir, lines, events } = await start();
    const document = await post(base, '/voice/telnyx', WITHHELD_WEBHOOK);
    // The start document says the number was withheld, so the setup's copies of it are taken out.
    expect(document).toContain(`<Parameter name="${WITHHELD_PARAMETER}" value="true"/>`);
    expect(document).not.toContain(DIGITS);
    const token = /token=([0-9a-f]{32})/.exec(document)![1]!;

    const relay = await FakeRelay.connect(`${ws}/conversation/telnyx?token=${token}`);
    relay.send(setupFor(document));
    const [greeting] = await relay.waitForTexts(1);
    await running!.store.get(CALL_ID)?.tail;

    // No number on the session: nothing kept for the app's code, and nothing to offer.
    const session = running!.store.get(CALL_ID)!.session;
    expect(session).not.toHaveProperty('callerNumber');
    // The start event carries none, and the call-start lookup by the caller's number never ran.
    const records = readFileSync(join(traceDir, readdirSync(traceDir).find((n) => n.endsWith('.jsonl') && !n.includes('frames'))!), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l) as TraceRecord);
    const startRecord = records.find((r) => r.event?.type === 'session.start')!;
    expect(startRecord.event).not.toHaveProperty('callerNumber');
    expect(startRecord.gateEvents ?? []).toEqual([]);
    // Nothing offered: no line names the number's last four.
    expect(greeting).not.toContain('0142');
    expect(relay.texts().join(' ')).not.toContain('0142');
    // The console shows the caller as withheld, never by their last four.
    expect(events.find((e) => e.type === 'call_started')).toMatchObject({ from: 'withheld' });
    // Not one copy of the number anywhere: the trace, the frame log, the console's events, the server's log.
    expect(written(traceDir)).not.toContain(DIGITS);
    expect(written(traceDir)).not.toContain('Jordan Avery');
    expect(JSON.stringify(events)).not.toContain(DIGITS);
    expect(JSON.stringify(events)).not.toContain('0142');
    expect(lines.join('\n')).not.toContain('0142');
    expect(lines.some((l) => l.includes(`${CALL_ID} from withheld`))).toBe(true);

    // A dropped relay's reconnect, its callback with no marks of its own: the new document says so again,
    // and the new setup (which carries the number again) has it taken out too.
    relay.close();
    await new Promise((r) => setTimeout(r, 50));
    const again = await post(base, '/cr-action/telnyx', { CallSid: CALL_ID, CallStatus: 'in-progress', SessionStatus: 'failed' });
    expect(again).toContain(`<Parameter name="${WITHHELD_PARAMETER}" value="true"/>`);
    const token2 = /token=([0-9a-f]{32})/.exec(again)![1]!;
    const relay2 = await FakeRelay.connect(`${ws}/conversation/telnyx?token=${token2}`);
    const { customParameters, ...rest } = setupFor(again);
    const { [WITHHELD_PARAMETER]: _w, ...noMark } = customParameters;
    relay2.send({ ...rest, type: 'setup', customParameters: noMark });
    await relay2.waitForTexts(1);
    await running!.store.get(CALL_ID)?.tail;
    expect(events.filter((e) => e.type === 'reconnect')).toEqual([expect.objectContaining({ call: expect.objectContaining({ from: 'withheld' }) })]);
    expect(written(traceDir)).not.toContain(DIGITS);
    expect(JSON.stringify(events)).not.toContain('0142');
    expect(running!.store.get(CALL_ID)!.session).not.toHaveProperty('callerNumber');
    relay2.close();
  });

  it('a call with its number given is as before: kept, looked up, and shown by its last four', async () => {
    const { base, ws, traceDir, events } = await start();
    const { CallerId: _c, FromSipUri: _f, ...given } = WITHHELD_WEBHOOK;
    const document = await post(base, '/voice/telnyx', given);
    expect(document).not.toContain(WITHHELD_PARAMETER);
    const token = /token=([0-9a-f]{32})/.exec(document)![1]!;
    const relay = await FakeRelay.connect(`${ws}/conversation/telnyx?token=${token}`);
    relay.send(setupFor(document));
    await relay.waitForTexts(1);
    await running!.store.get(CALL_ID)?.tail;
    expect(running!.store.get(CALL_ID)!.session.callerNumber).toBe(NUMBER);
    expect(events.find((e) => e.type === 'call_started')).toMatchObject({ from: '…0142' });
    // The call-start lookup by the number ran, as it does for every call that gives one.
    const records = readFileSync(join(traceDir, readdirSync(traceDir).find((n) => n.endsWith('.jsonl') && !n.includes('frames'))!), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l) as TraceRecord);
    expect(records.find((r) => r.event?.type === 'session.start')!.gateEvents?.map((e) => e.decision.call.tool)).toEqual(['findCallerByPhone']);
    // Kept, and still never written whole.
    expect(written(traceDir)).not.toContain(DIGITS);
    relay.close();
  });
});
