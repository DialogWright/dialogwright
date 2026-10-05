import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeFileStem, startServer, type RunningServer } from '../index';
import { loadConfig } from '../config';
import { readFrameLog } from '../frameLog';
import { FakeRelay } from '../../testing/fakeRelay';
import type { JevClient } from '../../jev/types';
import type { TraceRecord } from '../../trace/types';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { replayFrameLog } from '../../harness-text/replay';
import { useTestkit } from '../../testing/apps';
import { defaultCorpusFile } from '../../run/fixtures';
import { RESAY_SETTLE_MS, SPURIOUS_INTERRUPT_SETTLE_MS } from '../adapter';

useTestkit();

/**
 * A line the carrier cut short is said again (RESAY_CUT_LINES), over a real socket. What a live Telnyx
 * call showed (2026-10-05, with TELNYX_EVENTS=speaker-events tokens-played): right after the caller
 * spoke, the reply (one 24-word line) went out; Telnyx reported agentSpeaking on, then tokensPlayed with
 * the whole line 0.67 s later, then agentSpeaking off, with no interrupt and no clientSpeaking between.
 * The caller heard nothing, and sat in silence until the no-input wait asked again.
 */

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const TELNYX_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const CALL_ID = 'v3:ResayExampleCallIdForTheTestsOnly0123456789abcdefXY';
const GOODBYE = 'Thanks for calling Example Parcels. Goodbye.';

let running: RunningServer | null = null;
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let client: JevClient | null = null;
beforeAll(async () => {
  const { FixtureStubClient } = await import('../../jev/fixtureStub');
  const { HeuristicStubClient } = await import('../../jev/heuristicStub');
  const { loadCorpus } = await import('../../jev/corpus');
  client = new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: 0.9, fallback: new HeuristicStubClient() });
}, 60_000);

interface Call {
  relay: FakeRelay;
  traceDir: string;
  logs: string[];
  /** Everything the store's queue holds for the call has run. */
  settled: () => Promise<void>;
}

/** A call on a server answering `provider`, with `env` on top, up to its greeting. */
async function startCall(provider: 'telnyx' | 'twilio', env: Record<string, string> = {}): Promise<Call> {
  const traceDir = mkdtempSync(join(tmpdir(), 'resay-'));
  const audioDir = mkdtempSync(join(tmpdir(), 'audio-'));
  dirs.push(traceDir, audioDir);
  const config = loadConfig({
    PUBLIC_HOST: 'localhost',
    VOICE_PROVIDERS: provider,
    ...(provider === 'telnyx' ? { TELNYX_PUBLIC_KEY } : { TWILIO_AUTH_TOKEN: 'x'.repeat(32) }),
    HANDOFF_NUMBER: '+15551234567',
    PORT: '0',
    TODAY_OVERRIDE: '2026-09-18',
    TRACE_DIR: traceDir,
    AUDIT_DIR: join(traceDir, 'audit'),
    AUDIO_DIR: audioDir,
    ...env,
  });
  const logs: string[] = [];
  running = await startServer(config, { host: '127.0.0.1', client: client!, log: (l) => logs.push(l) });
  const base = `http://127.0.0.1:${running.port}`;
  const ws = `ws://127.0.0.1:${running.port}`;
  let relay: FakeRelay;
  if (provider === 'telnyx') {
    const body = new URLSearchParams({ CallSid: CALL_ID, From: '+15555550110', To: '+15555550111' }).toString();
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await fetch(`${base}/voice/telnyx`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'telnyx-timestamp': ts,
        'telnyx-signature-ed25519': sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString('base64'),
      },
      body,
    });
    const token = /token=([0-9a-f]{32})/.exec(await res.text())![1]!;
    relay = await FakeRelay.connect(`${ws}/conversation/telnyx?token=${token}`);
    relay.send({
      type: 'setup', from: null, to: null, direction: null, callControlId: CALL_ID, callSid: '5e9fcc12-0000-4000-8000-000000000000',
      callStatus: 'active', customParameters: { telnyx_call_from: '+15555550110' }, sessionId: '05ff737c-0000-4000-8000-000000000000',
    });
  } else {
    relay = await FakeRelay.connect(`${ws}/conversation/twilio?token=${running.tokens.mint(CALL_ID)}`);
    relay.setup(CALL_ID);
  }
  await relay.waitForTexts(1);
  const settled = async (): Promise<void> => {
    await running!.store.get(CALL_ID)?.tail;
  };
  await settled();
  return { relay, traceDir, logs, settled };
}

/** Telnyx's event message, as a live call sends it. */
const info = (name: string, value: string) => ({ type: 'info', name, value });

/** Let `ms` pass on the server's clock, without waiting for it. */
function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

/** Long enough for a re-send to have gone out, had there been one. */
const quiet = () => new Promise((r) => setTimeout(r, RESAY_SETTLE_MS + 400));

/** The caller asks something; resolves with the turn's lines as they arrived. */
async function ask(call: Call, words: string): Promise<{ lines: string[]; last: (boolean | undefined)[] }> {
  const before = call.relay.texts().length;
  call.relay.prompt(words, true, 'en');
  await call.relay.waitForTexts(before + 1);
  await call.settled();
  const texts = call.relay.received.filter((m) => m.type === 'text').slice(before);
  return { lines: texts.map((m) => m.token as string), last: texts.map((m) => m.last as boolean | undefined) };
}

/** The carrier's events the server has taken in so far (each is written to the frame log as it is read). */
function eventsLogged(call: Call): number {
  return frameLines(call).filter((l) => l.dir === 'in' && typeof l.msg === 'object' && l.msg !== null && 'carrierEvent' in l.msg).length;
}

/** Send a carrier event and wait until the server has read it, so the clock moves only between events. */
async function event(call: Call, msg: { type: string } & Record<string, unknown>): Promise<void> {
  const n = eventsLogged(call);
  call.relay.send(msg);
  for (let i = 0; i < 400 && eventsLogged(call) === n; i += 1) await new Promise((r) => setTimeout(r, 5));
}

/** The carrier plays the turn's lines for `heardMs`, says it played them all, and stops: no caller in between, unless `between`. */
async function playedFor(call: Call, heardMs: number, lastLine: string, between?: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  await event(call, info('agentSpeaking', 'on'));
  await between?.();
  advance(heardMs);
  await event(call, info('tokensPlayed', lastLine));
  advance(29);
  await event(call, info('agentSpeaking', 'off'));
}

function frameLines(call: Call) {
  return readFrameLog(join(call.traceDir, `${safeFileStem(CALL_ID)}.frames.jsonl`));
}

function resaidLines(call: Call): unknown[] {
  return frameLines(call).filter((l) => l.dir === 'log' && typeof l.msg === 'object' && l.msg !== null && 'resaid' in l.msg).map((l) => (l.msg as { resaid: unknown }).resaid);
}

const TELNYX_EVENTS = { TELNYX_EVENTS: 'speaker-events tokens-played' };

describe('a line the carrier cut short', () => {
  it('is said again once, as it was sent, when the carrier reports it played in a fraction of its length', async () => {
    const call = await startCall('telnyx', TELNYX_EVENTS);
    const reply = await ask(call, 'can you deliver tomorrow morning');
    expect(reply.lines.length).toBeGreaterThan(1);
    expect(reply.last.at(-1)).toBe(true);
    const sentBefore = call.relay.texts().length;

    await playedFor(call, 670, reply.lines.at(-1)!);
    await call.relay.waitForTexts(sentBefore + reply.lines.length);
    await quiet();
    await call.settled();

    // The turn's lines again, in order, with last: true on the final one only (Telnyx's textLast), once.
    const again = call.relay.received.filter((m) => m.type === 'text').slice(sentBefore);
    expect(again.map((m) => m.token)).toEqual(reply.lines);
    expect(again.map((m) => m.last)).toEqual(reply.last);
    // The frame log records the re-send, with what was heard and what was expected, and the wait re-armed after it.
    const resaid = resaidLines(call);
    expect(resaid).toHaveLength(1);
    const { heardMs, expectedMs } = resaid[0] as { heardMs: number; expectedMs: number };
    expect(heardMs).toBe(670);
    expect(expectedMs).toBeGreaterThan(4000);
    const lines = frameLines(call);
    const at = lines.findIndex((l) => l.dir === 'log' && typeof l.msg === 'object' && l.msg !== null && 'resaid' in l.msg);
    expect(lines.slice(at).filter((l) => l.dir === 'out').map((l) => (l.msg as { token?: string }).token)).toEqual(reply.lines);
    expect(lines.slice(at).some((l) => l.dir === 'log' && typeof l.msg === 'object' && l.msg !== null && 'noInputArmedMs' in l.msg)).toBe(true);
    // Every event the carrier sent is still in the frame log as it came.
    expect(lines.filter((l) => l.dir === 'in' && typeof l.msg === 'object' && l.msg !== null && 'carrierEvent' in l.msg)).toHaveLength(3);
    // And the server says so.
    expect(call.logs).toContain(`${CALL_ID}: playback cut short (0.67 s of ~${(expectedMs / 1000).toFixed(1)} s), lines said again`);
    call.relay.assertKnownTypes();
  });

  it('replays to the same outcome: a re-send is not a turn', async () => {
    const call = await startCall('telnyx', TELNYX_EVENTS);
    const reply = await ask(call, 'can you deliver tomorrow morning');
    const sentBefore = call.relay.texts().length;
    await playedFor(call, 670, reply.lines.at(-1)!);
    await call.relay.waitForTexts(sentBefore + reply.lines.length);
    // The clock was moved on 0.7 s; real time passes that before it is the clock again, so the log stays in order.
    await quiet();
    await new Promise((r) => setTimeout(r, 100));
    vi.useRealTimers();
    await ask(call, 'five five five zero one two three four');
    await call.settled();
    expect(resaidLines(call)).toHaveLength(1);

    const live = readFileSync(join(call.traceDir, `${safeFileStem(CALL_ID)}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TraceRecord);
    const replay = await replayFrameLog(
      join(call.traceDir, `${safeFileStem(CALL_ID)}.frames.jsonl`),
      { client: client!, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', trace: null },
      undefined,
      { todayIsoOverride: '2026-09-18' },
    );
    const shape = (r: TraceRecord) => [r.event.type, (r.event as { text?: string }).text ?? null, r.decision.kind, (r.decision as { promptId?: string }).promptId ?? null];
    expect(replay.records.map(shape)).toEqual(live.map(shape));
    // The carrier's events are its reports, not the caller's: replay passes over them, as the adapter does.
    expect(replay.skipped).toEqual([]);
  });

  it('is not said again when the playback took about as long as the line', async () => {
    const call = await startCall('telnyx', TELNYX_EVENTS);
    const reply = await ask(call, 'can you deliver tomorrow morning');
    const sentBefore = call.relay.texts().length;
    await playedFor(call, 9000, reply.lines.at(-1)!);
    await quiet();
    expect(call.relay.texts()).toHaveLength(sentBefore);
    expect(resaidLines(call)).toEqual([]);
  });

  it('is not said again when the caller interrupted it, or was heard speaking, before it finished', async () => {
    const interrupted = await startCall('telnyx', TELNYX_EVENTS);
    const reply = await ask(interrupted, 'can you deliver tomorrow morning');
    const sentBefore = interrupted.relay.texts().length;
    await playedFor(interrupted, 670, reply.lines.at(-1)!, async () => {
      // Heard speaking as they cut in, as Telnyx reports a caller's barge-in: an interrupt with no caller
      // heard around it is not theirs (RESAY_SPURIOUS_INTERRUPTS, below).
      await event(interrupted, info('clientSpeaking', 'on'));
      interrupted.relay.interrupt(reply.lines[0]!.slice(0, 12), 600);
      await interrupted.settled();
    });
    await quiet();
    await interrupted.settled();
    expect(interrupted.relay.texts()).toHaveLength(sentBefore);
    expect(resaidLines(interrupted)).toEqual([]);
    vi.useRealTimers();
    await running!.close();
    running = null;

    const spoke = await startCall('telnyx', TELNYX_EVENTS);
    const reply2 = await ask(spoke, 'can you deliver tomorrow morning');
    const sentBefore2 = spoke.relay.texts().length;
    await playedFor(spoke, 670, reply2.lines.at(-1)!, async () => {
      await event(spoke, info('clientSpeaking', 'on'));
      await event(spoke, info('clientSpeaking', 'off'));
    });
    await quiet();
    expect(spoke.relay.texts()).toHaveLength(sentBefore2);
    expect(resaidLines(spoke)).toEqual([]);
  });

  it('is said again only once: a re-send cut short as well is left alone', async () => {
    const call = await startCall('telnyx', TELNYX_EVENTS);
    const reply = await ask(call, 'can you deliver tomorrow morning');
    const sentBefore = call.relay.texts().length;
    await playedFor(call, 670, reply.lines.at(-1)!);
    await call.relay.waitForTexts(sentBefore + reply.lines.length);
    await call.settled();
    await playedFor(call, 500, reply.lines.at(-1)!);
    await quiet();
    expect(call.relay.texts()).toHaveLength(sentBefore + reply.lines.length);
    expect(resaidLines(call)).toHaveLength(1);
  });

  it('is never said again for the turn that ends the call', async () => {
    const call = await startCall('telnyx', TELNYX_EVENTS);
    await ask(call, 'can you deliver tomorrow morning');
    await ask(call, 'five five five zero one two three four');
    await ask(call, 'april twelfth nineteen eighty five');
    const bye = await ask(call, "no, that's all");
    expect(bye.lines.at(-1)).toBe(GOODBYE);
    // Telnyx drops what it has not said at `end`, so the end waits for the goodbye to play (END_AFTER_PLAYBACK).
    expect(call.relay.received.some((m) => m.type === 'end')).toBe(false);
    const sentBefore = call.relay.texts().length;
    await playedFor(call, 300, GOODBYE);
    await call.relay.waitFor((m) => m.type === 'end');
    await quiet();
    expect(call.relay.texts()).toHaveLength(sentBefore);
    expect(resaidLines(call)).toEqual([]);
  });

  it('is not said again with RESAY_CUT_LINES=off', async () => {
    const call = await startCall('telnyx', { ...TELNYX_EVENTS, RESAY_CUT_LINES: 'off' });
    const reply = await ask(call, 'can you deliver tomorrow morning');
    const sentBefore = call.relay.texts().length;
    await playedFor(call, 670, reply.lines.at(-1)!);
    await quiet();
    expect(call.relay.texts()).toHaveLength(sentBefore);
    expect(resaidLines(call)).toEqual([]);
  });

  it('changes nothing on a Twilio call, whose carrier reads no playback events', async () => {
    const call = await startCall('twilio');
    const reply = await ask(call, 'can you deliver tomorrow morning');
    const sentBefore = call.relay.texts().length;
    await playedFor(call, 670, reply.lines.at(-1)!);
    await quiet();
    expect(call.relay.texts()).toHaveLength(sentBefore);
    expect(resaidLines(call)).toEqual([]);
    // Still written to the frame log as they came, as before.
    expect(frameLines(call).filter((l) => l.dir === 'in' && typeof l.msg === 'object' && l.msg !== null && 'carrierEvent' in l.msg)).toHaveLength(3);
  });
});

/**
 * An interrupt the caller did not make (RESAY_SPURIOUS_INTERRUPTS), over a real socket: on a live Telnyx call
 * (2026-10-05, BARGE_IN=speech, TELNYX_EVENTS=speaker-events tokens-played) an `interrupt` came 1704 ms into
 * the greeting with no clientSpeaking at all, and the caller, hearing nothing, said nothing for 11 s.
 */
describe('an interrupt with no caller heard', () => {
  /** Long enough for the settle and a re-send. */
  const settle = () => new Promise((r) => setTimeout(r, SPURIOUS_INTERRUPT_SETTLE_MS + 300));

  it('is not a barge-in, and the greeting is said again from the start, once', async () => {
    const call = await startCall('telnyx', { ...TELNYX_EVENTS, BARGE_IN: 'speech' });
    const greeting = call.relay.texts()[0]!;
    call.relay.interrupt(greeting, 1704);
    await call.relay.waitForTexts(2);
    await settle();
    await call.settled();
    expect(call.relay.texts()).toEqual([greeting, greeting]);
    const spurious = frameLines(call).filter((l) => l.dir === 'log' && typeof l.msg === 'object' && l.msg !== null && 'spuriousInterrupt' in l.msg);
    expect(spurious.map((l) => l.msg)).toEqual([{ spuriousInterrupt: { afterMs: 1704, quietMs: null } }]);
    expect(resaidLines(call)).toEqual([{ reason: 'spurious-interrupt', afterMs: 1704, expectedMs: expect.any(Number) }]);
    expect(call.logs).toContain(`${CALL_ID}: interrupted 1.70 s into the lines with no caller heard, lines said again`);
    expect(running!.store.get(CALL_ID)!.session.lastInterrupt).toBeNull();
  });

  it('is a barge-in, as before, where Telnyx is not asked for speaker-events, or with RESAY_SPURIOUS_INTERRUPTS=off', async () => {
    for (const env of [{ TELNYX_EVENTS: 'tokens-played' }, { ...TELNYX_EVENTS, RESAY_SPURIOUS_INTERRUPTS: 'off' }]) {
      const call = await startCall('telnyx', { ...env, BARGE_IN: 'speech' });
      const greeting = call.relay.texts()[0]!;
      call.relay.interrupt(greeting, 1704);
      await settle();
      await call.settled();
      expect(call.relay.texts(), JSON.stringify(env)).toEqual([greeting]);
      expect(running!.store.get(CALL_ID)!.session.lastInterrupt).toEqual({ heard: greeting, afterMs: 1704 });
      await running!.close();
      running = null;
    }
  });
});

/**
 * A reply held for a caller not finished (INCOMPLETE_WAIT_MS), over a real socket, where Telnyx is asked to
 * report the caller's voice: words the model reads as unfinished get no reply while the caller goes on.
 */
describe('a reply held for a caller not finished', () => {
  it('is never said when the caller goes on, and the next prompt continues theirs', async () => {
    const call = await startCall('telnyx', { ...TELNYX_EVENTS, BARGE_IN: 'speech' });
    const before = call.relay.texts().length;
    // The heuristic model reads words that end in "and" as unfinished.
    call.relay.prompt('i want to and', true, 'en');
    await new Promise((r) => setTimeout(r, 300));
    await event(call, info('clientSpeaking', 'on'));
    await event(call, info('clientSpeaking', 'off'));
    await call.settled();
    expect(call.relay.texts()).toHaveLength(before);
    const held = frameLines(call).filter((l) => l.dir === 'log' && typeof l.msg === 'object' && l.msg !== null && 'replyHeld' in l.msg);
    expect(held.map((l) => (l.msg as { replyHeld: { outcome: string } }).replyHeld.outcome)).toEqual(['joined']);
    const reply = await ask(call, 'track a parcel');
    expect(reply.lines.length).toBeGreaterThan(0);
    const last = readFileSync(join(call.traceDir, `${safeFileStem(CALL_ID)}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TraceRecord).at(-1)!;
    expect(last.joined).toEqual({ fragments: ['i want to and', 'track a parcel'] });
  });

  it('is not held for a turn that went through the gate, however unfinished the words', async () => {
    const call = await startCall('telnyx', { ...TELNYX_EVENTS, BARGE_IN: 'speech' });
    // The testkit asks who is calling before a delivery: an identity step, through the gate.
    const reply = await ask(call, 'can you deliver tomorrow and');
    expect(reply.lines.length).toBeGreaterThan(0);
    expect(frameLines(call).some((l) => l.dir === 'log' && typeof l.msg === 'object' && l.msg !== null && 'replyHeld' in l.msg)).toBe(false);
  });

  it('is not held where Telnyx is not asked for speaker-events, or with INCOMPLETE_WAIT_MS=0', async () => {
    for (const env of [{ TELNYX_EVENTS: 'tokens-played' }, { ...TELNYX_EVENTS, INCOMPLETE_WAIT_MS: '0' }]) {
      const call = await startCall('telnyx', { ...env, BARGE_IN: 'speech' });
      const reply = await ask(call, 'i want to and');
      expect(reply.lines.length, JSON.stringify(env)).toBeGreaterThan(0);
      expect(frameLines(call).some((l) => l.dir === 'log' && typeof l.msg === 'object' && l.msg !== null && 'replyHeld' in l.msg)).toBe(false);
      await running!.close();
      running = null;
    }
  });
});
