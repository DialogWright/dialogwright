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
import { spokenText } from '../prompts/render';
import { runTurn, type TurnRun } from '../run/turn';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { mockCodeVerifier } from '../core/tools';
import { newSession, type Session } from '../core/session';
import { checkAgentReply, shapeLeak } from './agentLine';
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

async function call(script: Record<string, AgentAnswer>, steps: string[], opts: { chat?: boolean; judged?: (state: { agent: { said: string } }) => number | undefined } = {}): Promise<Call> {
  const tools = { ...app.systems(), codes: mockCodeVerifier };
  const judge = jev(opts.judged);
  const agent = fakeAgent((ctx) => {
    const words = ctx.conversation.at(-1)!.text;
    const out = script[words];
    if (out === undefined) throw new Error(`no answer scripted for "${words}"`);
    return out;
  });
  const o = { client: judge, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0, tools, agent: { client: agent } };
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

  it('a figure the caller said, or a value held, may be said back', async () => {
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
    const c = await call({ [words]: said('The Quiet Harbor, a lovely one. What name is it under?', [['title', 'The Quiet Harbor', words]]) }, [words]);
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
