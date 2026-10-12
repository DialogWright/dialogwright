import { describe, expect, it } from 'vitest';
import { scripted, type Step } from '../../testing/scripted';
import { useTestkit } from '../../testing/apps';
import { defaultAppId, getApp } from '../../core/app/registry';
import type { App } from '../../core/app/types';
import type { TraceRecord } from '../../trace/types';
import { parseFrameLog } from '../frameLog';
import { summaryOfTrace } from './calls';
import { dayDataFrom, dayDataOf, factsOfTrace, insightsOf, minutesToRuns, peaksByHour, runsToMinutes, sumHours, COUNTED_MINUTES, DAY_MINUTES, FIGURES_VERSION, LENGTH_EDGES_S, type AppFigures, type CallSummary } from './figures';

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

/** The day of T0, whole. */
const RANGE = { from: Date.parse('2026-09-18T00:00:00Z'), to: Date.parse('2026-09-18T23:59:59.999Z') };

/** An app's figures for calls, as the cache would give them for RANGE. */
function figs(calls: CallSummary[], id: string | null = null, app: App = getApp(defaultAppId())): AppFigures {
  const d = dayDataOf(calls, RANGE.from);
  const minutes = new Uint32Array(2 * DAY_MINUTES);
  minutes.set(d.minutes);
  return { id, app, figures: sumHours(Object.values(d.hours)), hourCalls: Object.fromEntries(Object.entries(d.hours).map(([k, h]) => [k, h.calls])), base: RANGE.from, minutes, peaks: {}, older: [], unreadable: [] };
}

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
    // The rule's own hours condition is not in the record: an app with no such rule names neither open nor closed.
    expect(facts.hours).toEqual({ 'start::handoff': 1 });
    // With the app's routes, the rule taken says which: closed.
    const routed = { ...app, routes: { start: [{ when: [{ kind: 'hours', open: false }], outcome: { then: 'handoff' } }] } } as unknown as App;
    expect(factsOfTrace(records, routed).hours).toEqual({ 'start:closed:handoff': 1 });
    expect(insightsOf([figs([{ row: { startedAt: T0, endedAt: T0 + 1000, lastAt: T0 + 1000, ending: { kind: 'handled', text: '' }, channel: 'voice', provider: 'twilio', costUsd: 0, handoffReason: null } as never, facts: factsOfTrace(records, routed) }])], undefined, RANGE).hours)
      .toEqual([{ app: null, key: 'start:closed:handoff', label: 'at the start, closed: to a person', value: 1 }]);
    expect(facts.gaps).toEqual({ unmatched: 1, none: 1 });
    expect(facts.gapTopics).toEqual({ '~': { n: 1, latest: '2026-09-18T15:00:00.000Z' }, pets: { n: 1, latest: '2026-09-18T15:00:00.000Z' } });
    // Nothing a caller said is kept.
    expect(JSON.stringify(facts)).not.toMatch(/open|dog|fifth/);
    const without = factsOfTrace(records, { ...app, knowledge: undefined } as App);
    expect(without.gaps).toEqual({});
  });
});

describe('summed by the hour, and said in the app\'s words (dayDataOf, sumHours, insightsOf)', () => {
  it('containment of the calls that ended; hang-ups and errors apart; transfers by reason; abandonment by step; completion per intent; lengths', async () => {
    const calls = [
      await call(TRACK, 'completed', T0),
      await call([OPENER, 'let me talk to a person'], 'handoff', T0 + 60_000),
      await call([OPENER, ACCOUNT], 'hangup', T0 + 120_000),
      await call([], 'hangup', T0 + 180_000),
      await call([OPENER], 'error', T0 + 240_000),
      await call([OPENER], 'none', T0 + 300_000),
    ];
    const { hours } = dayDataOf(calls, RANGE.from);
    expect(Object.keys(hours)).toEqual([String(T0)]);
    const h = hours[String(T0)]!;
    expect([h.calls, h.ended, h.contained, h.toPerson, h.hungUp, h.errors]).toEqual([6, 5, 1, 1, 2, 1]);
    expect(h.transfers).toEqual({ 'live-agent': 1 });
    // Where they hung up, by ids: said in the app's labels when shown.
    expect(h.abandoned).toEqual({ 'report_missing|dob': 1, greeting: 1 });
    expect(h.tasks).toEqual({ track_parcel: { started: 1, finished: 1, ms: 20_000 }, report_missing: { started: 4, finished: 0, ms: 0 } });
    expect(h.lengths).toHaveLength(LENGTH_EDGES_S.length + 1);
    expect(h.lengths.reduce((a, b) => a + b, 0)).toBe(5);
    const ins = insightsOf([figs(calls)], undefined, RANGE);
    expect(ins.containment).toBeCloseTo(1 / 5);
    expect(ins.transfers).toEqual([{ app: null, key: 'live-agent', label: 'caller asked for a person', value: 1 }]);
    expect(ins.abandoned.map((r) => [r.label, r.value])).toEqual([['Report a missing parcel · Date of birth', 1], ['the greeting', 1]]);
    expect(ins.tasks.map((r) => [r.label, r.value])).toEqual([['Report a missing parcel', { started: 4, finished: 0, meanMs: null }], ['Track a parcel', { started: 1, finished: 1, meanMs: 20_000 }]]);
    expect(ins.byHour).toEqual([{ hour: T0, calls: 6, peak: expect.any(Number) }]);
    expect(ins.hours).toEqual([]);
  });

  it('the peak at once: calls that overlap, in each hour they are in progress; one ending as another starts is not at once', async () => {
    const a = await call(TRACK, 'completed', T0);
    const b = await call(TRACK, 'completed', T0 + 5_000);
    const c = await call(TRACK, 'completed', T0 + 600_000);
    expect(insightsOf([figs([a, b, c])], undefined, RANGE).totals.peak).toBe(2);
    const next = await call(TRACK, 'completed', T0 + 3_600_000);
    const ins = insightsOf([figs([a, b, c, next])], undefined, RANGE);
    expect(ins.byHour.map((h) => [h.hour, h.peak])).toEqual([[T0, 2], [T0 + 3_600_000, 1]]);
    // Counts by the minute by hand: the peak of each hour is its busiest minute; a range that starts inside an hour takes its minutes from there.
    const counts = new Uint32Array(3 * 60);
    counts.fill(1, 0, 5);
    counts[5] = 2; // in minute 5, one call ended and the next began: two, to the minute
    counts.fill(1, 61, 125);
    expect([...peaksByHour(counts, T0, RANGE.from, RANGE.to)]).toEqual([[T0, 2], [T0 + 3_600_000, 1], [T0 + 7_200_000, 1]]);
    expect([...peaksByHour(counts, T0, T0 + 3_600_000, RANGE.to)]).toEqual([[T0 + 3_600_000, 1], [T0 + 7_200_000, 1]]);
  });

  it('minutes and the model\'s cost; the carrier\'s cost only with a rate, each call rounded up to the minute per carrier; cost per call and per handled call', async () => {
    const calls = [
      await call(TRACK, 'completed', T0, { provider: 'twilio' }), // 26 s: 1 minute
      await call([...TRACK, 'and one more thing', 'thanks', 'bye', 'ok', 'fine', 'right', 'yes', 'no', 'maybe', 'well', 'hm', 'so'], 'hangup', T0, { provider: 'telnyx' }), // 86 s: 2 minutes
      await call([OPENER], 'completed', T0, { provider: null }), // a chat: no minutes
    ];
    const f = figs(calls);
    const figures = f.figures;
    expect(figures.billedMinutes).toEqual({ twilio: 1, telnyx: 2 });
    expect(figures.voice).toBe(2);
    const app = getApp(defaultAppId());
    const off = insightsOf([f], undefined, RANGE);
    expect(off.carrier).toBeNull();
    expect(off.cost.carrierUsd).toBeNull();
    expect(off.cost.modelUsd).toBeCloseTo(calls.reduce((s, c) => s + c.row.costUsd, 0), 6);
    expect(off.minutes).toBeCloseTo((26_000 + 86_000) / 60_000, 1);
    const on = insightsOf([f], { twilio: 0.014 }, RANGE);
    expect(on.carrier).toEqual({ usd: 0.014, byCarrier: [{ carrier: 'twilio', minutes: 1, ratePerMin: 0.014, usd: 0.014 }], unpriced: 2 });
    const both = insightsOf([f], { twilio: 0.014, telnyx: 0.01 }, RANGE);
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
    const ins = insightsOf([figs(calls)], undefined, RANGE);
    expect(ins.struggles).toEqual([{ app: null, key: 'dob', label: 'Date of birth', value: { reasks: 1, silences: 1, ranOut: 1 } }]);
    expect(ins.refusals).toEqual([{ app: null, key: 'scope', label: 'scope', value: 1 }]);
    expect(ins.totals.stepUps).toBe(2);
  });

  it('on a host, each app\'s rows carry its name; the totals add every app', async () => {
    const one = await call(TRACK, 'completed', T0);
    const two = await call([OPENER, 'let me talk to a person'], 'handoff', T0);
    const app = getApp(defaultAppId());
    const ins = insightsOf([figs([one], 'north', { ...app, brand: { name: 'North Line' } } as App), figs([two], 'south', { ...app, brand: { name: 'South Line' } } as App)], undefined, RANGE);
    expect(ins.totals.calls).toBe(2);
    expect(ins.transfers).toEqual([{ app: 'South Line', key: 'live-agent', label: 'caller asked for a person', value: 1 }]);
    expect(ins.tasks.map((t) => t.app).sort()).toEqual(['North Line', 'South Line']);
    // The peak at once of every app's calls together, not each app's peak added.
    expect(ins.byHour).toEqual([{ hour: T0, calls: 2, peak: 2 }]);
    const apart = insightsOf([figs([await call(TRACK, 'completed', T0)], 'north'), figs([await call(TRACK, 'completed', T0 + 600_000)], 'south')], undefined, RANGE);
    expect(apart.totals.peak).toBe(1);
  });
});

describe('a day\'s figures read back from a file (dayDataFrom)', () => {
  it('takes them as written, and refuses any number that is not a finite count, any map of another shape, and any key that is not an hour', async () => {
    const d = dayDataOf([await call(TRACK, 'completed', T0), await call([OPENER], 'hangup', T0 + 60_000)], RANGE.from);
    const written = JSON.parse(JSON.stringify({ hours: d.hours, inProgress: minutesToRuns(d.minutes) })) as Record<string, unknown>;
    expect(dayDataFrom(written, FIGURES_VERSION, RANGE.from)).toEqual(d);
    // No call's own times in what is written: only runs of minutes, and counts.
    expect(written.inProgress).toEqual([15 * 60, 2, 1]);
    const hour = Object.keys(d.hours)[0]!;
    const bad = (patch: Record<string, unknown>): unknown => ({ ...written, hours: { [hour]: { ...(written.hours as Record<string, object>)[hour], ...patch } } });
    for (const patch of [{ hungUp: '<img src=x onerror=alert(1)>' }, { calls: -1 }, { costUsd: Number.NaN }, { transfers: { a: 'x' } }, { lengths: [1] }, { asked: { dob: { reasks: 1 } } }, { gapTopics: { a: { n: 1, latest: 5 } } }]) {
      expect(dayDataFrom(bad(patch) as never, FIGURES_VERSION, RANGE.from), JSON.stringify(patch)).toBeNull();
    }
    expect(dayDataFrom({ ...written, hours: { notAnHour: (written.hours as Record<string, object>)[hour] } }, FIGURES_VERSION, RANGE.from)).toBeNull();
    for (const runs of [[1, 'x', 1], [0, 1], [COUNTED_MINUTES - 1, 2, 1], [0, 0, 1], [0, 1, -1]]) expect(runsToMinutes(runs), JSON.stringify(runs)).toBeNull();
    // A version-2 file's spans are made counts by the minute as it is read.
    const v2 = dayDataFrom({ hours: written.hours, spans: [T0, T0 + 26_000, T0 + 60_000, T0 + 66_000] }, 2, RANGE.from)!;
    expect(minutesToRuns(v2.minutes)).toEqual([15 * 60, 2, 1]);
    expect(dayDataFrom({ hours: written.hours, spans: [1, 'x'] }, 2, RANGE.from)).toBeNull();
  });

  it('reads a version-1 file (a peak by the hour, after-hours by its old name, where callers hung up in words)', () => {
    const v1hour = { calls: 2, ended: 2, contained: 1, toPerson: 0, hungUp: 1, errors: 0, peak: 2, lengthMs: 1000, lengths: [2, 0, 0, 0, 0, 0, 0], voice: 2, voiceMs: 1000, billedMinutes: { twilio: 2 }, costUsd: 0.01, transfers: {}, abandoned: { 'the greeting': 1 }, asked: {}, tasks: {}, screenHits: 0, refusals: {}, stepUps: 0, afterHours: 1, hours: { 'start:handoff': 1 }, gaps: 0, gapKinds: {}, gapTopics: {} };
    const d = dayDataFrom({ hours: { [String(T0)]: v1hour } }, 1, RANGE.from)!;
    expect(d.peaks).toEqual({ [String(T0)]: 2 });
    expect(d.hours[String(T0)]).toMatchObject({ hoursRouted: 1, abandoned: { 'text:the greeting': 1 }, hours: { 'start::handoff': 1 } });
  });
});
