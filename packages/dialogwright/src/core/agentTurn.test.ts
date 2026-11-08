import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAgent, type FakeAgentFailure } from '../agent/fake';
import type { AgentAnswer, AgentContext } from '../agent/types';
import { VOICE_RELAY, WEB_CHAT } from '../channel/caps';
import { speechEvent, startEvent, textEvent, withCallerNumber, type SessionEvent } from '../channel/events';
import { businessFixtureApp, type LibrarySystems } from '../define/__fixtures__/business/app';
import { ANONYMOUS } from '../gate/principal';
import { choiceAnswer, noulAnswer, sharp } from '../jev/distributions';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { JevClient, JevRequest, JevResponse } from '../jev/types';
import { spokenText } from '../prompts/render';
import { runTurn, type TurnRun } from '../run/turn';
import { registerApp, resetAppsForTest } from './app/registry';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { mockCodeVerifier } from './tools';
import { newSession, type Session } from './session';
import { agentContextOf, agentTurn } from './agentTurn';

/**
 * The agent turn (core/agentTurn.ts) on the fixture business (an invented library: holds for anyone, the
 * study room for a member club recognized by the number it calls from, a callback note), with a fake
 * agent model scripted by the caller's words and a decision model that reads only the turn-level
 * questions (the heuristic stub, its request read by keyword). No model is called.
 */

const app = businessFixtureApp;
const TODAY = '2026-11-09'; // a Monday
const CLUB = '+15555550142';
const STRANGER = '+15555550199';

beforeAll(() => {
  resetAppsForTest();
  registerApp(app);
});

/** The decision model: the heuristic stub, with the request read by keyword, side speech by "honey", and an optional delay. */
function jev(delayMs = 0): JevClient & { asked: JevRequest[] } {
  const stub = new HeuristicStubClient({ todayIso: TODAY, app });
  const asked: JevRequest[] = [];
  return {
    asked,
    async ask(req: JevRequest): Promise<JevResponse> {
      asked.push(req);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const r = await stub.ask(req);
      const text = ((req.state as { asr?: { text?: string } }).asr?.text ?? '').toLowerCase();
      const answers = { ...r.answers };
      const intent = req.questions.intent;
      if (intent !== undefined && intent.type === 'choice') {
        const labels = Object.keys(intent.criteria);
        const label = /study room/.test(text) ? 'booking' : /\bhold\b/.test(text) ? 'request' : /\b(person|someone)\b/.test(text) ? 'agent' : 'none';
        answers.intent = choiceAnswer(sharp(labels, label, 0.9));
      }
      if (/\bhoney\b/.test(text)) answers.addressedToSystem = noulAnswer(0.05);
      return { ...r, answers };
    },
  };
}

type Scripted = AgentAnswer | FakeAgentFailure;

/** An answer: the reply, the values (field, value, words), the action. */
const said = (reply: string, values: [string, string, string][] = [], action = 'none', fromFacts = false): AgentAnswer => ({
  reply,
  values: values.map(([field, value, words]) => ({ field, value, words })),
  action,
  fromFacts,
});

interface Step {
  text: string;
  overLine?: true;
}

interface Call {
  runs: TurnRun[];
  contexts: AgentContext[];
  sys: LibrarySystems;
  last: TurnRun;
}

/** A call: its start (from `number`), then each step's words, the agent answering each by its script (the caller's words to the answer). */
async function call(script: Record<string, Scripted>, steps: (string | Step)[], opts: { number?: string; chat?: boolean; jev?: JevClient; delayMs?: number; noAgent?: boolean } = {}): Promise<Call> {
  const tools = { ...app.systems(), codes: mockCodeVerifier };
  const contexts: AgentContext[] = [];
  const agent = fakeAgent((ctx) => {
    contexts.push(ctx);
    const words = ctx.conversation.at(-1)!.text;
    const out = script[words];
    if (out === undefined) throw new Error(`no answer scripted for "${words}"`);
    return out;
  }, opts.delayMs !== undefined ? { delayMs: opts.delayMs } : {});
  const runOpts = { client: opts.jev ?? jev(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0, tools, ...(opts.noAgent ? {} : { agent: { client: agent } }) };
  let session: Session = newSession('S-agent', 0, opts.chat ? WEB_CHAT : VOICE_RELAY, ANONYMOUS, app.id);
  const runs: TurnRun[] = [];
  const run = async (event: SessionEvent): Promise<void> => {
    const r = await runTurn(session, event, runOpts);
    runs.push(r);
    session = r.result.session;
  };
  await run(withCallerNumber(startEvent(), opts.chat ? undefined : (opts.number ?? STRANGER)));
  for (const step of steps) {
    const s = typeof step === 'string' ? { text: step } : step;
    await run(opts.chat ? textEvent(s.text) : { ...speechEvent(s.text), ...(s.overLine ? { overLine: true as const } : {}) });
  }
  return { runs, contexts, sys: tools.sys as LibrarySystems, last: runs.at(-1)! };
}

const heard = (r: TurnRun): string => spokenText(app, r.result.decision);
const promptOf = (r: TurnRun): string | undefined => ('promptId' in r.result.decision ? r.result.decision.promptId : undefined);
const value = (r: TurnRun, slot: string): string | null => r.result.session.slots[slot]!.value;
const toolCalls = (c: Call, tool: string) => c.runs.flatMap((r) => r.result.gateEvents.filter((e) => e.decision.call.tool === tool));

const HOLD = 'I would like to place a hold on The Quiet Harbor';
const HOLD_ANSWER = said('Happy to help with that. What name is it under?', [['title', 'The Quiet Harbor', 'The Quiet Harbor']]);
const DETAILS = 'Avery Lane, two copies, Thursday morning, and call me at 555 555 0144';
const DETAILS_ANSWER = said('Thanks, Avery.', [
  ['patronName', 'Avery Lane', 'Avery Lane'],
  ['copies', 'two', 'two copies'],
  ['day', '2026-11-12', 'Thursday'],
  ['window', 'morning', 'morning'],
  ['callbackNumber', '5555550144', '555 555 0144'],
]);
const READ_BACK = "Here's the hold: Avery Lane, two of The Quiet Harbor, collected Thursday, November 12 in the morning, and we'll call you at 5555550144. Is that right?";

describe('the agent turn: values', () => {
  it('a value with words the caller never said is dropped and the field asked', async () => {
    const c = await call({ [HOLD]: said('Sure, Thursday it is.', [['title', 'The Quiet Harbor', 'The Quiet Harbor'], ['day', '2026-11-12', 'Thursday']]) }, [HOLD]);
    const t = c.last;
    expect(t.result.session.form).toBe('request');
    // The title was said, and is held as the agent understood it; the day's words were never said.
    expect(t.result.session.slots.request_title).toMatchObject({ value: 'The Quiet Harbor', display: 'The Quiet Harbor', by: 'agent', confirmed: false });
    expect(value(t, 'request_day')).toBeNull();
    // The reply that took the day is not said: the day's own question is, in fixed words.
    expect(promptOf(t)).toBe('ask_request_day');
    expect(heard(t)).toBe('What day would you like to collect it?');
    expect(t.record.agent).toMatchObject({ use: 'used', replySaid: false, values: [{ field: 'title', slot: 'request_title', outcome: 'accepted', shown: 'The Quiet Harbor' }, { field: 'day', slot: 'request_day', outcome: 'words' }] });
  });

  it('several values and a correction in one turn: each checked, the correction replaces the old value, and the read-back says the new one', async () => {
    const c = await call({
      [HOLD]: said('Happy to help. How many copies?', [['title', 'The Quiet Harbor', 'The Quiet Harbor'], ['copies', 'one', 'The Quiet Harbor']]),
      'one copy please': said('One copy. What name is it under?', [['copies', 'one', 'one copy']]),
      'Avery Lane, actually two copies not one, Thursday morning, and call me at 555 555 0144': said('Got it.', [
        ['patronName', 'Avery Lane', 'Avery Lane'],
        ['copies', 'two', 'two copies not one'],
        ['day', '2026-11-12', 'Thursday'],
        ['window', 'morning', 'morning'],
        ['callbackNumber', '5555550144', '555 555 0144'],
      ]),
    }, [HOLD, 'one copy please', 'Avery Lane, actually two copies not one, Thursday morning, and call me at 555 555 0144']);
    const [, opened, one, all] = c.runs;
    // "one" cited from words that do not say it (the title): a choice is not tied to its words, so it is taken.
    expect(value(opened!, 'request_copies')).toBe('one');
    expect(value(one!, 'request_copies')).toBe('one');
    expect(value(all!, 'request_copies')).toBe('two');
    expect(value(all!, 'request_day')).toBe('2026-11-12');
    expect(promptOf(all!)).toBe('readback_request');
    expect(heard(all!)).toBe(READ_BACK);
    expect(all!.record.agent!.values.map((v) => v.outcome)).toEqual(['accepted', 'accepted', 'accepted', 'accepted', 'accepted']);
    // The read-back's values are masked in the record as the records mask the callback number.
    expect(all!.record.agent!.values.find((v) => v.field === 'callbackNumber')!.shown).toBe('5555550144');
  });

  it('a request said over the greeting opens its form and gives its values, with the fields of the forms the caller may open sent', async () => {
    const c = await call({ 'Avery Lane here, The Quiet Harbor please': said('Thanks, Avery. How many copies?', [['patronName', 'Avery Lane', 'Avery Lane'], ['title', 'The Quiet Harbor', 'The Quiet Harbor']]) }, ['Avery Lane here, The Quiet Harbor please']);
    // No form open: the fields of the forms an unknown caller may open (the request, not the booking), one of each name.
    expect(c.contexts[0]!.form).toBeNull();
    expect(c.contexts[0]!.fields.map((f) => f.name)).toEqual(['patronName', 'title', 'copies', 'format', 'day', 'window', 'callbackNumber']);
    const t = c.last;
    expect(t.result.session.form).toBe('request');
    // A name is held as the name fill holds it (lower case), and shown as said.
    expect(t.result.session.slots.request_patronName).toMatchObject({ value: 'avery lane', display: 'Avery Lane' });
    // The reply is said in place of the next field's question, its fallback.
    expect(t.result.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_request_copies', target: 'request_copies', agent: { reply: 'Thanks, Avery. How many copies?' } });
    expect(heard(t)).toBe('Thanks, Avery. How many copies?');
    expect(t.result.actions).toMatchObject([{ type: 'say', parts: [{ text: 'Thanks, Avery. How many copies?' }] }]);
    expect(t.record.agent!.replySaid).toBe(true);
  });
});

describe('the agent turn: the read-back', () => {
  const toReadBack = { [HOLD]: HOLD_ANSWER, [DETAILS]: DETAILS_ANSWER };

  it('every field filled says the read-back, in its fixed words, with the values shown', async () => {
    const c = await call(toReadBack, [HOLD, DETAILS]);
    expect(promptOf(c.last)).toBe('readback_request');
    expect(heard(c.last)).toBe(READ_BACK);
    expect(c.last.result.session.pendingConfirmation).toMatchObject({ target: 'form', form: 'request' });
    // Nothing is done before the yes.
    expect(toolCalls(c, 'placeHold')).toEqual([]);
  });

  it('a yes at the read-back sends the request through the gate, its then in order, and says its done line', async () => {
    const c = await call({ ...toReadBack, "yes that's right": said('Great!') }, [HOLD, DETAILS, "yes that's right"]);
    expect(toolCalls(c, 'placeHold').map((e) => e.decision.verdict)).toEqual(['ALLOW']);
    expect(toolCalls(c, 'notifyDesk').map((e) => e.decision.verdict)).toEqual(['ALLOW']);
    expect(c.sys.holds).toEqual([{ patronName: 'avery lane', title: 'The Quiet Harbor', copies: 'two', format: '', day: '2026-11-12', window: 'morning', callbackNumber: '5555550144' }]);
    expect(heard(c.last)).toContain("Thanks, Avery Lane. The desk will call you when it's ready.");
    expect(c.last.record.agent).toMatchObject({ use: 'used', replySaid: false });
  });

  it('a correction at the read-back says it again with the new value, and nothing is done', async () => {
    const c = await call({ ...toReadBack, 'no, three copies': said('Three, got it.', [['copies', 'three', 'three copies']]) }, [HOLD, DETAILS, 'no, three copies']);
    expect(promptOf(c.last)).toBe('readback_request');
    expect(heard(c.last)).toContain('Avery Lane, three of The Quiet Harbor');
    expect(toolCalls(c, 'placeHold')).toEqual([]);
  });

  it('a bare no asks what to change; the change named then is read back again', async () => {
    const c = await call({ ...toReadBack, no: said('What should I change?'), 'the day, make it Friday': said('Friday, then.', [['day', '2026-11-13', 'Friday']]) }, [HOLD, DETAILS, 'no', 'the day, make it Friday']);
    const [, , , bareNo, changed] = c.runs;
    expect(promptOf(bareNo!)).toBe('ask_change');
    expect(heard(bareNo!)).toBe('What should I change?');
    expect(promptOf(changed!)).toBe('readback_request');
    expect(heard(changed!)).toContain('collected Friday, November 13');
  });

  it('a then tool proposed before the yes is ignored, with no gate call', async () => {
    const c = await call({ [HOLD]: said('Sure. What name?', [['title', 'The Quiet Harbor', 'The Quiet Harbor']], 'notifyDesk') }, [HOLD]);
    expect(c.last.record.agent).toMatchObject({ action: 'notifyDesk', actionOutcome: 'ignored' });
    expect(c.last.result.gateEvents).toEqual([]);
    expect(c.contexts[0]!.actions.map((a) => a.name)).toEqual(['callback']);
  });

  it('a callback proposed opens the callback note, as a person asked for does', async () => {
    const c = await call({ [HOLD]: HOLD_ANSWER, 'can you just have her ring me back': said('Of course.', [], 'callback') }, [HOLD, 'can you just have her ring me back']);
    expect(c.contexts[1]!.actions.map((a) => a.name)).toEqual(['submit', 'callback', 'notifyDesk']);
    expect(c.last.result.session.form).toBe('callback');
    expect(heard(c.last)).toBe("I'll have someone from the desk call you back. Is the number you're calling from, ending in 0199, the best one to reach you?");
    expect(c.last.record.agent).toMatchObject({ action: 'callback', actionOutcome: 'taken' });
  });
});

describe('the agent turn: who may book (review focus 3)', () => {
  const BOOK = 'I would like the study room for four people tomorrow morning';
  const BOOK_ANSWER = said('Lovely.', [['people', 'four', 'four people'], ['day', '2026-11-10', 'tomorrow'], ['window', 'morning', 'morning']]);

  it('an account recognized by the number it calls from books, once it confirms the read-back', async () => {
    const c = await call({ [BOOK]: BOOK_ANSWER, 'yes book it': said('Done.') }, [BOOK, 'yes book it'], { number: CLUB });
    const [greeted, asked, booked] = c.runs;
    expect(greeted!.result.session.principal).toMatchObject({ kind: 'account', id: 'rivergate_book_club', level: 1 });
    expect(promptOf(asked!)).toBe('readback_booking');
    expect(heard(asked!)).toBe("So that's the study room for Rivergate Book Club, four people, Tuesday, November 10 in the morning. Shall I book it?");
    expect(toolCalls(c, 'bookRoom').map((e) => e.decision.verdict)).toEqual(['ALLOW']);
    expect(c.sys.bookings).toEqual([{ account: 'rivergate_book_club', people: 'four', day: '2026-11-10', window: 'morning' }]);
    expect(heard(booked!)).toContain("You're booked for Tuesday, November 10, morning.");
  });

  it('a caller claiming the account from a number not on file is told so and begun on the request: the booking is never offered, and nothing books', async () => {
    const claim = 'This is Rivergate Book Club, I would like the study room for four people tomorrow morning';
    const c = await call({ [claim]: BOOK_ANSWER }, [claim]);
    const t = c.last;
    expect(t.result.session.principal).toEqual(ANONYMOUS);
    expect(t.result.session.form).toBe('request');
    // The booking's fields were never offered to the model: only the forms this caller may open.
    expect(c.contexts[0]!.fields.map((f) => f.name)).not.toContain('people');
    // The people are no field of the request; the day and the window are.
    expect(t.record.agent!.values.map((v) => [v.field, v.outcome])).toEqual([['people', 'field'], ['day', 'accepted'], ['window', 'accepted']]);
    expect(heard(t)).toBe('Bookings are for our account holders; I can send a request instead. Lovely.');
    expect(toolCalls(c, 'bookRoom')).toEqual([]);
  });
});

describe('the agent turn: what the decision model decides alone', () => {
  it('side speech drops the agent\'s answer', async () => {
    const c = await call({ [HOLD]: HOLD_ANSWER, 'honey, the book is called The Quiet Harbor': said('Thanks.', [['patronName', 'Honey', 'honey']]) }, [HOLD, 'honey, the book is called The Quiet Harbor']);
    expect(c.last.result.decision).toEqual({ kind: 'ignore' });
    expect(value(c.last, 'request_patronName')).toBeNull();
    expect(c.last.record.agent).toMatchObject({ use: 'dropped', dropped: 'ignore', values: [] });
  });

  it('a person asked for is the callback note, whatever the agent answered', async () => {
    const c = await call({ 'can I talk to a person': said('Sure, let me take your details.', [['patronName', 'Avery', 'person']]) }, ['can I talk to a person']);
    expect(c.last.result.session.form).toBe('callback');
    expect(c.last.record.agent).toMatchObject({ use: 'dropped', dropped: 'handoff' });
  });

  it('the decision model asks no field\'s question in agent mode: the turn-level ones, and the yes or no at a read-back', async () => {
    const j = jev();
    await call({ [HOLD]: HOLD_ANSWER, [DETAILS]: DETAILS_ANSWER, "yes that's right": said('Great!') }, [HOLD, DETAILS, "yes that's right"], { jev: j });
    const asked = j.asked.map((r) => Object.keys(r.questions).filter((q) => !q.startsWith('screen')).sort());
    for (const q of asked) expect(q.every((id) => !id.startsWith('request_') && id !== 'intentChange' && id !== 'changeSlot')).toBe(true);
    expect(asked.at(-1)).toContain('confirmsYes');
    expect(asked[0]).not.toContain('confirmsYes');
  });
});

describe('the agent turn: speech over a line', () => {
  it('over a line, an answer with nothing is set aside: nothing said, the session as it was', async () => {
    const c = await call({ [HOLD]: HOLD_ANSWER, 'mm hmm okay': said('Sure.') }, [HOLD, { text: 'mm hmm okay', overLine: true }]);
    const [, opened, over] = c.runs;
    expect(c.contexts[1]!.overLine).toBe(true);
    expect(over!.result.setAside).toBe('speech-over-line');
    expect(over!.result.decision).toEqual({ kind: 'ignore' });
    expect(over!.result.session).toEqual(opened!.result.session);
    expect(over!.record.agent).toMatchObject({ dropped: 'speech-over-line' });
  });

  it('over a line, an answer with a value is a turn', async () => {
    const c = await call({ [HOLD]: HOLD_ANSWER, 'Avery Lane': said('Thanks, Avery.', [['patronName', 'Avery Lane', 'Avery Lane']]) }, [HOLD, { text: 'Avery Lane', overLine: true }]);
    expect(c.last.result.setAside).toBeUndefined();
    expect(value(c.last, 'request_patronName')).toBe('avery lane');
  });
});

describe('the agent turn: a slow or failed model', () => {
  it('a timeout says the next field\'s question and counts a fallback', async () => {
    const c = await call({ [HOLD]: HOLD_ANSWER, 'Avery Lane': { fail: 'timeout' } }, [HOLD, 'Avery Lane']);
    expect(promptOf(c.last)).toBe('ask_request_patronName');
    expect(heard(c.last)).toBe("What's your name?");
    expect(c.last.record.agent).toMatchObject({ use: 'failed', fallback: 'timeout', replySaid: false });
    expect(c.last.result.session.agent!.failures).toBe(1);
  });

  it('invalid JSON says the same', async () => {
    const c = await call({ [HOLD]: HOLD_ANSWER, 'Avery Lane': { fail: 'invalid', detail: 'the answer is not JSON' } }, [HOLD, 'Avery Lane']);
    expect(promptOf(c.last)).toBe('ask_request_patronName');
    expect(c.last.record.agent).toMatchObject({ use: 'failed', fallback: 'invalid', detail: 'the answer is not JSON' });
  });

  it('two failures in a row end with the handoff line; one answer between resets the count', async () => {
    const twice = await call({ [HOLD]: { fail: 'error' }, 'Avery Lane': { fail: 'timeout' } }, [HOLD, 'Avery Lane']);
    expect(promptOf(twice.runs[1]!)).toBe('ask_request_patronName');
    expect(twice.last.result.decision).toMatchObject({ kind: 'handoff', reason: 'system-failure' });
    expect(heard(twice.last)).toBe("I'll have someone from the desk call you back.");
    const between = await call({ [HOLD]: { fail: 'error' }, 'Avery Lane': said('Thanks.', [['patronName', 'Avery Lane', 'Avery Lane']]), 'two copies': { fail: 'timeout' } }, [HOLD, 'Avery Lane', 'two copies']);
    expect(between.last.result.decision.kind).toBe('prompt');
  });

  it('a run with no agent client says each turn\'s fallback, and traces why', async () => {
    const c = await call({}, [HOLD], { noAgent: true });
    expect(promptOf(c.last)).toBe('ask_request_patronName');
    expect(c.last.record.agent).toMatchObject({ use: 'failed', fallback: 'error', detail: 'no agent client' });
  });
});

describe('what the agent model is sent', () => {
  it('the conversation so far, the line\'s words and the caller\'s, with a value the records hide masked once understood', async () => {
    const c = await call({ [HOLD]: HOLD_ANSWER, [DETAILS]: DETAILS_ANSWER, 'no, three copies': said('Three.', [['copies', 'three', 'three copies']]) }, [HOLD, DETAILS, 'no, three copies']);
    const third = c.contexts[2]!;
    const texts = third.conversation.map((u) => `${u.who}: ${u.text}`);
    expect(texts[0]).toBe('line: Thanks for calling Example Library. How can I help?');
    expect(texts[1]).toBe(`caller: ${HOLD}`);
    expect(texts.at(-1)).toBe('caller: no, three copies');
    // Understood, the callback number is masked wherever the conversation said it: the caller's words and the read-back.
    const all = texts.join('\n');
    expect(all).not.toMatch(/555 555 0144|5555550144/);
    expect(all).toContain('...0144');
    expect(third.fields.find((f) => f.name === 'callbackNumber')).toMatchObject({ value: '5555550144', redact: 'last4' });
    // The trace keeps what was sent, its values masked as sent.
    expect(c.last.record.agent!.sent!.fields.find((f) => f.name === 'callbackNumber')!.value).toBe('...0144');
    // Before it was understood, the caller's own words with it were sent whole: the model reads the value from them.
    expect(c.contexts[1]!.conversation.at(-1)!.text).toBe(DETAILS);
  });

  it('on a chat, the channel says so; and the context is the turn\'s own, built with no model', () => {
    const s = newSession('S-chat', 0, WEB_CHAT, ANONYMOUS, app.id);
    const ctx = agentContextOf(s, textEvent('hello'), { todayIso: TODAY });
    expect(ctx).toMatchObject({ channel: 'chat', form: null, caller: { account: null }, today: TODAY, overLine: false, conversation: [{ who: 'caller', text: 'hello' }], seen: [] });
  });

  it('agentTurn resolves a turn with the answer given', () => {
    const s = newSession('S-direct', 0, WEB_CHAT, ANONYMOUS, app.id);
    const r = agentTurn(s, textEvent(HOLD), null, { ok: true, answer: HOLD_ANSWER, ms: 5 }, { nowMs: 0, todayIso: TODAY, thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...app.systems(), codes: mockCodeVerifier } });
    // No decision model's answers: the turn's failure path, the answer dropped.
    expect(r.agent).toMatchObject({ use: 'dropped', dropped: 'decision-model-failed' });
  });
});
