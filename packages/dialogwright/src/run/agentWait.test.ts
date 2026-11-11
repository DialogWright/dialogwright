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
import { questionAfterFiller, type TurnRun } from './turn';
import { Continuation } from './continuation';
import { holdsReply } from '../server/adapter';
import type { TurnResult } from '../core/turn';
import { JevClientError } from '../jev/types';
import { noulAnswer } from '../jev/distributions';

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

interface CallOptions {
  chat?: boolean;
  noEarly?: boolean;
  retry?: false;
  jevDelayMs?: number;
  /** The decision model's utteranceComplete on these words (the caller read as not finished under 0.6). */
  unfinished?: string;
  /** The decision model fails on these words. */
  jevFails?: string;
  /** The caller came back in before these words (Continuation.resumed): they continue the words before them. */
  resumedBefore?: string;
  /** These words were heard over a line the caller could not interrupt (UserSpeech.overLine, SPEECH_OVER_LINE=unless-miss). */
  overLine?: string;
}

async function call(script: Scripted, steps: string[], opts: CallOptions = {}): Promise<Call> {
  const early: string[][] = [];
  const stub = new HeuristicStubClient({ todayIso: TODAY, app });
  const jev = {
    ask: async (req: Parameters<typeof stub.ask>[0]) => {
      if (opts.jevDelayMs !== undefined) await new Promise((r) => setTimeout(r, opts.jevDelayMs));
      const text = (req.state as { asr?: { text?: string } }).asr?.text;
      if (text !== undefined && text === opts.jevFails) throw new JevClientError('the decision model timed out');
      const r = await stub.ask(req);
      return text !== undefined && text === opts.unfinished && req.questions.utteranceComplete !== undefined ? { ...r, answers: { ...r.answers, utteranceComplete: noulAnswer(0.2) } } : r;
    },
  };
  const runOpts = {
    client: jev,
    thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0, tools: { ...app.systems(), codes: mockCodeVerifier },
    agent: { client: slowAgent(script), timeoutMs: { voice: 300, chat: 300 }, ...(opts.retry === false ? { retry: false } : {}) },
    // As the voice relay's early lines (server/adapter.ts): none where it would hold the reply for a caller not finished (INCOMPLETE_WAIT_MS, under 0.6).
    ...(opts.noEarly === true ? {} : { early: (lines: readonly Action[], result: TurnResult) => (holdsReply(result, 0.6) !== null ? false : (early.push(lines.map((l) => JSON.stringify(l))), true)) }),
  };
  let session: Session = newSession('S-wait', 0, opts.chat ? WEB_CHAT : VOICE_RELAY, ANONYMOUS, app.id);
  const runs: TurnRun[] = [];
  // Through the call's Continuation, as the voice server runs every turn.
  const continuation = new Continuation(300);
  const run = async (event: SessionEvent): Promise<void> => {
    const r = await continuation.run(session, event, runOpts);
    runs.push(r);
    session = r.result.session;
  };
  await run(withCallerNumber(startEvent(), opts.chat ? undefined : '+15555550199'));
  for (const text of steps) {
    if (text === opts.resumedBefore) continuation.resumed();
    await run(opts.chat ? textEvent(text) : text === opts.overLine ? { ...speechEvent(text), overLine: true as const } : speechEvent(text));
  }
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
    expect(c.last.record.filler).toBeUndefined();
  });

  it('an answer in time, the decision model slower: the model was not slow, nothing said', async () => {
    const c = await call(nameAfter(0), [HOLD, 'Avery Lane'], { jevDelayMs: 250 });
    expect(c.early).toEqual([]);
    expect(c.last.record.agent).toMatchObject({ use: 'used' });
    expect(c.last.record.filler).toBeUndefined();
  });

  it('an answer after afterMs: the first line said at once, then the reply, past the runner\'s own 300 ms', async () => {
    const c = await call(nameAfter(350), [HOLD, 'Avery Lane']);
    expect(c.early).toHaveLength(1);
    expect(lineTexts(c)).toContain('One sec.');
    expect(c.last.record.agent).toMatchObject({ use: 'used' });
    expect(c.last.record.filler).toMatchObject({ promptId: 'agent_wait_1', said: true });
    expect(c.last.record.filler!.atMs).toBeGreaterThanOrEqual(90);
    expect(c.last.result.session.slots.request_patronName!.value).toBe('avery lane');
    expect(c.last.result.session.agent!.waitLine).toBe(0);
  });

  it('an answer past upToMs: the line, then the turn\'s fallback, the question waited on', async () => {
    const c = await call(nameAfter(900), [HOLD, 'Avery Lane']);
    expect(c.early).toHaveLength(1);
    expect(c.last.record.agent).toMatchObject({ use: 'failed', fallback: 'timeout' });
    expect(c.last.record.filler).toMatchObject({ promptId: 'agent_wait_1', said: true });
    expect(c.last.result.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_request_patronName' });
  });

  it('an answer not in its shape, then a good one within the wait: one line, the second answer used', async () => {
    const script: Scripted = (w, attempt) => (w === HOLD ? { delayMs: 0, out: HOLD_ANSWER } : attempt === 1 ? { delayMs: 120, out: 'invalid' } : { delayMs: 120, out: NAME });
    const c = await call(script, [HOLD, 'Avery Lane']);
    expect(c.early).toHaveLength(1);
    expect(c.last.record.agent).toMatchObject({ use: 'used', retried: { invalid: 'the answer is not the shape' } });
    expect(c.last.record.filler).toMatchObject({ promptId: 'agent_wait_1', said: true });
    expect(c.last.result.session.slots.request_patronName!.value).toBe('avery lane');
  });

  it('never the same line twice in a row on a call: the next slow turn says the next line', async () => {
    const script: Scripted = (w) => ({ delayMs: w === HOLD ? 0 : 200, out: w === HOLD ? HOLD_ANSWER : w === 'Avery Lane' ? NAME : said('Two copies.', [['copies', 'two', 'two copies']]) });
    const c = await call(script, [HOLD, 'Avery Lane', 'two copies']);
    expect(c.runs.at(-2)!.record.filler).toMatchObject({ promptId: 'agent_wait_1' });
    expect(c.last.record.filler).toMatchObject({ promptId: 'agent_wait_2' });
    expect(lineTexts(c)).toContain('Okay, one moment.');
  });

  it('the next line is another across a turn the Continuation runs again (the words continued): never the same twice running', async () => {
    const script: Scripted = (w) => (w === HOLD ? { delayMs: 0, out: HOLD_ANSWER } : { delayMs: 200, out: w === 'Avery' ? said('Thanks.') : NAME });
    const c = await call(script, [HOLD, 'Avery', 'Lane'], { resumedBefore: 'Lane' });
    expect(c.last.record.joined).toEqual({ fragments: ['Avery', 'Lane'] });
    expect(c.runs.at(-2)!.record.filler).toMatchObject({ promptId: 'agent_wait_1', said: true });
    expect(c.last.record.filler).toMatchObject({ promptId: 'agent_wait_2', said: true });
    expect(c.last.result.session.agent!.waitLine).toBe(1);
  });

  it('not in a chat: its own budget (AGENT_TIMEOUT_CHAT_MS), and no line', async () => {
    const c = await call(nameAfter(350), [HOLD, 'Avery Lane'], { chat: true });
    expect(c.early).toEqual([]);
    expect(c.last.record.agent).toMatchObject({ use: 'failed', fallback: 'timeout' });
    expect(c.last.record.filler).toBeUndefined();
  });

  it('a caller the decision model reads as not finished (a reply the relay would hold): no line over them, the reply waited for as before', async () => {
    const c = await call(nameAfter(350), [HOLD, 'Avery Lane'], { unfinished: 'Avery Lane' });
    expect(c.early).toEqual([]);
    expect(c.last.record.filler).toMatchObject({ promptId: 'agent_wait_1', said: false });
    expect(c.last.result.session.agent!.waitLine).toBeUndefined();
  });

  it('a turn the decision model\'s reading shows will be decided without the answer: no line, and no wait past the runner\'s own budget', async () => {
    const c = await call(nameAfter(500), [HOLD, 'Avery Lane'], { jevFails: 'Avery Lane' });
    expect(c.early).toEqual([]);
    expect(c.last.record.filler).toBeUndefined();
    expect(c.last.record.agent).toMatchObject({ use: 'dropped', dropped: 'decision-model-failed' });
    expect(c.last.record.agent!.ms).toBe(300);
  });

  it('at a form\'s read-back: no line, the runner\'s own budget, and no asking again, so the scripted reading is not delayed', async () => {
    const DETAILS = 'Avery Lane, two copies, Thursday morning, and call me at 555 555 0144';
    const DETAILS_ANSWER = said('Thanks, Avery.', [['patronName', 'Avery Lane', 'Avery Lane'], ['copies', 'two', 'two copies'], ['day', '2026-11-12', 'Thursday'], ['window', 'morning', 'morning'], ['callbackNumber', '5555550144', '555 555 0144']]);
    const YES = 'yes, place the hold';
    const script: Scripted = (w, attempt) => (w === HOLD ? { delayMs: 0, out: HOLD_ANSWER } : w === DETAILS ? { delayMs: 0, out: DETAILS_ANSWER } : attempt === 1 ? { delayMs: 50, out: 'invalid' } : { delayMs: 0, out: said('Great!') });
    const asked: number[] = [];
    const c = await call((w, a) => (w === YES && asked.push(a), script(w, a)), [HOLD, DETAILS, YES]);
    expect(asked).toEqual([1]);
    expect(c.early).toEqual([]);
    expect(c.last.record.agent).toMatchObject({ use: 'failed', fallback: 'invalid', scripted: 'read' });
    expect(c.last.record.agent!.retried).toBeUndefined();
    const slow = await call((w, a) => (w === YES ? { delayMs: 450, out: said('Great!') } : script(w, a)), [HOLD, DETAILS, YES]);
    expect(slow.early).toEqual([]);
    expect(slow.last.record.agent).toMatchObject({ use: 'failed', fallback: 'timeout', scripted: 'read' });
  });

  it('words heard over a line: no line for the model\'s slowness, the wait the same, the answer used (call 61)', async () => {
    const c = await call(nameAfter(350), [HOLD, 'Avery Lane'], { overLine: 'Avery Lane' });
    expect(c.early).toEqual([]);
    expect(c.last.record.filler).toBeUndefined();
    expect(c.last.record.agent).toMatchObject({ use: 'used' });
    expect(c.last.result.session.slots.request_patronName!.value).toBe('avery lane');
    expect(c.last.result.session.agent!.waitLine).toBeUndefined();
  });

  it('words heard over a line that are set aside: no line said before them, so no silence after one (call 61)', async () => {
    const c = await call((w) => (w === HOLD ? { delayMs: 0, out: HOLD_ANSWER } : { delayMs: 350, out: said('Sure.') }), [HOLD, 'mm hmm okay'], { overLine: 'mm hmm okay' });
    expect(c.early).toEqual([]);
    expect(c.last.record.filler).toBeUndefined();
    expect(c.last.result.setAside).toBe('speech-over-line');
    expect(c.last.result.decision).toEqual({ kind: 'ignore' });
  });

  it('a turn set aside after a line for the model\'s slowness says the question it was on again, never silence', () => {
    const c = { kind: 'ignore' as const };
    const session = { ...newSession('S-aside', 0, VOICE_RELAY, ANONYMOUS, app.id), lastPromptText: "What's your name?" };
    const setAside = { session, decision: c, actions: [], setAside: 'speech-over-line' } as unknown as TurnResult;
    const again = questionAfterFiller(setAside);
    expect(again.decision).toEqual({ kind: 'replay', text: "What's your name?" });
    expect(JSON.stringify(again.actions)).toContain("What's your name?");
    expect(again.setAside).toBe('speech-over-line');
    expect(again.session).toBe(session);
    // Any other turn as it is.
    const taken = { ...setAside, setAside: undefined } as unknown as TurnResult;
    expect(questionAfterFiller(taken)).toBe(taken);
  });

  it('with no early lines (a harness): the line recorded as due and not said, the wait the same', async () => {
    const c = await call(nameAfter(350), [HOLD, 'Avery Lane'], { noEarly: true });
    expect(c.last.record.agent).toMatchObject({ use: 'used' });
    expect(c.last.record.filler).toMatchObject({ promptId: 'agent_wait_1', said: false });
    expect(c.last.result.session.agent!.waitLine).toBeUndefined();
  });
});
