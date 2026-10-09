import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleSocketMessage, newConnectionContext, type AdapterDeps } from './adapter';
import { SessionStore, type SocketLike } from './sessions';
import { DashboardBus } from './dashboard/bus';
import { redactFrameLine, redactRecord, redactSetupFrame, type DashboardEvent } from './dashboard/events';
import { makeObserver } from './dashboard/observer';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { TraceWriter } from '../trace/writer';
import type { TraceRecord } from '../trace/types';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { testkitApp } from '../testing/testkit';
import { ANONYMOUS } from '../gate/principal';
import { VOICE_RELAY } from '../channel/caps';
import { CALLBACK_DIR, callbackApp } from '../testing/callback/app';
import { replayFrameLog } from '../harness-text/replay';
import type { SetupFrame } from '../channel/relay/frames';

/**
 * The data a call comes with, on the phone line (app.yaml's `callData`): read off the carrier's setup
 * by the adapter, kept on the session, never changed by a reconnect, and recorded by each key's
 * redact in the trace file, on the console and in the frame log, whose custom parameters are written
 * redacted for every app unless a key keeps one. A replay of that log stands in what it holds.
 */

beforeEach(() => {
  resetAppsForTest();
  registerApp(callbackApp);
  registerApp(testkitApp);
});

const SETUP: SetupFrame = {
  type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+15555550142', to: '+15555550100', forwardedFrom: '+15555550102', callType: 'PSTN',
  customParameters: { queue: 'priority', accountRef: 'AC-55501234', dw_referral: 'partner-7', callReference: 'bar', locale: 'en-US' },
};

interface Fake extends SocketLike { sent: unknown[] }
function fakeSocket(): Fake {
  const sent: unknown[] = [];
  return { sent, readyState: 1, send: (data: string, cb?: (err?: Error) => void) => { sent.push(JSON.parse(data)); cb?.(); }, close: () => {} } as unknown as Fake;
}

function deps(appId: string): { d: AdapterDeps & { dir: string }; events: DashboardEvent[] } {
  const dir = mkdtempSync(join(tmpdir(), 'calldata-'));
  const client = new FixtureStubClient(loadCorpus(join(CALLBACK_DIR, 'fixtures', 'corpus.jsonl'), callbackApp), { sharpness: 0.9, fallback: new HeuristicStubClient() });
  const bus = new DashboardBus();
  const events: DashboardEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const store: SessionStore = new SessionStore((callSid) => ({
    session: newSession(callSid, 0, VOICE_RELAY, ANONYMOUS, appId),
    opts: {
      client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-10-09',
      trace: new TraceWriter(join(dir, `${callSid}.jsonl`)), now: () => 0, render: null,
      observe: makeObserver(bus, store, callSid),
    },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), () => Date.parse('2026-10-09T15:00:00Z')),
  }), 60_000, () => 0);
  return { d: { store, tokens: new CallTokens(60_000, () => 0), log: () => {}, dir, bus }, events };
}

async function setUp(appId: string, setup: SetupFrame = SETUP) {
  const { d, events } = deps(appId);
  const sock = fakeSocket();
  await handleSocketMessage(d, sock, newConnectionContext(d.tokens.mint(setup.callSid, 'twilio'), sock, 'twilio'), JSON.stringify(setup));
  const traced = JSON.parse(readFileSync(join(d.dir, 'CA1.jsonl'), 'utf8').split('\n')[0]!) as TraceRecord;
  const frames = readFileSync(join(d.dir, 'CA1.frames.jsonl'), 'utf8');
  return { d, events, traced, frames };
}

describe('the setup\'s call data', () => {
  it('is kept on the session by the app\'s keys, each from its source', async () => {
    const { d } = await setUp('callback');
    expect(d.store.get('CA1')!.session.callData).toEqual({ queue: 'priority', accountRef: 'AC-55501234', forwardedFrom: '+15555550102', referral: 'partner-7' });
  });

  it('is recorded by each key\'s redact in the trace file, the setup\'s own copies too', async () => {
    const { traced, d } = await setUp('callback');
    expect(traced.event).toMatchObject({
      type: 'session.start',
      callData: { queue: 'priority', accountRef: '...1234', forwardedFrom: '...0102', referral: '•' },
      provider: { 'param.queue': 'priority', 'param.accountRef': '...1234', 'param.dw_referral': '•', 'param.locale': 'en-US' },
    });
    const file = readFileSync(join(d.dir, 'CA1.jsonl'), 'utf8');
    expect(file).not.toContain('AC-55501234');
    expect(file).not.toContain('partner-7');
  });

  it('is recorded by each key\'s redact on the console', async () => {
    const { events } = await setUp('callback');
    const turn = events.find((e) => e.type === 'turn') as Extract<DashboardEvent, { type: 'turn' }>;
    expect(turn.record.event).toMatchObject({ callData: { queue: 'priority', accountRef: '...1234', forwardedFrom: '...0102', referral: '•' } });
    expect(JSON.stringify(events)).not.toMatch(/AC-55501234|partner-7/);
  });

  it('is never sent whole to the frame log: a key\'s parameter by its redact, every other one redacted', async () => {
    const { frames } = await setUp('callback');
    const setup = JSON.parse(frames.split('\n')[0]!) as { msg: SetupFrame };
    expect(setup.msg.customParameters).toEqual({ queue: 'priority', accountRef: '...1234', dw_referral: '•', callReference: 'redacted', locale: 'en-US' });
    expect(frames).not.toMatch(/AC-55501234|partner-7|"bar"/);
  });

  it('keeps the first setup\'s values through a reconnect, whose setup is logged the same way', async () => {
    const { d } = await setUp('callback');
    const again = fakeSocket();
    const second = { ...SETUP, sessionId: 'VX2', customParameters: { queue: 'standard', accountRef: 'AC-55509876' } };
    await handleSocketMessage(d, again, newConnectionContext(d.tokens.mint('CA1', 'twilio'), again, 'twilio'), JSON.stringify(second));
    expect(d.store.get('CA1')!.session.callData).toMatchObject({ queue: 'priority', accountRef: 'AC-55501234' });
    const frames = readFileSync(join(d.dir, 'CA1.frames.jsonl'), 'utf8');
    expect(frames).toContain('"customParameters":{"queue":"standard","accountRef":"...9876"}');
    expect(frames).not.toContain('AC-55509876');
  });
});

describe('an app without callData', () => {
  it('keeps nothing, and its start event and trace are as they were', async () => {
    const { d, traced } = await setUp('testkit');
    expect(d.store.get('CA1')!.session).not.toHaveProperty('callData');
    expect(traced.event).not.toHaveProperty('callData');
    // A custom parameter no key reads is written redacted in the trace file too, for every app (the second
    // deliberate change: it used to be kept as sent); locale keeps its own rule.
    expect(traced.event).toMatchObject({ provider: { 'param.callReference': 'redacted', 'param.locale': 'en-US' } });
  });

  it('has its frame log\'s custom parameters redacted, locale and a carrier\'s copy of a number aside (the privacy change)', async () => {
    const { frames } = await setUp('testkit', { ...SETUP, customParameters: { callReference: 'bar', locale: 'es-US', telnyx_call_from: '+15555550142' } });
    const setup = JSON.parse(frames.split('\n')[0]!) as { msg: SetupFrame };
    expect(setup.msg.customParameters).toEqual({ callReference: 'redacted', locale: 'es-US', telnyx_call_from: '…0142' });
  });
});

describe('the console\'s view of a frame log', () => {
  it('redacts a setup line\'s custom parameters, the same when already redacted', () => {
    const line = { line: 1, ts: '2026-10-09T15:00:00.000Z', dir: 'in' as const, msg: { ...SETUP } };
    const once = redactFrameLine(line);
    expect((once.msg as SetupFrame).customParameters).toEqual({ queue: 'priority', accountRef: '...1234', dw_referral: '•', callReference: 'redacted', locale: 'en-US' });
    expect(redactFrameLine(once)).toEqual(once);
    expect(redactSetupFrame(once.msg, callbackApp.callData)).toEqual(once.msg);
  });

  it('shows a trace record\'s call data by each key\'s redact, whatever the key is called', () => {
    const record = { event: { type: 'session.start', provider: {}, callData: { forwardedFrom: '+15555550102', queue: 'priority' } }, slots: {}, turnState: null, decision: { kind: 'ignore' }, actions: [] } as unknown as TraceRecord;
    // forwardedFrom is a key the console would otherwise mask by its name: here it is the app's key, masked by its own redact (last4).
    expect(redactRecord(record).event).toMatchObject({ callData: { forwardedFrom: '...0102', queue: 'priority' } });
  });
});

describe('a replay of the frame log', () => {
  it('stands in what the log holds for a key it records masked, and says so', async () => {
    const { d } = await setUp('callback');
    const replay = await replayFrameLog(join(d.dir, 'CA1.frames.jsonl'), { client: new HeuristicStubClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-10-09' });
    const session = replay.runs[0]!.result.session;
    expect(session.callData).toEqual({ queue: 'priority', accountRef: '...1234', forwardedFrom: '…0102', referral: '•' });
    expect(replay.skipped).toEqual(['line 1: call data accountRef, forwardedFrom, referral recorded masked or not at all, so the replay stands in what the log holds, or has none']);
  });
});

/** Example Callbacks with keys the review asked about: a kept caller's name and a kept forwarded number, secrets and a dropped field. */
const strict = {
  ...callbackApp,
  callData: {
    ...callbackApp.callData!,
    forwardedFrom: { from: 'setup.forwardedFrom', redact: 'keep' as const },
    name: { from: 'setup.callerName', redact: 'keep' as const },
    parent: { from: 'setup.parentCallSid', redact: 'secret' as const },
    account: { from: 'setup.accountSid' },
    caller: { from: 'param.caller', redact: 'keep' as const },
    forwardedHook: { from: 'webhook.ForwardedFrom', redact: 'keep' as const },
    pin: { from: 'param.pin', redact: 'secret' as const },
  },
};
const STRICT_SETUP: SetupFrame = {
  ...SETUP, callerName: 'Pat Example', parentCallSid: 'CA999', accountSid: 'AC123',
  customParameters: { ...SETUP.customParameters, caller: '+15555550123', dw_forwardedHook: '+15555550104', pin: '4321', tenant: 'TOKEN-abc', telnyx_call_from: '+15555550142' },
};

describe('the floor: a key\'s redact never records less than the frame log and the console would by name', () => {
  beforeEach(() => {
    resetAppsForTest();
    registerApp(strict);
  });

  it('keeps the session\'s values whole', async () => {
    const { d } = await setUp('callback', STRICT_SETUP);
    expect(d.store.get('CA1')!.session.callData).toMatchObject({ forwardedFrom: '+15555550102', name: 'Pat Example', caller: '+15555550123', forwardedHook: '+15555550104', pin: '4321' });
  });

  it('writes a kept number to the frame log by its last four, its echo by its webhook field\'s name, and a secret not at all', async () => {
    const { frames } = await setUp('callback', STRICT_SETUP);
    const setup = JSON.parse(frames.split('\n')[0]!) as { msg: SetupFrame };
    expect(setup.msg.customParameters).toEqual({
      queue: 'priority', accountRef: '...1234', dw_referral: '•', callReference: 'redacted', locale: 'en-US',
      caller: '…0123', dw_forwardedHook: '…0104', tenant: 'redacted', telnyx_call_from: '…0142',
    });
    expect(frames).not.toMatch(/5555550123|5555550104|4321|TOKEN-abc|Pat Example/);
  });

  it('shows a kept number and a kept name on the console by the console\'s own masking', async () => {
    const { events } = await setUp('callback', STRICT_SETUP);
    const turn = events.find((e) => e.type === 'turn') as Extract<DashboardEvent, { type: 'turn' }>;
    expect(turn.record.event).toMatchObject({ callData: { forwardedFrom: '…0102', name: 'redacted', caller: '…0123', forwardedHook: '…0104', queue: 'priority' } });
    expect((turn.record.event as { callData: Record<string, string> }).callData).not.toHaveProperty('pin');
    expect((turn.record.event as { callData: Record<string, string> }).callData).not.toHaveProperty('account');
    expect(JSON.stringify(events)).not.toMatch(/5555550123|5555550104|Pat Example|CA999|4321|TOKEN-abc/);
    // The call_started audit row too: the floor holds in the audit, which holds no number or name whole.
    expect(turn.record.audit?.find((a) => a.type === 'call_started')?.detail).toMatchObject({ 'callData.forwardedFrom': '…0102', 'callData.name': 'redacted', 'callData.caller': '…0123', 'callData.forwardedHook': '…0104', 'callData.queue': 'priority' });
  });

  it('writes a setup key\'s own copy in the trace by its redact, and every custom parameter no key reads as redacted', async () => {
    const { traced, d } = await setUp('callback', STRICT_SETUP);
    const provider = (traced.event as { provider: Record<string, string> }).provider;
    // The trace file keeps what a key keeps (it is PHI-bearing); a secret is left out, a masked field masked.
    expect(provider).toMatchObject({ callerName: 'Pat Example', forwardedFrom: '+15555550102', accountSid: '•', 'param.tenant': 'redacted', 'param.callReference': 'redacted', 'param.locale': 'en-US', 'param.telnyx_call_from': '...0142' });
    expect(provider).not.toHaveProperty('parentCallSid');
    expect(provider).not.toHaveProperty('param.pin');
    const file = readFileSync(join(d.dir, 'CA1.jsonl'), 'utf8');
    expect(file).not.toMatch(/CA999|4321|TOKEN-abc|AC123/);
  });

  it('names in a replay every key the log keeps masked or not at all, those the call lacked or the log dropped included', async () => {
    const { d } = await setUp('callback', STRICT_SETUP);
    const replay = await replayFrameLog(join(d.dir, 'CA1.frames.jsonl'), { client: new HeuristicStubClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-10-09' });
    expect(replay.runs[0]!.result.session.callData).not.toHaveProperty('pin');
    expect(replay.runs[0]!.result.session.callData).not.toHaveProperty('account');
    expect(replay.skipped).toEqual(['line 1: call data accountRef, forwardedFrom, referral, name, account, caller, forwardedHook, pin recorded masked or not at all, so the replay stands in what the log holds, or has none']);
    // The log names the keys the call came with, never their values.
    expect(readFileSync(join(d.dir, 'CA1.frames.jsonl'), 'utf8')).toContain('"msg":{"callData":["queue","accountRef","forwardedFrom","referral","name","parent","account","caller","forwardedHook","pin"]}');
  });

  it('names nothing for keys the call did not come with', async () => {
    const { d } = await setUp('callback', { ...SETUP, customParameters: { queue: 'priority' }, forwardedFrom: undefined as unknown as string });
    const replay = await replayFrameLog(join(d.dir, 'CA1.frames.jsonl'), { client: new HeuristicStubClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-10-09' });
    expect(replay.skipped).toEqual([]);
    expect(replay.runs[0]!.result.session.callData).toEqual({ queue: 'priority' });
  });
});

describe('a value no start document can carry', () => {
  it('is no value: a control character in a custom parameter leaves its key absent', async () => {
    const { d } = await setUp('callback', { ...SETUP, customParameters: { queue: 'prio\u0001rity', accountRef: 'AC\n55501234' } });
    expect(d.store.get('CA1')!.session.callData).toEqual({ forwardedFrom: '+15555550102' });
  });
});
