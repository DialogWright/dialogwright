import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { cassetteAgent } from '../agent/cassette';
import { businessFixtureApp } from '../define/__fixtures__/business/app';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { mockCodeVerifier } from '../core/tools';
import { choiceAnswer, sharp } from '../jev/distributions';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { JevClient, JevRequest, JevResponse } from '../jev/types';
import { runScenario, type Scenario, type ScenarioRunOptions } from '../harness-text/runner';
import { agentCassetteFile, agentPropertyMismatches, harnessAgent, isScriptedAgentStep, validAgentProperties } from '../harness-text/agentScript';
import type { TurnRun } from '../run/turn';

/**
 * Testing an app in agent mode (plan Task 9), on the fixture business: scripted calls whose steps name the
 * agent's answers (the stub regression's fake agent), held to properties over their turns; the agent
 * cassette a recorded run replays, a miss failing the call. No model is called.
 */

const app = businessFixtureApp;
const TODAY = '2026-11-09';
const CLUB = '+15555550142';

beforeAll(() => {
  resetAppsForTest();
  registerApp(app);
});

/** The decision model: the heuristic stub, a booking read by "study room". */
function jev(): JevClient {
  const stub = new HeuristicStubClient({ todayIso: TODAY, app });
  return {
    async ask(req: JevRequest): Promise<JevResponse> {
      const r = await stub.ask(req);
      const intent = req.questions.intent;
      if (intent === undefined || intent.type !== 'choice') return r;
      const text = ((req.state as { asr?: { text?: string } }).asr?.text ?? '').toLowerCase();
      return { ...r, answers: { ...r.answers, intent: choiceAnswer(sharp(Object.keys(intent.criteria), /study room/.test(text) ? 'booking' : 'none', 0.9)) } };
    },
  };
}

const opts = (extra: Partial<ScenarioRunOptions> = {}): ScenarioRunOptions => ({ client: jev(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0, tools: { ...app.systems(), codes: mockCodeVerifier }, agentSteps: true, ...extra });

const BOOK = 'I would like the study room for four people on Thursday morning';
const BOOK_VALUES = [{ field: 'people', value: 'four', words: 'four people' }, { field: 'day', value: '2026-11-12', words: 'Thursday' }, { field: 'window', value: 'morning', words: 'morning' }];

/** The club's booking: the values understood, the read-back, the yes. */
const booking = (expect: Scenario['expect']): Scenario => ({
  id: 'club-books',
  callerNumber: CLUB,
  steps: [
    // Asked twice on the turn (the day's free windows are shown): the second answer, once shown, is the same.
    { say: BOOK, agent: [{ reply: 'Lovely.', values: BOOK_VALUES }, { reply: 'Thursday morning is free.', values: BOOK_VALUES }] },
    { say: 'yes book it', agent: { reply: 'Done.' } },
  ],
  expect,
});

const HOLDS = { decision: 'prompt', promptId: 'anything_else', values: { people: 'four', day: '2026-11-12', window: 'morning' }, action: 'bookRoom', said: { notFigure: true }, readBackSaid: true, nothingDoneBefore: 'confirm' as const };

describe('a scripted call of an app in agent mode', () => {
  it('its steps name the agent\'s answers, and its properties hold over its turns', async () => {
    const r = await runScenario(booking(HOLDS), opts());
    expect(r.mismatches).toEqual([]);
    expect(r.pass).toBe(true);
  });

  it('a property that fails names its turn', async () => {
    const r = await runScenario(booking({ ...HOLDS, values: { people: 'five', day: '2026-11-12' }, action: { not: 'bookRoom' } }), opts());
    expect(r.pass).toBe(false);
    expect(r.mismatches).toEqual([
      'values: people: expected "five", got "four" in bookRoom on turn 2',
      'action: expected bookRoom never to run, but turn 2 ran it',
    ]);
    // A call that never says yes: no write, so no read-back said before it is asked of; nothing booked.
    const unconfirmed = await runScenario({ ...booking({ decision: 'prompt', action: 'bookRoom' }), steps: [booking(HOLDS).steps[0]!] }, opts());
    expect(unconfirmed.mismatches).toEqual(['action: expected bookRoom to run, but the gate never allowed it']);
  });

  it('a step the agent is asked on that names no answer fails the call, naming the step', async () => {
    const r = await runScenario({ id: 'unscripted', callerNumber: CLUB, steps: [{ say: BOOK }], expect: { decision: 'prompt' } }, opts());
    expect(r.mismatches).toEqual([`agent: step 1 (${JSON.stringify(BOOK)}) was asked of the agent, but names no agent answer`]);
  });

  it('a cassette miss fails the run', async () => {
    const empty = join(mkdtempSync(join(tmpdir(), 'agent-cassette-')), 'none.jsonl');
    const r = await runScenario(booking({ decision: 'prompt' }), opts({ agentSteps: false, agent: { client: cassetteAgent(empty, { model: 'mercury-3' }) } }));
    expect(r.pass).toBe(false);
    expect(r.mismatches).toContain('agent: turn 1 has no answer in the agent cassette (a miss): record it with --client record');
  });

  it('a step heard over a line is marked so: an answer that understood nothing is set aside, one with values is taken', async () => {
    const HOLD = 'I would like a hold on The Quiet Harbor';
    const over = (step: Scenario['steps'][number]): Scenario => ({ id: 'over', steps: [step], expect: { decision: 'prompt' } });
    const nothing = await runScenario(over({ say: 'um so yeah', overLine: true, agent: { reply: '' } }), opts());
    expect(nothing.runs.at(-1)!.result.setAside).toBeDefined();
    const taken = await runScenario(over({ say: HOLD, overLine: true, agent: { reply: '', values: [{ field: 'title', value: 'The Quiet Harbor', words: 'The Quiet Harbor' }] } }), opts());
    expect(taken.runs.at(-1)!.result.setAside).toBeUndefined();
    expect(taken.runs.at(-1)!.result.session.slots.request_title?.value).toBe('The Quiet Harbor');
    // Typed text is never over a line.
    await expect(runScenario({ ...over({ say: HOLD, overLine: true }), as: 'web' }, opts())).rejects.toThrow(/overLine: true\) needs a channel with speech/);
  });

  it('the steps\' agent answers and the properties are held to their shape when the calls are read', () => {
    expect(isScriptedAgentStep({ reply: 'Sure.', values: [{ field: 'day', value: '2026-11-12', words: 'Thursday' }], action: 'submit' })).toBe(true);
    expect(isScriptedAgentStep([{ reply: 'Sure.' }, { fail: 'timeout' }])).toBe(true);
    expect(isScriptedAgentStep({ values: [{ field: 'day', value: 12 }] })).toBe(false);
    expect(isScriptedAgentStep({ fail: 'slow' })).toBe(false);
    expect(isScriptedAgentStep([])).toBe(false);
    expect(validAgentProperties({ values: { day: '2026-11-12' }, action: { not: 'bookRoom' }, said: { notFigure: true }, readBackSaid: true, nothingDoneBefore: 'confirm' })).toBe(true);
    expect(validAgentProperties({ nothingDoneBefore: 'yes' })).toBe(false);
    expect(validAgentProperties({ said: { figure: true } })).toBe(false);
  });
});

describe('the review of Task 9', () => {
  it('where the turn asks again, one answer per asking is required: a missing one fails the call', async () => {
    const r = await runScenario({ ...booking(HOLDS), steps: [{ say: BOOK, agent: { reply: 'Lovely.', values: BOOK_VALUES } }, booking(HOLDS).steps[1]!] }, opts());
    expect(r.pass).toBe(false);
    expect(r.mismatches).toContain(`agent: step 1 (${JSON.stringify(BOOK)}) asked the agent again (shown a tool's result), but names 1 answer: give one per asking`);
  });

  it('readBackSaid holds the read-back\'s values to the write\'s, and allows the keypad rung between them', async () => {
    const r = await runScenario(booking(HOLDS), opts());
    const turns = r.runs;
    expect(agentPropertyMismatches(app, { readBackSaid: true }, turns, TODAY)).toEqual([]);
    // The write carrying a value the read-back never said.
    const write = turns.findIndex((t) => t.result.gateEvents.some((e) => e.decision.call.tool === 'bookRoom'));
    const moved = turns.map((t, i) => (i === write ? { ...t, result: { ...t.result, gateEvents: t.result.gateEvents.map((e) => (e.decision.call.tool === 'bookRoom' ? { ...e, decision: { ...e.decision, call: { ...e.decision.call, params: { ...e.decision.call.params, day: '2026-11-14' } } } } : e)) } } : t));
    expect(agentPropertyMismatches(app, { readBackSaid: true }, moved, TODAY)).toEqual([`readBackSaid: turn ${write} ran bookRoom with day "2026-11-14", but the read-back on turn ${write - 1} said "2026-11-12"`]);
    // The keypad rung said between the read-back and the yes.
    const rung = { ...turns[write - 1]!, result: { ...turns[write - 1]!.result, decision: { kind: 'prompt', promptId: 'confirm_dtmf', vars: {}, acks: [], target: 'confirm', options: ['yes', 'no'] } } } as unknown as TurnRun;
    const keyed = [...turns.slice(0, write), rung, ...turns.slice(write)];
    expect(agentPropertyMismatches(app, { readBackSaid: true }, keyed, TODAY)).toEqual([]);
  });

  it('readBackSaid compares a value the records hide as the call records it (a callback number by its last four)', async () => {
    const r = await runScenario({
      id: 'callback', steps: [
        { say: 'can someone call me back', agent: { action: 'callback' } },
        { say: 'my number is 555 555 0144', agent: { values: [{ field: 'callbackNumber', value: '5555550144', words: '555 555 0144' }] } },
        { say: 'yes please', agent: {} },
      ],
      expect: { decision: 'prompt', action: 'noteCallback', readBackSaid: true, values: { callbackNumber: '...0144' } },
    }, opts());
    expect(r.mismatches).toEqual([]);
  });

  it('a live agent model is refused in CI, as recording it is', () => {
    expect(() => harnessAgent('jev', app, '/rec', { CI: '1', INCEPTION_API_KEY: 'test-key' })).toThrow(/asking the agent model live .* refused in CI/);
  });
});

describe('the agent a regression asks', () => {
  it('on the stubs, the steps\' answers; recorded, the agent cassette beside the decision model\'s; recording refused in CI', () => {
    expect(harnessAgent('stub', app, '/rec')).toMatchObject({ runner: null, steps: true });
    const recorded = harnessAgent('recorded', app, '/rec');
    expect(recorded.steps).toBe(false);
    expect(recorded.runner?.client.model).toBe('mercury-3');
    expect(agentCassetteFile('/rec', app.agent!.model)).toBe('/rec/agent/inception__mercury-3.instant.realtime.jsonl');
    expect(recorded.header).toContain('agent cassette /rec/agent/inception__mercury-3.instant.realtime.jsonl (not found; every turn will miss until recorded)');
    expect(() => harnessAgent('record', app, '/rec', { CI: 'true', INCEPTION_API_KEY: 'test-key' })).toThrow(/refused in CI/);
    expect(() => harnessAgent('record', app, '/rec', {})).toThrow(/INCEPTION_API_KEY/);
  });
});
