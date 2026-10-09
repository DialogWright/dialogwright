import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleSocketMessage, newConnectionContext, type AdapterDeps } from './adapter';
import { SessionStore, type SocketLike } from './sessions';
import { DashboardBus } from './dashboard/bus';
import type { DashboardEvent } from './dashboard/events';
import { makeObserver } from './dashboard/observer';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { newSession, type Session } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { TraceWriter } from '../trace/writer';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { testkitApp } from '../testing/testkit';
import { ANONYMOUS } from '../gate/principal';
import { useTestkit } from '../testing/apps';
import { defaultCorpusFile } from '../run/fixtures';
import { VOICE_RELAY } from '../channel/caps';
import { defineSlot } from '../slots/defineSlot';
import type { App } from '../core/app/types';

/**
 * A slot that hides its value hides its keys: a digit keyed at a slot recorded by its length (a
 * digits slot's `redact: length`, SlotSpec.statement false: a PIN) is masked in the frame log, on the
 * console and in the trace, as a digit of an identity factor is. A digit at an open slot or the menu
 * is logged as keyed, as before.
 */

/** The testkit with a four-digit PIN by its length, and a parcel number no one hides. */
const PIN_APP: App = {
  ...testkitApp,
  id: 'testkit-pin',
  slots: {
    ...testkitApp.slots,
    pin: defineSlot('pin', { type: 'digits', noun: 'PIN', length: 4, keypad: true, redact: 'length' }),
    parcel: defineSlot('parcel', { type: 'digits', noun: 'parcel', length: 4, keypad: true, redact: 'none', handoff: 'display' }),
  },
};

// PIN_APP is the default app: the trace file masks by the default app's slots (a record carries no app id).
beforeEach(() => {
  useTestkit();
  resetAppsForTest();
  registerApp(PIN_APP);
  registerApp(testkitApp);
});

interface Fake extends SocketLike { sent: unknown[] }
function fakeSocket(): Fake {
  const sent: unknown[] = [];
  return { sent, readyState: 1, send: (data: string, cb?: (err?: Error) => void) => { sent.push(JSON.parse(data)); cb?.(); }, close: () => {} } as unknown as Fake;
}

/** A call on PIN_APP, set up, then asked `promptedFor`, then keyed `digits`; what the frame log, the console and the trace got. */
async function keyed(promptedFor: Session['promptedFor'], digits: string): Promise<{ frames: string; trace: string; events: DashboardEvent[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'secret-keys-'));
  const client = new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: 0.9, fallback: new HeuristicStubClient() });
  const bus = new DashboardBus();
  const events: DashboardEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const store: SessionStore = new SessionStore((callSid) => ({
    session: newSession(callSid, 0, VOICE_RELAY, ANONYMOUS, PIN_APP.id),
    opts: {
      client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-10-08',
      trace: new TraceWriter(join(dir, `${callSid}.jsonl`)), now: () => 0, render: null,
      observe: makeObserver(bus, store, callSid),
    },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), () => 0),
  }), 60_000, () => 0);
  const d: AdapterDeps = { store, tokens: new CallTokens(60_000, () => 0), log: () => {}, bus };
  const sock = fakeSocket();
  const ctx = newConnectionContext(d.tokens.mint('CA1'), sock);
  await handleSocketMessage(d, sock, ctx, JSON.stringify({ type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+15555550199', to: '+15555550100', customParameters: {} }));
  store.get('CA1')!.session.promptedFor = promptedFor;
  for (const digit of digits) await handleSocketMessage(d, sock, ctx, JSON.stringify({ type: 'dtmf', digit }));
  return { frames: readFileSync(join(dir, 'CA1.frames.jsonl'), 'utf8'), trace: readFileSync(join(dir, 'CA1.jsonl'), 'utf8'), events };
}

const keyedDigits = (events: DashboardEvent[]): string[] => events.flatMap((e) => (e.type === 'dtmf' ? [e.digit] : []));

describe('keys at a slot that hides its value', () => {
  it('are masked in the frame log, on the console and in the trace', async () => {
    const { frames, trace, events } = await keyed('pin', '7395');
    expect(keyedDigits(events)).toEqual(['•', '•', '•', '•']);
    expect(frames).toContain('{"type":"dtmf","digit":"•"}');
    expect(frames).not.toMatch(/"digit":"\d"/);
    expect(trace).toContain('"event":{"type":"user.key","digit":"•"}');
    expect(trace).not.toMatch(/"digit":"\d"/);
    expect(trace).not.toContain('dtmf:7');
    for (const sink of [frames, trace, JSON.stringify(events)]) expect(sink).not.toContain('7395');
  });

  it('but not at a slot no one hides, nor at the menu', async () => {
    for (const at of ['parcel', null] as const) {
      const { frames, trace, events } = await keyed(at, '12');
      expect(keyedDigits(events), String(at)).toEqual(['1', '2']);
      expect(frames, String(at)).toContain('{"type":"dtmf","digit":"1"}');
      expect(trace, String(at)).toContain('"event":{"type":"user.key","digit":"1"}');
    }
  });
});
