import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from './index';
import { loadConfig } from './config';
import { FakeRelay } from '../testing/fakeRelay';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import type { ToolDef, ToolReply } from '../core/app/types';
import { defineApp } from '../define/defineApp';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { loadCorpus } from '../jev/corpus';
import { CALLBACK_DIR, callbackCode } from '../testing/callback/app';
import type { TraceRecord } from '../trace/types';
import { safeFileStem } from './fileStem';

/**
 * What the caller says over a line said early in a turn answers nothing (the review of call 60), on the
 * phone, on Twilio and on Telnyx. A line said before the turn's own lines (a tool's hold line, here
 * app.yaml's `waiting.line`; a knowledge answer's hold line goes the same way, RunOptions.early) opens a
 * window in the adapter (waitWindows) that closes when the turn's own lines go out. Speech that began
 * inside it is an answer to none of them: no turn runs for it (the frame log notes it, `overWaitLine`).
 * Without the rule an "okay" to "One moment while I check." is taken as the yes to the read-back that
 * follows, and files a request the caller has not yet heard read back, or counts a miss at a field's question.
 * These tests were the old agent mode's (its wait line over a slow model, server/agentWait.e2e.test.ts);
 * the rule is the scripted engine's too, so they live on here with a scripted fixture: the callback line,
 * its form entered with a lookup that waits on a system (an `entry` call) and says a hold line while it does.
 */

const dir = mkdtempSync(join(tmpdir(), 'wait-window-e2e-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
cpSync(CALLBACK_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
const edit = (file: string, change: (text: string) => string): void => {
  const path = join(dir, file);
  const before = readFileSync(path, 'utf8');
  const after = change(before);
  if (after === before) throw new Error(`no change made to ${file}`);
  rmSync(path);
  appendFileSync(path, after);
};
edit('app.yaml', (t) => `${t.replace('id: callback\n', 'id: callback-wait\n')}\nwaiting:\n  line: lookup_hold\n  afterMs: 50\n`);
edit('prompts.yaml', (t) => `${t.trimEnd()}\n  lookup_hold:\n    text: One moment while I check.\n    interruptible: false\n`);
edit('forms.yaml', (t) => t.replace('hooks: [confirmedParams, complete]\n    calls: [requestCallback]', 'hooks: [entry, confirmedParams, complete]\n    calls: [checkQueue, requestCallback]'));
edit('policy.yaml', (t) => t.replace('actions:\n', 'actions:\n  checkQueue:\n    say: check the queue\n    level: 0\n    rules:\n      - identity\n'));

/** The lookup made as the form is entered: its reply comes 600 ms later, as a request to another system does. */
const checkQueue: ToolDef = {
  params: [],
  run: () => new Promise<ToolReply>((resolve) => setTimeout(() => resolve({ value: {}, summary: 'queue checked' }), 600)),
};
const app = defineApp(dir, {
  ...callbackCode,
  tools: { ...callbackCode.tools, checkQueue },
  forms: { request_callback: { ...callbackCode.forms.request_callback!, entry: () => ({ tool: 'checkQueue', params: {} }) } },
});

const TODAY = '2026-11-09';
const TARGETS = { MAIN_LINE: '+15555550101', PRIORITY_LINE: '+15555550102', CALLBACK_DESK: '+15555550103', SECURITY_DESK: '+15555550104' };
const HOLD = 'One moment while I check.';
const OPENER = 'can someone call me back';
const DETAILS = 'call me back, Jordan Avery, five five five five five five zero one four four, about an order';
// The callback line's corpus, and the caller who gives every detail with the request, so the read-back comes after the wait.
appendFileSync(join(dir, 'fixtures', 'corpus.jsonl'), `${JSON.stringify({ id: 'ww-01', text: DETAILS, intent: 'request_callback', context: 'no_form', slots: { caller: 'Jordan Avery', phone: { span: 'five five five five five five zero one four four', value: '5555550144' }, reason: 'order' } })}\n`);
const client = new FixtureStubClient(loadCorpus(join(dir, 'fixtures', 'corpus.jsonl'), app), { sharpness: 0.9, fallback: new HeuristicStubClient({ todayIso: TODAY, app }) });

const { publicKey } = generateKeyPairSync('ed25519');
const TELNYX_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

let running: RunningServer | null = null;
let traceDir = '';
const dirs: string[] = [];
afterEach(async () => {
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(env: Record<string, string> = {}): Promise<string> {
  resetAppsForTest();
  registerApp(app);
  traceDir = mkdtempSync(join(tmpdir(), 'wait-window-trace-'));
  dirs.push(traceDir);
  const config = loadConfig({
    PUBLIC_HOST: 'localhost', TWILIO_AUTH_TOKEN: 't', VOICE_PROVIDERS: 'twilio,telnyx', TELNYX_PUBLIC_KEY, HANDOFF_NUMBER: '+15551234567', PORT: '0', SIGNATURE_CHECK: 'off',
    TODAY_OVERRIDE: TODAY, TRACE_DIR: traceDir, AUDIT_DIR: join(traceDir, 'audit'), AUDIO_DIR: traceDir, DASHBOARD: 'off', BARGE_IN: 'none', TELNYX_EVENTS: 'speaker-events tokens-played', ...env,
  });
  running = await startServer(config, { host: '127.0.0.1', client, log: () => {}, env: TARGETS });
  return `ws://127.0.0.1:${running.port}`;
}

type Carrier = 'twilio' | 'telnyx';
/** A call with no caller number, so the form asks for the number rather than offering one. */
async function connect(ws: string, carrier: Carrier, callSid: string): Promise<FakeRelay> {
  const path = carrier === 'twilio' ? '/conversation' : '/conversation/telnyx';
  const relay = await FakeRelay.connect(`${ws}${path}?token=${carrier === 'twilio' ? running!.tokens.mint(callSid) : running!.tokens.mint(callSid, 'telnyx')}`);
  relay.setup(callSid, undefined, carrier === 'twilio' ? { from: null } : { from: null, customParameters: {} });
  await relay.waitForTexts(1);
  return relay;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const records = (callSid: string): TraceRecord[] => readFileSync(join(traceDir, `${safeFileStem(callSid)}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TraceRecord);
const frameLog = (callSid: string): { dir: string; msg: Record<string, unknown> }[] => readFileSync(join(traceDir, `${safeFileStem(callSid)}.frames.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { dir: string; msg: Record<string, unknown> });
/** Telnyx reports a line played (TELNYX_EVENTS tokens-played). */
const played = (relay: FakeRelay, text: string): void => {
  relay.send({ type: 'info', name: 'agentSpeaking', value: 'on' });
  relay.send({ type: 'info', name: 'tokensPlayed', value: text });
  relay.send({ type: 'info', name: 'agentSpeaking', value: 'off' });
};
/**
 * The caller says "okay" over the hold line, which has just gone out. Twilio reports no speech, so the
 * prompt's arrival is its start; Telnyx reports the speech starting (and ending) before its prompt.
 */
const okayOverTheLine = async (relay: FakeRelay, carrier: Carrier): Promise<void> => {
  if (carrier === 'telnyx') {
    relay.send({ type: 'info', name: 'clientSpeaking', value: 'on' });
    await pause(100);
    relay.send({ type: 'info', name: 'clientSpeaking', value: 'off' });
  }
  relay.prompt('okay');
};
/** What the carrier needs to say the turn's own lines after the hold line: Telnyx reports it played. */
const holdPlayed = (relay: FakeRelay, carrier: Carrier): void => {
  if (carrier === 'telnyx') played(relay, HOLD);
};

describe('what the caller says over a line said early answers nothing (the review of call 60)', () => {
  for (const carrier of ['twilio', 'telnyx'] as const) {
    it(`${carrier}: an "okay" over the line before the read-back is not its yes: no turn, nothing filed, the read-back said; a yes after it files`, async () => {
      const ws = await start();
      const sid = `v3:ww-1-${carrier}`;
      const relay = await connect(ws, carrier, sid);
      try {
        relay.prompt(DETAILS);
        await relay.waitForTexts(2);
        expect(relay.texts().at(-1)!.trim()).toBe(HOLD);
        // Over the hold line, before the read-back.
        await okayOverTheLine(relay, carrier);
        holdPlayed(relay, carrier);
        const texts = await relay.waitForTexts(4);
        expect(texts[3]!.trim()).toMatch(/^I have Jordan Avery, at 5 5 5, 5 5 5, 0 1 4 4, about .*\. Shall I set up the callback\?$/);
        await pause(300);
        expect(relay.texts()).toHaveLength(4);
        expect(records(sid).some((r) => (r.event as { text?: string }).text === 'okay')).toBe(false);
        expect(frameLog(sid).some((l) => l.dir === 'log' && l.msg.overWaitLine !== undefined)).toBe(true);
        expect(records(sid).some((r) => (r.gateEvents ?? []).some((e) => e.decision.call.tool === 'requestCallback'))).toBe(false);
        // The caller's yes, after hearing the read-back, files the callback.
        if (carrier === 'telnyx') played(relay, relay.texts().at(-1)!);
        relay.prompt('yes, please');
        await relay.waitForTexts(5);
        expect((records(sid).at(-1)!.gateEvents ?? []).some((e) => e.decision.call.tool === 'requestCallback' && e.decision.verdict === 'ALLOW')).toBe(true);
      } finally {
        relay.close();
      }
    });

    it(`${carrier}: an "okay" over the line before a field's question is not a miss: no turn, no attempt counted`, async () => {
      const ws = await start();
      const sid = `v3:ww-2-${carrier}`;
      const relay = await connect(ws, carrier, sid);
      try {
        relay.prompt(OPENER);
        await relay.waitForTexts(2);
        expect(relay.texts().at(-1)!.trim()).toBe(HOLD);
        await okayOverTheLine(relay, carrier);
        holdPlayed(relay, carrier);
        // The turn's own lines: the first field's question.
        const texts = await relay.waitForTexts(4);
        expect(texts[3]!.trim()).not.toBe(HOLD);
        await pause(300);
        expect(relay.texts()).toHaveLength(4);
        const recs = records(sid);
        expect(recs.some((r) => (r.event as { text?: string }).text === 'okay')).toBe(false);
        expect(Object.values(recs.at(-1)!.slots).every((s) => (s?.attempts ?? 0) === 0)).toBe(true);
        expect(frameLog(sid).some((l) => l.dir === 'log' && l.msg.overWaitLine !== undefined)).toBe(true);
      } finally {
        relay.close();
      }
    });
  }
});
