import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditDraft } from '../../audit/types';
import type { AuditSink } from '../../audit/sink';
import type { AnswerMap, JevClient, JevRequest } from '../../jev/types';
import type { InboundFrame, OutboundFrame, TextFrame } from '../../channel/relay/frames';
import type { ConverseModel, ModelEvent, ModelRequest } from '../../converse/model/types';
import { policyOf } from '../../converse/policy';
import { newConverseState } from '../../converse/state';
import { BRIDGE_AFTER_MS, CUT_IN_NOTE, UNHEARD_NOTE, type ConverseDeps } from '../../converse/turn';
import type { ConverseTraceRecord } from '../../converse/trace';
import { converseFixture } from '../../testing/converse/app';
import { BOOKING, call, DAY, done, text } from '../../testing/converse/chat';
import type { ConverseCallEntry } from '../sessions';
import type { PlaybackEvent } from './provider';
import type { VoiceIo } from './io';
import { converseVoiceRuntime } from './converseRuntime';

/**
 * The converse voice runtime over a fake io (server/voice/converseRuntime.ts): what it sends the carrier, the
 * turns it stops, and what the model is told the caller heard. The converse fixture's business, a scripted
 * model whose answers wait where a test says, and a decision model that reads a yes.
 */

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

const GREETING = 'Example Visits, how can I help?';

/** A step of a model's answer: an event, or a wait the test ends (`gate`) or that never ends (`hang`); the request's abort ends either. */
type Step = ModelEvent | 'hang' | { gate: Promise<void> };

/** A model answering each request with the next scripted round; a stopped wait ends its stream as a real client does (an error). */
function gatedModel(rounds: Step[][]): ConverseModel & { requests: ModelRequest[]; signals: AbortSignal[] } {
  const requests: ModelRequest[] = [];
  const signals: AbortSignal[] = [];
  return {
    id: 'gated',
    requests,
    signals,
    async *stream(req, signal) {
      requests.push(structuredClone(req));
      signals.push(signal);
      const round = rounds[requests.length - 1];
      if (round === undefined) {
        yield { type: 'error', kind: 'http', detail: 'no more scripted rounds' };
        return;
      }
      for (const step of round) {
        if (step === 'hang' || 'gate' in step) {
          const stopped = await Promise.race([
            step === 'hang' ? new Promise<boolean>(() => {}) : step.gate.then(() => false),
            new Promise<boolean>((resolve) => (signal.aborted ? resolve(true) : signal.addEventListener('abort', () => resolve(true), { once: true }))),
          ]);
          if (stopped) {
            yield { type: 'error', kind: 'timeout', detail: 'aborted' };
            return;
          }
          continue;
        }
        yield step;
      }
    },
  };
}

/** A gate a test opens. */
function gate(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  return { gate: new Promise<void>((r) => (open = r)), open };
}

/** A decision model that reads a yes in "yes", and each reply after it is said as `claims` (none: unread). */
function jevOf(claims?: { contradicted: number; notDone: number; gap: number }): JevClient & { asked: JevRequest[] } {
  const asked: JevRequest[] = [];
  return {
    asked,
    async ask(req) {
      asked.push(req);
      const isClaims = Object.hasOwn(req.questions, 'contradicted');
      const yes = /\byes\b/.test(String((req.state as { said?: unknown }).said ?? '').toLowerCase());
      const answers: AnswerMap = isClaims
        ? (claims === undefined ? {} : { contradicted: { type: 'noul', noul: claims.contradicted }, notDone: { type: 'noul', noul: claims.notDone }, gap: { type: 'noul', noul: claims.gap } })
        : { confirmsYes: { type: 'noul', noul: yes ? 0.95 : 0.05 }, confirmsNo: { type: 'noul', noul: yes ? 0.05 : 0.9 } };
      return { answers, model: 'fake', usage: { inputTokens: 0, outputTokens: 0, estimated: true }, latencyMs: 1, source: 'jev' };
    },
  };
}

/** A fake io: what was sent, ended, logged, saved and published. */
function fakeIo(entry: ConverseCallEntry) {
  const sent: OutboundFrame[] = [];
  const records: { dir: string; msg: unknown }[] = [];
  const saves: (string | undefined)[] = [];
  const published: unknown[] = [];
  const kept: OutboundFrame[][] = [];
  let finished = 0;
  const io = {
    async send(frames: readonly OutboundFrame[], o?: { logged?: (f: OutboundFrame) => OutboundFrame | null }) {
      if (entry.socket === null) return false;
      for (const f of frames) {
        sent.push(f);
        const l = o?.logged ? o.logged(f) : f;
        if (l !== null) records.push({ dir: 'out', msg: l });
      }
      return true;
    },
    async sendEnd(end: OutboundFrame, _said?: readonly OutboundFrame[], o?: { logged?: (f: OutboundFrame) => OutboundFrame | null }) {
      sent.push(end);
      records.push({ dir: 'out', msg: o?.logged ? o.logged(end) : end });
      return true;
    },
    keepUndelivered(frames: readonly OutboundFrame[]) {
      kept.push([...frames]);
      return true;
    },
    record(dir: string, msg: unknown) {
      records.push({ dir, msg });
    },
    publish(e: unknown) {
      published.push(e);
    },
    async save() {
      saves.push(entry.turnWords);
    },
    async finish() {
      finished += 1;
    },
    playback() {},
  } as unknown as VoiceIo;
  return { io, sent, records, saves, published, kept, finished: () => finished };
}

function harness(o: { model: ConverseModel; provider?: 'twilio' | 'telnyx'; jev?: JevClient; before?: Record<string, () => Promise<void>>; hooks?: Pick<Parameters<typeof converseVoiceRuntime>[0], 'onTurnEnd' | 'onClaimsRead'>; appending?: (d: AuditDraft, rows: readonly AuditDraft[]) => void }) {
  const { app, calendar, booked } = converseFixture();
  const rows: AuditDraft[] = [];
  const audit: AuditSink = {
    append(callId, channel, d) {
      // A test's look at each row before it is kept: one that throws fails the append.
      o.appending?.(d, rows);
      rows.push(d);
      return { ...d, seq: rows.length, at: new Date().toISOString(), callId, channel, prevHash: '', hash: '' };
    },
  };
  const traces: ConverseTraceRecord[] = [];
  /** What was written straight to the call's frame log (not through the io). */
  const logged: { dir: string; msg: unknown }[] = [];
  const entry: ConverseCallEntry = {
    trace: { write: (r) => void traces.push(r as ConverseTraceRecord) },
    frames: { write: (dir: string, msg: unknown) => void logged.push({ dir, msg }) } as ConverseCallEntry['frames'],
    callSid: 'CA-converse-1',
    socket: { send() {}, close() {} },
    reconnects: 0,
    createdAtMs: Date.now(),
    lastActivityMs: Date.now(),
    ended: false,
    endedAtMs: null,
    tail: Promise.resolve(),
    inFlight: 0,
    auditEntries: [],
    provider: o.provider ?? 'twilio',
    session: newConverseState({ appId: app.id, callId: 'CA-converse-1', channel: 'voice' }),
  };
  const jev = o.jev ?? jevOf();
  const rt = converseVoiceRuntime({
    apps: new Map([[app.id, app]]),
    converseDeps: (a) => ({
      business: a.business, model: o.model, jev, policy: policyOf(a.business), audit, tools: withBefore(a.tools, o.before ?? {}), texts: null,
      now: () => new Date(), trace: () => {}, jevTimeoutMs: 1000,
    }),
    now: () => Date.now(),
    ...(o.hooks ?? {}),
  });
  const fio = fakeIo(entry);
  const said = (): TextFrame[] => fio.sent.filter((f): f is TextFrame => f.type === 'text');
  const prompt = (words: string, last = true): Promise<void> => rt.frame(entry, { type: 'prompt', voicePrompt: words, lang: 'en-US', last }, fio.io);
  const frame = (f: InboundFrame): Promise<void> => rt.frame(entry, f, fio.io);
  const event = (ev: PlaybackEvent): void => rt.playback(entry, ev, fio.io);
  /** Lets the turns run what they can, with the clock moved on by `ms`. */
  const settle = async (ms = 1): Promise<void> => void (await vi.advanceTimersByTimeAsync(ms));
  return { rt, entry, io: fio.io, fio, rows, traces, logged, calendar, booked, said, prompt, frame, event, settle, jev };
}

/** The app's actions, each named in `before` run after its wait. */
function withBefore(tools: ConverseDeps['tools'], before: Record<string, () => Promise<void>>): ConverseDeps['tools'] {
  return Object.fromEntries(Object.entries(tools).map(([name, impl]) => [name, before[name] === undefined ? impl : async (p: Record<string, string>, ctx: Parameters<typeof impl>[1]) => (await before[name]!(), impl(p, ctx))]));
}

/** The last user message of a request, as JSON. */
const lastUser = (req: ModelRequest): string => JSON.stringify([...req.messages].reverse().find((m) => m.role === 'user'));

describe('the converse voice runtime: sending', () => {
  it('the greeting is one final text frame', async () => {
    const h = harness({ model: gatedModel([]) });
    await h.rt.open(h.entry, { callerNumber: '+15555550123', provider: 'twilio' }, h.io);
    expect(h.said()).toEqual([{ type: 'text', token: GREETING, last: true, lang: 'en-US', interruptible: true, preemptible: false }]);
    expect(h.entry.session.caller).toEqual({ number: '+15555550123', account: null });
    expect(h.fio.published[0]).toMatchObject({ type: 'call_started', channel: 'voice', provider: 'twilio', from: '...0123' });
  });

  it('a reply streams as non-final frames and one final frame', async () => {
    const h = harness({ model: gatedModel([[text('Sure, we can help. '), text('What day suits you?'), done()]]) });
    await h.rt.open(h.entry, { callerNumber: null, provider: 'twilio' }, h.io);
    await h.prompt('I need a visit');
    expect(h.said().slice(1).map((f) => [f.token, f.last, f.interruptible])).toEqual([['Sure, we can help. ', false, true], ['What day suits you?', true, true]]);
    // Saved before the turn with its words, and after it without them.
    expect(h.fio.saves).toEqual([undefined, 'I need a visit', undefined]);
  });
});

describe('the converse voice runtime: cut-ins', () => {
  it('a Twilio interrupt stops the turn and the next turn hears what was played', async () => {
    const model = gatedModel([[text('Sure, we have the morning free. '), text('Or'), 'hang'], [text('Monday then.'), done()]]);
    const h = harness({ model });
    await h.rt.open(h.entry, { callerNumber: null, provider: 'twilio' }, h.io);
    const turn = h.prompt('Anything Tuesday?');
    await h.settle();
    expect(h.said().at(-1)!.token).toBe('Sure, we have the morning free. ');
    await h.frame({ type: 'interrupt', utteranceUntilInterrupt: 'Sure, we have', durationUntilInterruptMs: 800 });
    await h.settle();
    await turn;
    expect(model.signals[0]!.aborted).toBe(true);
    expect(h.traces.at(-1)!.interrupted).toBe(true);
    await h.prompt('actually, Monday');
    expect(JSON.stringify(model.requests[1]!.messages)).toContain(`Sure, we have${CUT_IN_NOTE}`);
    expect(JSON.stringify(model.requests[1]!.messages)).toContain('Sure, we have [The caller cut in here.]');
    expect(h.entry.session.failures).toBe(0);
  });

  it('a Telnyx interrupt with no caller speech is ignored', async () => {
    const g = gate();
    const model = gatedModel([[text('Sure, we have the morning free. '), text('Or'), g, text(' the afternoon.'), done()], [text('Good.'), done()]]);
    const h = harness({ model, provider: 'telnyx' });
    await h.rt.open(h.entry, { callerNumber: null, provider: 'telnyx' }, h.io);
    const turn = h.prompt('Anything Tuesday?');
    await h.settle();
    await h.frame({ type: 'interrupt', utteranceUntilInterrupt: 'Sure, we have the morning free.', durationUntilInterruptMs: 1700 });
    await h.settle();
    expect(model.signals[0]!.aborted).toBe(false);
    g.open();
    await turn;
    expect(h.traces.at(-1)!.interrupted).toBeUndefined();
    expect(h.said().slice(1).map((f) => f.token)).toEqual(['Sure, we have the morning free. ', 'Or the afternoon.']);
    await h.prompt('the morning');
    const sent = JSON.stringify(model.requests[1]!.messages);
    expect(sent).toContain('Sure, we have the morning free. Or the afternoon.');
    expect(sent).not.toContain(CUT_IN_NOTE);
    expect(h.traces.at(-1)!.heard).toEqual({ cutIn: false, spokeBefore: false, chars: expect.any(Number) });
  });

  it('Telnyx clientSpeaking over a reply is a cut-in, heard from tokensPlayed', async () => {
    const model = gatedModel([[text('Sure, we have the morning free. '), text('Or the afternoon, if that suits you better.'), done()], [text('Monday then.'), done()]]);
    const h = harness({ model, provider: 'telnyx' });
    await h.rt.open(h.entry, { callerNumber: null, provider: 'telnyx' }, h.io);
    await h.prompt('Anything Tuesday?');
    h.event({ kind: 'playback', state: 'started' });
    h.event({ kind: 'playback', state: 'finished', text: 'Sure, we have the morning free.' });
    h.event({ kind: 'caller', speaking: true });
    await h.prompt('actually, Monday');
    expect(JSON.stringify(model.requests[1]!.messages)).toContain(`Sure, we have the morning free.${CUT_IN_NOTE}`);
    expect(JSON.stringify(model.requests[1]!.messages)).not.toContain('if that suits you better');
    expect(h.traces.at(-1)!.heard).toEqual({ cutIn: true, spokeBefore: false, chars: 'Sure, we have the morning free.'.length });
  });

  it('a Telnyx cut-in while the turn runs stops it', async () => {
    const model = gatedModel([[text('Sure, we have the morning free. '), text('Or'), 'hang'], [text('Monday then.'), done()]]);
    const h = harness({ model, provider: 'telnyx' });
    await h.rt.open(h.entry, { callerNumber: null, provider: 'telnyx' }, h.io);
    const turn = h.prompt('Anything Tuesday?');
    await h.settle();
    h.event({ kind: 'playback', state: 'started' });
    h.event({ kind: 'caller', speaking: true });
    await h.settle();
    await turn;
    expect(model.signals[0]!.aborted).toBe(true);
    expect(h.traces.at(-1)!.interrupted).toBe(true);
  });
});

describe('the converse voice runtime: the recognizer and the bridge', () => {
  it('a second final before anything played is one turn', async () => {
    const model = gatedModel([['hang'], [text('Sure, Tuesday works.'), done()]]);
    const h = harness({ model });
    await h.rt.open(h.entry, { callerNumber: null, provider: 'twilio' }, h.io);
    const first = h.prompt('I need a visit');
    await h.settle(300);
    const second = h.prompt('on Tuesday');
    await h.settle();
    await Promise.all([first, second]);
    // The first request was stopped before a word of it was said; the one that answers holds both texts in one message.
    expect(model.requests).toHaveLength(2);
    expect(model.signals[0]!.aborted).toBe(true);
    const last = model.requests[1]!.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(JSON.stringify(last)).toContain('I need a visit');
    expect(JSON.stringify(last)).toContain('on Tuesday');
    expect(h.said().slice(1).map((f) => f.token)).toEqual(['Sure, Tuesday works.']);
    expect(h.said().map((f) => f.token)).not.toContain('Sorry, could you say that again?');
    expect(h.entry.session.failures).toBe(0);
  });

  it('speech over the bridge is the next turn', async () => {
    const g = gate();
    const model = gatedModel([[g, text('We have mornings free.'), done()], [text('Tuesday it is.'), done()]]);
    const h = harness({ model });
    await h.rt.open(h.entry, { callerNumber: null, provider: 'twilio' }, h.io);
    const first = h.prompt('Anything Tuesday?');
    await h.settle(BRIDGE_AFTER_MS);
    expect(h.said().at(-1)).toMatchObject({ token: 'One sec.', last: true, interruptible: false });
    const second = h.prompt('Tuesday please');
    await h.settle();
    expect(model.signals[0]!.aborted).toBe(false);
    g.open();
    await Promise.all([first, second]);
    expect(h.traces[1]!.interrupted).toBeUndefined();
    expect(h.traces[1]!.bridge).toBe(true);
    expect(h.said().slice(1).map((f) => f.token)).toEqual(['One sec.', 'We have mornings free.', 'Tuesday it is.']);
    expect(model.requests).toHaveLength(2);
  });
});

describe('the converse voice runtime: a confirmed change', () => {
  it('a cut-in during a confirmed change runs it once', async () => {
    const tool = gate();
    let calls = 0;
    const model = gatedModel([BOOKING[0]!, BOOKING[1]!, BOOKING[2]!, [text('You are booked for Tuesday morning.'), done()]]);
    const c = harness({ model, before: { book: async () => (calls += 1, tool.gate) } });
    await c.rt.open(c.entry, { callerNumber: '+15555550123', provider: 'twilio' }, c.io);
    await c.prompt('I need a visit on Tuesday');
    await c.prompt('the morning, for Sam Example');
    expect(c.said().at(-1)!.token).toContain('Is that right?');
    const yes = c.prompt('yes');
    await c.settle();
    expect(calls).toBe(1);
    await c.frame({ type: 'interrupt', utteranceUntilInterrupt: '', durationUntilInterruptMs: 300 });
    tool.open();
    await c.settle();
    await yes;
    expect(c.traces.at(-1)!.interrupted).toBe(true);
    expect(c.entry.session.done).toEqual([expect.objectContaining({ action: 'book' })]);
    await c.prompt('hello?');
    expect(calls).toBe(1);
    expect(c.booked).toHaveLength(1);
    expect(c.said().at(-1)!.token).toBe('You are booked for Tuesday morning.');
    expect(c.rows.filter((r) => r.type === 'confirmed').map((r) => r.detail.action)).toEqual(['book']);
  });
});

describe('the converse voice runtime: fix round 1', () => {
  /** The call up to the booking's read-back. */
  async function upToReadBack(h: ReturnType<typeof harness>): Promise<string> {
    await h.rt.open(h.entry, { callerNumber: '+15555550123', provider: h.entry.provider as 'twilio' | 'telnyx' }, h.io);
    await h.prompt('I need a visit on Tuesday');
    await h.prompt('the morning, for Sam Example');
    const readBack = h.said().at(-1)!.token;
    expect(readBack).toContain('Is that right?');
    return readBack;
  }

  it('a yes over a read-back heard in part, its turn cut by the socket closing, confirms nothing when asked again', async () => {
    const model = gatedModel([BOOKING[0]!, BOOKING[1]!, BOOKING[2]!, ['hang'], [text('Shall I read it again?'), done()]]);
    const h = harness({ model });
    const readBack = await upToReadBack(h);
    await h.frame({ type: 'interrupt', utteranceUntilInterrupt: readBack.slice(0, 20), durationUntilInterruptMs: 900 });
    const yes = h.prompt('yes');
    await h.settle();
    h.entry.socket = null;
    h.rt.closed(h.entry);
    await h.settle();
    await yes;
    expect(h.entry.turnWords).toBe('yes');
    expect(h.entry.turnHeard).toMatchObject({ cutIn: true, spokeBefore: false });
    h.entry.socket = { send() {}, close() {} };
    await h.rt.resumed(h.entry, h.io);
    expect(h.booked).toEqual([]);
    expect(h.rows.filter((r) => r.type === 'confirmed')).toEqual([]);
    expect(h.said().at(-1)!.token).toBe('Shall I read it again?');
    expect(h.entry.turnHeard).toBeUndefined();
  });

  it('tokensPlayed after the caller cut in counts for nothing: a yes over the read-back confirms nothing', async () => {
    const model = gatedModel([BOOKING[0]!, BOOKING[1]!, BOOKING[2]!, [text('Shall I read it again?'), done()]]);
    const h = harness({ model, provider: 'telnyx' });
    const readBack = await upToReadBack(h);
    h.event({ kind: 'playback', state: 'started' });
    h.event({ kind: 'caller', speaking: true });
    // Telnyx reports the whole line it handed its voice, though the audio stopped on the barge-in.
    h.event({ kind: 'playback', state: 'finished', text: readBack });
    await h.prompt('yes');
    expect(h.booked).toEqual([]);
    expect(h.rows.filter((r) => r.type === 'confirmed')).toEqual([]);
    expect(h.traces.at(-1)!.heard).toEqual({ cutIn: true, spokeBefore: false, chars: 0 });
  });

  it('three finals while a confirmed change still runs are one reply, holding all the words', async () => {
    const tool = gate();
    const model = gatedModel([BOOKING[0]!, BOOKING[1]!, BOOKING[2]!, [text('Yes, a second visit works.'), done()]]);
    const h = harness({ model, before: { book: () => tool.gate } });
    await upToReadBack(h);
    const asked = model.requests.length;
    const said = h.said().length;
    const yes = h.prompt('yes');
    await h.settle();
    const finals = [h.prompt('I also'), h.prompt('need a'), h.prompt('second visit')];
    await h.settle();
    tool.open();
    await h.settle();
    await Promise.all([yes, ...finals]);
    expect(h.booked).toHaveLength(1);
    expect(h.said().slice(said).map((f) => f.token)).toEqual(['Yes, a second visit works.']);
    expect(model.requests.slice(asked)).toHaveLength(1);
    const last = lastUser(model.requests.at(-1)!);
    for (const w of ['I also', 'need a', 'second visit']) expect(last).toContain(w);
    expect(h.entry.session.failures).toBe(0);
  });
});

describe('the converse voice runtime: keys and corrections', () => {
  it('keys are logged and ignored', async () => {
    const model = gatedModel([]);
    const h = harness({ model });
    await h.rt.open(h.entry, { callerNumber: null, provider: 'twilio' }, h.io);
    const before = h.fio.sent.length;
    await h.frame({ type: 'dtmf', digit: '0' });
    await h.settle();
    expect(h.fio.records).toContainEqual({ dir: 'in', msg: { type: 'dtmf', digit: '0' } });
    expect(h.fio.sent).toHaveLength(before);
    expect(model.requests).toHaveLength(0);
  });

  const SLIP = 'We are open Saturdays too.';
  const CORRECTION = 'Sorry, I should correct that: we are open every day.';
  const WRONG = { contradicted: 0.9, notDone: 0.1, gap: 0.1 };

  it('a correction waits for the reply to play, and is dropped when the caller speaks first', async () => {
    const played = harness({ model: gatedModel([[text(SLIP), done()], [text(CORRECTION), done()]]), jev: jevOf(WRONG) });
    await played.rt.open(played.entry, { callerNumber: null, provider: 'twilio' }, played.io);
    await played.prompt('Are you open Saturday?');
    expect(played.said().slice(1).map((f) => f.token)).toEqual([SLIP]);
    // The reply's estimated playback (2.5 words a second) has to pass first.
    await played.settle(1000);
    expect(played.said().slice(1).map((f) => f.token)).toEqual([SLIP]);
    await played.settle(2000);
    expect(played.said().slice(1).map((f) => [f.token, f.last])).toEqual([[SLIP, true], [CORRECTION, true]]);

    const model = gatedModel([[text(SLIP), done()], [text(CORRECTION), done()], [text('Yes, Saturday.'), done()]]);
    const spoke = harness({ model, jev: jevOf(WRONG) });
    await spoke.rt.open(spoke.entry, { callerNumber: null, provider: 'twilio' }, spoke.io);
    await spoke.prompt('Are you open Saturday?');
    await spoke.prompt('so', false);
    await spoke.settle(5000);
    expect(spoke.said().slice(1).map((f) => f.token)).toEqual([SLIP]);
    await spoke.prompt('so I can come Saturday?');
    // The correction was never heard: the model is told so.
    const sent = JSON.stringify(model.requests[2]!.messages);
    expect(sent).toContain(UNHEARD_NOTE);
    expect(sent).not.toContain(CORRECTION);
    expect(lastUser(model.requests[2]!)).toContain('so I can come Saturday?');
  });
});

describe('the converse voice runtime: the end and a restart', () => {
  it('ends with the closing line, the completed end and the audit\'s call_ended', async () => {
    const model = gatedModel([[{ type: 'tool_call', id: 'c1', name: 'end_call', args: {} }, done('tool')]]);
    const h = harness({ model });
    await h.rt.open(h.entry, { callerNumber: null, provider: 'twilio' }, h.io);
    await h.prompt('that is all, thanks');
    await h.settle();
    expect(h.said().at(-1)!.token).toBe('Thanks for getting in touch. Goodbye.');
    expect(h.fio.sent.at(-1)).toMatchObject({ type: 'end' });
    expect(JSON.parse((h.fio.sent.at(-1) as { handoffData: string }).handoffData)).toEqual({ reasonCode: 'completed' });
    expect(h.rows.at(-1)).toEqual({ type: 'call_ended', detail: { reason: 'completed' } });
    expect(h.fio.finished()).toBe(1);
  });

  it('a turn cut by the socket closing is asked again when the carrier reconnects', async () => {
    const model = gatedModel([['hang'], [text('Tuesday works.'), done()]]);
    const h = harness({ model });
    await h.rt.open(h.entry, { callerNumber: null, provider: 'twilio' }, h.io);
    const turn = h.prompt('Tuesday please');
    await h.settle();
    h.entry.socket = null;
    h.rt.closed(h.entry);
    await h.settle();
    await turn;
    expect(h.entry.turnWords).toBe('Tuesday please');
    // The call goes on from before the cut turn: the caller's words are not in it twice.
    h.entry.socket = { send() {}, close() {} };
    await h.rt.resumed(h.entry, h.io);
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests[1]!.messages).split('Tuesday please')).toHaveLength(2);
    expect(h.said().at(-1)!.token).toBe('Tuesday works.');
    expect(h.entry.turnWords).toBeUndefined();
  });

  it('an end with no socket to take it is kept for the next one, and sent there once', async () => {
    const h = harness({ model: gatedModel([[{ type: 'tool_call', id: 'c1', name: 'end_call', args: {} }, done('tool')]]) });
    await h.rt.open(h.entry, { callerNumber: null, provider: 'twilio' }, h.io);
    h.entry.socket = null;
    await h.prompt('bye');
    await h.settle();
    expect(h.fio.kept).toHaveLength(1);
    expect(h.fio.kept[0]!.map((f) => f.type)).toEqual(['text', 'end']);
    expect(h.fio.finished()).toBe(0);
    // The next socket: the lines and the end, once, then the call finished here.
    h.entry.socket = { send() {}, close() {} };
    h.entry.undelivered = h.fio.kept[0] as unknown as ConverseCallEntry['undelivered'];
    const before = h.fio.sent.length;
    await h.rt.replay(h.entry, h.io);
    await h.settle();
    expect(h.fio.sent.slice(before).map((f) => f.type)).toEqual(['text', 'end']);
    expect(h.entry.undelivered).toBeUndefined();
    expect(h.fio.finished()).toBe(1);
    // Kept in the frame log by its length alone: the turn that masked it is gone.
    expect(h.fio.records.filter((r) => r.dir === 'out').map((r) => (r.msg as { token?: string }).token).at(-2)).toBe(`<${'Thanks for getting in touch. Goodbye.'.length} chars>`);
  });

  it('logs each line masked as the trace masks it, and an end by its reason alone', async () => {
    const model = gatedModel([BOOKING[0]!, BOOKING[1]!, BOOKING[2]!]);
    const h = harness({ model });
    await h.rt.open(h.entry, { callerNumber: '+15555550123', provider: 'twilio' }, h.io);
    await h.prompt('I need a visit on Tuesday');
    await h.prompt('the morning, for Sam Example');
    const logged = h.fio.records.filter((r) => r.dir === 'out').map((r) => (r.msg as { token: string }).token);
    expect(logged.at(-1)).toContain('Is that right?');
    // The read-back names Sam Example; the fixture records the name by its length.
    expect(logged.at(-1)).not.toContain('Sam Example');
    expect(h.said().at(-1)!.token).toContain('Sam Example');
  });

  it('a hangup stops the turn, records the caller leaving and the end', async () => {
    const model = gatedModel([['hang']]);
    const h = harness({ model });
    await h.rt.open(h.entry, { callerNumber: null, provider: 'twilio' }, h.io);
    void h.prompt('hello');
    await h.settle();
    await h.rt.hangup(h.entry);
    expect(model.signals[0]!.aborted).toBe(true);
    expect(h.entry.session.ended).toBe('left');
    expect(h.rows.slice(-2).map((r) => r.type)).toEqual(['converse_left', 'call_ended']);
    expect(h.rows.at(-1)!.detail).toEqual({ reason: 'hangup' });
  });
});

describe('the converse voice runtime: the server\'s hooks and the frame log\'s end', () => {
  const SLIP = 'We are open Saturdays too.';
  const CORRECTION = 'Sorry, I should correct that: we are open every day.';

  it('tells onTurnEnd each turn\'s end once all it says is sent, a correction\'s after it is said, and onClaimsRead what the check read', async () => {
    const ends: string[] = [];
    const reads: number[] = [];
    const h = harness({
      model: gatedModel([[text(SLIP), done()], [text(CORRECTION), done()], [text('Good.'), done()]]),
      jev: jevOf({ contradicted: 0.9, notDone: 0.1, gap: 0.1 }),
      hooks: { onTurnEnd: (id) => ends.push(id), onClaimsRead: (_id, read) => reads.push(read.turn) },
    });
    await h.rt.open(h.entry, { callerNumber: null, provider: 'twilio' }, h.io);
    expect(ends).toEqual(['CA-converse-1']);
    await h.prompt('Are you open Saturday?');
    // The reply is sent, its correction waits for it to play: the turn has not ended yet.
    expect(ends).toHaveLength(1);
    expect(reads).toHaveLength(1);
    await h.settle(3000);
    expect(h.said().at(-1)!.token).toBe(CORRECTION);
    expect(ends).toEqual(['CA-converse-1', 'CA-converse-1']);
    await h.prompt('thanks');
    expect(ends).toHaveLength(3);
  });

  it('a hook that throws is logged, never the call\'s failure', async () => {
    const h = harness({ model: gatedModel([[text('Good.'), done()]]), hooks: { onTurnEnd: () => { throw new Error('boom'); } } });
    await h.rt.open(h.entry, { callerNumber: null, provider: 'twilio' }, h.io);
    await h.prompt('hello');
    expect(h.said().at(-1)!.token).toBe('Good.');
  });

  it('writes how the call ended to the frame log, as a converse chat does: closing, handoff, or the caller hanging up', async () => {
    const closing = harness({ model: gatedModel([[{ type: 'tool_call', id: 'c1', name: 'end_call', args: {} }, done('tool')]]) });
    await closing.rt.open(closing.entry, { callerNumber: null, provider: 'twilio' }, closing.io);
    await closing.prompt('that is all');
    await closing.settle();
    expect(closing.fio.records).toContainEqual({ dir: 'log', msg: { ended: 'closing' } });
    const left = harness({ model: gatedModel([['hang']]) });
    await left.rt.open(left.entry, { callerNumber: null, provider: 'twilio' }, left.io);
    void left.prompt('hello');
    await left.settle();
    await left.rt.hangup(left.entry);
    expect(left.logged).toContainEqual({ dir: 'log', msg: { ended: 'caller' } });
  });
});

describe('the converse voice runtime: final fix wave', () => {
  /** The call up to the booking's read-back, its text returned. */
  async function readBackOf(h: ReturnType<typeof harness>, greetingPlayed = false): Promise<string> {
    await h.rt.open(h.entry, { callerNumber: '+15555550123', provider: h.entry.provider as 'twilio' | 'telnyx' }, h.io);
    if (greetingPlayed) {
      // The carrier reported the greeting played: it reports its playback on this call.
      h.event({ kind: 'playback', state: 'started' });
      h.event({ kind: 'playback', state: 'finished', text: GREETING });
      h.event({ kind: 'playback', state: 'finished' });
    }
    await h.prompt('I need a visit on Tuesday');
    await h.prompt('the morning, for Sam Example');
    const readBack = h.said().at(-1)!.token;
    expect(readBack).toContain('Is that right?');
    return readBack;
  }

  const shallI = (): ModelEvent[][] => [BOOKING[0]!, BOOKING[1]!, BOOKING[2]!, [text('Shall I read it again?'), done()]];

  it('Telnyx: the caller heard speaking before agentSpeaking on, as the read-back is sent, makes a yes confirm nothing', async () => {
    const h = harness({ model: gatedModel(shallI()), provider: 'telnyx' });
    const readBack = await readBackOf(h);
    // clientSpeaking 24 ms after the reply was sent, before agentSpeaking on; then the line reported played in full.
    await h.settle(24);
    h.event({ kind: 'caller', speaking: true });
    h.event({ kind: 'playback', state: 'started' });
    h.event({ kind: 'playback', state: 'finished', text: readBack });
    await h.prompt('yes');
    expect(h.booked).toEqual([]);
    expect(h.rows.filter((r) => r.type === 'confirmed')).toEqual([]);
    expect(h.traces.at(-1)!.heard).toEqual({ cutIn: true, spokeBefore: true, chars: 0 });
    expect(h.said().at(-1)!.token).toBe('Shall I read it again?');
  });

  it('Telnyx: the caller heard speaking after the read-back was sent but before any playback began makes a yes confirm nothing', async () => {
    const h = harness({ model: gatedModel(shallI()), provider: 'telnyx' });
    await readBackOf(h, true);
    await h.settle(300);
    h.event({ kind: 'caller', speaking: true });
    await h.prompt('yes');
    expect(h.booked).toEqual([]);
    expect(h.rows.filter((r) => r.type === 'confirmed')).toEqual([]);
    expect(h.traces.at(-1)!.heard).toMatchObject({ cutIn: true, spokeBefore: true });
  });

  it('Telnyx: a yes after the read-back was reported played through still confirms', async () => {
    const h = harness({ model: gatedModel(BOOKING.slice(0, 4)), provider: 'telnyx' });
    const readBack = await readBackOf(h, true);
    h.event({ kind: 'playback', state: 'started' });
    h.event({ kind: 'playback', state: 'finished', text: readBack });
    h.event({ kind: 'playback', state: 'finished' });
    await h.settle(500);
    h.event({ kind: 'caller', speaking: true });
    await h.prompt('yes');
    expect(h.booked).toHaveLength(1);
    expect(h.traces.at(-1)!.heard).toMatchObject({ cutIn: false, spokeBefore: false });
  });

  it('a line reported played after the turn let go of the call, before its masking was kept, never logs a masked value whole', async () => {
    const h = harness({ model: gatedModel(BOOKING.slice(0, 3)), provider: 'telnyx' });
    await h.rt.open(h.entry, { callerNumber: '+15555550123', provider: 'telnyx' }, h.io);
    await h.prompt('I need a visit on Tuesday');
    // The read-back's frame is held on its way to the carrier: the turn has ended and waits for its frames.
    const held = gate();
    let readBack = '';
    const send = h.io.send.bind(h.io);
    (h.io as { send: VoiceIo['send'] }).send = async (frames, o) => {
      const line = frames.find((f): f is TextFrame => f.type === 'text' && f.token.includes('Is that right?'));
      if (line !== undefined) {
        readBack = line.token;
        await held.gate;
      }
      return send(frames, o);
    };
    const turn = h.prompt('the morning, for Sam Example');
    await h.settle();
    expect(h.traces).toHaveLength(3);
    expect(readBack).toContain('Sam Example');
    const report = { event: 'tokensPlayed', text: readBack };
    const logged = JSON.stringify(h.rt.loggedEvent(h.entry, report, { kind: 'playback', state: 'finished', text: readBack }));
    expect(logged).not.toContain('Sam Example');
    held.open();
    await turn;
  });

  it('"yes" then a second final while the yes is saved books nothing, and one reply answers both', async () => {
    const model = gatedModel([BOOKING[0]!, BOOKING[1]!, BOOKING[2]!, [text('Wednesday then?'), done()]]);
    const h = harness({ model });
    await readBackOf(h);
    const asked = model.requests.length;
    const said = h.said().length;
    const saving = gate();
    const save = h.io.save.bind(h.io);
    (h.io as { save: VoiceIo['save'] }).save = async () => {
      if (h.entry.turnWords === 'yes') await saving.gate;
      return save();
    };
    const yes = h.prompt('yes');
    await h.settle();
    const more = h.prompt('no wait, make it Wednesday');
    await h.settle();
    saving.open();
    await h.settle();
    await Promise.all([yes, more]);
    expect(h.booked).toEqual([]);
    expect(h.rows.filter((r) => r.type === 'confirmed')).toEqual([]);
    expect(model.requests.slice(asked)).toHaveLength(1);
    const last = lastUser(model.requests.at(-1)!);
    expect(last).toContain('The caller went on speaking after their answer, so it is not confirmed. They said: \\"yes\\"');
    expect(last).toContain('no wait, make it Wednesday');
    expect(h.said().slice(said).map((f) => f.token)).toEqual(['Wednesday then?']);
    expect(h.entry.session.failures).toBe(0);
  });

  it('a turn that throws before its reply says the business\'s recovery line, as a final text frame', async () => {
    const h = harness({
      model: gatedModel([[call('c1', 'availability', { day: DAY }), done('tool')]]),
      appending: (d) => {
        if (d.type === 'gate') throw new Error('disk full');
      },
    });
    await h.rt.open(h.entry, { callerNumber: null, provider: 'twilio' }, h.io);
    await h.prompt('hello');
    expect(h.fio.records).toContainEqual({ dir: 'log', msg: { turnFailed: 'Error: disk full' } });
    expect(h.said().at(-1)).toMatchObject({ token: 'Sorry, could you say that again?', last: true });
  });

  it('a thrown turn after its final reply says nothing more', async () => {
    const h = harness({ model: gatedModel([[text('Good.'), done()]]) });
    await h.rt.open(h.entry, { callerNumber: null, provider: 'twilio' }, h.io);
    const before = h.said().length;
    h.entry.trace = { write: () => { throw new Error('disk full'); } } as unknown as ConverseCallEntry['trace'];
    await h.prompt('hello');
    expect(h.fio.records).toContainEqual({ dir: 'log', msg: { turnFailed: 'Error: disk full' } });
    expect(h.said().slice(before).map((f) => [f.token, f.last])).toEqual([['Good.', true]]);
  });

  it('a thrown turn after a confirmed change says the done line', async () => {
    // After the yes, the booking runs; the model's next round calls a lookup, and its gate row fails to be written.
    const model = gatedModel([BOOKING[0]!, BOOKING[1]!, BOOKING[2]!, [call('c3', 'availability', { day: DAY }), done('tool')]]);
    const h = harness({
      model,
      appending: (d, rows) => {
        if (d.type === 'gate' && d.detail.tool === 'availability' && rows.some((r) => r.type === 'confirmed')) throw new Error('disk full');
      },
    });
    await readBackOf(h);
    const before = h.said().length;
    await h.prompt('yes');
    expect(h.booked).toHaveLength(1);
    expect(h.fio.records).toContainEqual({ dir: 'log', msg: { turnFailed: 'Error: disk full' } });
    expect(h.said().slice(before).map((f) => [f.token, f.last])).toEqual([["That's done.", true]]);
  });

  it('a thrown turn after a confirmed change keeps the change: done holds it, nothing waits, and the next yes runs nothing', async () => {
    const model = gatedModel([BOOKING[0]!, BOOKING[1]!, BOOKING[2]!, [call('c3', 'availability', { day: DAY }), done('tool')], [text('Anything else?'), done()]]);
    const h = harness({
      model,
      appending: (d, rows) => {
        if (d.type === 'gate' && d.detail.tool === 'availability' && rows.some((r) => r.type === 'confirmed')) throw new Error('disk full');
      },
    });
    await readBackOf(h);
    await h.prompt('yes');
    expect(h.entry.session.done).toEqual([expect.objectContaining({ action: 'book' })]);
    expect(h.entry.session.pending).toBeNull();
    await h.prompt('yes');
    expect(h.booked).toHaveLength(1);
    expect(h.rows.filter((r) => r.type === 'confirmed').map((r) => r.detail.action)).toEqual(['book']);
    expect(lastUser(model.requests.at(-1)!)).not.toContain('Not done');
    expect(h.said().at(-1)!.token).toBe('Anything else?');
  });

  it('a thrown turn before anything ran keeps the session from before it', async () => {
    const h = harness({
      model: gatedModel([[call('c1', 'availability', { day: DAY }), done('tool')]]),
      appending: (d) => {
        if (d.type === 'gate') throw new Error('disk full');
      },
    });
    await h.rt.open(h.entry, { callerNumber: null, provider: 'twilio' }, h.io);
    const before = structuredClone(h.entry.session);
    await h.prompt('hello');
    expect(h.entry.session).toEqual(before);
  });
});
