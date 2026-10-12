import { describe, expect, it } from 'vitest';
import { scripted, type Step } from '../../testing/scripted';
import { useTestkit } from '../../testing/apps';
import { defaultAppId, getApp } from '../../core/app/registry';
import type { App } from '../../core/app/types';
import type { TraceRecord } from '../../trace/types';
import { parseFrameLog } from '../frameLog';
import { summaryOfTrace } from './calls';
import { factsOfTrace, hoursOf, insightsOf, sumHours, LENGTH_EDGES_S, type CallSummary } from './figures';

/**
 * Insights' figures (figures.ts) on fixture traces: what each call adds (its tasks, where it struggled,
 * the gate's refusals, the screen, business hours, the knowledge base's gaps), summed by the hour, and
 * said in the app's words, with the carrier's cost only when a rate is set.
 */

useTestkit();

const T0 = Date.parse('2026-09-18T15:00:00Z');
const OPENER = 'my parcel never arrived';
const ACCOUNT = 'five five five zero one two three four';
const DOB = 'april twelfth nineteen eighty five';
const TRACK: Step[] = ['where is my parcel', ACCOUNT, DOB, { dtmf: '123456' }, 'the box of books'];

type End = 'hangup' | 'handoff' | 'completed' | 'error' | 'none';

/** A scripted call's summary and facts, as calls.ts reads them from its trace and frame log, ended as `end` says. */
async function call(steps: Step[], end: End, startMs: number, opts: { provider?: 'twilio' | 'telnyx' | null; reason?: string; sid?: string } = {}): Promise<CallSummary> {
  const { records } = await scripted(steps, { callSid: opts.sid ?? `CA${startMs}`, startMs });
  const last = new Date(startMs + 5_000 * steps.length + 1_000).toISOString();
  const frames = end === 'hangup' ? [{ ts: last, dir: 'log', msg: { socketClosed: true, ended: false } }]
    : end === 'handoff' || end === 'completed' ? [{ ts: last, dir: 'out', msg: { type: 'end', handoffData: JSON.stringify({ reasonCode: end === 'handoff' ? (opts.reason ?? 'live-agent') : 'completed' }) } }]
      : [];
  const app = getApp(defaultAppId());
  const row = summaryOfTrace(records, parseFrameLog(frames.map((f) => JSON.stringify(f)).join('\n')), app)!;
  const provider = opts.provider === undefined ? 'twilio' : opts.provider;
  const ended = end === 'error' ? { ...row, endedAt: row.lastAt, ending: { kind: 'error' as const, text: 'ended in an error' } } : row;
  return { row: { ...ended, provider, ...(provider === null ? { channel: 'chat' } : {}) }, facts: factsOfTrace(records, app) };
}

describe('what one call adds (factsOfTrace)', () => {
  it('a task started and finished, with the time it took; one started and never finished', async () => {
    const done = await call(TRACK, 'completed', T0);
    expect(done.facts.tasks).toEqual({ track_parcel: { finished: true, ms: 20_000 } });
    const left = await call([OPENER, ACCOUNT], 'hangup', T0);
    expect(left.facts.tasks).toEqual({ report_missing: { finished: false, ms: null } });
  });

  it('where callers struggle, per question: a silence, a re-ask after an answer that did not fill the slot, a slot that ran out', async () => {
    const c = await call([OPENER, ACCOUNT, { silence: true }, 'banana', 'banana'], 'handoff', T0, { reason: 'max-attempts' });
    expect(c.facts.asked).toEqual({ dob: { silences: 1, reasks: 1, ranOut: 1 } });
  });

  it("the gate's refusals by the rule that failed, and its step-ups apart", async () => {
    const c = await call(['where is parcel 7201', ACCOUNT, DOB, { dtmf: '123456' }], 'hangup', T0);
    expect(c.facts.refusals).toEqual({ scope: 1 });
    expect(c.facts.stepUps).toBe(1);
  });

  it('the screen\'s hits, a route on business hours, and the knowledge base\'s gaps by kind and nearest topic (never the words)', () => {
    const base = { v: 2, sessionId: 'CA9', turnState: null, source: 'jev', error: null, gates: [], actions: [], form: null, slots: {}, timing: { planMs: 0, askMs: 0, resolveMs: 0, totalMs: 0 }, usage: { inputTokens: 0, outputTokens: 0, estimated: false, costUsd: 0 } };
    const records = [
      { ...base, turnIndex: 1, ts: '2026-09-18T15:00:00.000Z', event: { type: 'session.start', provider: {} }, questions: null, answers: null, decision: { kind: 'prompt', promptId: 'greeting' }, promptedFor: 'intent', routes: [{ point: 'start', rule: 1, outcome: 'handoff', subjects: ['hours'] }] },
      { ...base, turnIndex: 2, ts: '2026-09-18T15:00:05.000Z', event: { type: 'user.speech', text: 'what time do you open on the fifth?', final: true, lang: 'en' }, questions: {}, answers: {}, decision: { kind: 'prompt', promptId: 'x' }, promptedFor: 'intent', retrieval: { retrieverId: 'keyword', nominated: [] }, screen: { value: 0.9, fired: true, error: null }, quarantined: false },
      { ...base, turnIndex: 3, ts: '2026-09-18T15:00:10.000Z', event: { type: 'user.speech', text: 'can i bring a dog', final: true, lang: 'en' }, questions: { askTopic: { type: 'choice', criteria: { pets: 'p', none: 'n' } } }, answers: { askTopic: { type: 'choice', choice: 'none', probabilities: { pets: 0.1, none: 0.9 }, confidence: 0.9 } }, decision: { kind: 'prompt', promptId: 'x' }, promptedFor: 'intent', retrieval: { retrieverId: 'keyword', nominated: [{ topic: 'pets', score: 1, via: 'keyword' }] } },
    ] as unknown as TraceRecord[];
    const app = { ...getApp(defaultAppId()), knowledge: { topics: [{ id: 'pets', title: 'Pets on site' }], retriever: { id: 'r', nominate: () => [] } } } as unknown as App;
    const facts = factsOfTrace(records, app);
    expect(facts.screenHits).toBe(1);
    expect(facts.hours).toEqual({ 'start:handoff': 1 });
    expect(facts.gaps).toEqual({ unmatched: 1, none: 1 });
    expect(facts.gapTopics).toEqual({ '~': { n: 1, latest: '2026-09-18T15:00:05.000Z' }, pets: { n: 1, latest: '2026-09-18T15:00:10.000Z' } });
    // Nothing a caller said is kept.
    expect(JSON.stringify(facts)).not.toMatch(/open|dog|fifth/);
    const without = factsOfTrace(records, { ...app, knowledge: undefined } as App);
    expect(without.gaps).toEqual({});
  });
});

describe('summed by the hour, and said in the app\'s words (hoursOf, sumHours, insightsOf)', () => {
  it('containment of the calls that ended; hang-ups and errors apart; transfers by reason; abandonment by step; completion per intent; lengths', async () => {
    const calls = [
      await call(TRACK, 'completed', T0),
      await call([OPENER, 'let me talk to a person'], 'handoff', T0 + 60_000),
      await call([OPENER, ACCOUNT], 'hangup', T0 + 120_000),
      await call([], 'hangup', T0 + 180_000),
      await call([OPENER], 'error', T0 + 240_000),
      await call([OPENER], 'none', T0 + 300_000),
    ];
    const hours = hoursOf(calls);
    expect(Object.keys(hours)).toEqual([String(T0)]);
    const h = hours[String(T0)]!;
    expect([h.calls, h.ended, h.contained, h.toPerson, h.hungUp, h.errors]).toEqual([6, 5, 1, 1, 2, 1]);
    expect(h.transfers).toEqual({ 'live-agent': 1 });
    expect(h.abandoned).toEqual({ 'Report a missing parcel · Date of birth': 1, 'the greeting': 1 });
    expect(h.tasks).toEqual({ track_parcel: { started: 1, finished: 1, ms: 20_000 }, report_missing: { started: 4, finished: 0, ms: 0 } });
    expect(h.lengths).toHaveLength(LENGTH_EDGES_S.length + 1);
    expect(h.lengths.reduce((a, b) => a + b, 0)).toBe(5);
    const ins = insightsOf([{ id: null, app: getApp(defaultAppId()), figures: sumHours(Object.values(hours)), hours }], undefined);
    expect(ins.containment).toBeCloseTo(1 / 5);
    expect(ins.transfers).toEqual([{ app: null, key: 'live-agent', label: 'caller asked for a person', value: 1 }]);
    expect(ins.abandoned.map((r) => [r.label, r.value])).toEqual([['Report a missing parcel · Date of birth', 1], ['the greeting', 1]]);
    expect(ins.tasks.map((r) => [r.label, r.value])).toEqual([['Report a missing parcel', { started: 4, finished: 0, meanMs: null }], ['Track a parcel', { started: 1, finished: 1, meanMs: 20_000 }]]);
    expect(ins.byHour).toEqual([{ hour: T0, calls: 6, peak: expect.any(Number) }]);
  });

  it('the peak at once: calls that overlap, by the hour they started', async () => {
    const a = await call(TRACK, 'completed', T0);
    const b = await call(TRACK, 'completed', T0 + 5_000);
    const c = await call(TRACK, 'completed', T0 + 600_000);
    const hours = hoursOf([a, b, c]);
    expect(hours[String(T0)]!.peak).toBe(2);
    const next = await call(TRACK, 'completed', T0 + 3_600_000);
    expect(hoursOf([a, b, c, next])[String(T0 + 3_600_000)]!.peak).toBe(1);
  });

  it('minutes and the model\'s cost; the carrier\'s cost only with a rate, each call rounded up to the minute per carrier; cost per call and per handled call', async () => {
    const calls = [
      await call(TRACK, 'completed', T0, { provider: 'twilio' }), // 26 s: 1 minute
      await call([...TRACK, 'and one more thing', 'thanks', 'bye', 'ok', 'fine', 'right', 'yes', 'no', 'maybe', 'well', 'hm', 'so'], 'hangup', T0, { provider: 'telnyx' }), // 86 s: 2 minutes
      await call([OPENER], 'completed', T0, { provider: null }), // a chat: no minutes
    ];
    const hours = hoursOf(calls);
    const figures = sumHours(Object.values(hours));
    expect(figures.billedMinutes).toEqual({ twilio: 1, telnyx: 2 });
    expect(figures.voice).toBe(2);
    const app = getApp(defaultAppId());
    const off = insightsOf([{ id: null, app, figures, hours }], undefined);
    expect(off.carrier).toBeNull();
    expect(off.cost.carrierUsd).toBeNull();
    expect(off.cost.modelUsd).toBeCloseTo(calls.reduce((s, c) => s + c.row.costUsd, 0), 6);
    expect(off.minutes).toBeCloseTo((26_000 + 86_000) / 60_000, 1);
    const on = insightsOf([{ id: null, app, figures, hours }], { twilio: 0.014 });
    expect(on.carrier).toEqual({ usd: 0.014, byCarrier: [{ carrier: 'twilio', minutes: 1, ratePerMin: 0.014, usd: 0.014 }], unpriced: 2 });
    const both = insightsOf([{ id: null, app, figures, hours }], { twilio: 0.014, telnyx: 0.01 });
    expect(both.carrier!.usd).toBeCloseTo(0.034, 6);
    expect(both.cost.totalUsd).toBeCloseTo(both.cost.modelUsd + 0.034, 6);
    expect(both.cost.perCall).toBeCloseTo(both.cost.totalUsd / 3, 6);
    expect(both.cost.perHandled).toBeCloseTo(both.cost.totalUsd / 2, 6);
  });

  it('struggles per question in the app\'s labels, only those with any; refusals by rule', async () => {
    const calls = [
      await call([OPENER, ACCOUNT, { silence: true }, 'banana', 'banana'], 'handoff', T0, { reason: 'max-attempts' }),
      await call(['where is parcel 7201', ACCOUNT, DOB, { dtmf: '123456' }], 'hangup', T0),
    ];
    const hours = hoursOf(calls);
    const ins = insightsOf([{ id: null, app: getApp(defaultAppId()), figures: sumHours(Object.values(hours)), hours }], undefined);
    expect(ins.struggles).toEqual([{ app: null, key: 'dob', label: 'Date of birth', value: { reasks: 1, silences: 1, ranOut: 1 } }]);
    expect(ins.refusals).toEqual([{ app: null, key: 'scope', label: 'scope', value: 1 }]);
    expect(ins.totals.stepUps).toBe(2);
  });

  it('on a host, each app\'s rows carry its name; the totals add every app', async () => {
    const one = await call(TRACK, 'completed', T0);
    const two = await call([OPENER, 'let me talk to a person'], 'handoff', T0);
    const h1 = hoursOf([one]);
    const h2 = hoursOf([two]);
    const app = getApp(defaultAppId());
    const ins = insightsOf([
      { id: 'north', app: { ...app, brand: { name: 'North Line' } } as App, figures: sumHours(Object.values(h1)), hours: h1 },
      { id: 'south', app: { ...app, brand: { name: 'South Line' } } as App, figures: sumHours(Object.values(h2)), hours: h2 },
    ], undefined);
    expect(ins.totals.calls).toBe(2);
    expect(ins.transfers).toEqual([{ app: 'South Line', key: 'live-agent', label: 'caller asked for a person', value: 1 }]);
    expect(ins.tasks.map((t) => t.app).sort()).toEqual(['North Line', 'South Line']);
    expect(ins.byHour).toEqual([{ hour: T0, calls: 2, peak: 2 }]);
  });
});
