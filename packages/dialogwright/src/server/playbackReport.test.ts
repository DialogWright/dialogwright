import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetNoInput, handleSocketMessage, newConnectionContext, type AdapterDeps } from './adapter';
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
      set('intent', /\breport\b/i.test(text) ? choice({ report: 0.95, none: 0.05 }) : choice({ none: 0.9, other: 0.1 }));
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

/**
 * A call to `app` from CALLER on `provider`: the number read back, then the carrier's word on the line:
 * Telnyx's report of the line it played (tokensPlayed), or Twilio's interrupt with the part of it heard.
 */
async function readBackPlayed(app: App, provider: 'telnyx' | 'twilio' = 'telnyx'): Promise<{ wire: string; out: string; report: Record<string, unknown> }> {
  resetAppsForTest();
  registerApp(app);
  forgetNoInput(CALL);
  const dir = mkdtempSync(join(tmpdir(), 'playback-report-'));
  const opts = { client: client(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-10-14', now: () => 0 };
  const store = new SessionStore((callSid) => ({
    session: newSession(callSid, 0, VOICE_RELAY, ANONYMOUS, app.id),
    opts: { ...opts, trace: new TraceWriter(join(dir, `${callSid}.jsonl`)) },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`)),
  }), 60_000, () => 0);
  const tokens = new CallTokens(60_000, () => 0);
  const deps: AdapterDeps = { store, tokens, log: () => {}, bargeIn: 'any' };
  const sent: Record<string, unknown>[] = [];
  const sock: SocketLike = { send: (d, cb) => { sent.push(JSON.parse(d) as Record<string, unknown>); cb?.(); }, close: () => {} };
  const ctx = newConnectionContext(tokens.mint(CALL, provider), sock, provider);
  const send = (m: object) => handleSocketMessage(deps, sock, ctx, JSON.stringify(m));
  await send(provider === 'telnyx'
    ? { type: 'setup', sessionId: 'TX28', callSid: CALL, from: null, to: null, customParameters: { telnyx_call_from: CALLER, telnyx_call_to: '+15555550111' } }
    : { type: 'setup', sessionId: 'VX28', callSid: CALL, from: CALLER, to: '+15555550111', customParameters: {} });
  await send({ type: 'prompt', voicePrompt: 'i want to report a problem', lang: 'en-US', last: true });
  await send({ type: 'prompt', voicePrompt: 'five five five five five five zero one four two', lang: 'en-US', last: true });
  const wire = sent.filter((f) => f.type === 'text').map((f) => (f.token as string).trim()).at(-1)!;
  // Telnyx's echo of the line it played (tokens-played), as seen on the live call: the line as it was sent.
  // Twilio reports no playback; its interrupt carries the part of the line heard, the number among it.
  if (provider === 'telnyx') await send({ type: 'info', name: 'tokensPlayed', value: wire });
  else await send({ type: 'interrupt', utteranceUntilInterrupt: wire.replace(/\. Is that right\?$/, ''), durationUntilInterruptMs: 4200 });
  const frames = readFileSync(join(dir, `${CALL}.frames.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { dir: string; msg: Record<string, unknown> });
  const out = frames.filter((l) => l.dir === 'out' && l.msg.type === 'text').map((l) => (l.msg.token as string).trim()).at(-1)!;
  const report = provider === 'telnyx'
    ? frames.filter((l) => l.dir === 'in' && l.msg.carrierEvent !== undefined).map((l) => l.msg.carrierEvent as Record<string, unknown>).at(-1)!
    : frames.filter((l) => l.dir === 'in' && l.msg.type === 'interrupt').map((l) => l.msg).at(-1)!;
  return { wire, out, report };
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

  it('with records.callerNumber: keep, such a copy is kept whole, in the report as in the line sent', async () => {
    const { wire, out, report } = await readBackPlayed(callbackApp({ redact: 'none' }, { records: { callerNumber: 'keep' } }));
    expect(out).toBe(wire);
    expect(report.value).toBe(wire);
  });
});
