import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetNoInput, handleSocketMessage, newConnectionContext, RESAY_SETTLE_MS, type AdapterDeps } from './adapter';
import { SessionStore, type SocketLike } from './sessions';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { TraceWriter } from '../trace/writer';
import { VOICE_RELAY } from '../channel/caps';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { ANONYMOUS } from '../gate/principal';
import { placeApp } from '../testing/placeApp';
import { choice, noul } from '../testing/answers';
import { defineSlot } from '../slots/defineSlot';
import { spokenToDigits } from '../core/extract/spokenNumber';
import type { App } from '../core/app/types';
import type { AnswerMap, JevClient, Question } from '../jev/types';

/**
 * The carrier's report of what it played, in the records (live findings item 28). On a live Telnyx call
 * the read-back said the callback number, the number the caller was calling from, digit by digit: the
 * frame log masked the line sent (`out`, "on …0142") but wrote Telnyx's `tokensPlayed`, its echo of the
 * line, whole ("on 5 5 5, 5 5 5, 0 1 4 2"). The report is now recorded as the line it echoes is: the
 * slot values the line said, and any copy of the caller's number however the voice spaced it, masked as
 * app.yaml's records say. What is delivered, and what the server reads of the report, are unchanged.
 */

const CALL = 'CA28';
const CALLER = '+15555550142';
const SAID = '5 5 5, 5 5 5, 0 1 4 2';

/** The place app's one form, asking a ten-digit callback number, read back digit by digit in groups of three, three and four. */
function callbackApp(options: Record<string, unknown> = {}, over: Partial<App> = {}): App {
  const base = placeApp();
  const phone = defineSlot('phone', { type: 'digits', noun: 'phone', length: 10, group: [3, 3, 4], keypad: true, ...options });
  return placeApp({
    id: 'callback-line',
    forms: { report: { ...base.forms.report!, slots: ['phone'] } },
    slots: { phone },
    prompts: {
      manifest: {
        ...base.prompts.manifest,
        ask_phone: { text: 'What number should we call you back on?', interruptible: true },
        ask_phone_retry: { text: 'Sorry, what number?', interruptible: true },
        ask_phone_dtmf: { text: 'Please key in the number.', interruptible: false },
        confirm_report: { text: 'We will call you on {phone}. Is that right?', interruptible: true },
      },
      tags: {},
    },
    ...over,
  });
}

function quiet(q: Question): AnswerMap[string] {
  if (q.type === 'noul') return noul(0.02);
  const labels = q.type === 'choice' ? Object.keys(q.criteria) : q.levels.map((l) => l.label);
  const pick = labels.includes('none') ? 'none' : labels.includes('answering') ? 'answering' : labels[0]!;
  return choice(Object.fromEntries(labels.map((l) => [l, l === pick ? 0.9 : 0.1 / Math.max(1, labels.length - 1)])));
}

/** A model that hears a request to report, and a number as the span of the most digits. */
function client(): JevClient {
  return {
    ask: async (req) => {
      const text = (req.state as { asr?: { text?: string } } | null)?.asr?.text ?? '';
      const answers: AnswerMap = {};
      for (const [id, q] of Object.entries(req.questions)) answers[id] = quiet(q);
      const set = (id: string, a: AnswerMap[string]) => {
        if (Object.hasOwn(req.questions, id)) answers[id] = a;
      };
      set('addressedToSystem', noul(0.95));
      set('intelligible', noul(0.95));
      set('utteranceComplete', noul(0.9));
      set('intent', /\breport\b/i.test(text) ? choice({ report: 0.95, none: 0.05 })
        : /\bagain\b/i.test(text) ? choice({ repeat_prompt: 0.95, none: 0.05 }) : choice({ none: 0.9, other: 0.1 }));
      set('confirmsYes', noul(/^yes\b/i.test(text) ? 0.95 : 0.02));
      const span = req.questions.phoneSpan;
      const spans = span?.type === 'choice' ? Object.keys(span.criteria).filter((s) => s !== 'none') : [];
      const best = spans.sort((a, b) => spokenToDigits(b).length - spokenToDigits(a).length)[0];
      if (best !== undefined) {
        set('phoneGiven', noul(0.95));
        set('phoneSpan', choice({ [best]: 0.9, none: 0.1 }));
        set('phoneComplete', noul(0.9));
      }
      return { answers, model: 'callback-test', usage: { inputTokens: 0, outputTokens: 0, estimated: true }, latencyMs: 0, source: 'stub:fixture' };
    },
  };
}

beforeEach(() => {
  resetAppsForTest();
  vi.useFakeTimers();
});
afterEach(() => {
  forgetNoInput(CALL);
  vi.useRealTimers();
});

type Frame = { dir: string; msg: Record<string, unknown> };

/** A live call to `app` on `provider`, from CALLER, on a server of its own (`more`: its settings). */
function liveCall(app: App, provider: 'telnyx' | 'twilio' = 'telnyx', more: Partial<AdapterDeps> = {}, seed?: ReturnType<typeof newSession>) {
  resetAppsForTest();
  registerApp(app);
  forgetNoInput(CALL);
  const dir = mkdtempSync(join(tmpdir(), 'playback-report-'));
  const opts = { client: client(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-10-14', now: () => 0 };
  const store = new SessionStore((callSid) => ({
    session: seed ?? newSession(callSid, 0, VOICE_RELAY, ANONYMOUS, app.id),
    opts: { ...opts, trace: new TraceWriter(join(dir, `${callSid}.jsonl`)) },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`)),
  }), 60_000, () => 0);
  const tokens = new CallTokens(60_000, () => 0);
  const deps: AdapterDeps = { store, tokens, log: () => {}, bargeIn: 'any', ...more };
  const sent: Record<string, unknown>[] = [];
  const sock: SocketLike = { send: (d, cb) => { sent.push(JSON.parse(d) as Record<string, unknown>); cb?.(); }, close: () => {} };
  const ctx = newConnectionContext(tokens.mint(CALL, provider), sock, provider);
  const send = (m: object) => handleSocketMessage(deps, sock, ctx, JSON.stringify(m));
  // Taken over: the entry made for the saved session, with no setup and none of the first server's lines.
  if (seed !== undefined) {
    store.create(CALL, sock, provider, app.id);
    ctx.callSid = CALL;
  }
  const frames = (): Frame[] => readFileSync(join(dir, `${CALL}.frames.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Frame);
  return {
    store, sent, ctx,
    start: () => send(provider === 'telnyx'
      ? { type: 'setup', sessionId: 'TX28', callSid: CALL, from: null, to: null, customParameters: { telnyx_call_from: CALLER, telnyx_call_to: '+15555550111' } }
      : { type: 'setup', sessionId: 'VX28', callSid: CALL, from: CALLER, to: '+15555550111', customParameters: {} }),
    say: (text: string) => send({ type: 'prompt', voicePrompt: text, lang: 'en-US', last: true }),
    /** Telnyx's echo of the line it played (tokens-played), as seen on the live call. */
    played: (value: string) => send({ type: 'info', name: 'tokensPlayed', value }),
    speaking: (on: boolean) => send({ type: 'info', name: 'agentSpeaking', value: on ? 'on' : 'off' }),
    /** Twilio's interrupt, with the part of our line the caller heard. */
    interrupt: (heard: string) => send({ type: 'interrupt', utteranceUntilInterrupt: heard, durationUntilInterruptMs: 4200 }),
    /** The lines as they went out on the wire. */
    wire: () => sent.filter((f) => f.type === 'text').map((f) => (f.token as string).trim()),
    out: () => frames().filter((l) => l.dir === 'out' && l.msg.type === 'text').map((l) => (l.msg.token as string).trim()),
    reports: () => frames().filter((l) => l.dir === 'in' && l.msg.carrierEvent !== undefined).map((l) => l.msg.carrierEvent as Record<string, unknown>),
    interrupts: () => frames().filter((l) => l.dir === 'in' && l.msg.type === 'interrupt').map((l) => l.msg),
    logged: (key: string) => frames().filter((l) => l.dir === 'log' && l.msg[key] !== undefined).map((l) => l.msg[key]),
    session: () => store.get(CALL)!.session,
  };
}
type Call = ReturnType<typeof liveCall>;

/** `call` as another server takes it over: a new entry for it, with the session as it stands, and none of the first server's lines. */
function takeOver(call: Call, app: App): Call {
  return liveCall(app, 'telnyx', {}, structuredClone(call.session()));
}

/** To the read-back of `said` (the caller's own number unless another is given). */
async function toReadBack(call: Call, said = 'five five five five five five zero one four two'): Promise<string> {
  await call.start();
  await call.say('i want to report a problem');
  await call.say(said);
  return call.wire().at(-1)!;
}

/**
 * A call to `app` from CALLER on `provider`: the number read back, then the carrier's word on the line:
 * Telnyx's report of the line it played (tokensPlayed), or Twilio's interrupt with the part of it heard.
 */
async function readBackPlayed(app: App, provider: 'telnyx' | 'twilio' = 'telnyx', heard?: string): Promise<{ wire: string; out: string; report: Record<string, unknown> }> {
  const call = liveCall(app, provider);
  const wire = await toReadBack(call);
  if (provider === 'telnyx') await call.played(wire);
  else await call.interrupt(heard ?? wire.replace(/\. Is that right\?$/, ''));
  return { wire, out: call.out().at(-1)!, report: provider === 'telnyx' ? call.reports().at(-1)! : call.interrupts().at(-1)! };
}

describe('the carrier\'s playback report in the frame log (live findings item 28)', () => {
  it('the live call: the callback number, the caller\'s own, read back digit by digit; the line sent and Telnyx\'s report of it are both masked', async () => {
    const { wire, out, report } = await readBackPlayed(callbackApp());
    // Delivered whole: masking is for the records only.
    expect(wire).toBe(`We will call you on ${SAID}. Is that right?`);
    expect(out).toBe('We will call you on ...0142. Is that right?');
    expect(report).toEqual({ type: 'info', name: 'tokensPlayed', value: 'We will call you on ...0142. Is that right?' });
  });

  it('a copy of the caller\'s number no redacted slot holds is masked by its last four too, in the line sent and in the report, as records.callerNumber says', async () => {
    const { wire, out, report } = await readBackPlayed(callbackApp({ redact: 'none' }));
    expect(wire).toBe(`We will call you on ${SAID}. Is that right?`);
    expect(out).toBe('We will call you on …0142. Is that right?');
    expect(report.value).toBe('We will call you on …0142. Is that right?');
  });

  it('Twilio reports no playback; the part of the line its interrupt heard is masked as the line is, the caller\'s number among it', async () => {
    const slot = await readBackPlayed(callbackApp(), 'twilio');
    expect(slot.report.utteranceUntilInterrupt).toBe('We will call you on ...0142');
    const copy = await readBackPlayed(callbackApp({ redact: 'none' }), 'twilio');
    expect(copy.report.utteranceUntilInterrupt).toBe('We will call you on …0142');
    const kept = await readBackPlayed(callbackApp({ redact: 'none' }, { records: { callerNumber: 'keep' } }), 'twilio');
    expect(kept.report.utteranceUntilInterrupt).toBe(`We will call you on ${SAID}`);
  });

  it('an interrupt cut off part way through the caller\'s number: what was said of it is masked too', async () => {
    const cut = await readBackPlayed(callbackApp({ redact: 'none' }), 'twilio', 'We will call you on 5 5 5, 5 5 5, 0');
    expect(cut.report.utteranceUntilInterrupt).toBe('We will call you on …0142');
    // Fewer than three of its digits say nothing of it, and stay.
    const early = await readBackPlayed(callbackApp({ redact: 'none' }), 'twilio', 'We will call you on 5 5');
    expect(early.report.utteranceUntilInterrupt).toBe('We will call you on 5 5');
  });

  it('with records.callerNumber: keep, such a copy is kept whole, in the report as in the line sent', async () => {
    const { wire, out, report } = await readBackPlayed(callbackApp({ redact: 'none' }, { records: { callerNumber: 'keep' } }));
    expect(out).toBe(wire);
    expect(report.value).toBe(wire);
  });

  it('a report that comes after the turn moved on (the slot emptied, or given another value) is masked by the line it echoes', async () => {
    // Another number than the caller's, so only the slot's own masking can find it.
    const call = liveCall(callbackApp());
    const wire = await toReadBack(call, 'five five five five five five zero one nine nine');
    expect(wire).toBe('We will call you on 5 5 5, 5 5 5, 0 1 9 9. Is that right?');
    call.session().slots.phone = { ...call.session().slots.phone!, value: null, display: null };
    await call.played(wire);
    expect(call.reports().at(-1)!.value).toBe('We will call you on ...0199. Is that right?');
    call.session().slots.phone = { ...call.session().slots.phone!, value: '5555550177', display: '555 555 0177' };
    await call.played(wire);
    expect(call.reports().at(-1)!.value).toBe('We will call you on ...0199. Is that right?');
  });

  it('only the latest four lines are kept for it: a report of a line older than that is masked by the session as it is now, and the caller\'s number', async () => {
    const call = liveCall(callbackApp());
    const first = await toReadBack(call, 'five five five five five five zero one nine nine');
    // The slot given another value, then four lines sent, each of the slot as it now is.
    call.session().slots.phone = { ...call.session().slots.phone!, value: '5555550177', display: '555 555 0177' };
    for (let i = 0; i < 4; i++) await call.say('can you say that again');
    await call.played(first);
    // The first line's own masking is gone: its number, no longer the slot's and not the caller's, is as it came.
    expect(call.reports().at(-1)!.value).toBe(first);
    // With three lines since, it is still kept.
    const again = liveCall(callbackApp());
    const line = await toReadBack(again, 'five five five five five five zero one nine nine');
    again.session().slots.phone = { ...again.session().slots.phone!, value: '5555550177', display: '555 555 0177' };
    for (let i = 0; i < 3; i++) await again.say('can you say that again');
    await again.played(line);
    expect(again.reports().at(-1)!.value).toBe('We will call you on ...0199. Is that right?');
  });

  it('a call taken over by another server, which sent none of its lines: the report is masked by the session as it stands', async () => {
    const call = liveCall(callbackApp());
    const wire = await toReadBack(call, 'five five five five five five zero one nine nine');
    const other = takeOver(call, callbackApp());
    await other.played(wire);
    expect(other.reports().at(-1)!.value).toBe('We will call you on ...0199. Is that right?');
  });

  it('in an app whose records keep no caller words (a slot summarized though masked, as the secretary\'s message): the line the report says it played is kept by its length', async () => {
    const base = callbackApp();
    const phone = base.slots.phone!;
    // framesMaskWords: a slot marked to be summarized though masked in the records (a text slot's redact: length-summarized).
    const app: App = { ...base, slots: { ...base.slots, phone: { ...phone, redact: 'length', statement: false, summarized: true } } };
    const call = liveCall(app);
    const wire = await toReadBack(call);
    await call.played(wire);
    expect(call.reports().at(-1)).toEqual({ type: 'info', name: 'tokensPlayed', value: `<${wire.length} chars>` });
    // Its other events, which say no line, are as they came.
    await call.speaking(true);
    expect(call.reports().at(-1)).toEqual({ type: 'info', name: 'agentSpeaking', value: 'on' });
  });
});

describe('what the server reads of the report is the event as it came (live findings item 28)', () => {
  it('a report of the read-back, played in a moment: the line is taken as cut short and said again, read from the raw report (the masked one names no line sent)', async () => {
    const call = liveCall(callbackApp(), 'telnyx', { resay: { minFraction: 0.35 } });
    const wire = await toReadBack(call);
    await call.speaking(true);
    await call.played(wire);
    expect(call.reports().at(-1)!.value).toBe('We will call you on ...0142. Is that right?');
    await vi.advanceTimersByTimeAsync(RESAY_SETTLE_MS + 50);
    expect(call.logged('resaid')).toHaveLength(1);
    expect(call.wire().filter((l) => l === wire)).toHaveLength(2);
  });

  it('a held end is let go by the report of the last line, the caller\'s number in it, read from the raw report', async () => {
    const base = callbackApp();
    const app: App = {
      ...base,
      forms: { report: { ...base.forms.report!, complete: ({ s, acks }) => ({ kind: 'end', promptId: 'call_back_on', vars: { phone: s.slots.phone!.display ?? '' }, acks, goodbye: false }) } },
      prompts: { ...base.prompts, manifest: { ...base.prompts.manifest, call_back_on: { text: 'We will call you back on {phone}.', interruptible: false } } },
    };
    const call = liveCall(app);
    await toReadBack(call);
    await call.say('yes');
    const last = call.wire().at(-1)!;
    expect(last).toBe(`We will call you back on ${SAID}.`);
    expect(call.sent.some((f) => f.type === 'end')).toBe(false);
    await call.played(last);
    await vi.advanceTimersByTimeAsync(0);
    expect(call.sent.some((f) => f.type === 'end')).toBe(true);
    expect(call.logged('endAfter')).toContain('played');
    expect(call.reports().at(-1)!.value).toBe('We will call you back on ...0142.');
  });
});
