import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerApp, resetAppsForTest } from '../../core/app/registry';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { runScenario, type Scenario } from '../../harness-text/runner';
import { loadCorpus } from '../../jev/corpus';
import { FixtureStubClient } from '../../jev/fixtureStub';
import { HeuristicStubClient } from '../../jev/heuristicStub';
import { FakeRenderClient } from '../../render/fake';
import { MESSAGE_DIR, messageApp } from '../../testing/message/app';
import { parseFrameLog } from '../frameLog';
import { summaryOfTrace } from './calls';
import { dayDataFrom, dayDataOf, factsOfTrace, FIGURES_VERSION, insightsOf, minutesToRuns, sumHours, DAY_MINUTES, type CallSummary } from './figures';
import { wordingRows } from './view.js';
import { renderFiguresOf } from './wordingFigures';

/**
 * Insights for generated wording ("measured, not assumed"): calls of the message fixture served
 * generated and served fixed (RENDER_SHARE), compared on containment, re-asks, frustration, length and
 * cost, with each generated line's fallback rate and latency, and the lines' cost in Insights' cost.
 */

const TODAY = '2026-10-13';
const T0 = Date.parse('2026-10-13T15:00:00Z');
const RANGE = { from: Date.parse('2026-10-13T00:00:00Z'), to: Date.parse('2026-10-13T23:59:59.999Z') };
const STEPS: Scenario['steps'] = [
  { say: 'can I leave a message for Dana' },
  { say: "it's Morgan Lee" },
  { say: 'five five five five five five zero one four two' },
  { say: 'please call me about the March invoice before Friday, I think we were charged twice for the same delivery' },
  { say: 'yes, pass it on' },
];

beforeAll(() => {
  resetAppsForTest();
  registerApp(messageApp);
});

/** One call of the fixture, ended as the agent ended it, its summary and facts as calls.ts reads them. */
async function call(sid: string, share: number, failSummary = false): Promise<CallSummary> {
  const corpus = loadCorpus(join(MESSAGE_DIR, 'fixtures', 'corpus.jsonl'), messageApp);
  const client = new FixtureStubClient(corpus, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY, app: messageApp }), app: messageApp });
  let at = T0;
  // The read-back is framed: its summary span, worded with a number its message does not have, falls back.
  const renderer = { client: new FakeRenderClient(failSummary ? { spans: { confirm_take_message: 'a call back on 555 555 0199' } } : {}), share };
  const run = await runScenario({ id: sid, steps: STEPS, expect: { decision: 'any' } }, { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => (at += 5_000), renderer });
  const records = run.runs.map((r) => r.record);
  const last = new Date(at + 1_000).toISOString();
  const frames = parseFrameLog(JSON.stringify({ ts: last, dir: 'out', msg: { type: 'end', handoffData: JSON.stringify({ reasonCode: 'completed' }) } }));
  const row = summaryOfTrace(records, frames, messageApp)!;
  return { row: { ...row, provider: 'twilio' }, facts: factsOfTrace(records, messageApp) };
}

describe('generated wording in Insights', () => {
  it('a call\'s facts: its group, and each generated line tried, said generated or fallen back, with its time', async () => {
    const c = await call('CA-gen', 100, true);
    expect(c.facts.render).toMatchObject({ group: 'generated', frustrated: 0 });
    expect(c.facts.render!.prompts.confirm_take_message).toMatchObject({ tried: 1, generated: 0, fellBack: 1 });
    expect(c.facts.render!.prompts.ask_caller).toMatchObject({ tried: 1, generated: 1, fellBack: 0 });
    expect(c.facts.render!.costUsd).toBeGreaterThan(0);
    // The lines' cost is in the call's cost, beside the decision model's.
    expect(c.row.costUsd).toBeGreaterThanOrEqual(c.facts.render!.costUsd);
  });

  it('the two groups side by side, each line\'s fallback rate and latency, and the lines\' cost; kept in a day\'s file and read back', async () => {
    const calls = [await call('CA-1', 100), await call('CA-2', 100, true), await call('CA-3', 0)];
    const d = dayDataOf(calls, RANGE.from);
    const minutes = new Uint32Array(2 * DAY_MINUTES);
    minutes.set(d.minutes);
    const i = insightsOf([{ id: null, app: messageApp, figures: sumHours(Object.values(d.hours)), hourCalls: {}, base: RANGE.from, minutes, peaks: {}, older: [], unreadable: [] }], undefined, RANGE);
    expect(i.wording!.generated).toMatchObject({ calls: 2, containment: 1, frustratedShare: 0 });
    expect(i.wording!.fixed).toMatchObject({ calls: 1, containment: 1 });
    const summary = i.wording!.prompts.find((p) => p.promptId === 'confirm_take_message')!;
    expect(summary).toMatchObject({ tried: 2, generated: 1, fallbackRate: 0.5 });
    expect(summary.meanMs).not.toBeNull();
    expect(i.wording!.costUsd).toBeGreaterThan(0);
    expect(i.cost.modelUsd).toBeGreaterThanOrEqual(i.wording!.costUsd);
    // As a day's file holds it, and read back.
    const file = JSON.parse(JSON.stringify({ hours: d.hours, inProgress: minutesToRuns(d.minutes) }));
    const back = dayDataFrom(file, FIGURES_VERSION, RANGE.from)!;
    expect(sumHours(Object.values(back.hours)).render).toEqual(sumHours(Object.values(d.hours)).render);
    // The page's rows.
    const rows = wordingRows(i.wording!);
    expect(rows.compare[0]).toEqual(['Calls', '2', '1']);
    expect(rows.prompts.find((p) => p.cells[0] === 'confirm_take_message')!.cells.slice(0, 4)).toEqual(['confirm_take_message', '2', '1', '50%']);
  });

  it('an app that generates nothing has no wording figures; a file\'s malformed ones are not read', () => {
    expect(insightsOf([], undefined, RANGE).wording).toBeUndefined();
    expect(renderFiguresOf({ groups: { generated: {}, fixed: {} }, prompts: {}, costUsd: 0 })).toBeNull();
    expect(renderFiguresOf({ groups: { generated: { calls: -1 } }, prompts: {}, costUsd: 0 })).toBeNull();
  });
});
