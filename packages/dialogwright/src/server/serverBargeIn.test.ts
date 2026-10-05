import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_NO_INPUT_AFTER_SPEECH_MS, forgetNoInput, handleSocketMessage, newConnectionContext, type AdapterDeps, type ServerBargeInSettings } from './adapter';
import { SessionStore, type SocketLike } from './sessions';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { JevClient } from '../jev/types';
import { textEstimateMs } from '../prompts/playback';
import { promptText } from '../prompts/render';
import { TraceWriter } from '../trace/writer';
import { replayFrameLog } from '../harness-text/replay';
import { testkitApp } from '../testing/testkit';
import { useTestkit } from '../testing/apps';
import { defaultCorpusFile } from '../run/fixtures';
import { VOICE_RELAY } from '../channel/caps';
import { DEFAULT_BARGE_IN_MIN_SPEECH_MS, DEFAULT_SPEECH_GAP_MS, type BargeIn } from '../channel/voiceProviders';

useTestkit();

/**
 * BARGE_IN=server (server/adapter.ts bargeIn): the server stops a line the caller talks over, from the
 * carrier's reports of the caller and the agent speaking, with a play frame of the silent clip, and hands
 * the core the interrupt a carrier's own barge-in would have sent.
 */

type Fake = SocketLike & { sent: Record<string, unknown>[] };
function fakeSocket(): Fake {
  const s: Fake = { sent: [], send(d, cb) { s.sent.push(JSON.parse(d) as Record<string, unknown>); cb?.(); }, close() {} };
  return s;
}

function corpusClient(): JevClient {
  return new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: 0.9, fallback: new HeuristicStubClient() });
}

const STOP = 'https://demo.example.app/relay/silence.wav';
const SETTINGS: ServerBargeInSettings = { minSpeechMs: DEFAULT_BARGE_IN_MIN_SPEECH_MS, stopSource: STOP };
const WAIT = 7_000;

function deps(over: Partial<AdapterDeps> = {}): AdapterDeps & { dir: string; lines: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'server-barge-'));
  const client = corpusClient();
  const store = new SessionStore((callSid) => ({
    session: newSession(callSid, 0, VOICE_RELAY),
    opts: { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', trace: new TraceWriter(join(dir, `${callSid}.jsonl`)), now: () => 0, render: null },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`)),
  }), 60_000, () => 0);
  const lines: string[] = [];
  return {
    store, tokens: new CallTokens(60_000, () => 0), log: (l) => lines.push(l), dir, lines,
    noInputMs: WAIT, bargeIn: 'server', serverBargeIn: SETTINGS, ...over,
  };
}

const setupMsg = (callSid: string) => JSON.stringify({ type: 'setup', sessionId: 'VX1', callSid, from: '+15555550110', to: '+15555550111', customParameters: {} });
const prompt = (t: string) => JSON.stringify({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: true });
const info = (name: string, value: string) => JSON.stringify({ type: 'info', name, value });
const texts = (s: Fake) => s.sent.filter((m) => m.type === 'text').map((m) => m.token as string);
const plays = (s: Fake) => s.sent.filter((m) => m.type === 'play');
type LogLine = { dir: string; msg: Record<string, unknown> };
const frameLines = (dir: string): LogLine[] => readFileSync(join(dir, 'CA1.frames.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LogLine);
const logged = (dir: string, key: string) => frameLines(dir).filter((f) => f.dir === 'log' && f.msg[key] !== undefined).map((f) => f.msg[key]);

const GREETING = promptText(testkitApp, 'greeting', {});
const NO_INPUT = promptText(testkitApp, 'no_input', {});
const ASK_INTENT = promptText(testkitApp, 'ask_intent', {});
const REPORT_ACK = 'Sure, I can help you report a missing parcel.';
const ASK_ACCOUNT_ID = "First I need to verify your identity. What's your account ID? It's the eight digits on your delivery notice.";
const GOODBYE = 'Thanks for calling Example Parcels. Goodbye.';

describe('BARGE_IN=server', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    forgetNoInput('CA1');
    vi.useRealTimers();
  });

  /** A call on `provider` that has just been sent the greeting. */
  async function greeted(d: AdapterDeps, provider = 'telnyx') {
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1', provider), sock, provider);
    const send = (raw: string) => handleSocketMessage(d, sock, ctx, raw);
    await send(setupMsg('CA1'));
    return {
      sock, ctx, send,
      agent: (on: boolean) => send(info('agentSpeaking', on ? 'on' : 'off')),
      caller: (on: boolean) => send(info('clientSpeaking', on ? 'on' : 'off')),
      played: (line: string) => send(info('tokensPlayed', line)),
    };
  }

  it('speech under the minimum does not stop the line', async () => {
    const d = deps();
    const call = await greeted(d);
    await call.agent(true);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_BARGE_IN_MIN_SPEECH_MS - 1);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(plays(call.sock)).toEqual([]);
    expect(logged(d.dir, 'bargeIn')).toEqual([]);
    expect(d.store.get('CA1')!.session.lastInterrupt).toBeNull();
  });

  it('speech that reaches the minimum stops the line once, with the silent clip, and the core is told of an interrupt', async () => {
    const d = deps();
    const call = await greeted(d);
    await call.agent(true);
    await vi.advanceTimersByTimeAsync(1_500);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_BARGE_IN_MIN_SPEECH_MS - 1);
    expect(plays(call.sock)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(plays(call.sock)).toEqual([{ type: 'play', source: STOP, loop: 1, preemptible: true, interruptible: false }]);
    // The caller talks on: still one stop.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(plays(call.sock)).toHaveLength(1);

    const lines = frameLines(d.dir);
    const barge = lines.findIndex((l) => l.dir === 'log' && l.msg.bargeIn !== undefined);
    expect(lines[barge]!.msg).toEqual({ bargeIn: { speechMs: DEFAULT_BARGE_IN_MIN_SPEECH_MS, line: 0, lines: 1 } });
    // The play frame, then the interrupt as an inbound frame (what replay reads), in that order.
    expect(lines[barge + 1]).toMatchObject({ dir: 'out', msg: { type: 'play', source: STOP } });
    expect(lines[barge + 2]).toMatchObject({ dir: 'in', msg: { type: 'interrupt', utteranceUntilInterrupt: '', durationUntilInterruptMs: 1_500 } });
    expect(d.store.get('CA1')!.session.lastInterrupt).toEqual({ heard: '', afterMs: 1_500 });
    expect(d.lines).toContain(`CA1: the caller spoke over line 1 of 1 for ${DEFAULT_BARGE_IN_MIN_SPEECH_MS} ms, playback stopped`);
    // Nothing else was said: an interrupt is state, not a turn.
    expect(texts(call.sock)).toEqual([GREETING]);
  });

  it('sums the carrier\'s short bursts of one stretch of speech, and starts afresh after a longer pause', async () => {
    const d = deps();
    const call = await greeted(d);
    await call.agent(true);
    // Blips with pauses longer than the gap: each a stretch of its own, none reaching the minimum.
    for (let i = 0; i < 4; i += 1) {
      await call.caller(true);
      await vi.advanceTimersByTimeAsync(200);
      await call.caller(false);
      await vi.advanceTimersByTimeAsync(DEFAULT_SPEECH_GAP_MS + 1);
    }
    expect(plays(call.sock)).toEqual([]);
    // One sentence as Telnyx reports it: 150 ms on, 100 ms off, again and again. 150 + 150 + 100 = 400 ms of speech.
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(150);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(100);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(150);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(100);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(99);
    expect(plays(call.sock)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(plays(call.sock)).toHaveLength(1);
    expect(logged(d.dir, 'bargeIn')).toEqual([{ speechMs: 400, line: 0, lines: 1 }]);
  });

  it('nothing is stopped when the agent is not speaking', async () => {
    const d = deps();
    const call = await greeted(d);
    // The carrier has not said the agent is speaking: the caller talking is an answer, not a barge-in.
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(2_000);
    await call.caller(false);
    // Nor once it has said the lines finished.
    await call.agent(true);
    await call.agent(false);
    await vi.advanceTimersByTimeAsync(DEFAULT_SPEECH_GAP_MS + 1);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(plays(call.sock)).toEqual([]);
    // Nor once the carrier has reported the line played.
    await call.agent(true);
    await call.played(GREETING);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(plays(call.sock)).toEqual([]);
  });

  it('counts speech that began before the lines from when they began', async () => {
    const d = deps();
    const call = await greeted(d);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await call.agent(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_BARGE_IN_MIN_SPEECH_MS - 1);
    expect(plays(call.sock)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(plays(call.sock)).toHaveLength(1);
    // The caller was already speaking when the line began: it was cut at its start (a caller who had not finished).
    expect(d.store.get('CA1')!.session.lastInterrupt).toEqual({ heard: '', afterMs: 0 });
  });

  it('a line the carrier reports played is what the caller heard, and the line spoken over is the next', async () => {
    const d = deps();
    const call = await greeted(d);
    await call.send(prompt('my parcel never arrived'));
    expect(texts(call.sock).slice(-2)).toEqual([REPORT_ACK, ASK_ACCOUNT_ID]);
    await call.agent(true);
    await call.played(REPORT_ACK);
    await vi.advanceTimersByTimeAsync(300);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_BARGE_IN_MIN_SPEECH_MS);
    expect(plays(call.sock)).toHaveLength(1);
    expect(logged(d.dir, 'bargeIn')).toEqual([{ speechMs: DEFAULT_BARGE_IN_MIN_SPEECH_MS, line: 1, lines: 2 }]);
    expect(d.store.get('CA1')!.session.lastInterrupt).toEqual({ heard: REPORT_ACK, afterMs: 300 });
  });

  it('never stops a line the app marked not interruptible: a goodbye held for its end plays out', async () => {
    const d = deps();
    const call = await greeted(d);
    for (const t of ['can you deliver tomorrow morning', 'five five five zero one two three four', 'april twelfth nineteen eighty five', "no, that's all"]) {
      await call.send(prompt(t));
    }
    expect(texts(call.sock).at(-1)).toBe(GOODBYE);
    // Telnyx drops what it has not said at `end`: the end waits for the goodbye (END_AFTER_PLAYBACK).
    expect(call.sock.sent.some((m) => m.type === 'end')).toBe(false);
    await call.agent(true);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(plays(call.sock)).toEqual([]);
    await call.played(GOODBYE);
    expect(call.sock.sent.at(-1)).toMatchObject({ type: 'end' });
    expect(logged(d.dir, 'bargeIn')).toEqual([]);
  });

  it('once per stretch: a new line sent while the same stretch goes on is not stopped; after a pause it can be', async () => {
    const d = deps();
    const call = await greeted(d);
    await call.agent(true);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_BARGE_IN_MIN_SPEECH_MS);
    expect(plays(call.sock)).toHaveLength(1);
    // Telnyx's transcript of what they said so far, while they go on talking: its reply plays over them.
    await call.send(prompt('my parcel never arrived'));
    await call.agent(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(plays(call.sock)).toHaveLength(1);
    // They stop, longer than the gap, and talk over the reply again: a new stretch.
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(DEFAULT_SPEECH_GAP_MS + 1);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_BARGE_IN_MIN_SPEECH_MS);
    expect(plays(call.sock)).toHaveLength(2);
  });

  it('BARGE_IN other than server: the server stops nothing', async () => {
    for (const mode of ['any', 'none'] as BargeIn[]) {
      const d = deps({ bargeIn: mode });
      const call = await greeted(d);
      await call.agent(true);
      await call.caller(true);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(plays(call.sock)).toEqual([]);
      forgetNoInput('CA1');
    }
  });

  it('a carrier with no way to stop its playback: nothing is stopped', async () => {
    // Twilio cannot (config refuses BARGE_IN=server there); were a call to come on it all the same, nothing is sent.
    const d = deps();
    const call = await greeted(d, 'twilio');
    await call.agent(true);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(plays(call.sock)).toEqual([]);
  });

  it('the no-input wait is held while the caller who barged in talks on, and resumes after them as before', async () => {
    const d = deps();
    const call = await greeted(d);
    await call.agent(true);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_BARGE_IN_MIN_SPEECH_MS);
    expect(plays(call.sock)).toHaveLength(1);
    // The interrupt's turn re-armed the wait while the caller is still speaking: held.
    expect(logged(d.dir, 'noInputHeld').length).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(textEstimateMs(GREETING) + WAIT + 5_000);
    expect(texts(call.sock)).toEqual([GREETING]);
    await call.caller(false);
    // The wait was armed from the silent clip, not the greeting it cut: the settle after the caller stopped.
    expect(logged(d.dir, 'after').at(-1)).toBe('speech');
    await vi.advanceTimersByTimeAsync(DEFAULT_NO_INPUT_AFTER_SPEECH_MS);
    expect(texts(call.sock)).toEqual([GREETING, NO_INPUT, ASK_INTENT]);
  });

  it('the call replays from its frame log to the same turns, the interrupt among them', async () => {
    const d = deps();
    const call = await greeted(d);
    await call.agent(true);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_BARGE_IN_MIN_SPEECH_MS);
    await call.caller(false);
    await call.send(prompt('my parcel never arrived'));
    vi.useRealTimers();
    const live = readFileSync(join(d.dir, 'CA1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { event: { type: string } });
    const replay = await replayFrameLog(join(d.dir, 'CA1.frames.jsonl'), { client: corpusClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', trace: null }, undefined, { todayIsoOverride: '2026-09-18' });
    expect(replay.skipped).toEqual([]);
    expect(replay.records.map((r) => r.event.type)).toEqual(live.map((r) => r.event.type));
    expect(replay.records.map((r) => r.event.type)).toContain('user.interrupt');
  });
});
