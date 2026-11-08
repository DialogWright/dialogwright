import { performance } from 'node:perf_hooks';
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAgent } from '../agent/fake';
import type { AgentClient } from '../agent/types';
import { VOICE_RELAY, WEB_CHAT } from '../channel/caps';
import { speechEvent, startEvent, textEvent, withCallerNumber } from '../channel/events';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { newSession, type Session } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { mockCodeVerifier } from '../core/tools';
import { businessFixtureApp } from '../define/__fixtures__/business/app';
import { ANONYMOUS } from '../gate/principal';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { JevClient, JevRequest, JevResponse } from '../jev/types';
import { runTurn, type RunOptions } from './turn';

/**
 * The agent model in the run (run/turn.ts): asked beside the decision model, never after it, within its
 * channel's budget, and only on the turns it can answer. Real timers, short delays.
 */

const app = businessFixtureApp;
const TODAY = '2026-11-09';
const ANSWER = { reply: 'Happy to help. What name is it under?', values: [{ field: 'title', value: 'The Quiet Harbor', words: 'The Quiet Harbor' }], action: 'none', fromFacts: false };

beforeAll(() => {
  resetAppsForTest();
  registerApp(app);
});

/**
 * The heuristic stub, each answer to the turn's questions `delayMs` late. The drift judge of the agent's
 * reply (render/agentLine.ts) is asked after both, in series, by design: it answers at once here, so the
 * timings below are the turn's own.
 */
function slowJev(delayMs: number): JevClient {
  const stub = new HeuristicStubClient({ todayIso: TODAY, app });
  return {
    async ask(req: JevRequest): Promise<JevResponse> {
      if (!Object.hasOwn(req.questions, 'renderAgentDrift')) await new Promise((r) => setTimeout(r, delayMs));
      return stub.ask(req);
    },
  };
}

function opts(client: JevClient, agent: AgentClient, timeoutMs?: { voice: number; chat: number }): RunOptions {
  return { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, tools: { ...app.systems(), codes: mockCodeVerifier }, agent: { client: agent, ...(timeoutMs !== undefined ? { timeoutMs } : {}) } };
}

async function started(o: RunOptions, chat = false): Promise<Session> {
  const s = newSession('S-run', 0, chat ? WEB_CHAT : VOICE_RELAY, ANONYMOUS, app.id);
  return (await runTurn(s, withCallerNumber(startEvent(), chat ? undefined : '+15555550199'), o)).result.session;
}

describe('the agent model in the run', () => {
  it('Jev and the agent run at once: the turn takes about the slower of the two, not their sum', async () => {
    const asked: number[] = [];
    const agent = fakeAgent(() => {
      asked.push(performance.now());
      return ANSWER;
    }, { delayMs: 150 });
    const o = opts(slowJev(150), agent);
    const s = await started(o);
    const t0 = performance.now();
    const r = await runTurn(s, speechEvent('I would like a hold on The Quiet Harbor'), o);
    const took = performance.now() - t0;
    expect(r.result.session.slots.request_title!.value).toBe('The Quiet Harbor');
    expect(took).toBeGreaterThanOrEqual(140);
    expect(took).toBeLessThan(280);
    expect(r.record.timing.agentMs).toBe(150);
  });

  it('an answer past its channel\'s budget is a timeout: the fallback is said and the turn does not wait for it', async () => {
    const agent = fakeAgent(() => ANSWER, { delayMs: 2000 });
    const o = opts(slowJev(0), agent, { voice: 300, chat: 3000 });
    const s = await started(o);
    const t0 = performance.now();
    const r = await runTurn(s, speechEvent('I would like a hold on The Quiet Harbor'), o);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.record.agent).toMatchObject({ use: 'failed', fallback: 'timeout' });
    expect(r.result.session.slots.request_title!.value).toBeNull();
  });

  it('a chat waits the chat\'s budget', async () => {
    let budget = 0;
    const agent: AgentClient = { model: 'probe', answer: async (_ctx, timeoutMs) => ((budget = timeoutMs), { ok: true, answer: ANSWER, ms: 1 }) };
    const o = opts(slowJev(0), agent);
    const s = await started(o, true);
    await runTurn(s, textEvent('I would like a hold on The Quiet Harbor'), o);
    expect(budget).toBe(3000);
  });

  it('is not asked at the call\'s start, on silence, or at the offer of the caller\'s number', async () => {
    let asked = 0;
    const agent = fakeAgent(() => ((asked += 1), { reply: '', values: [], action: 'callback', fromFacts: false }));
    const o = opts(slowJev(0), agent);
    const s = await started(o);
    expect(asked).toBe(0);
    // The callback note offers the number the caller is calling from: its yes or no is the decision model's alone.
    const offered = (await runTurn(s, speechEvent('please have someone call me'), o)).result.session;
    expect(asked).toBe(1);
    expect(offered.pendingConfirmation).toMatchObject({ target: 'slot', offered: true });
    const r = await runTurn(offered, speechEvent('yes'), o);
    expect(asked).toBe(1);
    expect(r.record.agent).toBeUndefined();
  });

  it('a client that throws is an error, never the turn\'s failure', async () => {
    const agent: AgentClient = { model: 'broken', answer: async () => { throw new TypeError('boom'); } };
    const o = opts(slowJev(0), agent);
    const s = await started(o);
    const r = await runTurn(s, speechEvent('I would like a hold on The Quiet Harbor'), o);
    expect(r.record.agent).toMatchObject({ use: 'failed', fallback: 'error', detail: 'the agent client threw (TypeError)' });
  });
});
