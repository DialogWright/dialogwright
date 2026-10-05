import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetNoInput, handleSocketMessage, newConnectionContext, type AdapterDeps } from './adapter';
import { SessionStore, type SocketLike } from './sessions';
import { CallTokens } from './tokens';
import { FrameLog, readFrameLog } from './frameLog';
import { DashboardBus } from './dashboard/bus';
import type { DashboardEvent } from './dashboard/events';
import { makeObserver } from './dashboard/observer';
import { deliveriesOf } from './dashboard/delivery';
import { reduce } from './dashboard/view.js';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { TraceWriter } from '../trace/writer';
import { VOICE_RELAY } from '../channel/caps';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { registerTestkit } from '../testing/testkit';
import { ANONYMOUS } from '../gate/principal';
import { PLACE_APP_ID, placeApp, placeClient } from '../testing/placeApp';
import { DEFAULT_INCOMPLETE_WAIT_MS, DEFAULT_SPURIOUS_INTERRUPT_WINDOW_MS, type BargeIn } from '../channel/voiceProviders';
import { SPURIOUS_INTERRUPT_UNREPORTED_SETTLE_MS } from './adapter';

/**
 * The console's delivery notes, from the adapter's side: each fact it writes to the frame log goes to
 * the dashboard as it is written, and a reload of the call reads the very same facts back from the frame
 * log (dashboard/delivery.ts deliveriesOf). The timings are a live Telnyx call's (2026-10-05); the words
 * are the test app's.
 */

const CALL = 'CA6';
const REASK = 'Sorry, where is the problem?';
/** The model hears a bare number as unfinished; anything else as finished (as bargeRecovery.test.ts). */
const complete = (text: string): number => (/^(seventy six)$/i.test(text.trim()) ? 0.3 : 0.9);
const SPURIOUS = { spuriousInterrupts: { windowMs: DEFAULT_SPURIOUS_INTERRUPT_WINDOW_MS } } as const;
const HOLD = { incompleteWait: { waitMs: DEFAULT_INCOMPLETE_WAIT_MS } } as const;

beforeEach(() => {
  resetAppsForTest();
  registerApp(placeApp());
  registerTestkit();
  vi.useFakeTimers();
});
afterEach(() => {
  forgetNoInput(CALL);
  vi.useRealTimers();
});

function liveCall(provider: string, bargeIn: BargeIn = 'any', more: Partial<AdapterDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-notes-'));
  const bus = new DashboardBus();
  const events: DashboardEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const opts = { client: placeClient({ utteranceComplete: complete }), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => Date.now() };
  const store: SessionStore = new SessionStore((callSid) => ({
    session: newSession(callSid, 0, VOICE_RELAY, ANONYMOUS, PLACE_APP_ID),
    opts: { ...opts, trace: new TraceWriter(join(dir, `${callSid}.jsonl`)), observe: makeObserver(bus, store, callSid) },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`)),
  }), 60_000, () => 0);
  const tokens = new CallTokens(60_000, () => 0);
  const deps: AdapterDeps = { store, tokens, log: () => {}, bargeIn, bus, resay: { minFraction: 0.35 }, ...more };
  const sent: Record<string, unknown>[] = [];
  const sock: SocketLike = { send: (d, cb) => { sent.push(JSON.parse(d) as Record<string, unknown>); cb?.(); }, close: () => {} };
  const ctx = newConnectionContext(tokens.mint(CALL, provider), sock, provider);
  const send = (m: object) => handleSocketMessage(deps, sock, ctx, JSON.stringify(m));
  const info = (name: string, value: string) => send({ type: 'info', name, value });
  const caller = (on: boolean) => info('clientSpeaking', on ? 'on' : 'off');
  return {
    sent, events, caller, texts: () => sent.filter((f) => f.type === 'text').map((f) => f.token as string),
    start: () => send({ type: 'setup', sessionId: 'VX6', callSid: CALL, from: '+15555550100', to: '+15555550199', customParameters: {} }),
    say: (t: string) => send({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: true }),
    cut: (heard: string, ms: number) => send({ type: 'interrupt', utteranceUntilInterrupt: heard, durationUntilInterruptMs: ms }),
    agent: (on: boolean) => info('agentSpeaking', on ? 'on' : 'off'),
    speak: async (...bursts: number[]) => {
      for (const [i, ms] of bursts.entries()) {
        await caller(i % 2 === 0);
        await vi.advanceTimersByTimeAsync(ms);
      }
      if (bursts.length % 2 === 1) await caller(false);
    },
    /** The delivery facts the dashboard was handed live, in order. */
    published: () => events.flatMap((e) => (e.type === 'delivery' ? [e.fact] : [])),
    /** The same, as a reload of the call reads them from its frame log. */
    reloaded: () => deliveriesOf(readFrameLog(join(dir, `${CALL}.frames.jsonl`)), CALL).map((e) => e.fact),
  };
}

describe('delivery notes, as the adapter publishes them', () => {
  it('a caller who came back in: the join on the joined words, with their pause, live and on reload', async () => {
    const call = liveCall('telnyx', 'none');
    await call.start();
    await call.speak(900);
    await vi.advanceTimersByTimeAsync(800);
    await call.say('i want to report a problem');
    await vi.advanceTimersByTimeAsync(3_000);
    await call.speak(400);
    await vi.advanceTimersByTimeAsync(517);
    await call.say('at');
    expect(call.sent.filter((f) => f.type === 'text').at(-1)?.token).toBe(REASK);
    await vi.advanceTimersByTimeAsync(24);
    await call.speak(343, 130, 410);
    await vi.advanceTimersByTimeAsync(496);
    await call.say('22 Alder Street.');

    expect(call.published()).toEqual([
      { kind: 'callerResumed', pauseMs: 541, intoReplyMs: 24 },
      { kind: 'joined', value: 2 },
    ]);
    expect(call.reloaded()).toEqual(call.published());
    const v = reduce(call.events);
    const noted = v.lines.filter((l) => l.notes);
    expect(noted.map((l) => [l.kind, l.text, l.notes!.map((n) => n.text)])).toEqual([
      ['caller', 'at 22 Alder Street.', ['joined with the previous answer (paused 0.5 s)']],
    ]);
  });

  /** The agent lines with notes, as the console shows them: the line, whether it was said, and its notes. */
  const noted = (events: DashboardEvent[]) => reduce(events).lines.filter((l) => l.notes)
    .map((l) => [l.kind, l.text, l.unsaid === true ? 'not said' : 'said', l.notes!.map((n) => n.text)]);

  it("an interrupt the adapter finds was not the caller's: one note, said again, live and on reload", async () => {
    const call = liveCall('telnyx', 'speech', SPURIOUS);
    await call.start();
    const greeting = call.texts()[0]!;
    await vi.advanceTimersByTimeAsync(65);
    await call.agent(true);
    await vi.advanceTimersByTimeAsync(1_639);
    const cut = call.cut(greeting, 1_704);
    await vi.advanceTimersByTimeAsync(SPURIOUS_INTERRUPT_UNREPORTED_SETTLE_MS);
    await cut;
    expect(call.texts()).toEqual([greeting, greeting]);
    expect(call.published()).toEqual([
      { kind: 'interrupt', afterMs: 1_704 },
      { kind: 'spuriousInterrupt', afterMs: 1_704, quietMs: null },
      { kind: 'resaid', reason: 'spurious-interrupt', afterMs: 1_704, expectedMs: expect.any(Number) },
    ]);
    expect(call.reloaded()).toEqual(call.published());
    expect(noted(call.events)).toEqual([['system', greeting, 'said', ['interrupted 1.7 s in with no caller speaking, said again']]]);
  });

  it("a real interrupt (the caller heard just before it) keeps the caller's note", async () => {
    const call = liveCall('telnyx', 'speech', SPURIOUS);
    await call.start();
    await call.agent(true);
    await vi.advanceTimersByTimeAsync(500);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(200);
    await call.cut('Hello', 700);
    expect(call.published()).toEqual([{ kind: 'interrupt', afterMs: 700 }]);
    expect(call.reloaded()).toEqual(call.published());
    expect(noted(call.events).map((n) => n[3])).toEqual([['caller talked over this, 0.7 s in']]);
  });

  it('on a carrier that reports no speakers, an interrupt is the caller talking over the line', async () => {
    const call = liveCall('twilio', 'any', SPURIOUS);
    await call.start();
    await vi.advanceTimersByTimeAsync(300);
    await call.cut('Hello', 300);
    expect(call.published()).toEqual([{ kind: 'interrupt', afterMs: 300 }]);
    expect(call.reloaded()).toEqual(call.published());
  });

  /** Up to "seventy six", whose reply is held: returns the held prompt, not awaited. */
  async function toFragment(call: ReturnType<typeof liveCall>): Promise<{ held: Promise<void> }> {
    await call.start();
    await call.speak(900);
    await vi.advanceTimersByTimeAsync(800);
    await call.say('i want to report a problem');
    await vi.advanceTimersByTimeAsync(3_000);
    await call.speak(595);
    await vi.advanceTimersByTimeAsync(712);
    return { held: call.say('seventy six') };
  }

  it('a reply held and never said, the caller going on: struck out, and the join on the joined words', async () => {
    const call = liveCall('telnyx', 'speech', HOLD);
    const { held } = await toFragment(call);
    await vi.advanceTimersByTimeAsync(680);
    await call.caller(true);
    await held;
    await vi.advanceTimersByTimeAsync(800);
    await call.speak(150, 400);
    await vi.advanceTimersByTimeAsync(900);
    await call.say('twenty five oak hollow lane');
    expect(call.texts()).not.toContain(REASK);
    expect(call.published()).toEqual([
      { kind: 'replyHeld', ms: 680, outcome: 'joined', utteranceComplete: 0.3, turn: expect.any(Number) },
      { kind: 'callerResumed', pauseMs: 1_392, intoReplyMs: 0 },
      { kind: 'joined', value: 2 },
    ]);
    expect(call.reloaded()).toEqual(call.published());
    expect(noted(call.events)).toEqual([
      ['system', REASK, 'not said', ['not said: the caller went on']],
      ['caller', 'seventy six twenty five oak hollow lane', 'said', ['joined with the previous answer (paused 1.4 s)']],
    ]);
  });

  it('a reply held with no caller in the wait: said after it, and noted so', async () => {
    const call = liveCall('telnyx', 'speech', HOLD);
    const { held } = await toFragment(call);
    await vi.advanceTimersByTimeAsync(DEFAULT_INCOMPLETE_WAIT_MS);
    await held;
    expect(call.texts().at(-1)).toBe(REASK);
    expect(call.reloaded()).toEqual(call.published());
    expect(noted(call.events)).toEqual([['system', REASK, 'said', ['reply held 1.0 s for the caller to finish, then said']]]);
  });
});
