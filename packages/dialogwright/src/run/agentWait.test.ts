import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAnswer, AgentClient, AgentContext, AgentResult } from '../agent/types';
import type { Action } from '../channel/actions';
import { VOICE_RELAY, WEB_CHAT } from '../channel/caps';
import { speechEvent, startEvent, textEvent, withCallerNumber, type SessionEvent } from '../channel/events';
import { BUSINESS_FIXTURE_DIR, code } from '../define/__fixtures__/business/app';
import { defineApp } from '../define/defineApp';
import { ANONYMOUS } from '../gate/principal';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { mockCodeVerifier } from '../core/tools';
import { newSession, type Session } from '../core/session';
import { runTurn, type TurnRun } from './turn';

/**
 * What a call hears while the agent model is slow (business.yaml's `waiting`; the agent-mode design, call 60):
 * the fixture business with `waiting: { afterMs: 100, upToMs: 600 }` and two lines, its runner's own voice
 * budget 300 ms (so the wait is the setting's), a fake agent model that answers after a delay set by the
 * caller's words and the attempt, and a channel that takes early lines. Real timers, short waits.
 */

const dir = mkdtempSync(join(tmpdir(), 'agent-wait-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
cpSync(BUSINESS_FIXTURE_DIR, dir, { recursive: true });
appendFileSync(join(dir, 'business.yaml'), '\nwaiting:\n  afterMs: 100\n  upToMs: 600\n  lines: ["One sec.", "Okay, one moment."]\n');
const app = defineApp(dir, code);
const TODAY = '2026-11-09';

beforeAll(() => {
  resetAppsForTest();
  registerApp(app);
});

const HOLD = 'I would like to place a hold on The Quiet Harbor';
const said = (reply: string, values: [string, string, string][] = []): AgentAnswer => ({ reply, values: values.map(([field, value, words]) => ({ field, value, words })), action: 'none', fromFacts: false });
const HOLD_ANSWER = said('Happy to help with that. What name is it under?', [['title', 'The Quiet Harbor', 'The Quiet Harbor']]);
const NAME = said('Thanks, Avery.', [['patronName', 'Avery Lane', 'Avery Lane']]);
const NOT_THE_SHAPE: AgentResult = { ok: false, reason: 'invalid', detail: 'the answer is not the shape', ms: 0 };

/** One answer of the fake model: what it gives, and after how long, by the caller's words and the attempt. */
type Scripted = (words: string, attempt: number) => { delayMs: number; out: AgentAnswer | 'invalid' };

function slowAgent(script: Scripted): AgentClient & { asked: number } {
  const client = {
    model: 'fake-agent',
    asked: 0,
    async answer(ctx: AgentContext, timeoutMs: number, attempt = 1): Promise<AgentResult> {
      client.asked += 1;
      const { delayMs, out } = script(ctx.conversation.at(-1)!.text, attempt);
      const t0 = performance.now();
      await new Promise((r) => setTimeout(r, Math.min(delayMs, timeoutMs + 50)));
      if (delayMs > timeoutMs) return { ok: false, reason: 'timeout', detail: `fake: no answer within ${timeoutMs} ms`, ms: timeoutMs };
      const ms = Math.round(performance.now() - t0);
      return out === 'invalid' ? { ...NOT_THE_SHAPE, ms } : { ok: true, answer: out, ms, raw: JSON.stringify(out) };
    },
  };
  return client;
}

interface Call {
  runs: TurnRun[];
  early: string[][];
  last: TurnRun;
}

async function call(script: Scripted, steps: string[], opts: { chat?: boolean; noEarly?: boolean; retry?: false; jevDelayMs?: number } = {}): Promise<Call> {
  const early: string[][] = [];
  const stub = new HeuristicStubClient({ todayIso: TODAY, app });
  const jev = opts.jevDelayMs === undefined ? stub : { ask: async (req: Parameters<typeof stub.ask>[0]) => (await new Promise((r) => setTimeout(r, opts.jevDelayMs)), stub.ask(req)) };
  const runOpts = {
    client: jev,
    thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0, tools: { ...app.systems(), codes: mockCodeVerifier },
    agent: { client: slowAgent(script), timeoutMs: { voice: 300, chat: 300 }, ...(opts.retry === false ? { retry: false } : {}) },
    ...(opts.noEarly === true ? {} : { early: (lines: readonly Action[]) => (early.push(lines.map((l) => JSON.stringify(l))), true) }),
  };
  let session: Session = newSession('S-wait', 0, opts.chat ? WEB_CHAT : VOICE_RELAY, ANONYMOUS, app.id);
  const runs: TurnRun[] = [];
  const run = async (event: SessionEvent): Promise<void> => {
    const r = await runTurn(session, event, runOpts);
    runs.push(r);
    session = r.result.session;
  };
  await run(withCallerNumber(startEvent(), opts.chat ? undefined : '+15555550199'));
  for (const text of steps) await run(opts.chat ? textEvent(text) : speechEvent(text));
  return { runs, early, last: runs.at(-1)! };
}

/** The fake model: the request at once; "Avery Lane" after `ms`, its answer `out`. */
const nameAfter = (ms: number, out: AgentAnswer | 'invalid' = NAME): Scripted => (w) => (w === HOLD ? { delayMs: 0, out: HOLD_ANSWER } : { delayMs: ms, out });
const lineTexts = (c: Call): string => JSON.stringify(c.early);

describe('a line while the agent model is slow on a call (business.yaml waiting)', () => {
  it('an answer in time says nothing meanwhile, and waits no differently', async () => {
    const c = await call(nameAfter(0), [HOLD, 'Avery Lane']);
    expect(c.early).toEqual([]);
    expect(c.last.record.agent).toMatchObject({ use: 'used' });
    expect(c.last.record.agent!.filler).toBeUndefined();
  });

  it('an answer in time, the decision model slower: the model was not slow, nothing said', async () => {
    const c = await call(nameAfter(0), [HOLD, 'Avery Lane'], { jevDelayMs: 250 });
    expect(c.early).toEqual([]);
    expect(c.last.record.agent).toMatchObject({ use: 'used' });
    expect(c.last.record.agent!.filler).toBeUndefined();
  });

  it('an answer after afterMs: the first line said at once, then the reply, past the runner\'s own 300 ms', async () => {
    const c = await call(nameAfter(350), [HOLD, 'Avery Lane']);
    expect(c.early).toHaveLength(1);
    expect(lineTexts(c)).toContain('One sec.');
    expect(c.last.record.agent).toMatchObject({ use: 'used', filler: { promptId: 'agent_wait_1', said: true } });
    expect(c.last.record.agent!.filler!.atMs).toBeGreaterThanOrEqual(90);
    expect(c.last.result.session.slots.request_patronName!.value).toBe('avery lane');
    expect(c.last.result.session.agent!.waitLine).toBe(0);
  });

  it('an answer past upToMs: the line, then the turn\'s fallback, the question waited on', async () => {
    const c = await call(nameAfter(900), [HOLD, 'Avery Lane']);
    expect(c.early).toHaveLength(1);
    expect(c.last.record.agent).toMatchObject({ use: 'failed', fallback: 'timeout', filler: { promptId: 'agent_wait_1', said: true } });
    expect(c.last.result.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_request_patronName' });
  });

  it('an answer not in its shape, then a good one within the wait: one line, the second answer used', async () => {
    const script: Scripted = (w, attempt) => (w === HOLD ? { delayMs: 0, out: HOLD_ANSWER } : attempt === 1 ? { delayMs: 120, out: 'invalid' } : { delayMs: 120, out: NAME });
    const c = await call(script, [HOLD, 'Avery Lane']);
    expect(c.early).toHaveLength(1);
    expect(c.last.record.agent).toMatchObject({ use: 'used', retried: { invalid: 'the answer is not the shape' }, filler: { promptId: 'agent_wait_1', said: true } });
    expect(c.last.result.session.slots.request_patronName!.value).toBe('avery lane');
  });

  it('never the same line twice in a row on a call: the next slow turn says the next line', async () => {
    const script: Scripted = (w) => ({ delayMs: w === HOLD ? 0 : 200, out: w === HOLD ? HOLD_ANSWER : w === 'Avery Lane' ? NAME : said('Two copies.', [['copies', 'two', 'two copies']]) });
    const c = await call(script, [HOLD, 'Avery Lane', 'two copies']);
    expect(c.runs.at(-2)!.record.agent!.filler).toMatchObject({ promptId: 'agent_wait_1' });
    expect(c.last.record.agent!.filler).toMatchObject({ promptId: 'agent_wait_2' });
    expect(lineTexts(c)).toContain('Okay, one moment.');
  });

  it('not in a chat: its own budget (AGENT_TIMEOUT_CHAT_MS), and no line', async () => {
    const c = await call(nameAfter(350), [HOLD, 'Avery Lane'], { chat: true });
    expect(c.early).toEqual([]);
    expect(c.last.record.agent).toMatchObject({ use: 'failed', fallback: 'timeout' });
    expect(c.last.record.agent!.filler).toBeUndefined();
  });

  it('with no early lines (a harness): the line recorded as due and not said, the wait the same', async () => {
    const c = await call(nameAfter(350), [HOLD, 'Avery Lane'], { noEarly: true });
    expect(c.last.record.agent).toMatchObject({ use: 'used', filler: { promptId: 'agent_wait_1', said: false } });
    expect(c.last.result.session.agent!.waitLine).toBeUndefined();
  });
});
