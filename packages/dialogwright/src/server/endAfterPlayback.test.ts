import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetNoInput, handleSocketClose, handleSocketMessage, newConnectionContext, RESAY_SETTLE_MS, type AdapterDeps } from './adapter';
import { SessionStore, type SocketLike } from './sessions';
import { decideActionTwiml, type HttpDeps } from './http';
import { describeConfig, loadConfig } from './config';
import { DashboardBus } from './dashboard/bus';
import type { DashboardEvent } from './dashboard/events';
import { makeObserver } from './dashboard/observer';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { textEstimateMs } from '../prompts/playback';
import { TraceWriter } from '../trace/writer';
import { useTestkit } from '../testing/apps';
import { defaultCorpusFile } from '../run/fixtures';
import { VOICE_RELAY } from '../channel/caps';
import { DEFAULT_END_PLAYBACK_MAX_MS, END_PLAYBACK_LEAD_MS, END_PLAYBACK_MARGIN_MS } from '../channel/voiceProviders';
import { endDropsSpeechOf } from './voice/registry';

useTestkit();

/**
 * A turn that ends the call holds its `end` frame until the lines before it have played
 * (END_AFTER_PLAYBACK). Seen on a live Telnyx call (2026-10-05): "Goodbye." and `end` went out in the
 * same millisecond, Telnyx acted on the end at once, agentSpeaking went off 14 ms after it went on,
 * and the caller heard nothing of the goodbye.
 */

type Fake = SocketLike & { sent: { type: string; [k: string]: unknown }[]; closed: { code?: number; reason?: string } | null };
function fakeSocket(): Fake {
  const s: Fake = {
    sent: [], closed: null,
    send(d, cb) { s.sent.push(JSON.parse(d)); cb?.(); },
    close(code, reason) { s.closed = { code, reason }; },
  };
  return s;
}

const CALL = 'CA1';

function deps(extra: Partial<AdapterDeps> = {}): AdapterDeps & { dir: string; lines: string[]; events: DashboardEvent[] } {
  const dir = mkdtempSync(join(tmpdir(), 'end-hold-'));
  const client = new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: 0.9, fallback: new HeuristicStubClient() });
  const bus = new DashboardBus();
  const events: DashboardEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const store: SessionStore = new SessionStore((callSid) => ({
    session: newSession(callSid, 0, VOICE_RELAY),
    opts: {
      client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18',
      trace: new TraceWriter(join(dir, `${callSid}.jsonl`)), now: () => 0, render: null,
      observe: makeObserver(bus, store, callSid),
    },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), () => 0),
  }), 60_000, () => 0);
  const lines: string[] = [];
  return { store, tokens: new CallTokens(60_000, () => 0), log: (l) => lines.push(l), dir, lines, events, bus, ...extra };
}

/** The `<Connect action>` callback side of the same call, sharing its store, tokens and bus. */
function actionDeps(d: ReturnType<typeof deps>): HttpDeps {
  const config = loadConfig({ PUBLIC_HOST: 'voice.example.com', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15555550123', AUDIO_DIR: d.dir, CHAT: 'off', TRACE_DIR: d.dir });
  return { config, store: d.store, tokens: d.tokens, hints: '', log: () => {}, bus: d.bus! };
}

const setupMsg = JSON.stringify({ type: 'setup', sessionId: 'VX1', callSid: CALL, from: '+15555550110', to: '+15555550111', customParameters: {} });
const prompt = (t: string) => JSON.stringify({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: true });
const info = (name: string, value: string) => JSON.stringify({ type: 'info', name, value });

const GOODBYE = 'Thanks for calling Example Parcels. Goodbye.';
const UP_TO_ANYTHING_ELSE = ['can you deliver tomorrow morning', 'five five five zero one two three four', 'april twelfth nineteen eighty five'];
const GOODBYE_MS = textEstimateMs(GOODBYE);

type LogLine = { dir: string; msg: Record<string, unknown> };
const frameLines = (dir: string): LogLine[] =>
  readFileSync(join(dir, `${CALL}.frames.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LogLine);
const endLogs = (dir: string) => frameLines(dir).filter((l) => l.dir === 'log' && 'endAfter' in l.msg).map((l) => l.msg);
const ends = (s: Fake) => s.sent.filter((m) => m.type === 'end');

interface Call {
  d: ReturnType<typeof deps>;
  sock: Fake;
  ctx: ReturnType<typeof newConnectionContext>;
  /** A message from the carrier, as it comes on the socket. */
  send: (raw: string) => Promise<void>;
}

/** A call on `provider` that has reached "anything else?", with the greeting's playback reported when `events`. */
async function atAnythingElse(provider: 'telnyx' | 'twilio', d: ReturnType<typeof deps>, events: boolean): Promise<Call> {
  const sock = fakeSocket();
  const ctx = newConnectionContext(d.tokens.mint(CALL, provider), sock, provider);
  const send = (raw: string) => handleSocketMessage(d, sock, ctx, raw);
  await send(setupMsg);
  if (events) {
    await send(info('agentSpeaking', 'on'));
    await send(info('agentSpeaking', 'off'));
  }
  for (const t of UP_TO_ANYTHING_ELSE) await send(prompt(t));
  return { d, sock, ctx, send };
}

/** The caller says that's all: the goodbye goes out, and the `end` is held (or not). */
async function sayThatsAll(call: Call): Promise<void> {
  await call.send(prompt("no, that's all"));
  expect(call.sock.sent.filter((m) => m.type === 'text').at(-1)?.token).toBe(GOODBYE);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  forgetNoInput(CALL);
  vi.useRealTimers();
});

describe('which carriers drop speech at end', () => {
  it('Telnyx does, Twilio does not (it plays what is queued while the socket stays open)', () => {
    expect(endDropsSpeechOf('telnyx')).toBe(true);
    expect(endDropsSpeechOf('twilio')).toBe(false);
    expect(endDropsSpeechOf(undefined)).toBe(false);
  });
});

describe('the end held until the lines play (END_AFTER_PLAYBACK)', () => {
  it('on Telnyx, holds the end until the carrier says it played the goodbye, and the call is ended meanwhile', async () => {
    const call = await atAnythingElse('telnyx', deps(), true);
    await sayThatsAll(call);
    // The goodbye is out; the end is not, and the call is already over as the store and the callback see it.
    expect(ends(call.sock)).toEqual([]);
    expect(call.d.store.get(CALL)?.ended).toBe(true);
    await call.send(info('agentSpeaking', 'on'));
    await vi.advanceTimersByTimeAsync(GOODBYE_MS);
    expect(ends(call.sock)).toEqual([]);
    await call.send(info('tokensPlayed', GOODBYE));
    await vi.advanceTimersByTimeAsync(0);
    expect(ends(call.sock)).toEqual([{ type: 'end', handoffData: '{"reasonCode":"completed","completed":["delivery_window"]}' }]);
    expect(endLogs(call.d.dir)).toEqual([{ endAfter: 'played', endHeldMs: GOODBYE_MS, expectedMs: GOODBYE_MS }]);
    // The end follows the goodbye in the frame log, with the hold between.
    const out = frameLines(call.d.dir).filter((l) => l.dir === 'out' || (l.dir === 'log' && 'endAfter' in l.msg)).slice(-3);
    expect(out.map((l) => (l.dir === 'out' ? l.msg.type : 'hold'))).toEqual(['text', 'hold', 'end']);
  });

  it('takes the carrier stopping as the end of the lines, once it has stayed stopped for the settle', async () => {
    const call = await atAnythingElse('telnyx', deps(), true);
    await sayThatsAll(call);
    await call.send(info('agentSpeaking', 'on'));
    await vi.advanceTimersByTimeAsync(1000);
    await call.send(info('agentSpeaking', 'off'));
    expect(ends(call.sock)).toEqual([]);
    await vi.advanceTimersByTimeAsync(RESAY_SETTLE_MS);
    expect(ends(call.sock)).toHaveLength(1);
    expect(endLogs(call.d.dir)[0]).toMatchObject({ endAfter: 'played', endHeldMs: 1000 + RESAY_SETTLE_MS });
  });

  it('does not take a stop from before the goodbye began playing as its end', async () => {
    const call = await atAnythingElse('telnyx', deps(), true);
    await sayThatsAll(call);
    // The last line before the goodbye stopping late: nothing has started since the goodbye went out.
    await call.send(info('agentSpeaking', 'off'));
    await vi.advanceTimersByTimeAsync(RESAY_SETTLE_MS + 10);
    expect(ends(call.sock)).toEqual([]);
  });

  it('sends the end at the ceiling, the estimate and a margin, when the carrier reports playback but not this one', async () => {
    const call = await atAnythingElse('telnyx', deps(), true);
    await sayThatsAll(call);
    await vi.advanceTimersByTimeAsync(GOODBYE_MS + END_PLAYBACK_MARGIN_MS - 1);
    expect(ends(call.sock)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ends(call.sock)).toHaveLength(1);
    expect(endLogs(call.d.dir)).toEqual([{ endAfter: 'timeout', endHeldMs: GOODBYE_MS + END_PLAYBACK_MARGIN_MS, expectedMs: GOODBYE_MS }]);
    expect(call.d.lines.some((l) => l.includes('end sent after') && l.includes('no report the lines finished'))).toBe(true);
  });

  it('never holds longer than END_PLAYBACK_MAX_MS', async () => {
    const call = await atAnythingElse('telnyx', deps({ endPlaybackMaxMs: 800 }), true);
    await sayThatsAll(call);
    await vi.advanceTimersByTimeAsync(799);
    expect(ends(call.sock)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ends(call.sock)).toHaveLength(1);
    expect(endLogs(call.d.dir)[0]).toMatchObject({ endAfter: 'timeout', endHeldMs: 800 });
  });

  it('waits the estimate, with the lead for the carrier to begin, on a call whose carrier reports no playback', async () => {
    // Telnyx without TELNYX_EVENTS: no event has come on this call.
    const call = await atAnythingElse('telnyx', deps(), false);
    await sayThatsAll(call);
    await vi.advanceTimersByTimeAsync(GOODBYE_MS + END_PLAYBACK_LEAD_MS - 1);
    expect(ends(call.sock)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ends(call.sock)).toHaveLength(1);
    expect(endLogs(call.d.dir)).toEqual([{ endAfter: 'estimate', endHeldMs: GOODBYE_MS + END_PLAYBACK_LEAD_MS, expectedMs: GOODBYE_MS }]);
  });

  it('on Twilio, sends the end with the goodbye, as before: it plays what is queued after end', async () => {
    const call = await atAnythingElse('twilio', deps(), false);
    await sayThatsAll(call);
    expect(call.sock.sent.at(-1)).toMatchObject({ type: 'end' });
    expect(endLogs(call.d.dir)).toEqual([]);
  });

  it('holds on any carrier with END_AFTER_PLAYBACK=on, by the estimate where the carrier reports nothing', async () => {
    const call = await atAnythingElse('twilio', deps({ endAfterPlayback: 'on' }), false);
    await sayThatsAll(call);
    expect(ends(call.sock)).toEqual([]);
    await vi.advanceTimersByTimeAsync(GOODBYE_MS + END_PLAYBACK_LEAD_MS);
    expect(ends(call.sock)).toHaveLength(1);
    expect(endLogs(call.d.dir)[0]).toMatchObject({ endAfter: 'estimate' });
  });

  it('sends the end with the goodbye on Telnyx too with END_AFTER_PLAYBACK=off, as before', async () => {
    const call = await atAnythingElse('telnyx', deps({ endAfterPlayback: 'off' }), true);
    await sayThatsAll(call);
    expect(call.sock.sent.at(-1)).toMatchObject({ type: 'end' });
    expect(endLogs(call.d.dir)).toEqual([]);
  });

  it('holds a transfer the same way: its line plays before the end that carries the handoff', async () => {
    const d = deps();
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint(CALL, 'telnyx'), sock, 'telnyx');
    await handleSocketMessage(d, sock, ctx, setupMsg);
    await handleSocketMessage(d, sock, ctx, info('agentSpeaking', 'on'));
    await handleSocketMessage(d, sock, ctx, info('agentSpeaking', 'off'));
    await handleSocketMessage(d, sock, ctx, prompt('i want to talk to a person'));
    const line = sock.sent.filter((m) => m.type === 'text').at(-1)!.token as string;
    expect(ends(sock)).toEqual([]);
    expect(d.store.get(CALL)?.ended).toBe(true);
    await handleSocketMessage(d, sock, ctx, info('agentSpeaking', 'on'));
    await handleSocketMessage(d, sock, ctx, info('tokensPlayed', line));
    expect(ends(sock)).toEqual([{ type: 'end', handoffData: '{"reasonCode":"live-agent"}' }]);
    expect(endLogs(d.dir)[0]).toMatchObject({ endAfter: 'played' });
  });

  it('takes a report of the lines run together, ending with the last, as the end of them', async () => {
    const call = await atAnythingElse('telnyx', deps(), true);
    await sayThatsAll(call);
    await call.send(info('agentSpeaking', 'on'));
    // A report that names an earlier line, or the last one with more after it, is not the end of the lines.
    await call.send(info('tokensPlayed', 'Is there anything else I can help with?'));
    await call.send(info('tokensPlayed', `${GOODBYE} Is there anything else I can help with?`));
    expect(ends(call.sock)).toEqual([]);
    // Telnyx may report a turn's lines as one, with no space between them (seen on a live call).
    await call.send(info('tokensPlayed', `Is there anything else I can help with?${GOODBYE}`));
    expect(ends(call.sock)).toHaveLength(1);
    expect(endLogs(call.d.dir)[0]).toMatchObject({ endAfter: 'played', endHeldMs: 0 });
  });

  it('a caller who hangs up during the hold: nothing more is sent, no error, and the call reads as ended, not dropped', async () => {
    const call = await atAnythingElse('telnyx', deps({ endCloseGraceMs: 1000 }), true);
    await sayThatsAll(call);
    const endedEvents = () => call.d.events.filter((e) => e.type === 'ended');
    expect(endedEvents()).toEqual([expect.objectContaining({ reason: 'completed' })]);
    await handleSocketClose(call.d, call.ctx);
    expect(frameLines(call.d.dir).find((l) => l.dir === 'log' && l.msg.socketClosed === true)?.msg).toEqual({ socketClosed: true, ended: true });
    expect(endLogs(call.d.dir)).toEqual([{ endAfter: 'closed', endHeldMs: 0, expectedMs: GOODBYE_MS }]);
    // The carrier's callback, even one that says the relay session failed, hangs up: no reconnect, no second ended.
    const action = decideActionTwiml(actionDeps(call.d), { CallSid: CALL, CallStatus: 'in-progress', SessionStatus: 'failed' });
    expect(action.twiml).toContain('<Hangup/>');
    expect(action.note).toBe('hangup');
    expect(endedEvents()).toHaveLength(1);
    // The hold's own timers are gone: nothing is sent, closed or logged later.
    await vi.advanceTimersByTimeAsync(DEFAULT_END_PLAYBACK_MAX_MS + 60_000);
    expect(ends(call.sock)).toEqual([]);
    expect(call.sock.closed).toBeNull();
    expect(call.d.lines.filter((l) => /fail|error/i.test(l))).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the socket open for the end-close grace after a held end, and closes it only if the carrier never does', async () => {
    const call = await atAnythingElse('telnyx', deps({ endCloseGraceMs: 1000 }), true);
    await sayThatsAll(call);
    await call.send(info('tokensPlayed', GOODBYE));
    expect(ends(call.sock)).toHaveLength(1);
    expect(call.sock.closed).toBeNull();
    await vi.advanceTimersByTimeAsync(999);
    expect(call.sock.closed).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(call.sock.closed).toEqual({ code: 1000, reason: 'end grace elapsed' });
  });

  it('a turn queued behind the goodbye says nothing, and the end still goes when the lines finish', async () => {
    const call = await atAnythingElse('telnyx', deps(), true);
    await sayThatsAll(call);
    const sentBefore = call.sock.sent.length;
    await call.send(prompt('wait, one more thing'));
    expect(call.sock.sent).toHaveLength(sentBefore);
    await call.send(info('tokensPlayed', GOODBYE));
    expect(call.sock.sent.slice(sentBefore).map((m) => m.type)).toEqual(['end']);
  });
});

describe('END_AFTER_PLAYBACK and END_PLAYBACK_MAX_MS', () => {
  const base = { PUBLIC_HOST: 'voice.example.com', HANDOFF_NUMBER: '+15555550100', VOICE_PROVIDERS: 'telnyx,twilio', TELNYX_PUBLIC_KEY: 'MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=', TWILIO_AUTH_TOKEN: 'x'.repeat(32) };
  it('reads auto and the default cap unless set, on and off, and refuses anything else', () => {
    expect(loadConfig(base)).toMatchObject({ endAfterPlayback: 'auto', endPlaybackMaxMs: DEFAULT_END_PLAYBACK_MAX_MS });
    expect(loadConfig({ ...base, END_AFTER_PLAYBACK: ' ON ', END_PLAYBACK_MAX_MS: '8000' })).toMatchObject({ endAfterPlayback: 'on', endPlaybackMaxMs: 8000 });
    expect(loadConfig({ ...base, END_AFTER_PLAYBACK: 'off' }).endAfterPlayback).toBe('off');
    expect(() => loadConfig({ ...base, END_AFTER_PLAYBACK: 'yes' })).toThrow('END_AFTER_PLAYBACK must be auto, on or off, got "yes"');
    expect(() => loadConfig({ ...base, END_PLAYBACK_MAX_MS: '0' })).toThrow('END_PLAYBACK_MAX_MS');
  });
  it('says at startup which carriers have their end held', () => {
    expect(describeConfig(loadConfig(base))).toContain(`end after playback auto (telnyx), up to ${DEFAULT_END_PLAYBACK_MAX_MS} ms`);
    expect(describeConfig(loadConfig({ ...base, END_AFTER_PLAYBACK: 'on' }))).toContain(`end after playback on (every carrier), up to ${DEFAULT_END_PLAYBACK_MAX_MS} ms`);
    expect(describeConfig(loadConfig({ ...base, END_AFTER_PLAYBACK: 'off' }))).toContain('end after playback off');
    const twilio = { PUBLIC_HOST: 'voice.example.com', HANDOFF_NUMBER: '+15555550100', TWILIO_AUTH_TOKEN: 'x'.repeat(32) };
    expect(describeConfig(loadConfig(twilio))).toContain('end after playback auto (no carrier listed needs it)');
  });
});
