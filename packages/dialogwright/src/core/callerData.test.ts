import { beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runScenario, type Scenario, type ScenarioRun } from '../harness-text/runner';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { JevClient } from '../jev/types';
import { registerApp, resetAppsForTest } from './app/registry';
import type { App } from './app/types';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { newSession } from './session';
import { handoff } from './decision';
import { callerOf, usableCallerNumber } from './callerNumber';
import { redactRecordSlots, redactSent } from '../trace/redact';
import type { TraceRecord } from '../trace/types';
import { TEXTING_DIR, textingApp } from '../testing/texting/app';
import { callbackApp } from '../testing/callback/app';
import { VOICE_RELAY } from '../channel/caps';
import { handoffDataProblems } from '../handoff/data';
import { recordsSettingFor } from '../server/config';

/**
 * Live findings item 26: the framework provides the call's data, and the limits on it are the app's.
 * A number the caller withheld is kept and used by default, ignored by every feature with app.yaml's
 * callerNumber.withheld: ignore; what a transfer sends is the app's delivery, never its records; the
 * records mask what was sent as they mask its source. Numbers fictional (555).
 */

const TODAY = '2026-10-07';
const MOBILE = '+15555550142';
const corpus = loadCorpus(join(TEXTING_DIR, 'fixtures', 'corpus.jsonl'), textingApp);

function stub(): JevClient {
  return new FixtureStubClient(corpus, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY }) });
}

function use(app: App): void {
  resetAppsForTest();
  registerApp(app);
}

beforeEach(() => use(textingApp));

async function call(o: Partial<Scenario>, ...says: string[]): Promise<ScenarioRun> {
  return runScenario({ id: 'call', steps: says.map((say) => ({ say })), expect: { decision: 'any' }, ...o }, { client: stub(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 });
}

const lookups = (r: ScenarioRun): string[] => r.runs.flatMap((x) => x.result.gateEvents.map((e) => e.decision.call.tool));

describe('a number the caller withheld, as the app chooses (app.yaml callerNumber.withheld)', () => {
  it('is kept marked and used by every feature by default (use)', async () => {
    const r = await call({ callerNumber: MOBILE, callerWithheld: true });
    const s = r.runs[0]!.result.session;
    expect(callerOf(s)).toEqual({ number: MOBILE, last4: '0142', withheld: true });
    expect(usableCallerNumber(textingApp, s)).toBe(MOBILE);
    expect(lookups(r)).toEqual(['findCallerByPhone']);
    expect(r.runs[0]!.record.callerNumber).toBe('kept');
  });

  it('is no number for any feature with ignore, and still the app\'s data', async () => {
    const ignoring: App = { ...textingApp, callerNumber: { ...textingApp.callerNumber!, withheld: 'ignore' } };
    use(ignoring);
    const r = await call({ callerNumber: MOBILE, callerWithheld: true }, "I'd like to open a request", "it's about an order");
    const s = r.runs.at(-1)!.result.session;
    expect(callerOf(s)).toEqual({ number: MOBILE, last4: '0142', withheld: true });
    expect(usableCallerNumber(ignoring, s)).toBeUndefined();
    expect(lookups(r)).toEqual([]);
    expect(r.runs[0]!.record.callerNumber).toBe('ignored');
    // Nothing offered: the text slot asks no offer by the number's last four.
    expect(JSON.stringify(r.runs.map((x) => x.result.decision))).not.toContain('0142');
    // A number not withheld is used as always.
    expect(lookups(await call({ callerNumber: MOBILE }))).toEqual(['findCallerByPhone']);
  });
});

describe('what a transfer sends is delivery; the records mask it by its source', () => {
  const app: App = {
    ...callbackApp,
    id: 'callback-sends-numbers',
    transfer: { ...callbackApp.transfer!, send: { ...callbackApp.transfer!.send, headers: { ...callbackApp.transfer!.send!.headers, 'X-Caller': 'callerNumber', 'X-Called': 'calledNumber' } } },
  };

  it('sends the numbers and a call data key whole, and the trace records them masked', () => {
    use(app);
    const s = newSession('t', 0, VOICE_RELAY, undefined, app.id);
    Object.assign(s, { callerNumber: MOBILE, calledNumber: '+15555550100', callData: { accountRef: 'AC-55501234' } });
    const d = handoff(s, 'live-agent');
    expect(d.transfer?.headers).toMatchObject({ 'X-Caller': MOBILE, 'X-Called': '+15555550100', 'X-Account-Ref': 'AC-55501234' });
    const recorded = redactSent(app, 'headers', d.transfer!.headers, 'length') as Record<string, string>;
    // The caller's number by its last four, the business's number whole, the key by its redact (last4).
    expect(recorded).toMatchObject({ 'X-Caller': '…0142', 'X-Called': '+15555550100', 'X-Account-Ref': '...1234' });
    const r = redactRecordSlots({ slots: {}, decision: d, actions: [] } as unknown as TraceRecord, 'length', app);
    expect(JSON.stringify(r)).not.toMatch(/5555550142|55501234/);
  });

  it('sends no caller\'s number for a withheld one the app ignores', () => {
    const ignoring: App = { ...app, id: 'callback-ignores', callerNumber: { withheld: 'ignore' } };
    use(ignoring);
    const s = newSession('t', 0, VOICE_RELAY, undefined, ignoring.id);
    Object.assign(s, { callerNumber: MOBILE, callerPrivacy: 'withheld' });
    expect(handoff(s, 'live-agent').transfer?.headers).not.toHaveProperty('X-Caller');
  });
});

describe('the offer\'s whole number, {callerNumber}', () => {
  it('is given to the offer line beside {last4}, and the trace masks it as the slot masks its value', async () => {
    const r = await call({ callerNumber: MOBILE }, "I'd like to open a request", "it's about an order");
    const offer = r.runs.map((x) => x.record).find((rec) => (rec.decision as { promptId?: string }).promptId === 'offer_textTo')!;
    expect((offer.decision as { vars: Record<string, string> }).vars).toMatchObject({ last4: '0142', callerNumber: expect.stringContaining('555') });
    expect(JSON.stringify(redactRecordSlots(offer, 'length'))).not.toContain('5550142');
  });
});

describe('the checks the app\'s own choices get', () => {
  it('warns, never refuses, of a secret held by its length sent as-is', () => {
    const problems = handoffDataProblems({ send: { pin: 'as-is' } }, { pin: { redact: 'length', statement: false } }, []);
    expect(problems).toEqual([expect.objectContaining({ path: ['send', 'pin'], warning: true })]);
  });

  it('honours records that keep the caller\'s number or name only with the console behind sign-in', () => {
    expect(recordsSettingFor({}, undefined)).toBeNull();
    expect(recordsSettingFor({ records: { businessNumbers: 'last4' } }, undefined)).toBe("records: the business's numbers by their last four");
    expect(() => recordsSettingFor({ records: { callerNumber: 'keep' } }, undefined)).toThrow(/CONSOLE_AUTH=token/);
    expect(() => recordsSettingFor({ records: { callerName: 'keep' } }, undefined)).toThrow(/callerName: redact/);
    expect(recordsSettingFor({ records: { callerNumber: 'keep' } }, { mode: 'token' })).toBe("records: the caller's number kept whole");
  });
});
