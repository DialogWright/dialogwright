import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetNoInput, handleSocketMessage, newConnectionContext, RESAY_SETTLE_MS, type AdapterDeps } from './adapter';
import { SessionStore, type SocketLike } from './sessions';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { replayFrameLog } from '../harness-text/replay';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { TraceWriter } from '../trace/writer';
import type { TraceRecord } from '../trace/types';
import { VOICE_RELAY } from '../channel/caps';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { registerTestkit, testkitApp } from '../testing/testkit';
import { ANONYMOUS } from '../gate/principal';
import { PLACE_APP_ID, placeApp, placeClient } from '../testing/placeApp';
import type { BargeIn, SpeechOverLine } from '../channel/voiceProviders';
import type { JevClient } from '../jev/types';

/**
 * Speech over a line the caller could not interrupt (SPEECH_OVER_LINE, server/adapter.ts). The timeline is
 * a live Telnyx call's (2026-11-05, BARGE_IN=none, a speakerphone in a noisy room): the greeting sent, the
 * carrier reporting the caller speaking 67 ms later, and 1.9 s in a final prompt of words said to someone
 * else. The words, the greeting and the app are the test app's (the words invented); the greeting is
 * estimated at 11.6 s.
 */

const CALL = 'CA9';
/** The test app's greeting: 29 words, 11.6 s by the estimate (2.5 words a second). */
const GREETING_MS = 11_600;
const NO_INPUT_MS = 7_000;
const ASIDE = 'can you pass me the blue folder';
const NOMATCH = testkitApp.prompts.manifest.nomatch_open!.text;
/** The no-match line: 21 words, 8.4 s. */
const NOMATCH_MS = 8_400;
const KEYPAD = testkitApp.prompts.manifest.nomatch_dtmf_menu!.text;
const NO_INPUT = testkitApp.prompts.manifest.no_input!.text;
const GREETING = testkitApp.prompts.manifest.greeting!.text;
const ASK_PLACE = 'Where is the problem?';
const REASK = 'Sorry, where is the problem?';

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

function liveCall(provider: string, bargeIn: BargeIn, more: Partial<AdapterDeps> = {}, client: () => JevClient = () => placeClient()) {
  const dir = mkdtempSync(join(tmpdir(), 'speech-over-line-'));
  const opts = { client: client(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-11-05', now: () => 0 };
  const store = new SessionStore((callSid) => ({
    session: newSession(callSid, 0, VOICE_RELAY, ANONYMOUS, PLACE_APP_ID),
    opts: { ...opts, trace: new TraceWriter(join(dir, `${callSid}.jsonl`)) },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`)),
  }), 60_000, () => 0);
  const tokens = new CallTokens(60_000, () => 0);
  const log: string[] = [];
  const deps: AdapterDeps = { store, tokens, log: (l) => log.push(l), bargeIn, noInputMs: NO_INPUT_MS, ...more };
  const sent: Record<string, unknown>[] = [];
  const socket = (): SocketLike => ({ send: (d, cb) => { sent.push(JSON.parse(d) as Record<string, unknown>); cb?.(); }, close: () => {} });
  const sock = socket();
  const ctx = newConnectionContext(tokens.mint(CALL, provider), sock, provider);
  const send = (m: object) => handleSocketMessage(deps, sock, ctx, JSON.stringify(m));
  const info = (name: string, value: string) => send({ type: 'info', name, value });
  const setup = { type: 'setup', sessionId: 'VX9', callSid: CALL, from: '+15555550100', to: '+15555550199', customParameters: {} };
  return {
    sent, store, log, send,
    caller: (on: boolean) => info('clientSpeaking', on ? 'on' : 'off'),
    agent: (on: boolean) => info('agentSpeaking', on ? 'on' : 'off'),
    played: (value: string) => info('tokensPlayed', value),
    start: () => send(setup),
    say: (t: string) => send({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: true }),
    partial: (t: string) => send({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: false }),
    key: (digit: string) => send({ type: 'dtmf', digit }),
    /** A reconnect: the carrier's new socket for the call, before the old one's close; its lines go to `sent` too. */
    reconnect: () => {
      const sock2 = socket();
      return handleSocketMessage(deps, sock2, newConnectionContext(tokens.mint(CALL, provider), sock2, provider), JSON.stringify({ ...setup, sessionId: 'VX10' }));
    },
    /** What went out as lines, in order. */
    lines: () => sent.filter((f) => f.type === 'text').map((f) => (f.token as string).trimEnd()),
    session: () => store.get(CALL)!.session,
    records: () => readFileSync(join(dir, `${CALL}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TraceRecord),
    logs: () => readFileSync(join(dir, `${CALL}.frames.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { dir: string; msg: Record<string, unknown> }),
    replay: () => replayFrameLog(join(dir, `${CALL}.frames.jsonl`), { ...opts, client: client(), trace: null }, undefined, { todayIsoOverride: opts.todayIso }),
  };
}
type Call = ReturnType<typeof liveCall>;

/** The frame log's note just before the last final prompt with these words, or undefined when there is none. */
function noteBefore(call: Call, words: string): Record<string, unknown> | undefined {
  const logs = call.logs();
  let at = -1;
  for (const [i, l] of logs.entries()) if (l.dir === 'in' && l.msg.type === 'prompt' && l.msg.voicePrompt === words && l.msg.last === true) at = i;
  expect(at).toBeGreaterThan(0);
  // The log lines written as the prompt came, just before its own (a caller back in is noted after it).
  for (let i = at - 1; i >= 0 && logs[i]!.dir === 'log'; i--) {
    if (logs[i]!.msg.speechOverLine !== undefined) return logs[i]!.msg.speechOverLine as Record<string, unknown>;
  }
  return undefined;
}

const notes = (call: Call) => call.logs().filter((l) => l.dir === 'log' && l.msg.speechOverLine !== undefined);

const shape = (r: TraceRecord) => [r.event.type, (r.event as { text?: string }).text ?? null, (r.event as { overLine?: true }).overLine ?? null, r.decision.kind, r.gates.find((g) => g.decided)?.gate ?? null, r.joined?.fragments ?? null];

/** Live, then replayed from the frame log: the same turns, set aside where the call set them aside. */
async function sameOnReplay(call: Call): Promise<void> {
  const live = call.records();
  vi.useRealTimers();
  const replayed = await call.replay();
  // A partial prompt (Twilio's) is in the log, and no turn of replay's.
  expect(replayed.skipped.filter((s) => !s.endsWith('non-final prompt'))).toEqual([]);
  expect(replayed.records.map(shape)).toEqual(live.map(shape));
}

/** The live call to its first prompt: the greeting, the caller heard 67 ms in, the words 1.9 s in. */
async function overTheGreeting(call: Call, words = ASIDE): Promise<void> {
  await call.start();
  expect(call.lines()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(67);
  await call.caller(true);
  await vi.advanceTimersByTimeAsync(1_533);
  await call.caller(false);
  await vi.advanceTimersByTimeAsync(300);
  await call.say(words);
}

/** Past the greeting, a request said after its end; the place question asked at once. */
async function toPlace(call: Call): Promise<void> {
  await call.start();
  await vi.advanceTimersByTimeAsync(GREETING_MS + 500);
  await call.say('i want to report a problem');
  expect(call.lines().at(-1)).toBe(ASK_PLACE);
}

/** The greeting, reported played 0.7 s in (Telnyx): cut short, and said again once the settle has passed. */
async function greetingCutAndSaidAgain(call: Call): Promise<void> {
  await call.start();
  await vi.advanceTimersByTimeAsync(50);
  await call.agent(true);
  await vi.advanceTimersByTimeAsync(650);
  await call.played(GREETING);
  await vi.advanceTimersByTimeAsync(RESAY_SETTLE_MS);
  expect(call.lines()).toEqual([GREETING, GREETING]);
}

describe('speech over a line, unless-miss (the default), on Telnyx with BARGE_IN=none', () => {
  it('the live call: words said to someone else over the greeting are set aside, the greeting plays on and the caller is asked after it', async () => {
    const call = liveCall('telnyx', 'none');
    await overTheGreeting(call);
    // Nothing said over the greeting, nothing counted, the question as it was.
    expect(call.lines()).toHaveLength(1);
    expect(call.session().intentAttempts).toBe(0);
    expect(call.session().lastPromptId).toBe('greeting');
    expect(call.session().promptedFor).toBe('intent');
    const last = call.records().at(-1)!;
    expect(last.decision.kind).toBe('ignore');
    expect(last.event).toMatchObject({ type: 'user.speech', text: ASIDE, overLine: true });
    expect(last.gates.filter((g) => g.decided)).toEqual([{ gate: 'speechOverLine', value: null, threshold: null, passed: false, outcome: 'set_aside', decided: true }]);
    // The speech's start is the carrier's report, 67 ms into the greeting.
    expect(noteBefore(call, ASIDE)).toEqual({ mode: 'unless-miss', afterMs: 67, expectedMs: GREETING_MS, start: 'speaking' });
    // The server log says what became of it once the turn has run, not before.
    expect(call.log.filter((l) => l.includes('speech'))).toEqual([`${CALL}: speech 0.07 s into lines it could not interrupt (~11.6 s)`, `${CALL}: speech over a line set aside as a miss`]);
    // The no-input wait asks again from the greeting's end, not from the words; the caller spoke, so the
    // question is said without "I didn't hear anything" (Session.spokeAt, the agent-mode design's call 48).
    await vi.advanceTimersByTimeAsync(GREETING_MS + NO_INPUT_MS - 1_900 - 1);
    expect(call.lines()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.lines()[1]).toBe(testkitApp.prompts.manifest.ask_intent!.text);
    expect(call.lines()).not.toContain(NO_INPUT);
    expect(call.records().at(-1)!.event.type).toBe('user.silence');
    await sameOnReplay(call);
  });

  it('a request said over the greeting is acted on, and the log says so', async () => {
    const call = liveCall('telnyx', 'none');
    await overTheGreeting(call, 'i want to report a problem');
    expect(call.session().form).toBe('report');
    expect(call.lines().at(-1)).toBe(ASK_PLACE);
    expect(call.records().at(-1)!.gates.some((g) => g.gate === 'speechOverLine')).toBe(false);
    // Noted all the same: the speech was over the greeting.
    expect(noteBefore(call, 'i want to report a problem')).toMatchObject({ mode: 'unless-miss', afterMs: 67 });
    expect(call.log.at(-1)).toBe(`${CALL}: speech over a line taken`);
    await sameOnReplay(call);
  });

  it('speech that starts after the greeting\'s estimated end is a miss, as before', async () => {
    const call = liveCall('telnyx', 'none');
    await call.start();
    await vi.advanceTimersByTimeAsync(GREETING_MS + 200);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(300);
    await call.say(ASIDE);
    expect(call.lines().at(-1)).toBe(NOMATCH);
    expect(call.session().intentAttempts).toBe(1);
    expect(noteBefore(call, ASIDE)).toBeUndefined();
    await sameOnReplay(call);
  });

  it('a report of the caller long before the prompt is not its speech: the prompt\'s arrival is its start', async () => {
    const call = liveCall('telnyx', 'none');
    await call.start();
    // A cough as the greeting starts, then nothing reported: the words come after the greeting's end.
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(300);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(GREETING_MS + 500);
    await call.say(ASIDE);
    expect(call.lines().at(-1)).toBe(NOMATCH);
    expect(noteBefore(call, ASIDE)).toBeUndefined();
  });

  it('two real misses, then a third over the keypad line: set aside, and no one is put through', async () => {
    const call = liveCall('telnyx', 'none');
    await call.start();
    await vi.advanceTimersByTimeAsync(GREETING_MS + 500);
    await call.say(ASIDE);
    expect(call.lines().at(-1)).toBe(NOMATCH);
    await vi.advanceTimersByTimeAsync(NOMATCH_MS + 600);
    await call.say('no the other one');
    expect(call.lines().at(-1)).toBe(KEYPAD);
    expect(call.session().intentAttempts).toBe(2);
    // Heard 0.2 s into the keypad line.
    await vi.advanceTimersByTimeAsync(200);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(400);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(300);
    await call.say('right over there');
    expect(call.lines().at(-1)).toBe(KEYPAD);
    expect(call.session().intentAttempts).toBe(2);
    expect(call.session().ended).toBe(false);
    expect(call.sent.some((f) => f.type === 'end')).toBe(false);
    expect(call.records().at(-1)!.decision.kind).toBe('ignore');
    // A key at the keypad line is never affected.
    await call.key('1');
    expect(call.session().form).toBe('report');
    await sameOnReplay(call);
  });

  it('a fragment set aside over the question is not the caller\'s: the rest said after it is heard alone, never joined', async () => {
    const call = liveCall('telnyx', 'none');
    await toPlace(call);
    // "Sure, I can help you report a problem. Where is the problem?": 12 words, 4.8 s.
    await vi.advanceTimersByTimeAsync(1_000);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(400);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(500);
    await call.say('at');
    expect(call.lines().at(-1)).toBe(ASK_PLACE);
    expect(call.records().at(-1)!.decision.kind).toBe('ignore');
    // Back in 0.6 s after they stopped, with the rest: heard on its own.
    await vi.advanceTimersByTimeAsync(100);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(900);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(300);
    await call.say('22 Alder Street.');
    expect(call.session().slots.place?.value).toBe('22 Alder Street.');
    expect(call.records().at(-1)!.joined).toBeUndefined();
    await sameOnReplay(call);
  });

  it('a partial prompt is never looked at: only a final one is a turn', async () => {
    const call = liveCall('telnyx', 'none');
    await call.start();
    await vi.advanceTimersByTimeAsync(500);
    await call.partial('i would');
    expect(notes(call)).toHaveLength(0);
  });

  it('a reconnect mid-line: the question said again is the line, from its own send', async () => {
    const call = liveCall('telnyx', 'none');
    await call.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await call.reconnect();
    expect(call.lines()).toEqual([GREETING, GREETING]);
    await vi.advanceTimersByTimeAsync(1_500);
    await call.say(ASIDE);
    expect(noteBefore(call, ASIDE)).toEqual({ mode: 'unless-miss', afterMs: 1_500, expectedMs: GREETING_MS, start: 'arrival' });
    expect(call.session().intentAttempts).toBe(0);
  });

  it('INCOMPLETE_WAIT_MS: a turn set aside holds no reply, so nothing is held for a caller not finished', async () => {
    const call = liveCall('telnyx', 'none', { incompleteWait: { waitMs: 1_000 } }, () => placeClient({ utteranceComplete: () => 0.1 }));
    await overTheGreeting(call);
    expect(call.records().at(-1)!.decision.kind).toBe('ignore');
    expect(call.logs().some((l) => l.dir === 'log' && l.msg.replyHeld !== undefined)).toBe(false);
    expect(call.lines()).toHaveLength(1);
  });

  it('a prompt during a service\'s wait is not looked at: it is ignored there already', async () => {
    const call = liveCall('telnyx', 'none');
    await call.start();
    const entry = call.store.get(CALL)!;
    entry.session = { ...entry.session, pendingService: 'records' };
    await vi.advanceTimersByTimeAsync(1_000);
    await call.say(ASIDE);
    expect(notes(call)).toHaveLength(0);
    expect(call.records().at(-1)!.gates.some((g) => g.gate === 'speechOverLine')).toBe(false);
  });
});

/**
 * Call 60 (Telnyx, 2026-11-10, speakerphone with a television on): blips of 57 to 240 ms over a question,
 * the first 281 ms into it, none of the pauses between them longer than RESUME_AFTER_PAUSE_MS, and after the
 * line the caller's answer, itself heard only as blips under MIN_SPEECH_MS. [on, off] in ms from the question's send.
 */
const CALL_60_BLIPS: readonly (readonly [number, number])[] = [
  [281, 519], [1_973, 2_148], [2_272, 2_329], [2_452, 2_571], [3_218, 3_336], [3_881, 3_939], [4_364, 4_482],
  [4_787, 4_844], [4_966, 5_145], [5_389, 5_447], [6_295, 6_412], [6_638, 6_695], [7_180, 7_419], [7_482, 7_600], [7_723, 8_022],
];

describe('blips of noise over a question are not the start of the answer after it (MIN_SPEECH_MS, call 60)', () => {
  async function call60(call: Call): Promise<void> {
    await toPlace(call);
    let at = 0;
    for (const [on, off] of CALL_60_BLIPS) {
      await vi.advanceTimersByTimeAsync(on - at);
      await call.caller(true);
      await vi.advanceTimersByTimeAsync(off - on);
      await call.caller(false);
      at = off;
    }
    await vi.advanceTimersByTimeAsync(8_385 - at);
    await call.say('22 Alder Street.');
  }

  it('the answer said after the question is not speech over it: no note, a turn as after any line', async () => {
    const call = liveCall('telnyx', 'none');
    await call60(call);
    expect(noteBefore(call, '22 Alder Street.')).toBeUndefined();
    expect(call.session().slots.place?.value).toBe('22 Alder Street.');
    await sameOnReplay(call);
  });

  it('with MIN_SPEECH_MS=0, as before: the first blip began the run, and the answer was noted as over the question', async () => {
    const call = liveCall('telnyx', 'none', { minSpeechMs: 0 });
    await call60(call);
    expect(noteBefore(call, '22 Alder Street.')).toMatchObject({ mode: 'unless-miss', afterMs: 281, start: 'speaking' });
    await sameOnReplay(call);
  });

  it('speech of MIN_SPEECH_MS or more over the question after the blips is its start, as before', async () => {
    const call = liveCall('telnyx', 'none');
    await toPlace(call);
    await vi.advanceTimersByTimeAsync(281);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(238);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(400);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(400);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(300);
    await call.say(ASIDE);
    expect(noteBefore(call, ASIDE)).toMatchObject({ mode: 'unless-miss', afterMs: 919, start: 'speaking' });
  });
});

/**
 * The carrier's report of a line played is its end (call 61, 2026-11-10, Telnyx with BARGE_IN=none): a 9.2 s line
 * was reported played (tokensPlayed, then agentSpeaking off) 7.5 s in, and the caller's "No. That's it." began
 * 1.4 s after the report, before the estimate's end, and was taken as speech over it and set aside. Here on the
 * test app's greeting (11.6 s by the estimate), at the same distances from its end; the words are the test's.
 */
describe('the carrier\'s report of a line played is its end (call 61)', () => {
  /** The greeting played and reported 2.1 s before its estimated end, as call 61's line was 1.7 s before its own. */
  const REPORTED_MS = 9_500;
  async function reported(call: Call): Promise<void> {
    await call.start();
    await vi.advanceTimersByTimeAsync(71);
    await call.agent(true);
    await vi.advanceTimersByTimeAsync(REPORTED_MS - 71);
    await call.played(GREETING);
    await vi.advanceTimersByTimeAsync(31);
    await call.agent(false);
  }
  /** The caller's speech from `onMs` into the greeting, as call 61's came: two runs, the prompt 181 ms after the second stops. */
  async function speech(call: Call, onMs: number, words = ASIDE): Promise<void> {
    await vi.advanceTimersByTimeAsync(onMs - (REPORTED_MS + 31));
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(300);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(69);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(353);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(181);
    await call.say(words);
  }

  it('speech begun after the report, before the estimate\'s end, is not over the line: a turn as after any line', async () => {
    const call = liveCall('telnyx', 'none');
    await reported(call);
    await speech(call, REPORTED_MS + 1_400);
    expect(noteBefore(call, ASIDE)).toBeUndefined();
    expect(call.records().at(-1)!.event).not.toHaveProperty('overLine');
    expect(call.lines().at(-1)).toBe(NOMATCH);
    expect(call.session().intentAttempts).toBe(1);
    await sameOnReplay(call);
  });

  it('a request begun after the report is taken as ever', async () => {
    const call = liveCall('telnyx', 'none');
    await reported(call);
    await speech(call, REPORTED_MS + 1_400, 'i want to report a problem');
    expect(noteBefore(call, 'i want to report a problem')).toBeUndefined();
    expect(call.lines().at(-1)).toBe(ASK_PLACE);
  });

  it('speech begun before the report is over the line, placed against the reported end, and the wait after it set aside runs from that end', async () => {
    const call = liveCall('telnyx', 'none');
    await call.start();
    await vi.advanceTimersByTimeAsync(71);
    await call.agent(true);
    await vi.advanceTimersByTimeAsync(8_000 - 71);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(REPORTED_MS - 8_000);
    await call.played(GREETING);
    await vi.advanceTimersByTimeAsync(31);
    await call.agent(false);
    await vi.advanceTimersByTimeAsync(400);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(300);
    await call.say(ASIDE);
    expect(noteBefore(call, ASIDE)).toEqual({ mode: 'unless-miss', afterMs: 8_000, expectedMs: REPORTED_MS, start: 'speaking', played: true });
    expect(call.records().at(-1)!.decision.kind).toBe('ignore');
    expect(call.lines()).toHaveLength(1);
    // The question again a no-input wait from now, the reported end being past, where the estimate's end would
    // have it 1.4 s later (the caller spoke: no "I didn't hear anything").
    await vi.advanceTimersByTimeAsync(NO_INPUT_MS - 1);
    expect(call.lines()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.lines()[1]).toBe(testkitApp.prompts.manifest.ask_intent!.text);
    await sameOnReplay(call);
  });

  it('a stop that names no line ends the lines once it has stayed stopped; one followed at once by a start does not', async () => {
    const settled = liveCall('telnyx', 'none');
    await settled.start();
    await vi.advanceTimersByTimeAsync(71);
    await settled.agent(true);
    await vi.advanceTimersByTimeAsync(REPORTED_MS - 71);
    await settled.agent(false);
    await vi.advanceTimersByTimeAsync(31);
    await speech(settled, REPORTED_MS + 1_400);
    expect(noteBefore(settled, ASIDE)).toBeUndefined();
    expect(settled.lines().at(-1)).toBe(NOMATCH);
    forgetNoInput(CALL);
    // A frame sent mid-line gave a stop and a start 230 ms apart (server/voice/telnyx.ts): the line plays on.
    const restarted = liveCall('telnyx', 'none');
    await restarted.start();
    await vi.advanceTimersByTimeAsync(71);
    await restarted.agent(true);
    await vi.advanceTimersByTimeAsync(REPORTED_MS - 71);
    await restarted.agent(false);
    await vi.advanceTimersByTimeAsync(31);
    await restarted.agent(true);
    await speech(restarted, REPORTED_MS + 1_400);
    expect(noteBefore(restarted, ASIDE)).toMatchObject({ mode: 'unless-miss', expectedMs: GREETING_MS, start: 'speaking' });
    expect(noteBefore(restarted, ASIDE)).not.toHaveProperty('played');
    expect(restarted.lines()).toHaveLength(1);
  });

  it('a report that names another line, or comes after the estimate, changes nothing', async () => {
    const call = liveCall('telnyx', 'none');
    await call.start();
    await vi.advanceTimersByTimeAsync(REPORTED_MS);
    await call.played('Some other line.');
    await vi.advanceTimersByTimeAsync(31);
    await speech(call, REPORTED_MS + 1_400);
    expect(noteBefore(call, ASIDE)).toMatchObject({ expectedMs: GREETING_MS });
    expect(call.lines()).toHaveLength(1);
  });
});

describe('the lines\' end the no-input wait reads', () => {
  it('a reply of two lines on Twilio: speech over the second is placed against both, and the wait after it runs from their end', async () => {
    const call = liveCall('twilio', 'none');
    await toPlace(call);
    // Two frames: 3.2 s, then 1.6 s behind it.
    expect(call.lines().slice(-2)).toEqual(['Sure, I can help you report a problem.', ASK_PLACE]);
    await vi.advanceTimersByTimeAsync(4_000);
    await call.say('mm hm');
    expect(noteBefore(call, 'mm hm')).toEqual({ mode: 'unless-miss', afterMs: 4_000, expectedMs: 4_800, start: 'arrival' });
    expect(call.records().at(-1)!.decision.kind).toBe('ignore');
    await vi.advanceTimersByTimeAsync(800 + NO_INPUT_MS - 1);
    expect(call.lines().at(-1)).toBe(ASK_PLACE);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.records().at(-1)!.event.type).toBe('user.silence');
  });

  it('a reply sent while the greeting is still playing is queued behind it: speech over the greeting\'s tail is over a line', async () => {
    const call = liveCall('twilio', 'none');
    await call.start();
    await vi.advanceTimersByTimeAsync(1_000);
    // A request over the greeting: taken, its reply queued behind the greeting (11.6 s, then 4.8 s).
    await call.say('i want to report a problem');
    // The no-input wait after it is counted as it always was, from the reply's own estimate.
    const armed = call.logs().filter((l) => l.dir === 'log' && l.msg.noInputArmedMs !== undefined).at(-1)!.msg.noInputArmedMs;
    expect(armed).toBe(4_800 + NO_INPUT_MS);
    await vi.advanceTimersByTimeAsync(4_900);
    await call.say('mm hm');
    expect(noteBefore(call, 'mm hm')).toEqual({ mode: 'unless-miss', afterMs: 5_900, expectedMs: GREETING_MS + 4_800, start: 'arrival' });
    expect(call.records().at(-1)!.decision.kind).toBe('ignore');
  });

  it('background speech over a reply queued behind the greeting is set aside, and the wait after it runs from the queued end', async () => {
    const call = liveCall('telnyx', 'none');
    await call.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await call.say('i want to report a problem');
    expect(call.session().form).toBe('report');
    // At 12 s the reply plays (11.6 s to 16.4 s); someone in the room talks over it.
    await vi.advanceTimersByTimeAsync(10_700);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(300);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(300);
    await call.say(ASIDE);
    expect(noteBefore(call, ASIDE)).toEqual({ mode: 'unless-miss', afterMs: 11_700, expectedMs: GREETING_MS + 4_800, start: 'speaking' });
    expect(call.records().at(-1)!.decision.kind).toBe('ignore');
    expect(call.session().slots.place?.attempts).toBe(0);
    expect(call.lines().at(-1)).toBe(ASK_PLACE);
    // The wait: from the queued end, 16.4 s, then NO_INPUT_MS.
    const now = 12_300;
    await vi.advanceTimersByTimeAsync(GREETING_MS + 4_800 + NO_INPUT_MS - now - 1);
    expect(call.lines().at(-1)).toBe(ASK_PLACE);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.records().at(-1)!.event.type).toBe('user.silence');
    await sameOnReplay(call);
  });

  it("the caller's interrupt ends the lines as it comes: what is sent after it is not queued behind them", async () => {
    // Under BARGE_IN=speech the greeting can be cut; the acknowledgement after a request cannot (interruptible: false).
    resetAppsForTest();
    const app = placeApp();
    registerApp({ ...app, prompts: { ...app.prompts, manifest: { ...app.prompts.manifest, ack_intent: { ...app.prompts.manifest.ack_intent!, interruptible: false } } } });
    registerTestkit();
    const call = liveCall('twilio', 'speech');
    await call.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await call.send({ type: 'interrupt', utteranceUntilInterrupt: 'Thanks for calling', durationUntilInterruptMs: 1_000 });
    await call.say('i want to report a problem');
    // The reply plays from its send, at 1 s: its acknowledgement (3.2 s) and the question (1.6 s).
    await vi.advanceTimersByTimeAsync(1_000);
    await call.say(ASIDE);
    expect(noteBefore(call, ASIDE)).toEqual({ mode: 'unless-miss', afterMs: 1_000, expectedMs: 4_800, start: 'arrival' });
  });
});

describe.each(['take', 'unless-miss', 'ignore'] as const)('noise just before a line ends, then the answer just after it (SPEECH_OVER_LINE=%s)', (mode: SpeechOverLine) => {
  it('the answer is a turn of its own, as after any line: the run of speech ends at the line\'s end', async () => {
    const call = liveCall('telnyx', 'none', { speechOverLine: mode });
    await call.start();
    // Noise over the last 2 s of the greeting, ending 0.2 s before its estimated end, with no prompt.
    await vi.advanceTimersByTimeAsync(GREETING_MS - 2_000);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(1_800);
    await call.caller(false);
    // The answer, 0.5 s after the end: a pause of 0.7 s, under RESUME_AFTER_PAUSE_MS.
    await vi.advanceTimersByTimeAsync(700);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(300);
    await call.say(ASIDE);
    expect(notes(call)).toHaveLength(0);
    expect(call.lines().at(-1)).toBe(NOMATCH);
    expect(call.session().intentAttempts).toBe(1);
  });
});

describe('a line said again (RESAY_CUT_LINES)', () => {
  it('the no-input wait runs from the resent line\'s own end, not behind the estimate of the send it replaces', async () => {
    const call = liveCall('telnyx', 'none', { resay: { minFraction: 0.35 } });
    await greetingCutAndSaidAgain(call);
    await vi.advanceTimersByTimeAsync(GREETING_MS + NO_INPUT_MS - 1);
    expect(call.lines()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.lines()[2]).toBe(NO_INPUT);
  });

  it('an answer just after the resent line\'s own end is a turn, not speech over it', async () => {
    const call = liveCall('telnyx', 'none', { resay: { minFraction: 0.35 }, noInputMs: 0 });
    await greetingCutAndSaidAgain(call);
    await vi.advanceTimersByTimeAsync(GREETING_MS + 200);
    await call.say(ASIDE);
    expect(noteBefore(call, ASIDE)).toBeUndefined();
    expect(call.lines().at(-1)).toBe(NOMATCH);
  });

  it('speech over the resent line is placed against it, from its own send', async () => {
    const call = liveCall('telnyx', 'none', { resay: { minFraction: 0.35 }, noInputMs: 0 });
    await greetingCutAndSaidAgain(call);
    await vi.advanceTimersByTimeAsync(2_000);
    await call.say(ASIDE);
    expect(noteBefore(call, ASIDE)).toEqual({ mode: 'unless-miss', afterMs: 2_000, expectedMs: GREETING_MS, start: 'arrival' });
  });
});

describe('speech over a line on Twilio, which reports no caller speaking', () => {
  it('the prompt\'s arrival is the speech\'s start: over the greeting, a miss is set aside', async () => {
    const call = liveCall('twilio', 'none');
    await call.start();
    await vi.advanceTimersByTimeAsync(1_900);
    await call.say(ASIDE);
    expect(call.lines()).toHaveLength(1);
    expect(call.session().intentAttempts).toBe(0);
    expect(noteBefore(call, ASIDE)).toEqual({ mode: 'unless-miss', afterMs: 1_900, expectedMs: GREETING_MS, start: 'arrival' });
    await sameOnReplay(call);
  });

  it('chatter that begins during the greeting, its partial prompts first, and whose final prompt comes after its end: over the greeting, from the first partial', async () => {
    const call = liveCall('twilio', 'none');
    await call.start();
    await vi.advanceTimersByTimeAsync(9_000);
    for (const words of ['can you', 'can you pass me', 'can you pass me the blue']) {
      await call.partial(words);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    // The final prompt 0.4 s after the greeting's end.
    await call.say(ASIDE);
    expect(noteBefore(call, ASIDE)).toEqual({ mode: 'unless-miss', afterMs: 9_000, expectedMs: GREETING_MS, start: 'partial' });
    expect(call.session().intentAttempts).toBe(0);
    expect(call.lines()).toHaveLength(1);
    await sameOnReplay(call);
  });

  it('partials that began after the greeting\'s end: a miss as before', async () => {
    const call = liveCall('twilio', 'none');
    await call.start();
    await vi.advanceTimersByTimeAsync(GREETING_MS + 100);
    await call.partial('can you');
    await vi.advanceTimersByTimeAsync(800);
    await call.say(ASIDE);
    expect(noteBefore(call, ASIDE)).toBeUndefined();
    expect(call.lines().at(-1)).toBe(NOMATCH);
  });

  it('after the greeting\'s end, with no partial before it, a miss as before', async () => {
    const call = liveCall('twilio', 'none');
    await call.start();
    await vi.advanceTimersByTimeAsync(GREETING_MS + 1);
    await call.say(ASIDE);
    expect(call.lines().at(-1)).toBe(NOMATCH);
  });
});

describe('SPEECH_OVER_LINE=take', () => {
  it('is the old behaviour: the miss over the greeting is said and counted, and nothing is noted', async () => {
    const call = liveCall('telnyx', 'none', { speechOverLine: 'take' });
    await overTheGreeting(call);
    expect(call.lines().at(-1)).toBe(NOMATCH);
    expect(call.session().intentAttempts).toBe(1);
    expect(noteBefore(call, ASIDE)).toBeUndefined();
    expect(call.records().at(-1)!.event).not.toHaveProperty('overLine');
    await sameOnReplay(call);
  });
});

describe('SPEECH_OVER_LINE=ignore', () => {
  it('runs no turn for speech over the line: nothing said, no record, and the no-input wait from the greeting\'s end', async () => {
    const call = liveCall('telnyx', 'none', { speechOverLine: 'ignore' });
    await overTheGreeting(call);
    expect(call.lines()).toHaveLength(1);
    // The greeting's record only.
    expect(call.records()).toHaveLength(1);
    expect(noteBefore(call, ASIDE)).toEqual({ mode: 'ignore', afterMs: 67, expectedMs: GREETING_MS, start: 'speaking' });
    expect(call.log.filter((l) => l.includes('speech'))).toEqual([`${CALL}: speech 0.07 s into lines it could not interrupt (~11.6 s): no turn`]);
    await vi.advanceTimersByTimeAsync(GREETING_MS + NO_INPUT_MS - 1_900 - 1);
    expect(call.lines()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.lines()[1]).toBe(NO_INPUT);
    await sameOnReplay(call);
  });

  it('a request over the line is not taken either; one after it is', async () => {
    const call = liveCall('twilio', 'none', { speechOverLine: 'ignore' });
    await call.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await call.say('i want to report a problem');
    expect(call.session().form).toBeNull();
    await vi.advanceTimersByTimeAsync(GREETING_MS);
    await call.say('i want to report a problem');
    expect(call.session().form).toBe('report');
    await sameOnReplay(call);
  });

  it('a caller who came back in over the re-ask is not dropped: the rest is joined to what they began (the 2026-10-05 timings)', async () => {
    const call = liveCall('telnyx', 'none', { speechOverLine: 'ignore' });
    await toPlace(call);
    await vi.advanceTimersByTimeAsync(4_800 + 500);
    // "...for one two" said after the question's end: a fragment, a miss, the re-ask out 0.52 s after they stopped.
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(400);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(517);
    await call.say('at');
    expect(call.lines().at(-1)).toBe(REASK);
    // "...three four": back in 24 ms after the re-ask went out, over it, with the rest.
    await vi.advanceTimersByTimeAsync(24);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(343);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(130);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(410);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(496);
    await call.say('22 Alder Street.');
    expect(call.session().slots.place?.value).toBe('at 22 Alder Street.');
    expect(call.records().at(-1)!.joined).toEqual({ fragments: ['at', '22 Alder Street.'] });
    expect(notes(call)).toHaveLength(0);
    await sameOnReplay(call);
  });
});

describe('speech over a line the caller can interrupt', () => {
  it('BARGE_IN=any with an interruptible greeting: unchanged, the miss is said', async () => {
    const call = liveCall('telnyx', 'any');
    await overTheGreeting(call);
    expect(call.lines().at(-1)).toBe(NOMATCH);
    expect(call.session().intentAttempts).toBe(1);
    expect(noteBefore(call, ASIDE)).toBeUndefined();
  });

  it('BARGE_IN=any with a greeting sent interruptible: false: over it, as with the barge-in off', async () => {
    resetAppsForTest();
    const app = placeApp();
    registerApp({ ...app, prompts: { ...app.prompts, manifest: { ...app.prompts.manifest, greeting: { ...app.prompts.manifest.greeting!, interruptible: false } } } });
    registerTestkit();
    const call = liveCall('twilio', 'any');
    await call.start();
    expect(call.sent[0]).toMatchObject({ type: 'text', interruptible: false });
    await vi.advanceTimersByTimeAsync(1_900);
    await call.say(ASIDE);
    expect(call.lines()).toHaveLength(1);
    expect(noteBefore(call, ASIDE)).toMatchObject({ mode: 'unless-miss', start: 'arrival' });
  });
});

/** The place model, answering after `ms(text)` of the turn's words: a slow model. */
function slowClient(ms: (text: string) => number): JevClient {
  const inner = placeClient();
  return {
    ask: async (req) => {
      const text = (req.state as { asr?: { text?: string } } | null)?.asr?.text ?? '';
      await new Promise((r) => setTimeout(r, ms(text)));
      return inner.ask(req);
    },
  };
}

describe.each(['unless-miss', 'ignore'] as const)('a caller who comes back in while the turn before is still running (SPEECH_OVER_LINE=%s)', (mode: SpeechOverLine) => {
  it('is joined to the words before, and not dropped', async () => {
    const call = liveCall('telnyx', 'none', { speechOverLine: mode }, () => slowClient((t) => (t === 'at' ? 1_500 : 200)));
    await call.start();
    await vi.advanceTimersByTimeAsync(GREETING_MS + 500);
    // The request; its turn takes 0.2 s, and the caller starts "at" 0.1 s in, before the question goes out.
    const request = call.say('i want to report a problem');
    await vi.advanceTimersByTimeAsync(100);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(100);
    await request;
    expect(call.lines().at(-1)).toBe(ASK_PLACE);
    await vi.advanceTimersByTimeAsync(300);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(300);
    // "at", begun before the question went out: not over it, taken; its turn takes 1.5 s.
    const at = call.say('at');
    expect(noteBefore(call, 'at')).toBeUndefined();
    // Back in 0.7 s after they stopped, over the question, while that turn runs; the rest comes before it ends.
    await vi.advanceTimersByTimeAsync(400);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(400);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(300);
    const rest = call.say('22 Alder Street.');
    // Over the question, under either value: noted; under `ignore` not dropped, for the caller came back in.
    if (mode === 'unless-miss') expect(noteBefore(call, '22 Alder Street.')).toMatchObject({ mode, start: 'speaking' });
    else expect(noteBefore(call, '22 Alder Street.')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    await at;
    await rest;
    expect(call.session().slots.place?.value).toBe('at 22 Alder Street.');
    expect(call.records().at(-1)!.joined).toEqual({ fragments: ['at', '22 Alder Street.'] });
  });
});

describe('every final prompt ends the run of speech it carries', () => {
  it('a prompt during a service\'s wait: the next utterance, within RESUME_AFTER_PAUSE_MS of it, starts a run of its own', async () => {
    const call = liveCall('telnyx', 'none');
    await call.start();
    const entry = call.store.get(CALL)!;
    const waiting = entry.session;
    entry.session = { ...waiting, pendingService: 'records' };
    await vi.advanceTimersByTimeAsync(500);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(500);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(300);
    await call.say('one moment');
    expect(notes(call)).toHaveLength(0);
    // The answer is in; 0.7 s after the last stop, more speech.
    call.store.get(CALL)!.session = { ...call.store.get(CALL)!.session, pendingService: null };
    await vi.advanceTimersByTimeAsync(400);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(500);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(300);
    await call.say(ASIDE);
    expect(noteBefore(call, ASIDE)).toMatchObject({ afterMs: 1_700, start: 'speaking' });
  });
});
