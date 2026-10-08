import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleSocketMessage, newConnectionContext, type AdapterDeps } from './adapter';
import { SessionStore, type SocketLike } from './sessions';
import { DashboardBus } from './dashboard/bus';
import { redactDeep, type DashboardEvent } from './dashboard/events';
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
import { useTestkit } from '../testing/apps';
import { defaultCorpusFile } from '../run/fixtures';
import { VOICE_RELAY } from '../channel/caps';
import { callbackApp } from '../testing/callback/app';
import { setupCallerOf } from './voice/registry';
import { twilioProvider } from './voice/twilio';
import { telnyxProvider } from './voice/telnyx';
import type { SetupFrame } from '../channel/relay/frames';

/**
 * The number the caller is calling from, read off each carrier's setup frame (VoiceProvider.setupCallerOf):
 * the console's call_started shows it masked on every carrier, and the core is given it
 * (SessionStart.callerNumber) only for an app with a slot that offers it (core/callerNumber.ts).
 */

/** The registry with `first` as the default app (the one the trace file masks by), and the other beside it. */
function useApps(first: 'testkit' | 'callback'): void {
  useTestkit();
  if (first === 'callback') {
    resetAppsForTest();
    registerApp(callbackApp);
    registerApp(testkitApp);
  } else registerApp(callbackApp);
}

beforeEach(() => useApps('testkit'));

const TWILIO_SETUP: SetupFrame = { type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+15555550199', to: '+15555550100', customParameters: {} };
/** Shaped as a live Telnyx call sends it (2026-10-05): from and to null, the numbers in its custom parameters. */
const telnyxSetup = (from?: string): SetupFrame => ({
  type: 'setup', sessionId: 'TX1', callSid: '5e9fcc12-0000-4000-8000-000000000000', callControlId: 'v3:CALL1',
  from: null as unknown as string, to: null as unknown as string,
  customParameters: from === undefined ? { telnyx_call_to: '+15555550111' } : { telnyx_call_from: from, telnyx_call_to: '+15555550111' },
});

describe('the caller\'s number on a setup frame', () => {
  it('is Twilio\'s from', () => {
    expect(twilioProvider.setupCallerOf!(TWILIO_SETUP)).toBe('+15555550199');
    expect(twilioProvider.setupCallerOf!({ ...TWILIO_SETUP, from: '' })).toBeNull();
    // A withheld number comes as a placeholder, which the core refuses (core/callerNumber.ts); the provider passes it on.
    expect(twilioProvider.setupCallerOf!({ ...TWILIO_SETUP, from: '+7378742833' })).toBe('+7378742833');
  });

  it('is Telnyx\'s telnyx_call_from, its from being null', () => {
    expect(telnyxProvider.setupCallerOf!(telnyxSetup('+15555550110'))).toBe('+15555550110');
    expect(telnyxProvider.setupCallerOf!(telnyxSetup())).toBeNull();
    expect(telnyxProvider.setupCallerOf!(telnyxSetup(''))).toBeNull();
  });

  it('is the setup\'s from for a provider without the method, or one the engine does not know', () => {
    expect(setupCallerOf('twilio', TWILIO_SETUP)).toBe('+15555550199');
    expect(setupCallerOf('telnyx', telnyxSetup('+15555550110'))).toBe('+15555550110');
    expect(setupCallerOf('acme', TWILIO_SETUP)).toBe('+15555550199');
    expect(setupCallerOf(undefined, TWILIO_SETUP)).toBe('+15555550199');
    expect(setupCallerOf('acme', { ...TWILIO_SETUP, from: '' })).toBeNull();
  });

  it('is masked by key on the console and in the frame log, as a start event carries it', () => {
    expect(redactDeep({ type: 'session.start', provider: {}, callerNumber: '+15555550142' })).toEqual({ type: 'session.start', provider: {}, callerNumber: '…0142' });
  });
});

interface Fake extends SocketLike { sent: unknown[] }
function fakeSocket(): Fake {
  const sent: unknown[] = [];
  return { sent, readyState: 1, send: (data: string, cb?: (err?: Error) => void) => { sent.push(JSON.parse(data)); cb?.(); }, close: () => {} } as unknown as Fake;
}

/** Deps whose calls are `appId`'s, with a bus, and the events it carried. */
function busDeps(appId: string): { d: AdapterDeps & { dir: string }; events: DashboardEvent[] } {
  const dir = mkdtempSync(join(tmpdir(), 'caller-'));
  const client = new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: 0.9, fallback: new HeuristicStubClient() });
  const bus = new DashboardBus();
  const events: DashboardEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const store: SessionStore = new SessionStore((callSid) => ({
    session: newSession(callSid, 0, VOICE_RELAY, ANONYMOUS, appId),
    opts: {
      client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-10-07',
      trace: new TraceWriter(join(dir, `${callSid}.jsonl`)), now: () => 0, render: null,
      observe: makeObserver(bus, store, callSid),
    },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), () => 0),
  }), 60_000, () => 0);
  return { d: { store, tokens: new CallTokens(60_000, () => 0), log: () => {}, dir, bus }, events };
}

/** A call's setup on `provider`, and what the console and the trace file got of it. */
async function setUp(appId: string, provider: 'twilio' | 'telnyx', setup: SetupFrame): Promise<{ events: DashboardEvent[]; d: AdapterDeps & { dir: string }; callId: string; traced: TraceRecord }> {
  const { d, events } = busDeps(appId);
  const callId = provider === 'telnyx' ? setup.callControlId! : setup.callSid;
  const sock = fakeSocket();
  await handleSocketMessage(d, sock, newConnectionContext(d.tokens.mint(callId, provider), sock, provider), JSON.stringify(setup));
  const traced = JSON.parse(readFileSync(join(d.dir, `${callId}.jsonl`), 'utf8').split('\n')[0]!) as TraceRecord;
  return { events, d, callId, traced };
}

describe('the console\'s call_started', () => {
  it('shows a Telnyx caller\'s last four, where it showed "unknown"', async () => {
    const { events } = await setUp('testkit', 'telnyx', telnyxSetup('+15555550110'));
    expect(events.find((e) => e.type === 'call_started')).toMatchObject({ from: '…0110', provider: 'telnyx' });
    expect(JSON.stringify(events)).not.toContain('5555550110');
  });

  it('shows "unknown" for a Telnyx call with no number, and a Twilio caller as before', async () => {
    expect((await setUp('testkit', 'telnyx', telnyxSetup())).events.find((e) => e.type === 'call_started')).toMatchObject({ from: 'unknown' });
    expect((await setUp('testkit', 'twilio', TWILIO_SETUP)).events.find((e) => e.type === 'call_started')).toMatchObject({ from: '…0199' });
  });
});

describe('the start event', () => {
  it('carries no number for an app without a slot that offers it, on either carrier', async () => {
    for (const [provider, setup] of [['twilio', TWILIO_SETUP], ['telnyx', telnyxSetup('+15555550110')]] as const) {
      const { traced, d, callId } = await setUp('testkit', provider, setup);
      expect(traced.event).not.toHaveProperty('callerNumber');
      expect(traced).not.toHaveProperty('callerNumber');
      expect(d.store.get(callId)!.session).not.toHaveProperty('callerNumber');
    }
  });

  it('carries the number for an app with such a slot, kept on the session, masked in the trace file and on the console', async () => {
    // The app the server runs is its default: the trace file masks by its slots.
    useApps('callback');
    const { traced, d, callId, events } = await setUp('callback', 'telnyx', telnyxSetup('+15555550142'));
    expect(d.store.get(callId)!.session.callerNumber).toBe('+15555550142');
    expect(traced.callerNumber).toBe('kept');
    expect(traced.event).toMatchObject({ type: 'session.start', callerNumber: '...0142' });
    const turn = events.find((e) => e.type === 'turn') as Extract<DashboardEvent, { type: 'turn' }>;
    expect(turn.record.event).toMatchObject({ callerNumber: '…0142' });
    expect(JSON.stringify(events)).not.toContain('5555550142');
  });

  it('a withheld number is no number: nothing kept, and the trace says so', async () => {
    const { traced, d, callId } = await setUp('callback', 'twilio', { ...TWILIO_SETUP, from: '+7378742833' });
    expect(d.store.get(callId)!.session).not.toHaveProperty('callerNumber');
    expect(traced.callerNumber).toBe('none');
  });
});
