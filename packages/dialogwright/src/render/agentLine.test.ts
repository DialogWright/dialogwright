import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAgent } from '../agent/fake';
import type { AgentAnswer } from '../agent/types';
import { VOICE_RELAY, WEB_CHAT } from '../channel/caps';
import { speechEvent, startEvent, textEvent, withCallerNumber, type SessionEvent } from '../channel/events';
import { businessFixtureApp } from '../define/__fixtures__/business/app';
import { ANONYMOUS } from '../gate/principal';
import { choiceAnswer, noulAnswer, sharp } from '../jev/distributions';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { JevClient, JevRequest, JevResponse } from '../jev/types';
import { saidLineOf, spokenText } from '../prompts/render';
import { runTurn, type TurnRun } from '../run/turn';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { mockCodeVerifier } from '../core/tools';
import { newSession, type Session } from '../core/session';
import { checkAgentReply, judgedHistory, shapeLeak } from './agentLine';
import { redactRecordSlots } from '../trace/redact';
import { AGENT_DRIFT_QUESTION_ID } from './checks';

/**
 * An agent line held to the facts (render/agentLine.ts), on the fixture business (an invented library):
 * the agent model's reply passes the checks by code and the drift judge, or its fixed line is said and the
 * records say so. A fake agent model, and the heuristic stub as the decision model and the judge (its
 * agent judge, stubAgentDrift, or a reading a test scripts). No model is called.
 */

const app = businessFixtureApp;
const TODAY = '2026-11-09'; // a Monday
const STRANGER = '+15555550199';

beforeAll(() => {
  resetAppsForTest();
  registerApp(app);
});

/** The decision model and the judge: the heuristic stub, the request read by keyword, the judge's reading scripted where `judged` gives one. */
function jev(judged?: (state: { agent: { said: string } }) => number | undefined): JevClient & { judged: JevRequest[] } {
  const stub = new HeuristicStubClient({ todayIso: TODAY, app });
  const judgedReqs: JevRequest[] = [];
  return {
    judged: judgedReqs,
    async ask(req: JevRequest): Promise<JevResponse> {
      const r = await stub.ask(req);
      const answers = { ...r.answers };
      if (Object.hasOwn(req.questions, AGENT_DRIFT_QUESTION_ID)) {
        judgedReqs.push(req);
        const score = judged?.(req.state as { agent: { said: string } });
        if (score !== undefined) answers[AGENT_DRIFT_QUESTION_ID] = noulAnswer(score);
        return { ...r, answers };
      }
      const text = ((req.state as { asr?: { text?: string } }).asr?.text ?? '').toLowerCase();
      const intent = req.questions.intent;
      if (intent !== undefined && intent.type === 'choice') answers.intent = choiceAnswer(sharp(Object.keys(intent.criteria), /\bhold\b/.test(text) ? 'request' : 'none', 0.9));
      return { ...r, answers };
    },
  };
}

const said = (reply: string, values: [string, string, string][] = [], more: Partial<AgentAnswer> = {}): AgentAnswer => ({
  reply,
  values: values.map(([field, value, words]) => ({ field, value, words })),
  action: 'none',
  fromFacts: false,
  ...more,
});

interface Call {
  runs: TurnRun[];
  last: TurnRun;
  judge: ReturnType<typeof jev>;
}

async function call(script: Record<string, AgentAnswer>, steps: string[], opts: { chat?: boolean; judged?: (state: { agent: { said: string } }) => number | undefined; wrap?: (j: JevClient) => JevClient; checkTimeoutMs?: number } = {}): Promise<Call> {
  const tools = { ...app.systems(), codes: mockCodeVerifier };
  const judge = jev(opts.judged);
  const agent = fakeAgent((ctx) => {
    const words = ctx.conversation.at(-1)!.text;
    const out = script[words];
    if (out === undefined) throw new Error(`no answer scripted for "${words}"`);
    return out;
  });
  const o = { client: opts.wrap?.(judge) ?? judge, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0, tools, agent: { client: agent, ...(opts.checkTimeoutMs !== undefined ? { checkTimeoutMs: { voice: opts.checkTimeoutMs, chat: opts.checkTimeoutMs } } : {}) } };
  let session: Session = newSession('S-line', 0, opts.chat ? WEB_CHAT : VOICE_RELAY, ANONYMOUS, app.id);
  const runs: TurnRun[] = [];
  const run = async (event: SessionEvent): Promise<void> => {
    const r = await runTurn(session, event, o);
    runs.push(r);
    session = r.result.session;
  };
  await run(withCallerNumber(startEvent(), opts.chat ? undefined : STRANGER));
  for (const s of steps) await run(opts.chat ? textEvent(s) : speechEvent(s));
  return { runs, last: runs.at(-1)!, judge };
}

const heard = (r: TurnRun): string => spokenText(app, r.result.decision);
const sayTexts = (r: TurnRun): string[] => r.result.actions.flatMap((a) => (a.type === 'say' ? [a.parts.map((p) => ('text' in p ? p.text : '')).join('')] : []));
const fallbacks = (r: TurnRun) => r.audit.length > 0 ? r.audit.filter((e) => e.type === 'render_fallback') : r.result.audit.filter((d) => d.type === 'render_fallback');

const HOLD = 'I would like to place a hold on The Quiet Harbor';
const TITLE = [['title', 'The Quiet Harbor', 'The Quiet Harbor']] as [string, string, string][];
const NAME_Q = "What's your name?";
const PRICE_LINE = 'Fees are explained at the desk, by the person who looks at your account.';

describe('an agent line: the checks by code', () => {
  it('a figure not in the facts falls back: the fixed question is said, the reply refused and recorded', async () => {
    const c = await call({ [HOLD]: said('That usually runs about $80. What name is it under?', TITLE) }, [HOLD]);
    const t = c.last;
    expect(heard(t)).toBe(NAME_Q);
    expect(sayTexts(t)).toEqual([NAME_Q]);
    expect(t.result.decision).not.toHaveProperty('agent');
    expect(t.record.agent).toMatchObject({ replySaid: false, line: { source: 'agent', mode: 'fixed', fallback: 'foreign', refused: 'That usually runs about $80. What name is it under?', fixed: NAME_Q } });
    expect(t.result.audit).toContainEqual({ type: 'render_fallback', detail: { prompt: 'ask_request_patronName', reason: 'foreign', agent: true } });
    // No judge was asked: a check by code failed first.
    expect(c.judge.judged).toEqual([]);
  });

  it('"about four hundred" is a figure the facts do not hold: refused', async () => {
    const c = await call({ [HOLD]: said("It's about four hundred, give or take. What name is it under?", TITLE) }, [HOLD]);
    expect(c.last.record.agent!.line).toMatchObject({ mode: 'fixed', fallback: 'foreign' });
    expect(heard(c.last)).toBe(NAME_Q);
  });

  it('a value held may be said back, in the words it was cited from ("two copies")', async () => {
    const c = await call({ [HOLD]: said('Happy to help. What name is it under?', TITLE), 'Avery Lane, and I need two copies': said('Two copies for Avery, lovely. Which day would you collect them?', [['patronName', 'Avery Lane', 'Avery Lane'], ['copies', 'two', 'two copies']]) }, [HOLD, 'Avery Lane, and I need two copies']);
    expect(c.last.record.agent!.line).toMatchObject({ mode: 'generated', said: 'Two copies for Avery, lovely. Which day would you collect them?' });
  });

  it('"What\'s your name?values", a key of the answer\'s shape run into its words, is refused', async () => {
    const c = await call({ [HOLD]: said("Happy to help with that. What's your name?values", TITLE) }, [HOLD]);
    expect(c.last.record.agent!.line).toMatchObject({ mode: 'fixed', fallback: 'shape' });
    expect(heard(c.last)).toBe(NAME_Q);
  });

  it('shapeLeak reads the schema\'s own keys: glued to other words, or spelled as the shape spells them; a key as a word of its own passes', () => {
    expect(shapeLeak("What's your name?values")).toBe(true);
    expect(shapeLeak('Got it. fromFacts')).toBe(true);
    expect(shapeLeak('reply:"Thanks"')).toBe(true);
    expect(shapeLeak('Just a few words about the damage, please.')).toBe(false);
    expect(shapeLeak("What's the value of the order?")).toBe(false);
    expect(shapeLeak('A value-added service.')).toBe(false);
    // Ordinary words beside other marks pass (the review of Task 7): only the answer's JSON marks join a key to a word.
    expect(shapeLeak('Two words—that is all.')).toBe(false);
    expect(shapeLeak('Is it the value/price you want?')).toBe(false);
    expect(shapeLeak('A few actions, words and values.')).toBe(false);
    expect(shapeLeak('"Words" is what you said.')).toBe(false);
    expect(shapeLeak('Thanks.values')).toBe(true);
    expect(shapeLeak('{"values":[')).toBe(true);
    expect(shapeLeak('fixedLine')).toBe(true);
  });

  it('checkAgentReply: markup on a call, two questions, the word budget, a phrase to avoid, a web address not held', () => {
    const g = { channel: 'voice' as const, words: 12, avoid: ['no problem'], sources: ['Visit example.org/holds for more.'] };
    expect(checkAgentReply('**Sure.** What name?', g)).toBe('format');
    expect(checkAgentReply('Sure.\nWhat name?', g)).toBe('format');
    expect(checkAgentReply('**Sure.** What name?', { ...g, channel: 'chat' })).toBeNull();
    expect(checkAgentReply('Which book? And what name?', g)).toBe('question');
    expect(checkAgentReply('Sure thing, happy to help you with that today, what name is it under?', g)).toBe('words');
    expect(checkAgentReply('No problem. What name?', g)).toBe('avoid');
    expect(checkAgentReply('See example.com/fees. What name?', g)).toBe('foreign');
    expect(checkAgentReply('See example.org/holds. What name?', g)).toBeNull();
  });
});

describe('an agent line: the price line (review focus 1)', () => {
  it('price-pushed: "just ballpark it" gets the price line whole, and no figure, whatever the reply says', async () => {
    const c = await call({
      [HOLD]: said('Happy to help. What name is it under?', TITLE),
      'how much will it cost me? just ballpark it': said('Probably around four hundred. What name is it under?', [], { fromFacts: true, fixedLine: 'price' }),
    }, [HOLD, 'how much will it cost me? just ballpark it']);
    const t = c.last;
    expect(heard(t)).toBe(`${PRICE_LINE} ${NAME_Q}`);
    expect(sayTexts(t).join(' ')).not.toMatch(/\d|hundred/);
    expect(t.record.agent).toMatchObject({ fixedLine: 'price', replySaid: false });
    expect(t.record.agent!.line).toBeUndefined();
    // Nothing for the judge to read: the reply was never said (the judge read the first turn's alone).
    expect(c.judge.judged.map((r) => (r.state as { agent: { said: string } }).agent.said)).toEqual(['Happy to help. What name is it under?']);
    expect(t.result.session.agent!.conversation.at(-1)).toEqual({ who: 'line', text: `${PRICE_LINE} ${NAME_Q}` });
  });

  it('asked at the read-back, the price line is said whole and the read-back again as it stood, uncounted', async () => {
    const details = 'Avery Lane, two copies, Thursday morning, and call me at 555 555 0144';
    const c = await call({
      [HOLD]: said('Happy to help. What name is it under?', TITLE),
      [details]: said('Thanks, Avery.', [['patronName', 'Avery Lane', 'Avery Lane'], ['copies', 'two', 'two copies'], ['day', '2026-11-12', 'Thursday'], ['window', 'morning', 'morning'], ['callbackNumber', '5555550144', '555 555 0144']]),
      'and what will that cost': said('About a dollar a day.', [], { fromFacts: true, fixedLine: 'price' }),
    }, [HOLD, details, 'and what will that cost']);
    const t = c.last;
    expect(t.result.decision).toMatchObject({ promptId: 'readback_request' });
    expect(heard(t).startsWith(`${PRICE_LINE} Here's the hold:`)).toBe(true);
    expect(sayTexts(t).join(' ')).not.toMatch(/dollar/);
    expect(t.result.session.pendingConfirmation).toMatchObject({ target: 'form', attempts: 0 });
  });

  it('a reply that words a price itself without naming the price line falls back on its figure', async () => {
    const c = await call({ [HOLD]: said('Happy to help. What name is it under?', TITLE), 'just ballpark it': said('Ballpark, maybe twenty dollars. What name is it under?', [], { fixedLine: 'none' }) }, [HOLD, 'just ballpark it']);
    expect(c.last.record.agent!.line).toMatchObject({ mode: 'fixed', fallback: 'foreign' });
    expect(sayTexts(c.last).join(' ')).not.toMatch(/twenty|dollar/);
  });
});

describe('an agent line: the drift judge', () => {
  it('"this is Dana" is refused by the judge: the line speaks as no person; the judge\'s reading is kept', async () => {
    const c = await call({ [HOLD]: said('Hi, this is Dana at the desk. What name is it under?', TITLE) }, [HOLD]);
    const t = c.last;
    expect(t.record.agent!.line).toMatchObject({ mode: 'fixed', fallback: 'drift', judge: { score: 0.9, refuseAt: 0.5 } });
    expect(heard(t)).toBe(NAME_Q);
    expect(t.result.audit).toContainEqual({ type: 'render_fallback', detail: { prompt: 'ask_request_patronName', reason: 'drift', agent: true } });
  });

  it('a reply confirming availability no tool showed is refused', async () => {
    const c = await call({ [HOLD]: said('Thursday morning is available for you. What name is it under?', TITLE) }, [HOLD]);
    expect(c.last.record.agent!.line).toMatchObject({ mode: 'fixed', fallback: 'drift' });
    expect(heard(c.last)).toBe(NAME_Q);
  });

  it('a claim the facts do not hold, read so by the judge, is refused; one it passes is said with its reading', async () => {
    const claim = 'Our books are always in stock. What name is it under?';
    const refused = await call({ [HOLD]: said(claim, TITLE) }, [HOLD], { judged: (s) => (s.agent.said === claim ? 0.8 : undefined) });
    expect(refused.last.record.agent!.line).toMatchObject({ mode: 'fixed', fallback: 'drift', judge: { score: 0.8 } });
    const passed = await call({ [HOLD]: said('Happy to help with that. What name is it under?', TITLE) }, [HOLD], { judged: () => 0.2 });
    expect(passed.last.record.agent!.line).toMatchObject({ mode: 'generated', said: 'Happy to help with that. What name is it under?', judge: { score: 0.2, refuseAt: 0.5 } });
    expect(heard(passed.last)).toBe('Happy to help with that. What name is it under?');
  });

  it('the judge is given whose line speaks, what it may say, its fixed lines, what it understood (a text value with the caller\'s words), and the caller\'s words', async () => {
    const words = "it's that novel, The Quiet Harbor, the one about the lighthouse keeper";
    const c = await call({ [words]: said('The Quiet Harbor, a lovely book. What name is it under?', [['title', 'The Quiet Harbor', words]]) }, [words]);
    expect(c.last.record.agent!.line).toMatchObject({ mode: 'generated' });
    const state = c.judge.judged[0]!.state as { agent: Record<string, unknown>; quoted: { name: string; words: string }[] };
    expect(state.agent.speaks).toBe('the automated line of Example Library, speaking with a caller on a phone call');
    expect(state.agent.may_say).toContain('Holds are kept at the front desk for a week.');
    expect(state.agent.fixed_lines).toContain(PRICE_LINE);
    expect(state.agent.background).toEqual(['The desk has one person on most afternoons.']);
    expect(state.agent.understood).toEqual([{ field: 'title', about: "The book's title, as the caller gave it.", value: 'The Quiet Harbor', summary: true, words, confirmed: false }]);
    expect(state.quoted).toEqual([{ name: 'heard', words }]);
    const q = c.judge.judged[0]!.questions[AGENT_DRIFT_QUESTION_ID]!;
    expect(q.type).toBe('noul');
  });

  it('the line on the trace is masked as the records mask a value in it, said or refused', async () => {
    const reply = "We'll ring 5555550144 when it's in. How many copies?";
    const c = await call({ [HOLD]: said('Happy to help. What name is it under?', TITLE), 'Avery Lane, call me at 555 555 0144': said(reply, [['patronName', 'Avery Lane', 'Avery Lane'], ['callbackNumber', '5555550144', '555 555 0144']]) }, [HOLD, 'Avery Lane, call me at 555 555 0144'], { judged: (s) => (s.agent.said === reply ? 0.7 : undefined) });
    expect(c.last.record.agent!.line).toMatchObject({ mode: 'fixed', fallback: 'drift', refused: reply });
    const written = redactRecordSlots(c.last.record, 'length', app);
    expect(JSON.stringify(written.agent!.line)).not.toContain('5555550144');
  });

  it('a value the records hide is masked in what the judge is told', async () => {
    const c = await call({ [HOLD]: said('Happy to help. What name is it under?', TITLE), 'Avery Lane, call me at 555 555 0144': said('Thanks, Avery. How many copies?', [['patronName', 'Avery Lane', 'Avery Lane'], ['callbackNumber', '5555550144', '555 555 0144']]) }, [HOLD, 'Avery Lane, call me at 555 555 0144']);
    const state = c.judge.judged.at(-1)!.state as { agent: { understood: { field: string; value: string }[] } };
    expect(state.agent.understood.find((u) => u.field === 'callbackNumber')!.value).toBe('...0144');
  });
});

describe('an agent line: what a fallback leaves', () => {
  it('the core\'s records are corrected: the line said again on a repeat, and the conversation the agent model is sent', async () => {
    const c = await call({ [HOLD]: said('Hi, this is Dana. What name is it under?', TITLE) }, [HOLD]);
    const s = c.last.result.session;
    expect(s.lastPromptText).toBe(NAME_Q);
    expect(s.agent!.conversation.at(-1)).toEqual({ who: 'line', text: NAME_Q });
    expect(s.agent!.conversation.map((u) => u.text).join(' ')).not.toContain('Dana');
  });

  it('an aside that fails says nothing extra: the turn\'s own line follows, alone', async () => {
    const c = await call({ [HOLD]: said('We guarantee every hold.', TITLE) }, [HOLD]);
    const t = c.last;
    expect(t.record.agent!.line).toMatchObject({ mode: 'fixed', fallback: 'drift', act: 'acknowledge', fixed: '' });
    expect(sayTexts(t)).toEqual([NAME_Q]);
    expect(heard(t)).toBe(NAME_Q);
    expect(t.result.session.lastPromptText).toBe(NAME_Q);
    expect(t.result.session.agent!.conversation.at(-1)).toEqual({ who: 'line', text: NAME_Q });
  });

  it('an aside that passes is said before the turn\'s own line', async () => {
    const c = await call({ [HOLD]: said('Happy to help with that.', TITLE) }, [HOLD]);
    expect(sayTexts(c.last)).toEqual(['Happy to help with that.', NAME_Q]);
    expect(c.last.record.agent!.line).toMatchObject({ mode: 'generated', act: 'acknowledge' });
  });

  it('in a chat, the fixed line keeps its answer buttons and its chat words', async () => {
    const c = await call({ [HOLD]: said('Hi, this is Dana. What name is it under?', TITLE) }, [HOLD], { chat: true });
    expect(c.last.record.agent!.line).toMatchObject({ mode: 'fixed', fallback: 'drift' });
    expect(sayTexts(c.last)).toEqual([NAME_Q]);
  });
});

describe('the review of Task 7', () => {
  const NAMED = 'Avery Lane';

  it('a figure the caller proposes is not the line\'s: "is it under a hundred?" against "Yes, it\'s under a hundred"', async () => {
    const asked = 'is it under a hundred dollars?';
    const c = await call({ [HOLD]: said('Happy to help. What name is it under?', TITLE), [asked]: said("Yes, it's under a hundred dollars. What name is it under?", [], { fromFacts: true }) }, [HOLD, asked]);
    expect(c.last.record.agent!.line).toMatchObject({ mode: 'fixed', fallback: 'foreign', refused: "Yes, it's under a hundred dollars. What name is it under?" });
    expect(heard(c.last)).toBe(NAME_Q);
  });

  it('a choice value\'s cited words are no source: "two copies, is it under a hundred" cited for copies=two does not let "under a hundred" pass (the review of Task 8)', async () => {
    const words = 'two copies, is it under a hundred dollars';
    const c = await call({ [HOLD]: said('Happy to help. What name is it under?', TITLE), [words]: said('Two copies, and yes, under a hundred dollars. What name is it under?', [['copies', 'two', words]]) }, [HOLD, words]);
    expect(c.last.record.agent!.values).toMatchObject([{ field: 'copies', outcome: 'accepted' }]);
    expect(c.last.record.agent!.line).toMatchObject({ mode: 'fixed', fallback: 'foreign' });
    // Its held value and display stay sources: "two copies" said back passes.
    const ok = await call({ [HOLD]: said('Happy to help. What name is it under?', TITLE), [words]: said('Two copies, lovely. What name is it under?', [['copies', 'two', words]]) }, [HOLD, words]);
    expect(ok.last.record.agent!.line).toMatchObject({ mode: 'generated' });
  });

  it('"in two days?" against "Yes, two days is fine": the caller\'s figure, refused', async () => {
    const asked = 'can you have it ready in two days?';
    const c = await call({ [HOLD]: said('Happy to help. What name is it under?', TITLE), [asked]: said('Yes, two days is fine. What name is it under?', [], { fromFacts: true }) }, [HOLD, asked]);
    expect(c.last.record.agent!.line).toMatchObject({ mode: 'fixed', fallback: 'foreign' });
  });

  it('"$80" against a fact with a dollar figure of its own: refused; the fact\'s own figure passes', () => {
    const g = { channel: 'voice' as const, words: 30, avoid: [], sources: ['A replacement library card is $2.'] };
    expect(checkAgentReply("It's $80 for the large print.", g)).toBe('foreign');
    expect(checkAgentReply('A replacement card is $2.', g)).toBeNull();
  });

  it('the judge is asked whether the line agrees to a figure, a time or a promise the caller proposed, and is given the call so far, masked', async () => {
    const c = await call({ [HOLD]: said('Happy to help. What name is it under?', TITLE), 'Avery Lane, call me at 555 555 0144': said('Thanks, Avery. How many copies?', [['patronName', 'Avery Lane', 'Avery Lane'], ['callbackNumber', '5555550144', '555 555 0144']]), 'two please': said('Two it is. Which day would you collect them?', [['copies', 'two', 'two']]) }, [HOLD, 'Avery Lane, call me at 555 555 0144', 'two please']);
    const q = c.judge.judged.at(-1)!.questions[AGENT_DRIFT_QUESTION_ID] as { criteria: { true: string } };
    expect(q.criteria.true).toContain('it agrees to, or states as its own, a figure, a time or a promise the caller proposed');
    const state = c.judge.judged.at(-1)!.state as { agent: { conversation: { who: string; text: string }[] }; quoted: { words: string }[] };
    // The call before this turn, as the agent model is sent it: this turn's words quoted apart, the callback number masked.
    expect(state.agent.conversation.map((u) => u.who)).toEqual(['line', 'caller', 'line', 'caller', 'line']);
    expect(state.agent.conversation[3]!.text).not.toContain('0144 ');
    expect(JSON.stringify(state.agent.conversation)).not.toContain('555 555 0144');
    expect(state.quoted).toEqual([{ name: 'heard', words: 'two please' }]);
  });

  it('the history the judge is given takes off only the line this turn noted, never an earlier one', () => {
    const s = newSession('S-history', 0, VOICE_RELAY, ANONYMOUS, app.id);
    s.agent = { conversation: [{ who: 'line', text: 'Thanks for calling.' }, { who: 'caller', text: 'hello' }, { who: 'line', text: 'How can I help?' }], failures: 0 };
    expect(judgedHistory(app, s, 'hello', 'How can I help?')).toEqual([{ who: 'line', text: 'Thanks for calling.' }]);
    expect(judgedHistory(app, s, 'something else', 'Another line.')).toEqual(s.agent.conversation);
  });

  it('the stub judge reads the caller\'s quoted words as the caller\'s: a promise asked for and made is refused', async () => {
    const asked = 'can you promise me it will be kept for me?';
    const c = await call({ [HOLD]: said('Happy to help. What name is it under?', TITLE), [asked]: said('I promise it will be kept for you. What name is it under?', [], { fromFacts: true }) }, [HOLD, asked]);
    expect(c.last.record.agent!.line).toMatchObject({ mode: 'fixed', fallback: 'drift' });
  });

  it('a judge that does not answer in time: the fixed line, the reply refused as late', async () => {
    const slow = (j: JevClient): JevClient => ({ async ask(req) {
      if (Object.hasOwn(req.questions, AGENT_DRIFT_QUESTION_ID)) await new Promise((r) => setTimeout(r, 200));
      return j.ask(req);
    } });
    const c = await call({ [HOLD]: said('Happy to help with that. What name is it under?', TITLE) }, [HOLD], { wrap: slow, checkTimeoutMs: 50 });
    expect(c.last.record.agent!.line).toMatchObject({ mode: 'fixed', fallback: 'timeout' });
    expect(heard(c.last)).toBe(NAME_Q);
  });

  it('a judge that errs, or answers no reading: the fixed line', async () => {
    const failing = (j: JevClient): JevClient => ({ async ask(req) {
      if (Object.hasOwn(req.questions, AGENT_DRIFT_QUESTION_ID)) throw new Error('judge down');
      return j.ask(req);
    } });
    const c = await call({ [HOLD]: said('Happy to help with that. What name is it under?', TITLE) }, [HOLD], { wrap: failing });
    expect(c.last.record.agent!.line).toMatchObject({ mode: 'fixed', fallback: 'drift-error' });
    const silent = (j: JevClient): JevClient => ({ async ask(req) {
      const r = await j.ask(req);
      if (!Object.hasOwn(req.questions, AGENT_DRIFT_QUESTION_ID)) return r;
      const { [AGENT_DRIFT_QUESTION_ID]: _a, ...rest } = r.answers;
      return { ...r, answers: rest };
    } });
    const d = await call({ [HOLD]: said('Happy to help with that. What name is it under?', TITLE) }, [HOLD], { wrap: silent });
    expect(d.last.record.agent!.line).toMatchObject({ mode: 'fixed', fallback: 'drift-error' });
  });

  it('words the screen flagged are never answered by the reply; words the screen did not read are never answered either', async () => {
    const flagging = (j: JevClient): JevClient => ({ async ask(req) {
      const r = await j.ask(req);
      return Object.hasOwn(req.questions, 'manipulation') ? { ...r, answers: { ...r.answers, manipulation: noulAnswer(0.97) } } : r;
    } });
    const flagged = await call({ [HOLD]: said('Happy to help with that. What name is it under?', TITLE) }, [HOLD], { wrap: flagging });
    expect(flagged.last.result.quarantined).toBe(true);
    expect(flagged.last.record.agent).toMatchObject({ use: 'dropped', replySaid: false });
    expect(sayTexts(flagged.last).join(' ')).not.toContain('Happy to help');
    const unread = (j: JevClient): JevClient => ({ async ask(req) {
      const r = await j.ask(req);
      if (!Object.hasOwn(req.questions, 'manipulation')) return r;
      const { manipulation: _m, ...rest } = r.answers;
      return { ...r, answers: rest };
    } });
    const c = await call({ [HOLD]: said('Happy to help with that. What name is it under?', TITLE) }, [HOLD], { wrap: unread });
    expect(c.last.record.agent!.line).toMatchObject({ mode: 'fixed', skipped: 'screen' });
    expect(heard(c.last)).toBe(NAME_Q);
  });

  it('an aside at the read-back that fails says nothing extra: the read-back again as it stands, uncounted', async () => {
    const details = 'Avery Lane, two copies, Thursday morning, and call me at 555 555 0144';
    const c = await call({
      [HOLD]: said('Happy to help. What name is it under?', TITLE),
      [details]: said('Thanks, Avery.', [['patronName', 'Avery Lane', 'Avery Lane'], ['copies', 'two', 'two copies'], ['day', '2026-11-12', 'Thursday'], ['window', 'morning', 'morning'], ['callbackNumber', '5555550144', '555 555 0144']]),
      'do you guarantee it?': said('We guarantee every hold.', [], { fromFacts: true }),
    }, [HOLD, details, 'do you guarantee it?']);
    const [, , readBack, asked] = c.runs;
    expect(readBack!.result.decision).toMatchObject({ promptId: 'readback_request' });
    expect(asked!.record.agent!.line).toMatchObject({ mode: 'fixed', fallback: 'drift', act: 'acknowledge', fixed: '' });
    expect(asked!.result.decision).toMatchObject({ promptId: 'readback_request' });
    expect(sayTexts(asked!)).toEqual(sayTexts(readBack!));
    expect(asked!.result.session.pendingConfirmation).toMatchObject({ target: 'form', attempts: (readBack!.result.session.pendingConfirmation as { attempts: number }).attempts });
  });

  it('the fixed line said in a reply\'s place is the prompt\'s own line (its said line noted), with its chat buttons; an aside leaves the question its buttons', async () => {
    const chatty = { ...app, chat: { ...(app.chat ?? {}), replies: 'on' as const } };
    resetAppsForTest();
    registerApp(chatty);
    try {
      const fell = await call({ [HOLD]: said('Happy to help. What name is it under?', TITLE), [NAMED]: said('Hi, this is Dana. How many copies?', [['patronName', 'Avery Lane', 'Avery Lane']]) }, [HOLD, NAMED], { chat: true });
      expect(fell.last.record.agent!.line).toMatchObject({ mode: 'fixed', fallback: 'drift' });
      const last = fell.last.result.actions.at(-1)!;
      expect(last.type === 'say' && saidLineOf(last)?.promptId).toBe('ask_request_copies');
      expect(last.type === 'say' ? last.replies : undefined).toEqual(['One', 'Two', 'Three']);
      const aside = await call({ [HOLD]: said('Happy to help. What name is it under?', TITLE), [NAMED]: said('Thanks, Avery.', [['patronName', 'Avery Lane', 'Avery Lane']]) }, [HOLD, NAMED], { chat: true });
      expect(aside.last.record.agent!.line).toMatchObject({ mode: 'generated', act: 'acknowledge' });
      const asks = aside.last.result.actions.at(-1)!;
      expect(asks.type === 'say' ? asks.replies : undefined).toEqual(['One', 'Two', 'Three']);
    } finally {
      resetAppsForTest();
      registerApp(app);
    }
  });

  it('a slow judge is the caller\'s wait: the turn\'s total time counts it', async () => {
    const slow = (j: JevClient): JevClient => ({ async ask(req) {
      if (Object.hasOwn(req.questions, AGENT_DRIFT_QUESTION_ID)) await new Promise((r) => setTimeout(r, 120));
      return j.ask(req);
    } });
    const c = await call({ [HOLD]: said('Happy to help with that. What name is it under?', TITLE) }, [HOLD], { wrap: slow, checkTimeoutMs: 1000 });
    expect(c.last.record.agent!.line).toMatchObject({ mode: 'generated' });
    expect(c.last.record.timing.renderMs).toBeGreaterThanOrEqual(110);
    expect(c.last.record.timing.totalMs).toBeGreaterThanOrEqual(c.last.record.timing.renderMs!);
  });
});
