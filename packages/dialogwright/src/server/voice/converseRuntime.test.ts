import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditDraft } from '../../audit/types';
import type { AuditSink } from '../../audit/sink';
import type { AnswerMap, JevClient, JevRequest } from '../../jev/types';
import type { InboundFrame, OutboundFrame, TextFrame } from '../../channel/relay/frames';
import type { AgentBusiness } from '../../converse/business/schema';
import type { ConverseModel, ModelEvent, ModelRequest } from '../../converse/model/types';
import { policyOf } from '../../converse/policy';
import { newConverseState } from '../../converse/state';
import { BRIDGE_AFTER_MS, CUT_IN_NOTE, READ_BACK_HEARD_AT, UNHEARD_NOTE, type ConverseDeps } from '../../converse/turn';
import { textEstimateMs } from '../../channel/playbackEstimate';
import type { ConverseTraceRecord } from '../../converse/trace';
import { converseFixture } from '../../testing/converse/app';
import { BOOKING, call, DAY, done, SLOT, text } from '../../testing/converse/chat';
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

function harness(o: { model: ConverseModel; provider?: 'twilio' | 'telnyx'; jev?: JevClient; before?: Record<string, () => Promise<void>>; hooks?: Pick<Parameters<typeof converseVoiceRuntime>[0], 'onTurnEnd' | 'onClaimsRead'>; appending?: (d: AuditDraft, rows: readonly AuditDraft[]) => void; business?: (b: AgentBusiness) => AgentBusiness }) {
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
  // The business a test gives is the app's, so the runtime's own reading of it (the silence wait) is the turn's.
  const served = o.business === undefined ? app : { ...app, business: o.business(app.business) };
  const rt = converseVoiceRuntime({
    apps: new Map([[app.id, served]]),
    converseDeps: (a) => ({
      business: o.business?.(a.business) ?? a.business, model: o.model, jev, policy: policyOf(a.business), audit, tools: withBefore(a.tools, o.before ?? {}), texts: null,
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

describe('the converse voice runtime: a correction read back by its changed values alone', () => {
  it('the short read-back is sent speakable and, heard in full, a yes confirms the change with every value', async () => {
    const SHORT_SAID = 'Got it, on the number you\'re calling from, ending in 0 1 2 3. Is everything else right?';
    const model = gatedModel([
      BOOKING[0]!,
      BOOKING[1]!,
      [call('c2', 'book', { window: SLOT, name: 'Sam Example', phone: '5555550177' }), done('tool')],
      [call('c3', 'book', { window: SLOT, name: 'Sam Example', phone: 'caller' }), done('tool')],
      [text('You are booked for Tuesday morning.'), done()],
    ]);
    const short = (b: AgentBusiness): AgentBusiness => ({
      ...b,
      actions: { ...b.actions, book: { ...b.actions.book!, readBackChange: { en: { say: 'Got it, {changes}. Is everything else right?', and: 'and', params: { name: 'the name {name}', phone: 'on {phone}' } } } } },
    });
    const h = harness({ model, business: short });
    await h.rt.open(h.entry, { callerNumber: '+15555550123', provider: 'twilio' }, h.io);
    await h.prompt('I need a visit on Tuesday');
    await h.prompt('the morning, for Sam Example');
    expect(h.said().at(-1)!.token).toContain('on 555 555 0177. Is that right?');
    await h.prompt('no, call the number I am calling from');
    expect(h.said().at(-1)!.token).toBe(SHORT_SAID);
    expect(h.entry.session.pending).toMatchObject({ text: SHORT_SAID, changes: ['phone'] });
    await h.prompt('yes');
    expect(h.booked).toEqual([expect.objectContaining({ window: SLOT, name: 'Sam Example', phone: '+15555550123' })]);
    expect(h.rows.filter((r) => r.type === 'confirmed').map((r) => r.detail)).toEqual([expect.objectContaining({ action: 'book', short: true, changes: ['phone'] })]);
    expect(h.said().at(-1)!.token).toBe('You are booked for Tuesday morning.');
  });
});

describe('the converse voice runtime: a read-back said again held', () => {
  /** The booking: the read-back cut in on, the model calling the same change again (held), then the reply after the yes. */
  const rounds = (): Step[][] => [BOOKING[0]!, BOOKING[1]!, BOOKING[2]!, [call('c3', 'book', { window: SLOT, name: 'Sam Example', phone: 'caller' }), done('tool')], [text('You are booked for Tuesday morning.'), done()]];
  /** The call up to the held read-back: the first one cut in on at its start, the caller's words over it, the same change called again. */
  async function upToHeld(h: ReturnType<typeof harness>): Promise<TextFrame> {
    const telnyx = h.entry.provider === 'telnyx';
    await h.rt.open(h.entry, { callerNumber: '+15555550123', provider: h.entry.provider as 'twilio' | 'telnyx' }, h.io);
    if (telnyx) {
      h.event({ kind: 'playback', state: 'started' });
      h.event({ kind: 'playback', state: 'finished', text: GREETING });
      h.event({ kind: 'playback', state: 'finished' });
    }
    await h.prompt('I need a visit on Tuesday');
    await h.prompt('the morning, for Sam Example');
    const first = h.said().at(-1)!;
    expect(first).toMatchObject({ interruptible: true });
    if (telnyx) {
      h.event({ kind: 'playback', state: 'started' });
      h.event({ kind: 'caller', speaking: true });
      // Telnyx reports the line it handed its voice, whole, even where the caller cut it.
      h.event({ kind: 'playback', state: 'finished', text: first.token });
    } else await h.frame({ type: 'interrupt', utteranceUntilInterrupt: first.token.slice(0, 12), durationUntilInterruptMs: 600 });
    await h.prompt('wait, what was that?');
    const held = h.said().at(-1)!;
    expect(held.token).toBe(first.token);
    return held;
  }
  /** When the held line counts as played on Twilio, from when it was sent: READ_BACK_HEARD_AT of its estimate. */
  const twilioEndMs = (held: TextFrame): number => Math.ceil(READ_BACK_HEARD_AT * textEstimateMs(held.token));
  const ignoredLogged = (h: ReturnType<typeof harness>): unknown[] => h.fio.records.filter((r) => r.dir === 'log' && typeof (r.msg as { ignoredOverHeld?: unknown }).ignoredOverHeld === 'number').map((r) => r.msg);

  it('the read-back said again goes whole, not interruptible, as the turn\'s final frame', async () => {
    const h = harness({ model: gatedModel(rounds()) });
    const held = await upToHeld(h);
    expect(held).toMatchObject({ last: true, interruptible: false });
    expect(h.entry.session.pending).toMatchObject({ held: true, text: held.token });
    expect(h.traces.at(-1)!.readBack).toMatchObject({ held: true });
  });

  it('Twilio: speech that began while it played is ignored, recorded by its length; speech after it is the caller\'s answer', async () => {
    const model = gatedModel(rounds());
    const h = harness({ model });
    const held = await upToHeld(h);
    const asked = model.requests.length;
    const records = h.traces.length;
    await h.settle(1000);
    await h.prompt('yes', false);
    await h.settle(500);
    await h.prompt('yes yes');
    // Nothing is acted on: no turn, no model asked, the turn running not stopped.
    expect(model.requests).toHaveLength(asked);
    expect(h.traces).toHaveLength(records);
    expect(h.booked).toEqual([]);
    expect(h.entry.session.pending).not.toBeNull();
    expect(ignoredLogged(h)).toEqual([{ ignoredOverHeld: 7 }]);
    // After the line has played: the caller's answer is taken, and the record of its turn holds what was ignored.
    await h.settle(twilioEndMs(held));
    await h.prompt('yes', false);
    await h.prompt('yes');
    expect(h.booked).toHaveLength(1);
    expect(h.rows.filter((r) => r.type === 'confirmed').map((r) => r.detail)).toEqual([expect.objectContaining({ action: 'book', held: true })]);
    expect(h.traces.at(-1)!.ignored).toEqual([7]);
    expect(h.traces.at(-1)!.heard).toMatchObject({ cutIn: false, spokeBefore: false });
    expect(h.said().at(-1)!.token).toBe('You are booked for Tuesday morning.');
  });

  it('Twilio: speech that began near its end, its final words coming after the line has played, is ignored too (by its first partial)', async () => {
    const model = gatedModel(rounds());
    const h = harness({ model });
    const held = await upToHeld(h);
    const asked = model.requests.length;
    await h.settle(twilioEndMs(held) - 200);
    await h.prompt('no', false);
    await h.settle(3000);
    await h.prompt('no wait I meant something else entirely');
    expect(model.requests).toHaveLength(asked);
    expect(ignoredLogged(h)).toHaveLength(1);
  });

  it('Twilio: with no partial, speech is taken to have begun its estimate before its final words came', async () => {
    const model = gatedModel(rounds());
    const h = harness({ model });
    const held = await upToHeld(h);
    const asked = model.requests.length;
    // Eight words, about 3.2 s of speech, ending just after the line has played: begun while it played.
    await h.settle(twilioEndMs(held) + 100);
    await h.prompt('yes that is all right thank you very much');
    expect(model.requests).toHaveLength(asked);
    expect(ignoredLogged(h)).toHaveLength(1);
    // A short one coming well after it: taken.
    await h.settle(2000);
    await h.prompt('yes');
    expect(h.booked).toHaveLength(1);
  });

  it('Twilio: an interrupt over the held line is a cut (fail closed): it stops nothing, its words are ignored, and the yes after it confirms nothing', async () => {
    const model = gatedModel(rounds());
    const h = harness({ model });
    const held = await upToHeld(h);
    const asked = model.requests.length;
    await h.settle(500);
    await h.frame({ type: 'interrupt', utteranceUntilInterrupt: held.token.slice(0, 8), durationUntilInterruptMs: 400 });
    await h.prompt('hm');
    // Nothing ran: the read-back still waits, and the model was not asked.
    expect(model.requests).toHaveLength(asked);
    expect(h.entry.session.pending).toMatchObject({ held: true });
    await h.settle(twilioEndMs(held));
    await h.prompt('yes', false);
    await h.prompt('yes');
    expect(h.booked).toEqual([]);
    expect(h.rows.filter((r) => r.type === 'confirmed')).toEqual([]);
    expect(h.traces.at(-1)!.heard).toMatchObject({ cutIn: true, chars: 8 });
  });

  it('Telnyx: the caller heard speaking over it is no cut-in, and their words are ignored until it is reported played', async () => {
    const model = gatedModel(rounds());
    const h = harness({ model, provider: 'telnyx' });
    const held = await upToHeld(h);
    const asked = model.requests.length;
    h.event({ kind: 'playback', state: 'started' });
    // Near its end (Telnyx reports a line no sooner than half its estimate after it began).
    await h.settle(textEstimateMs(held.token) - 800);
    h.event({ kind: 'caller', speaking: true });
    await h.prompt('yes');
    expect(model.requests).toHaveLength(asked);
    expect(ignoredLogged(h)).toHaveLength(1);
    h.event({ kind: 'playback', state: 'finished', text: held.token });
    h.event({ kind: 'playback', state: 'finished' });
    // New speech 0.4 s after the words ignored, begun after the line's end: the caller's answer.
    await h.settle(400);
    h.event({ kind: 'caller', speaking: true });
    await h.prompt('yes');
    expect(h.booked).toHaveLength(1);
    expect(h.traces.at(-1)!.heard).toMatchObject({ cutIn: false, spokeBefore: false });
    expect(h.traces.at(-1)!.ignored).toEqual([3]);
  });

  it('Telnyx: speech begun while it played whose final words come after it was reported played is ignored', async () => {
    const model = gatedModel(rounds());
    const h = harness({ model, provider: 'telnyx' });
    const held = await upToHeld(h);
    const asked = model.requests.length;
    h.event({ kind: 'playback', state: 'started' });
    await h.settle(800);
    h.event({ kind: 'caller', speaking: true });
    await h.settle(1000);
    h.event({ kind: 'playback', state: 'finished', text: held.token });
    await h.settle(1500);
    await h.prompt('sorry, go on');
    expect(model.requests).toHaveLength(asked);
    expect(ignoredLogged(h)).toHaveLength(1);
  });

  it('with readBacks.holdAfterCut false, the read-back said again can be talked over, as before', async () => {
    const h = harness({ model: gatedModel(rounds()), business: (b) => ({ ...b, readBacks: { holdAfterCut: false } }) });
    const held = await upToHeld(h);
    expect(held).toMatchObject({ interruptible: true });
    await h.settle(500);
    await h.prompt('yes');
    // Taken at once, as any answer is: no speech is ignored, and the yes (with no cut-in reported) confirms.
    expect(ignoredLogged(h)).toEqual([]);
    expect(h.booked).toHaveLength(1);
  });

  it('a hangup after speech over the held line records it on the leaving turn', async () => {
    const h = harness({ model: gatedModel(rounds()) });
    await upToHeld(h);
    await h.settle(500);
    await h.prompt('hello?');
    await h.rt.hangup(h.entry);
    expect(h.traces.at(-1)!.ignored).toEqual([6]);
  });
});

describe('the converse voice runtime: a held read-back and a stale sign of speech', () => {
  /** The booking, the held read-back's round waiting on `wait` where given (so a sign of speech can come before it is sent). */
  const rounds = (wait?: { gate: Promise<void> }): Step[][] => [BOOKING[0]!, BOOKING[1]!, BOOKING[2]!, [...(wait !== undefined ? [wait] : []), call('c3', 'book', { window: SLOT, name: 'Sam Example', phone: 'caller' }), done('tool')], [text('You are booked for Tuesday morning.'), done()]];
  /** The call up to the held read-back's turn begun: the first read-back cut in on, the caller's words over it. */
  async function toHeldTurn(h: ReturnType<typeof harness>): Promise<{ turn: Promise<void> }> {
    const telnyx = h.entry.provider === 'telnyx';
    await h.rt.open(h.entry, { callerNumber: '+15555550123', provider: h.entry.provider as 'twilio' | 'telnyx' }, h.io);
    if (telnyx) {
      h.event({ kind: 'playback', state: 'started' });
      h.event({ kind: 'playback', state: 'finished', text: GREETING });
      h.event({ kind: 'playback', state: 'finished' });
    }
    await h.prompt('I need a visit on Tuesday');
    await h.prompt('the morning, for Sam Example');
    const first = h.said().at(-1)!;
    if (telnyx) {
      h.event({ kind: 'playback', state: 'started' });
      h.event({ kind: 'caller', speaking: true });
    } else await h.frame({ type: 'interrupt', utteranceUntilInterrupt: first.token.slice(0, 12), durationUntilInterruptMs: 600 });
    const turn = h.prompt('wait, what was that?');
    await h.settle();
    // Wrapped: an async function's promise of a promise would wait for the turn itself.
    return { turn };
  }
  /** A sign of speech (a Twilio partial, Telnyx's caller heard speaking, and stopping) that no transcript follows. */
  const noise = async (h: ReturnType<typeof harness>): Promise<void> => {
    if (h.entry.provider === 'telnyx') {
      h.event({ kind: 'caller', speaking: true });
      h.event({ kind: 'caller', speaking: false });
    } else await h.prompt('mm', false);
  };
  /** The caller's yes as each carrier brings it: its sign, then its words. */
  const yes = async (h: ReturnType<typeof harness>): Promise<void> => {
    await noise(h);
    await h.prompt('yes');
  };
  /** Waits until the held line has played: Telnyx reports it, Twilio's estimate passes. */
  const played = async (h: ReturnType<typeof harness>, held: TextFrame, afterMs: number): Promise<void> => {
    if (h.entry.provider === 'telnyx') {
      h.event({ kind: 'playback', state: 'started' });
      await h.settle(textEstimateMs(held.token));
      h.event({ kind: 'playback', state: 'finished', text: held.token });
      h.event({ kind: 'playback', state: 'finished' });
    } else await h.settle(Math.ceil(READ_BACK_HEARD_AT * textEstimateMs(held.token)));
    await h.settle(afterMs);
  };

  for (const provider of ['twilio', 'telnyx'] as const) {
    it(`${provider}: a sign of speech over the held line that no words follow does not drop a short yes begun after it`, async () => {
      const h = harness({ model: gatedModel(rounds()), provider });
      await toHeldTurn(h);
      const held = h.said().at(-1)!;
      expect(held.interruptible).toBe(false);
      await h.settle(1000);
      await noise(h);
      await played(h, held, 1000);
      await yes(h);
      expect(h.booked).toHaveLength(1);
      expect(h.fio.records.filter((r) => r.dir === 'log' && Object.hasOwn(r.msg as object, 'ignoredOverHeld'))).toEqual([]);
    });

    it(`${provider}: speech begun near the held line's end, its words coming after it, is still ignored`, async () => {
      const model = gatedModel(rounds());
      const h = harness({ model, provider });
      await toHeldTurn(h);
      const held = h.said().at(-1)!;
      const asked = model.requests.length;
      if (provider === 'telnyx') {
        h.event({ kind: 'playback', state: 'started' });
        await h.settle(textEstimateMs(held.token) - 300);
        await noise(h);
        await h.settle(300);
        h.event({ kind: 'playback', state: 'finished', text: held.token });
      } else {
        await h.settle(Math.ceil(READ_BACK_HEARD_AT * textEstimateMs(held.token)) - 300);
        await noise(h);
      }
      await h.settle(2500);
      await h.prompt('no wait I meant something else entirely');
      expect(model.requests).toHaveLength(asked);
      expect(h.booked).toEqual([]);
    });

    it(`${provider}: a sign of speech from before the held line was sent is not taken for its words`, async () => {
      const g = gate();
      const h = harness({ model: gatedModel(rounds(g)), provider });
      const { turn } = await toHeldTurn(h);
      // The line no longer playing (Telnyx's report), then a sign of speech while the held read-back is still being made.
      if (provider === 'telnyx') h.event({ kind: 'playback', state: 'finished' });
      await h.settle(200);
      await noise(h);
      await h.settle(200);
      g.open();
      await turn;
      const held = h.said().at(-1)!;
      expect(held.interruptible).toBe(false);
      await played(h, held, 1000);
      await yes(h);
      expect(h.booked).toHaveLength(1);
    });
  }
});

describe('the converse voice runtime: a held read-back, fix round 2', () => {
  /** The booking, the held read-back's round with `before` ahead of its call (text, or a gate to wait on). */
  const rounds = (before: Step[] = []): Step[][] => [BOOKING[0]!, BOOKING[1]!, BOOKING[2]!, [...before, call('c3', 'book', { window: SLOT, name: 'Sam Example', phone: 'caller' }), done('tool')], [text('You are booked for Tuesday morning.'), done()]];
  /** The call up to the held read-back's turn begun: the first read-back cut in on, the caller's words over it. */
  async function toHeldTurn(h: ReturnType<typeof harness>): Promise<{ turn: Promise<void>; first: TextFrame }> {
    const telnyx = h.entry.provider === 'telnyx';
    await h.rt.open(h.entry, { callerNumber: '+15555550123', provider: h.entry.provider as 'twilio' | 'telnyx' }, h.io);
    if (telnyx) {
      h.event({ kind: 'playback', state: 'started' });
      h.event({ kind: 'playback', state: 'finished', text: GREETING });
      h.event({ kind: 'playback', state: 'finished' });
    }
    await h.prompt('I need a visit on Tuesday');
    await h.prompt('the morning, for Sam Example');
    const first = h.said().at(-1)!;
    if (telnyx) {
      h.event({ kind: 'playback', state: 'started' });
      h.event({ kind: 'caller', speaking: true });
      h.event({ kind: 'caller', speaking: false });
      h.event({ kind: 'playback', state: 'finished' });
    } else await h.frame({ type: 'interrupt', utteranceUntilInterrupt: first.token.slice(0, 12), durationUntilInterruptMs: 600 });
    const turn = h.prompt('wait, what was that?');
    await h.settle();
    return { turn, first };
  }
  /** A sign of speech: a Twilio partial, Telnyx's caller heard speaking (on, and off where `off` is given after `offMs`). */
  const sign = async (h: ReturnType<typeof harness>, offMs?: number): Promise<void> => {
    if (h.entry.provider === 'telnyx') {
      h.event({ kind: 'caller', speaking: true });
      if (offMs !== undefined) {
        await h.settle(offMs);
        h.event({ kind: 'caller', speaking: false });
      }
    } else await h.prompt('mm', false);
  };
  /** The held line's end as the line counts it, from now: Telnyx's report (sent here), Twilio's 85% of its estimate. */
  const toEnd = async (h: ReturnType<typeof harness>, held: TextFrame, beforeMs = 0): Promise<void> => {
    const end = h.entry.provider === 'telnyx' ? textEstimateMs(held.token) : Math.ceil(READ_BACK_HEARD_AT * textEstimateMs(held.token));
    if (h.entry.provider === 'telnyx') h.event({ kind: 'playback', state: 'started' });
    await h.settle(end - beforeMs);
  };
  const reported = (h: ReturnType<typeof harness>, held: TextFrame): void => {
    if (h.entry.provider !== 'telnyx') return;
    h.event({ kind: 'playback', state: 'finished', text: held.token });
    h.event({ kind: 'playback', state: 'finished' });
  };
  const ignoredCount = (h: ReturnType<typeof harness>): number => h.fio.records.filter((r) => r.dir === 'log' && Object.hasOwn(r.msg as object, 'ignoredOverHeld')).length;

  for (const provider of ['twilio', 'telnyx'] as const) {
    it(`${provider}: the model's words before a held read-back go interruptible, and a cut over them, before the held line begins, makes the read-back unheard`, async () => {
      const h = harness({ model: gatedModel(rounds([text('Sure, let me read that again.')])), provider });
      await toHeldTurn(h);
      const [words, held] = h.said().slice(-2);
      expect([words!.token.trim(), words!.interruptible]).toEqual(['Sure, let me read that again.', true]);
      expect(held!.interruptible).toBe(false);
      // The caller cuts in on the words, before the held line has begun to play.
      if (provider === 'telnyx') {
        h.event({ kind: 'playback', state: 'started' });
        await h.settle(300);
        h.event({ kind: 'caller', speaking: true });
        await h.frame({ type: 'interrupt', utteranceUntilInterrupt: 'Sure, let', durationUntilInterruptMs: 300 });
        h.event({ kind: 'caller', speaking: false });
      } else {
        await h.settle(300);
        await h.frame({ type: 'interrupt', utteranceUntilInterrupt: 'Sure, let', durationUntilInterruptMs: 300 });
      }
      // Once the held line has played (or its hold has ended), a yes confirms nothing.
      await h.settle(Math.ceil(textEstimateMs(held!.token) * 1.5) + 2500);
      if (provider === 'telnyx') h.event({ kind: 'caller', speaking: true });
      else await h.prompt('yes', false);
      await h.prompt('yes');
      expect(h.booked).toEqual([]);
      expect(h.rows.filter((r) => r.type === 'confirmed')).toEqual([]);
      expect(h.traces.at(-1)!.heard).toMatchObject({ cutIn: true });
    });
  }

  it('Twilio: the held line\'s end counts from the bridge said before it', async () => {
    const g = gate();
    const model = gatedModel(rounds([g]));
    const h = harness({ model });
    const { turn } = await toHeldTurn(h);
    await h.settle(BRIDGE_AFTER_MS + 10);
    expect(h.said().at(-1)).toMatchObject({ token: 'One sec.', interruptible: false });
    g.open();
    await turn;
    const held = h.said().at(-1)!;
    const asked = model.requests.length;
    // Past the read-back's own 85% from when it was sent, but not from when it begins, once the bridge has played.
    await h.settle(Math.ceil(READ_BACK_HEARD_AT * textEstimateMs(held.token)) + 200);
    await h.prompt('yes', false);
    await h.prompt('yes');
    expect(model.requests).toHaveLength(asked);
    expect(ignoredCount(h)).toBe(1);
  });

  it('Telnyx: an interrupt over the held line with the caller heard speaking is a cut, and the yes after it confirms nothing', async () => {
    const h = harness({ model: gatedModel(rounds()), provider: 'telnyx' });
    await toHeldTurn(h);
    const held = h.said().at(-1)!;
    h.event({ kind: 'playback', state: 'started' });
    await h.settle(800);
    h.event({ kind: 'caller', speaking: true });
    await h.frame({ type: 'interrupt', utteranceUntilInterrupt: held.token.slice(0, 10), durationUntilInterruptMs: 800 });
    await h.prompt('hm');
    expect(h.entry.session.pending).toMatchObject({ held: true });
    await h.settle(textEstimateMs(held.token));
    reported(h, held);
    await h.settle(500);
    await sign(h);
    await h.prompt('yes');
    expect(h.booked).toEqual([]);
    expect(h.traces.at(-1)!.heard).toMatchObject({ cutIn: true });
  });

  it('Telnyx: an interrupt over the held line with no caller heard speaking is no cut', async () => {
    const h = harness({ model: gatedModel(rounds()), provider: 'telnyx' });
    await toHeldTurn(h);
    const held = h.said().at(-1)!;
    h.event({ kind: 'playback', state: 'started' });
    await h.settle(800);
    await h.frame({ type: 'interrupt', utteranceUntilInterrupt: held.token.slice(0, 10), durationUntilInterruptMs: 800 });
    await h.settle(textEstimateMs(held.token));
    reported(h, held);
    await h.settle(500);
    await sign(h);
    await h.prompt('yes');
    expect(h.booked).toHaveLength(1);
  });

  it('Telnyx: a late report of the first read-back, the same words, does not end the hold', async () => {
    const model = gatedModel(rounds());
    const h = harness({ model, provider: 'telnyx' });
    const { first } = await toHeldTurn(h);
    const held = h.said().at(-1)!;
    expect(held.token).toBe(first.token);
    h.event({ kind: 'playback', state: 'started' });
    await h.settle(400);
    // The first read-back's whole line, reported late.
    h.event({ kind: 'playback', state: 'finished', text: first.token });
    await h.settle(400);
    const asked = model.requests.length;
    await sign(h);
    await h.prompt('yes');
    expect(model.requests).toHaveLength(asked);
    expect(ignoredCount(h)).toBe(1);
  });

  for (const provider of ['twilio', 'telnyx'] as const) {
    it(`${provider}: a cough a second before the end, no words after it, does not drop a yes begun half a second after the end`, async () => {
      const h = harness({ model: gatedModel(rounds()), provider });
      await toHeldTurn(h);
      const held = h.said().at(-1)!;
      await toEnd(h, held, 1000);
      await sign(h, 200);
      await h.settle(1000);
      reported(h, held);
      await h.settle(500);
      await sign(h);
      await h.prompt('yes');
      expect(h.booked).toHaveLength(1);
      expect(ignoredCount(h)).toBe(0);
    });

    it(`${provider}: an empty final resets the signs, as words do`, async () => {
      const h = harness({ model: gatedModel(rounds()), provider });
      await toHeldTurn(h);
      const held = h.said().at(-1)!;
      await toEnd(h, held, 500);
      await sign(h);
      await h.settle(200);
      await h.prompt('  ');
      await h.settle(300);
      reported(h, held);
      await h.settle(200);
      await sign(h);
      await h.prompt('yes');
      expect(h.booked).toHaveLength(1);
    });

    it(`${provider}: a long utterance split into two finals across the line's end: both ignored`, async () => {
      const model = gatedModel(rounds());
      const h = harness({ model, provider });
      await toHeldTurn(h);
      const held = h.said().at(-1)!;
      const asked = model.requests.length;
      await toEnd(h, held, 1500);
      await sign(h);
      for (let i = 0; i < 3 && provider === 'twilio'; i++) {
        await h.settle(400);
        await sign(h);
      }
      await h.settle(provider === 'twilio' ? 300 : 1500);
      reported(h, held);
      await h.settle(200);
      await h.prompt('no wait I want');
      await h.settle(300);
      if (provider === 'twilio') await sign(h);
      await h.settle(900);
      await h.prompt('the afternoon instead');
      expect(model.requests).toHaveLength(asked);
      expect(ignoredCount(h)).toBe(2);
      expect(h.booked).toEqual([]);
    });

    it(`${provider}: a caller speaking from before the held line into it: their yes confirms nothing`, async () => {
      const g = gate();
      const h = harness({ model: gatedModel(rounds([g])), provider });
      const { turn } = await toHeldTurn(h);
      await h.settle(200);
      await sign(h);
      await h.settle(200);
      g.open();
      await turn;
      const held = h.said().at(-1)!;
      expect(held.interruptible).toBe(false);
      if (provider === 'telnyx') h.event({ kind: 'playback', state: 'started' });
      // Speaking all along: Twilio's partials keep coming, Telnyx reports no end of it.
      const end = provider === 'telnyx' ? textEstimateMs(held.token) : Math.ceil(READ_BACK_HEARD_AT * textEstimateMs(held.token));
      for (let at = 0; at < end + 300; at += 500) {
        await h.settle(500);
        if (provider === 'twilio') await sign(h);
      }
      reported(h, held);
      // Still speaking past the end (Telnyx: no new sign, the one run goes on), the words' final coming well after it.
      await h.settle(500);
      if (provider === 'twilio') await sign(h);
      await h.settle(300);
      await h.prompt('yes');
      expect(h.booked).toEqual([]);
    });
  }
});

describe('the converse voice runtime: a held read-back, fix round 3', () => {
  const rounds = (before: Step[] = []): Step[][] => [BOOKING[0]!, BOOKING[1]!, BOOKING[2]!, [...before, call('c3', 'book', { window: SLOT, name: 'Sam Example', phone: 'caller' }), done('tool')], [text('You are booked for Tuesday morning.'), done()]];
  async function toHeld(h: ReturnType<typeof harness>): Promise<TextFrame> {
    const telnyx = h.entry.provider === 'telnyx';
    await h.rt.open(h.entry, { callerNumber: '+15555550123', provider: h.entry.provider as 'twilio' | 'telnyx' }, h.io);
    if (telnyx) {
      h.event({ kind: 'playback', state: 'started' });
      h.event({ kind: 'playback', state: 'finished', text: GREETING });
      h.event({ kind: 'playback', state: 'finished' });
    }
    await h.prompt('I need a visit on Tuesday');
    await h.prompt('the morning, for Sam Example');
    const first = h.said().at(-1)!;
    if (telnyx) {
      h.event({ kind: 'playback', state: 'started' });
      h.event({ kind: 'caller', speaking: true });
      h.event({ kind: 'caller', speaking: false });
      h.event({ kind: 'playback', state: 'finished', text: first.token });
      h.event({ kind: 'playback', state: 'finished' });
    } else await h.frame({ type: 'interrupt', utteranceUntilInterrupt: first.token.slice(0, 12), durationUntilInterruptMs: 600 });
    await h.prompt('wait, what was that?');
    return h.said().at(-1)!;
  }
  const ignoredCount = (h: ReturnType<typeof harness>): number => h.fio.records.filter((r) => r.dir === 'log' && Object.hasOwn(r.msg as object, 'ignoredOverHeld')).length;
  const endOf = (h: ReturnType<typeof harness>, held: TextFrame): number => (h.entry.provider === 'telnyx' ? textEstimateMs(held.token) : Math.ceil(READ_BACK_HEARD_AT * textEstimateMs(held.token)));

  for (const provider of ['twilio', 'telnyx'] as const) {
    it(`${provider}: a yes over the line's last part, then a second yes with its own sign after the end: the second is taken`, async () => {
      const h = harness({ model: gatedModel(rounds()), provider });
      const held = await toHeld(h);
      if (provider === 'telnyx') h.event({ kind: 'playback', state: 'started' });
      await h.settle(endOf(h, held) - 1200);
      if (provider === 'telnyx') h.event({ kind: 'caller', speaking: true });
      else await h.prompt('yes', false);
      await h.settle(200);
      if (provider === 'telnyx') h.event({ kind: 'caller', speaking: false });
      // Its words come late, 0.3 s before the line's end.
      await h.settle(700);
      await h.prompt('yes');
      expect(ignoredCount(h)).toBe(1);
      await h.settle(300);
      if (provider === 'telnyx') {
        h.event({ kind: 'playback', state: 'finished', text: held.token });
        h.event({ kind: 'playback', state: 'finished' });
      }
      await h.settle(100);
      if (provider === 'telnyx') h.event({ kind: 'caller', speaking: true });
      else await h.prompt('yes', false);
      await h.prompt('yes');
      expect(h.booked).toHaveLength(1);
      expect(ignoredCount(h)).toBe(1);
    });
  }

  it('Telnyx: an early report of the held line\'s whole words does not end the hold', async () => {
    const model = gatedModel(rounds());
    const h = harness({ model, provider: 'telnyx' });
    const held = await toHeld(h);
    h.event({ kind: 'playback', state: 'started' });
    await h.settle(400);
    h.event({ kind: 'playback', state: 'finished', text: held.token });
    await h.settle(400);
    const asked = model.requests.length;
    h.event({ kind: 'caller', speaking: true });
    await h.prompt('yes');
    expect(model.requests).toHaveLength(asked);
    expect(ignoredCount(h)).toBe(1);
  });

  it('Telnyx: a report of the held reply\'s lines joined ends the hold', async () => {
    const h = harness({ model: gatedModel(rounds([text('Sure, let me read that again.')])), provider: 'telnyx' });
    const held = await toHeld(h);
    const before = h.said().at(-2)!;
    expect(before.interruptible).toBe(true);
    h.event({ kind: 'playback', state: 'started' });
    await h.settle(textEstimateMs(held.token));
    h.event({ kind: 'playback', state: 'finished', text: `${before.token}${held.token}` });
    await h.settle(300);
    h.event({ kind: 'caller', speaking: true });
    await h.prompt('yes');
    expect(h.booked).toHaveLength(1);
  });

  it('Telnyx: agentSpeaking off after the held line began ends the hold, where no report of it came', async () => {
    const h = harness({ model: gatedModel(rounds()), provider: 'telnyx' });
    const held = await toHeld(h);
    h.event({ kind: 'playback', state: 'started' });
    await h.settle(textEstimateMs(held.token));
    h.event({ kind: 'playback', state: 'finished' });
    await h.settle(300);
    h.event({ kind: 'caller', speaking: true });
    await h.prompt('yes');
    expect(h.traces.at(-1)!.heard).toMatchObject({ cutIn: false });
    expect(h.booked).toHaveLength(1);
  });

  it('Telnyx: with no report, the hold ends at one and a half times its estimate and two seconds', async () => {
    const model = gatedModel(rounds());
    const h = harness({ model, provider: 'telnyx' });
    const held = await toHeld(h);
    await h.settle(Math.ceil(textEstimateMs(held.token) * 1.5) + 2100);
    const asked = model.requests.length;
    h.event({ kind: 'caller', speaking: true });
    await h.prompt('yes');
    // Taken, not ignored: a turn ran on it (with no report that the line began, it confirms nothing: Telnyx fails closed).
    expect(ignoredCount(h)).toBe(0);
    expect(model.requests.length).toBeGreaterThan(asked);
  });

  it('an empty final lets go of the signs before it: a yes after the read-back, with a stray sign before it was sent, is heard', async () => {
    const g = gate();
    const h = harness({ model: gatedModel([BOOKING[0]!, BOOKING[1]!, [g, ...BOOKING[2]!], BOOKING[3]!]), business: (b) => ({ ...b, readBacks: { holdAfterCut: false } }) });
    await h.rt.open(h.entry, { callerNumber: '+15555550123', provider: 'twilio' }, h.io);
    await h.prompt('I need a visit on Tuesday');
    const turn = h.prompt('the morning, for Sam Example');
    await h.settle(100);
    // A sign of speech while the read-back is made, the recognizer finding no words in it.
    await h.prompt('um', false);
    await h.prompt(' ');
    await h.settle(200);
    g.open();
    await turn;
    const readBack = h.said().at(-1)!.token;
    expect(readBack).toContain('Is that right?');
    // The yes once the read-back has played, well within the silence wait.
    await h.settle(textEstimateMs(readBack) + 1000);
    await h.prompt('yes');
    expect(h.traces.at(-1)!.heard).toMatchObject({ cutIn: false, spokeBefore: false });
    expect(h.booked).toHaveLength(1);
  });
});

describe('the converse voice runtime: silence', () => {
  const SILENCE = 'Are you still there? We can carry on whenever you are ready.';
  const SILENCE_END = 'I will let you go for now. Call back any time.';
  const withLines = (b: AgentBusiness): AgentBusiness => ({ ...b, lines: { ...b.lines, silence: { en: SILENCE }, silenceEnd: { en: SILENCE_END } } });
  const NOTE = '[The caller has said nothing for 9 seconds since your last reply.';
  const silenceTurns = (h: ReturnType<typeof harness>): ConverseTraceRecord[] => h.traces.filter((r) => r.silence !== undefined);
  /** The greeting played: on Telnyx its report, on Twilio its estimate. */
  async function greeted(h: ReturnType<typeof harness>, provider: 'twilio' | 'telnyx'): Promise<void> {
    await h.rt.open(h.entry, { callerNumber: '+15555550123', provider }, h.io);
    if (provider === 'telnyx') {
      // Reported once it has played (a report sooner than half its estimate is not taken for its end).
      h.event({ kind: 'playback', state: 'started' });
      await h.settle(textEstimateMs(GREETING));
      h.event({ kind: 'playback', state: 'finished', text: GREETING });
      h.event({ kind: 'playback', state: 'finished' });
    } else await h.settle(textEstimateMs(GREETING));
  }

  for (const provider of ['twilio', 'telnyx'] as const) {
    it(`${provider}: nine seconds of silence after the line's reply has played: a turn on the silence, the model told of it`, async () => {
      const model = gatedModel([[text('Take your time.'), done()]]);
      const h = harness({ model, provider, business: withLines });
      await greeted(h, provider);
      await h.settle(8900);
      expect(model.requests).toHaveLength(0);
      await h.settle(200);
      expect(model.requests).toHaveLength(1);
      expect(JSON.stringify(model.requests[0]!.messages.at(-1))).toContain(NOTE);
      expect(silenceTurns(h).map((r) => [r.silence, r.said])).toEqual([[1, null]]);
      expect(h.said().at(-1)!.token).toBe('Take your time.');
    });

    it(`${provider}: speech just before the nine seconds: no silence turn`, async () => {
      const model = gatedModel([[text('Sure, what day?'), done()], [text('Unused.'), done()]]);
      const h = harness({ model, provider, business: withLines });
      await greeted(h, provider);
      await h.settle(8800);
      if (provider === 'telnyx') h.event({ kind: 'caller', speaking: true });
      else await h.prompt('I', false);
      await h.settle(300);
      if (provider === 'telnyx') h.event({ kind: 'caller', speaking: false });
      await h.prompt('I need a visit');
      expect(silenceTurns(h)).toEqual([]);
      expect(model.requests).toHaveLength(1);
    });

    it(`${provider}: a sign of speech with no words resets the wait`, async () => {
      const model = gatedModel([[text('Take your time.'), done()]]);
      const h = harness({ model, provider, business: withLines });
      await greeted(h, provider);
      await h.settle(8000);
      if (provider === 'telnyx') {
        h.event({ kind: 'caller', speaking: true });
        h.event({ kind: 'caller', speaking: false });
      } else await h.prompt('mm', false);
      await h.settle(8900);
      expect(model.requests).toHaveLength(0);
      await h.settle(200);
      expect(model.requests).toHaveLength(1);
    });

    it(`${provider}: two silences: the model answers the first, the silence end line ends the call on the second`, async () => {
      const model = gatedModel([[text('Take your time.'), done()]]);
      const h = harness({ model, provider, business: withLines });
      await greeted(h, provider);
      await h.settle(9100);
      const reprompt = h.said().at(-1)!;
      expect(reprompt.token).toBe('Take your time.');
      if (provider === 'telnyx') {
        h.event({ kind: 'playback', state: 'started' });
        await h.settle(textEstimateMs(reprompt.token));
        h.event({ kind: 'playback', state: 'finished', text: reprompt.token });
        h.event({ kind: 'playback', state: 'finished' });
      } else await h.settle(textEstimateMs(reprompt.token));
      await h.settle(9100);
      expect(model.requests).toHaveLength(1);
      expect(h.fio.sent.filter((f) => f.type === 'text').at(-1)).toMatchObject({ token: SILENCE_END });
      expect(h.fio.sent.at(-1)!.type).toBe('end');
      expect(h.entry.session.ended).toBe('closing');
      expect(h.rows.filter((r) => r.type === 'call_ended').map((r) => r.detail)).toEqual([{ reason: 'silence' }]);
      expect(h.fio.records).toContainEqual({ dir: 'log', msg: { ended: 'silence' } });
      expect(silenceTurns(h).map((r) => [r.silence, r.ended])).toEqual([[1, undefined], [2, 'silence']]);
      // Nothing more: the call is over.
      await h.settle(60_000);
      expect(model.requests).toHaveLength(1);
    });
  }

  it('a turn still running past nine seconds (a lookup that waits): no silence turn while it runs', async () => {
    const model = gatedModel([BOOKING[0]!, [text('Unused.'), done()]]);
    const h = harness({ model, business: withLines, before: { availability: () => new Promise<void>(() => {}) } });
    await greeted(h, 'twilio');
    void h.prompt('I need a visit on Tuesday');
    await h.settle(30_000);
    expect(model.requests).toHaveLength(1);
    expect(silenceTurns(h)).toEqual([]);
  });

  it('silence: off: nothing, however long the caller says nothing', async () => {
    const model = gatedModel([[text('Unused.'), done()]]);
    const h = harness({ model, business: (b) => ({ ...withLines(b), silence: 'off' }) });
    await greeted(h, 'twilio');
    await h.settle(120_000);
    expect(model.requests).toHaveLength(0);
    expect(h.said()).toHaveLength(1);
  });

  it('a model that fails on a silence turn: the app\'s silence line', async () => {
    const model = gatedModel([[{ type: 'error', kind: 'http', detail: 'down' }], [{ type: 'error', kind: 'http', detail: 'down' }]]);
    const h = harness({ model, business: withLines });
    await greeted(h, 'twilio');
    await h.settle(9100);
    expect(h.said().at(-1)).toMatchObject({ token: SILENCE, last: true });
  });

  it('with no silence end line, the closing line ends the call', async () => {
    const model = gatedModel([[text('Take your time.'), done()]]);
    const h = harness({ model });
    await greeted(h, 'twilio');
    await h.settle(9100);
    await h.settle(textEstimateMs('Take your time.') + 9100);
    expect(h.fio.sent.filter((f) => f.type === 'text').at(-1)).toMatchObject({ token: 'Thanks for getting in touch. Goodbye.' });
    expect(h.fio.sent.at(-1)!.type).toBe('end');
  });

  it('a held read-back\'s wait starts at its end', async () => {
    const model = gatedModel([BOOKING[0]!, BOOKING[1]!, BOOKING[2]!, [call('c3', 'book', { window: SLOT, name: 'Sam Example', phone: 'caller' }), done('tool')], [text('Take your time.'), done()]]);
    const h = harness({ model, business: withLines });
    await h.rt.open(h.entry, { callerNumber: '+15555550123', provider: 'twilio' }, h.io);
    await h.prompt('I need a visit on Tuesday');
    await h.prompt('the morning, for Sam Example');
    const first = h.said().at(-1)!;
    await h.frame({ type: 'interrupt', utteranceUntilInterrupt: first.token.slice(0, 12), durationUntilInterruptMs: 600 });
    await h.prompt('wait, what was that?');
    const held = h.said().at(-1)!;
    expect(held.interruptible).toBe(false);
    const asked = model.requests.length;
    // On Twilio at 100% of its estimate (the 85% is for speech over it alone).
    const end = textEstimateMs(held.token);
    await h.settle(end + 8800);
    expect(model.requests).toHaveLength(asked);
    await h.settle(400);
    expect(model.requests).toHaveLength(asked + 1);
    // The line answered the silence: the held read-back no longer waits, and nothing was done.
    expect(h.entry.session.pending).toBeNull();
    expect(h.booked).toEqual([]);
  });

  it('an end held for its playback: no silence turn after it', async () => {
    const model = gatedModel([[text('Goodbye then.'), call('c1', 'end_call', {}), done('tool')], [text('Unused.'), done()]]);
    const h = harness({ model, business: withLines });
    await greeted(h, 'twilio');
    await h.prompt('that is all, thanks');
    await h.settle(60_000);
    expect(model.requests).toHaveLength(1);
    expect(silenceTurns(h)).toEqual([]);
  });
});

describe('the converse voice runtime: silence, fix round 2', () => {
  const SILENCE_END = 'I will let you go for now. Call back any time.';
  const withLines = (b: AgentBusiness): AgentBusiness => ({ ...b, lines: { ...b.lines, silence: { en: 'Still there?' }, silenceEnd: { en: SILENCE_END } } });
  const silenceTurns = (h: ReturnType<typeof harness>): ConverseTraceRecord[] => h.traces.filter((r) => r.silence !== undefined);
  /** The call up to the booking's read-back, played: on Telnyx reported, on Twilio by its estimate. */
  async function readBackPlayed(h: ReturnType<typeof harness>, provider: 'twilio' | 'telnyx'): Promise<string> {
    await h.rt.open(h.entry, { callerNumber: '+15555550123', provider }, h.io);
    await h.prompt('I need a visit on Tuesday');
    await h.prompt('the morning, for Sam Example');
    const readBack = h.said().at(-1)!.token;
    expect(readBack).toContain('Is that right?');
    if (provider === 'telnyx') {
      h.event({ kind: 'playback', state: 'started' });
      await h.settle(textEstimateMs(readBack));
      h.event({ kind: 'playback', state: 'finished', text: readBack });
      h.event({ kind: 'playback', state: 'finished' });
    } else await h.settle(textEstimateMs(readBack));
    return readBack;
  }
  const sign = async (h: ReturnType<typeof harness>, provider: 'twilio' | 'telnyx'): Promise<void> => {
    if (provider === 'telnyx') h.event({ kind: 'caller', speaking: true });
    else await h.prompt('yes', false);
  };

  for (const provider of ['twilio', 'telnyx'] as const) {
    it(`${provider}: the caller beginning to speak as the silence turn starts stops it: nothing said, nothing counted, and their yes confirms`, async () => {
      const g = gate();
      const model = gatedModel([BOOKING[0]!, BOOKING[1]!, BOOKING[2]!, [g, text('Take your time.'), done()], BOOKING[3]!]);
      const h = harness({ model, provider, business: withLines });
      await readBackPlayed(h, provider);
      const sent = h.said().length;
      await h.settle(9000);
      expect(model.requests).toHaveLength(4);
      await h.settle(200);
      await sign(h, provider);
      if (provider === 'telnyx') h.event({ kind: 'caller', speaking: false });
      await h.prompt('yes');
      g.open();
      await h.settle(10);
      expect(h.said().slice(sent).map((f) => f.token)).toEqual(['You are booked for Tuesday morning.']);
      expect(h.booked).toHaveLength(1);
      // The silence turn stopped unsaid left no record.
      expect(silenceTurns(h)).toEqual([]);
      // Nothing counted: the next silence is answered, not the end.
      expect(h.entry.session.ended).toBeUndefined();
    });

    it(`${provider}: a yes after the line's answer to a silence has played runs nothing: the read-back no longer waited`, async () => {
      const model = gatedModel([BOOKING[0]!, BOOKING[1]!, BOOKING[2]!, [text('Take your time.'), done()], BOOKING[3]!]);
      const h = harness({ model, provider, business: withLines });
      await readBackPlayed(h, provider);
      await h.settle(9100);
      const reprompt = h.said().at(-1)!.token;
      expect(reprompt).toBe('Take your time.');
      if (provider === 'telnyx') {
        h.event({ kind: 'playback', state: 'started' });
        await h.settle(textEstimateMs(reprompt));
        h.event({ kind: 'playback', state: 'finished', text: reprompt });
        h.event({ kind: 'playback', state: 'finished' });
      } else await h.settle(textEstimateMs(reprompt));
      await sign(h, provider);
      await h.prompt('yes');
      expect(h.booked).toEqual([]);
      expect(h.entry.session.refusals).toEqual({});
    });
  }

  it('a final arriving while the silence end is recorded: the goodbye is said and the call ends', async () => {
    let h!: ReturnType<typeof harness>;
    let delivered = false;
    const model = gatedModel([[text('Take your time.'), done()]]);
    h = harness({ model, business: withLines, appending: (d) => {
      if (d.type === 'converse_end' && !delivered) {
        delivered = true;
        void h.prompt('hello? are you there?');
      }
    } });
    await h.rt.open(h.entry, { callerNumber: '+15555550123', provider: 'twilio' }, h.io);
    await h.settle(textEstimateMs(GREETING) + 9100);
    await h.settle(textEstimateMs('Take your time.') + 9100);
    expect(delivered).toBe(true);
    expect(h.fio.sent.filter((f) => f.type === 'text').at(-1)).toMatchObject({ token: SILENCE_END });
    expect(h.fio.sent.at(-1)!.type).toBe('end');
    expect(model.requests).toHaveLength(1);
  });

  it('a final before the silence end is said: the call does not end, the caller\'s turn is taken, and the count starts again', async () => {
    const model = gatedModel([[text('Take your time.'), done()], [text('Sure, what day?'), done()], [text('Still there?'), done()]]);
    const h = harness({ model, business: withLines });
    await h.rt.open(h.entry, { callerNumber: '+15555550123', provider: 'twilio' }, h.io);
    await h.settle(textEstimateMs(GREETING) + 9100);
    // The second silence's turn is queued behind work still in the call's queue: the caller speaks before its goodbye is sent.
    // (The re-prompt was sent 100 ms before this; its wait ends 9 s after its estimate.)
    await h.settle(textEstimateMs('Take your time.') + 8890);
    let release!: () => void;
    const blocker = new Promise<void>((r) => (release = r));
    h.entry.tail = h.entry.tail.then(() => blocker);
    await h.settle(20);
    const answered = h.prompt('I need a visit');
    release();
    await answered;
    await h.settle(100);
    expect(h.fio.sent.some((f) => f.type === 'end')).toBe(false);
    expect(h.said().map((f) => f.token)).not.toContain(SILENCE_END);
    expect(h.said().at(-1)!.token).toBe('Sure, what day?');
    // The count starts again: the next silence is answered by the model, not the end.
    await h.settle(textEstimateMs('Sure, what day?') + 9100);
    expect(h.said().at(-1)!.token).toBe('Still there?');
    expect(h.fio.sent.some((f) => f.type === 'end')).toBe(false);
  });

  it('Telnyx: a whole reply reported at once, long before it can have played, starts no wait: none before its estimate and nine seconds', async () => {
    const LONG = 'We have the morning window and the afternoon window on Tuesday, and either one can take a visit to look at a single item in your home, so tell me which you would like and the name to book it under.';
    const model = gatedModel([[text(LONG), done()], [text('Take your time.'), done()]]);
    const h = harness({ model, provider: 'telnyx', business: withLines });
    await h.rt.open(h.entry, { callerNumber: '+15555550123', provider: 'telnyx' }, h.io);
    await h.prompt('I need a visit on Tuesday');
    const reply = h.said().at(-1)!.token;
    expect(textEstimateMs(reply)).toBeGreaterThan(12_000);
    h.event({ kind: 'playback', state: 'started' });
    h.event({ kind: 'playback', state: 'finished', text: reply });
    await h.settle(textEstimateMs(reply) + 8900);
    expect(model.requests).toHaveLength(1);
    // The voice stopping, at its real end: the wait from then.
    h.event({ kind: 'playback', state: 'finished' });
    await h.settle(9100);
    expect(model.requests).toHaveLength(2);
  });

  it('Telnyx: the caller heard speaking with no end reported holds off the wait for twenty seconds, no more', async () => {
    const model = gatedModel([[text('Take your time.'), done()]]);
    const h = harness({ model, provider: 'telnyx', business: withLines });
    await h.rt.open(h.entry, { callerNumber: '+15555550123', provider: 'telnyx' }, h.io);
    h.event({ kind: 'playback', state: 'started' });
    await h.settle(1000);
    h.event({ kind: 'playback', state: 'finished', text: GREETING });
    h.event({ kind: 'playback', state: 'finished' });
    h.event({ kind: 'caller', speaking: true });
    await h.settle(20_000 + 8900);
    expect(model.requests).toHaveLength(0);
    await h.settle(300);
    expect(model.requests).toHaveLength(1);
  });

  it('after a reconnect, the wait starts from the resume', async () => {
    const model = gatedModel([[text('Take your time.'), done()]]);
    const h = harness({ model, business: withLines });
    await h.rt.open(h.entry, { callerNumber: '+15555550123', provider: 'twilio' }, h.io);
    await h.settle(2000);
    h.rt.closed(h.entry);
    await h.settle(30_000);
    expect(model.requests).toHaveLength(0);
    await h.rt.resumed(h.entry, h.io);
    await h.settle(8900);
    expect(model.requests).toHaveLength(0);
    await h.settle(300);
    expect(model.requests).toHaveLength(1);
  });

  it('a silence turn whose model is slow says no bridge', async () => {
    const g = gate();
    const model = gatedModel([[g, text('Take your time.'), done()]]);
    const h = harness({ model, business: withLines });
    await h.rt.open(h.entry, { callerNumber: '+15555550123', provider: 'twilio' }, h.io);
    await h.settle(textEstimateMs(GREETING) + 9100);
    await h.settle(BRIDGE_AFTER_MS + 100);
    expect(h.said().map((f) => f.token)).not.toContain('One sec.');
    g.open();
  });

  it('a cut-in over the line\'s answer to a silence counts no refusal and holds no later read-back', async () => {
    const model = gatedModel([BOOKING[0]!, BOOKING[1]!, BOOKING[2]!, [text('Take your time, there is no rush at all.'), done()], [call('c4', 'book', { window: SLOT, name: 'Sam Example', phone: 'caller' }), done('tool')]]);
    const h = harness({ model, business: withLines });
    await readBackPlayed(h, 'twilio');
    await h.settle(9100);
    const reprompt = h.said().at(-1)!.token;
    expect(reprompt).toBe('Take your time, there is no rush at all.');
    await h.settle(500);
    await h.frame({ type: 'interrupt', utteranceUntilInterrupt: 'Take your', durationUntilInterruptMs: 500 });
    await h.prompt('yes', false);
    await h.prompt('yes');
    expect(h.booked).toEqual([]);
    expect(h.entry.session.refusals).toEqual({});
    expect(h.entry.session.unheardReadBacks).toBeUndefined();
    expect(h.said().at(-1)).toMatchObject({ interruptible: true });
    expect(h.said().at(-1)!.token).toContain('Is that right?');
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

  it('a thrown turn writes its trace record: what was said, the tools as far as they ran, the done line after it, failed; the kept state moves on a turn', async () => {
    const model = gatedModel([BOOKING[0]!, BOOKING[1]!, BOOKING[2]!, [call('c3', 'availability', { day: DAY }), done('tool')]]);
    const h = harness({
      model,
      appending: (d, rows) => {
        if (d.type === 'gate' && d.detail.tool === 'availability' && rows.some((r) => r.type === 'confirmed')) throw new Error('disk full at /secret/path');
      },
    });
    await readBackOf(h);
    const index = h.entry.session.turnIndex;
    await h.prompt('yes');
    const r = h.traces.at(-1)!;
    expect(r).toMatchObject({ kind: 'converse', turnIndex: index, said: 'yes', failed: 'internal' });
    expect(r.tools[0]).toMatchObject({ name: 'book', outcome: 'confirmed' });
    expect(r.replies.at(-1)).toBe("That's done.");
    expect(JSON.stringify(r)).not.toContain('disk full');
    expect(JSON.stringify(r)).not.toContain('secret');
    expect(h.entry.session.turnIndex).toBe(index + 1);
  });

  it('a thrown turn before anything ran writes its record with the recovery line, and keeps the session from before it', async () => {
    const h = harness({
      model: gatedModel([[call('c1', 'availability', { day: DAY }), done('tool')]]),
      appending: (d) => {
        if (d.type === 'gate') throw new Error('disk full');
      },
    });
    await h.rt.open(h.entry, { callerNumber: null, provider: 'twilio' }, h.io);
    const index = h.entry.session.turnIndex;
    await h.prompt('hello');
    expect(h.traces.at(-1)).toMatchObject({ turnIndex: index, said: 'hello', failed: 'internal', replies: ['Sorry, could you say that again?'] });
    expect(h.entry.session.turnIndex).toBe(index);
  });

  it('a thrown turn whose trace cannot be written either still says its line, and the failure to write is logged', async () => {
    const h = harness({ model: gatedModel([[call('c1', 'availability', { day: DAY }), done('tool')]]) });
    await h.rt.open(h.entry, { callerNumber: null, provider: 'twilio' }, h.io);
    h.entry.trace = { write: () => { throw new Error('trace down'); } } as unknown as ConverseCallEntry['trace'];
    await h.prompt('hello');
    expect(h.said().at(-1)).toMatchObject({ token: 'Sorry, could you say that again?', last: true });
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

describe('the converse voice runtime: words for the ear', () => {
  it('a reply with a price range and a screen list goes out speakable', async () => {
    const h = harness({ model: gatedModel([[text("It's $60–$120 a visit. "), text('Could you tell me:\n- your name\n- the day\n\n'), done()]]) });
    await h.rt.open(h.entry, { callerNumber: '+15555550123', provider: 'twilio' }, h.io);
    await h.prompt('how much is a visit?');
    expect(h.said().slice(1).map((f) => [f.token, f.last])).toEqual([["It's $60 to $120 a visit. ", false], ['Could you tell me: your name, the day ', true]]);
  });

  /** The call up to the booking's read-back, on the number the caller is calling from: the read-back's token. */
  async function readBackOf(h: ReturnType<typeof harness>): Promise<string> {
    await h.rt.open(h.entry, { callerNumber: '+15555550123', provider: 'twilio' }, h.io);
    await h.prompt('I need a visit on Tuesday');
    await h.prompt('the morning, for Sam Example');
    return h.said().at(-1)!.token;
  }

  it('a read-back says the caller\'s last four digit by digit, and is what waits for the yes', async () => {
    const h = harness({ model: gatedModel(BOOKING.slice(0, 4)) });
    const readBack = await readBackOf(h);
    expect(readBack).toContain('ending in 0 1 2 3. Is that right?');
    expect(h.entry.session.pending!.text).toBe(readBack);
    // The frame log keeps it as the trace masks it: the name by its length, the number by its last four.
    const logged = h.fio.records.filter((r) => r.dir === 'out').map((r) => (r.msg as { token: string }).token).at(-1)!;
    expect(logged).toContain('Is that right?');
    expect(logged).not.toContain('Sam Example');
    expect(logged).toBe(h.traces.at(-1)!.readBack!.text);
  });

  it('a read-back with the caller\'s last four heard to its end (Twilio\'s report of it whole) still confirms on a yes', async () => {
    const h = harness({ model: gatedModel(BOOKING.slice(0, 4)) });
    const readBack = await readBackOf(h);
    await h.frame({ type: 'interrupt', utteranceUntilInterrupt: readBack, durationUntilInterruptMs: 4000 });
    await h.prompt('yes');
    expect(h.booked).toHaveLength(1);
    expect(h.said().at(-1)!.token).toBe('You are booked for Tuesday morning.');
  });

  it('one cut at half confirms nothing', async () => {
    const h = harness({ model: gatedModel([BOOKING[0]!, BOOKING[1]!, BOOKING[2]!, [text('Shall I read it again?'), done()]]) });
    const readBack = await readBackOf(h);
    await h.frame({ type: 'interrupt', utteranceUntilInterrupt: readBack.slice(0, Math.floor(readBack.length / 2)), durationUntilInterruptMs: 2000 });
    await h.prompt('yes');
    expect(h.booked).toEqual([]);
  });
});
