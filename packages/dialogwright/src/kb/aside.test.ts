import { afterAll, describe, expect, it } from 'vitest';
import { speechEvent } from '../channel/events';
import { registerApp } from '../core/app/registry';
import type { App } from '../core/app/types';
import { formOf } from '../core/app/lookup';
import { followUpOf } from '../core/turn';
import { checkApp } from '../define/check';
import { defineApp, isAppDefinitionError } from '../define/defineApp';
import { formatProblem } from '../define/problems';
import { isCassetteMiss } from '../jev/cassette';
import { JevClientError, type AnswerMap, type JevClient, type JevRequest } from '../jev/types';
import { runTurn, type RunOptions } from '../run/turn';
import { choice, noul } from '../testing/answers';
import { fixedRetriever } from '../testing/retrievers';
import { mockCodeVerifier } from '../core/tools';
import { APP_EDITS, BASE, call, calls, cleanScratch, codeFor, folder, heard, libraryKbApp, nominated, say, TODAY, type Call } from './__fixtures__/libraryKbApp';

/**
 * A question the knowledge base answers, asked in the middle of a task: the form that answers it
 * (forms.yaml `answers:`) is an aside by default (FormDef.aside). The task is set aside as it stands,
 * the answer is said, and the task resumes where it was, whatever the model read the turn as doing to
 * it (replacing or adding). The topic is asked on the turn of the switch, in a second request on the
 * same words with the topic question alone (run/turn.ts), made only on that turn. On Example Town
 * Library's line with its knowledge base (./__fixtures__/libraryKbApp.ts): renewing a book has a
 * summary; checking a hold asks a book and a branch.
 */

afterAll(cleanScratch);

const APP = libraryKbApp('library-aside');

const RENEW: AnswerMap = { intent: choice({ renew_loan: 0.95, none: 0.05 }) };
const BOOK = (book: string): AnswerMap => ({ intent: choice({ none: 0.95, other: 0.05 }), book: choice({ [book]: 0.95, none: 0.05 }) });
const YES: AnswerMap = { intent: choice({ none: 0.95, other: 0.05 }), confirmsYes: noul(0.95), confirmsNo: noul(0.03) };
const NO: AnswerMap = { intent: choice({ none: 0.95, other: 0.05 }), confirmsYes: noul(0.03), confirmsNo: noul(0.95) };
/** A question about `topic`, read as replacing the task (as the finding's recording read it), with the topic question answered. */
const QUESTION = (topic: string | null, change: 'replacing' | 'adding' = 'replacing'): AnswerMap => ({
  intent: change === 'replacing' ? choice({ ask_library: 0.92, renew_loan: 0.04, none: 0.04 }) : choice({ renew_loan: 0.5, ask_library: 0.45, none: 0.05 }),
  intentChange: choice(change === 'replacing' ? { replacing: 0.9, answering: 0.05, adding: 0.05 } : { adding: 0.9, answering: 0.05, replacing: 0.05 }),
  ...(topic !== null ? { libraryTopicTopic: choice({ [topic]: 0.92, none: 0.08 }) } : {}),
});

const LATE_FEES = 'Late books on an adult card cost 25 cents a day, up to 5 dollars a book. Your card has 2 dollars in late fees right now.';

/** Renew opened and its book asked. */
function renewing(c: Call): void {
  say(c, 'I want to renew a book', RENEW);
  expect(c.last.decision).toMatchObject({ promptId: 'ask_book' });
}

/** Renew at its summary. */
function atSummary(c: Call): void {
  renewing(c);
  say(c, 'The Clockwork Garden', BOOK('clockwork_garden'));
  expect(c.last.decision).toMatchObject({ promptId: 'confirm_renew' });
}

describe('an aside in the middle of a task (forms.yaml answers:, midTask: aside, the default)', () => {
  it('is what a form that answers is by default, with its topic slot', () => {
    expect(formOf(APP, 'ask_library').aside).toEqual({ slot: 'libraryTopic' });
    expect(formOf(APP, 'renew_loan').aside).toBeUndefined();
  });

  it('mid-form: the answer is said and the question the caller was on is asked again; the task carries on', () => {
    const c = call(APP);
    renewing(c);
    const r = say(c, 'what are the late fees', QUESTION('late_fees'), nominated('late_fees'));
    expect(heard(c)).toBe(`${LATE_FEES} Which book is it?`);
    expect(r.session.form).toBe('renew_loan');
    expect(r.session.parked).toBeUndefined();
    expect(r.session.slots.libraryTopic!.value).toBeNull();
    expect(r.session.completed).toEqual(['ask_library']);
    expect(calls(r)).toEqual(['findPassage(topic=late_fees) ALLOW: late-fees-adult', 'getFees(topic=late_fees) ALLOW: fees read']);
    // The gates read it as an aside, whatever the model said it did to the task.
    expect(r.rows.find((row) => row.gate === 'intent')?.outcome).toBe('aside:ask_library');
    say(c, 'The Clockwork Garden', BOOK('clockwork_garden'));
    expect(c.last.decision).toMatchObject({ promptId: 'confirm_renew' });
    say(c, 'yes', YES);
    expect(heard(c)).toContain('Done. The Clockwork Garden is now due back');
  });

  it('as an added request ("and also ...") too: not queued behind the task, but answered now', () => {
    const c = call(APP);
    renewing(c);
    const r = say(c, 'and also what are the late fees', QUESTION('late_fees', 'adding'), nominated('late_fees'));
    expect(heard(c)).toBe(`${LATE_FEES} Which book is it?`);
    expect(r.session.queued).toEqual([]);
    expect(r.rows.find((row) => row.gate === 'intent')?.outcome).toBe('aside_added:ask_library');
  });

  it('what else the breath said for the task fills it, before the answer', () => {
    const c = call(APP);
    renewing(c);
    const r = say(c, 'The Clockwork Garden, and what are the late fees', { ...QUESTION('late_fees'), book: choice({ clockwork_garden: 0.95, none: 0.05 }) }, nominated('late_fees'));
    expect(r.session.slots.book!.value).toBe('clockwork_garden');
    expect(heard(c)).toBe(`${LATE_FEES} You'd like to renew The Clockwork Garden for two more weeks. Shall I do that?`);
  });

  it('at the summary: the answer, then the summary asked again with its count unspent; a yes then completes the task', () => {
    const c = call(APP);
    atSummary(c);
    const r = say(c, 'actually, what are the late fees', QUESTION('late_fees'), nominated('late_fees'));
    expect(heard(c)).toBe(`${LATE_FEES} You'd like to renew The Clockwork Garden for two more weeks. Shall I do that?`);
    expect(r.session.pendingConfirmation).toMatchObject({ target: 'form', form: 'renew_loan', attempts: 0 });
    const done = say(c, 'yes', YES);
    expect(heard(c)).toMatch(/^Done\. The Clockwork Garden is now due back .*Is there anything else I can help with\?$/);
    expect(calls(done)).toEqual([expect.stringMatching(/^renewLoan\(book=clockwork_garden\) ALLOW/)]);
  });

  it('at a confirmation (an explicit switch asked about): the answer, then the confirmation asked again', () => {
    const c = call(APP);
    renewing(c);
    say(c, 'maybe check a hold instead', { intent: choice({ check_hold: 0.7, renew_loan: 0.2, none: 0.1 }), intentChange: choice({ replacing: 0.9, answering: 0.05, adding: 0.05 }) });
    expect(c.last.decision).toMatchObject({ promptId: 'confirm_intent_explicit' });
    const r = say(c, 'what are the late fees', QUESTION('late_fees'), nominated('late_fees'));
    expect(heard(c)).toBe(`${LATE_FEES} Just to check, do you want to check a hold? Yes or no.`);
    expect(r.session.pendingConfirmation).toMatchObject({ target: 'intent', intent: 'check_hold' });
    say(c, 'yes', YES);
    expect(c.last.session.form).toBe('check_hold');
  });

  it('with no topic said, the topic question is asked; its answer is said and the task resumes', () => {
    const c = call(APP);
    atSummary(c);
    const r = say(c, 'I have a question', QUESTION(null));
    expect(heard(c)).toBe('What would you like to know?');
    expect(r.session.form).toBe('ask_library');
    expect(r.session.parked?.form).toBe('renew_loan');
    say(c, 'late fees', { intent: choice({ none: 0.95, other: 0.05 }), libraryTopicTopic: choice({ late_fees: 0.92, none: 0.08 }) }, nominated('late_fees'));
    expect(heard(c)).toBe(`${LATE_FEES} You'd like to renew The Clockwork Garden for two more weeks. Shall I do that?`);
    expect(c.last.session.form).toBe('renew_loan');
    expect(c.last.session.parked).toBeUndefined();
  });

  it('in the aside, asking for the task again goes back to it where it stood', () => {
    const c = call(APP);
    atSummary(c);
    say(c, 'I have a question', QUESTION(null));
    say(c, 'never mind, renew the book', { intent: choice({ renew_loan: 0.95, none: 0.05 }), intentChange: choice({ replacing: 0.9, answering: 0.05, adding: 0.05 }) });
    expect(heard(c)).toBe("You'd like to renew The Clockwork Garden for two more weeks. Shall I do that?");
    expect(c.last.session.parked).toBeUndefined();
  });

  it('unanswerable: the unavailable line and a person offered once per call; turned down, the task resumes, and next time it resumes at once', () => {
    const c = call(APP, { setup: (sys) => { sys.cardKind = null; } });
    atSummary(c);
    say(c, 'what are the late fees', QUESTION('late_fees'), nominated('late_fees'));
    expect(heard(c)).toBe("I'm sorry, I don't have an answer to that I can give you right now. Would you like me to connect you to a librarian, or keep going?");
    say(c, 'no', NO);
    expect(heard(c)).toBe("You'd like to renew The Clockwork Garden for two more weeks. Shall I do that?");
    expect(c.last.session.form).toBe('renew_loan');
    expect(c.last.session.pendingConfirmation).toMatchObject({ target: 'form', form: 'renew_loan' });
    // The offer is not made twice on a call: the task resumes straight after the unavailable line.
    say(c, 'what are the late fees', QUESTION('late_fees'), nominated('late_fees'));
    expect(heard(c)).toBe("I'm sorry, I don't have an answer to that I can give you right now. You'd like to renew The Clockwork Garden for two more weeks. Shall I do that?");
    say(c, 'yes', YES);
    expect(heard(c)).toMatch(/^Done\. The Clockwork Garden is now due back/);
  });

  it('unanswerable, the person accepted: a handoff for a person, not a frustrated caller', () => {
    const c = call(APP, { setup: (sys) => { sys.cardKind = null; } });
    renewing(c);
    say(c, 'what are the late fees', QUESTION('late_fees'), nominated('late_fees'));
    say(c, 'yes', YES);
    expect(c.last.decision).toMatchObject({ kind: 'handoff', reason: 'live-agent' });
  });

  it('an answering reading is the form\'s: the question it was asked is answered, not the aside', () => {
    const c = call(APP);
    renewing(c);
    const r = say(c, 'which ones do I have', { intent: choice({ ask_library: 0.9, none: 0.1 }), intentChange: choice({ answering: 0.9, replacing: 0.05, adding: 0.05 }) });
    expect(r.session.form).toBe('renew_loan');
    expect(r.session.completed).toEqual([]);
  });
});

describe('midTask: task (the old behaviour)', () => {
  const TASK = libraryKbApp('library-aside-task', { 'forms.yaml': (t) => APP_EDITS['forms.yaml']!(t).replace('answers: { slot: libraryTopic }', 'answers: { slot: libraryTopic, midTask: task }') });

  it('is no aside: a replacing reading replaces the task, which is gone after the answer', () => {
    expect(formOf(TASK, 'ask_library').aside).toBeUndefined();
    const c = call(TASK);
    atSummary(c);
    const r = say(c, 'what are the late fees', QUESTION('late_fees'), nominated('late_fees'));
    expect(heard(c)).toBe(`Sure, I can help you answer a question. ${LATE_FEES} Is there anything else I can help with?`);
    expect(r.session.form).toBeNull();
    expect(r.rows.find((row) => row.gate === 'intent')?.outcome).toBe('switch:ask_library');
  });

  it('passes check, and check names a value it does not take, with the fix', async () => {
    const lines = async (id: string, midTask: string): Promise<string[]> => {
      const dir = folder(id, { 'forms.yaml': (t) => APP_EDITS['forms.yaml']!(t).replace('answers: { slot: libraryTopic }', `answers: { slot: libraryTopic, midTask: ${midTask} }`) });
      try {
        return (await checkApp(dir, { code: codeFor(dir), todayIso: TODAY })).map(formatProblem);
      } catch (error) {
        if (isAppDefinitionError(error)) return error.problems.map(formatProblem);
        throw error;
      }
    };
    expect(await lines('library-aside-check-task', 'task')).toEqual([]);
    expect(await lines('library-aside-check-aside', 'aside')).toEqual([]);
    const wrong = await lines('library-aside-check-wrong', 'sideways');
    expect(wrong).toHaveLength(1);
    expect(wrong[0]).toMatch(/^forms\.yaml:\d+:\d+ {2}forms\.ask_library\.answers\.midTask {2}.*aside.*task/);
  });

  it('asks no follow-up: its turns make the one request they always made', () => {
    const c = call(TASK);
    renewing(c);
    expect(followUpOf(c.last.session, speechEvent('what are the late fees', true), { ...BASE, ...QUESTION(null) }, c.t)).toBeNull();
  });
});

describe('the second request on the switch turn (run/turn.ts)', () => {
  /** The app with a retriever that nominates late fees for the words below, and nothing for any other. */
  const WORDS = 'what are the late fees';
  function appNominating(id: string): App {
    const dir = folder(id);
    const app = defineApp(dir, { ...codeFor(dir), knowledge: { retriever: fixedRetriever({ [WORDS]: ['late_fees'] }) } });
    registerApp(app);
    return app;
  }
  const NOMINATING = appNominating('library-aside-run');

  /** A client that answers each request from `answer` (by the request's question ids), keeping every request. */
  function client(answer: (req: JevRequest, n: number) => AnswerMap | Error): JevClient & { requests: JevRequest[] } {
    const requests: JevRequest[] = [];
    return {
      requests,
      async ask(req) {
        requests.push(req);
        const a = answer(req, requests.length);
        if (a instanceof Error) throw a;
        return { answers: a, model: 'test', usage: { inputTokens: 100 * requests.length, outputTokens: 10, estimated: false }, latencyMs: 1, source: 'jev' };
      },
    };
  }

  /** The renew form open at its book question, as resolve leaves it, and the run options. */
  function opened(c: JevClient): { session: Call['last']['session']; opts: RunOptions } {
    const k = call(NOMINATING);
    say(k, 'I want to renew a book', RENEW);
    const systems = NOMINATING.systems();
    return { session: k.last.session, opts: { client: c, thresholds: k.t.thresholds, todayIso: k.t.todayIso, now: () => 0, tools: { ...systems, codes: mockCodeVerifier } } };
  }

  /** The main request's answers for the question, the inline screen's question answered clear. */
  const main = (req: JevRequest): AnswerMap => {
    const a: AnswerMap = { ...BASE, ...QUESTION(null) };
    for (const id of Object.keys(req.questions)) if (!(id in a) && id !== 'libraryTopicTopic') a[id] = id.startsWith('screen') || id === 'manipulation' ? noul(0.02) : choice({ none: 0.95, other: 0.05 });
    return a;
  };

  it('is made only on the switch turn, with the topic question alone and the same state, and the answer is said', async () => {
    const c = client((req, n) => (n === 1 ? main(req) : { libraryTopicTopic: choice({ late_fees: 0.92, none: 0.08 }) }));
    const { session, opts } = opened(c);
    const run = await runTurn(session, speechEvent(WORDS, true), opts);
    expect(c.requests).toHaveLength(2);
    // The first request is the form's, as always: no topic question in it.
    expect(Object.keys(c.requests[0]!.questions)).not.toContain('libraryTopicTopic');
    expect(Object.keys(c.requests[1]!.questions)).toEqual(['libraryTopicTopic']);
    expect(c.requests[1]!.state).toEqual(c.requests[0]!.state);
    expect(run.result.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_book' });
    expect(run.result.decision.kind === 'prompt' && run.result.decision.acks.map((a) => a.promptId)).toEqual(['kb_answer']);
    // The trace: both requests, the follow-up's own record, its usage counted in the turn's.
    expect(run.record.followUp).toMatchObject({ reason: 'aside-topic', slot: 'libraryTopic', error: null, source: 'jev', usage: { inputTokens: 200, outputTokens: 10 } });
    expect(Object.keys(run.record.followUp!.questions)).toEqual(['libraryTopicTopic']);
    expect(run.record.usage.inputTokens).toBe(300);
    expect(run.record.usage.outputTokens).toBe(20);
    expect(run.record.timing.followUpMs).toBeTypeOf('number');
    expect(run.record.retrieval?.nominated.map((n) => n.topic)).toEqual(['late_fees']);
    expect(run.record.answers).not.toHaveProperty('libraryTopicTopic');
    expect(isCassetteMiss(run.record)).toBe(false);
  });

  it('a follow-up that fails never breaks the turn: the aside asks its topic question itself', async () => {
    const c = client((req, n) => (n === 1 ? main(req) : new JevClientError('timeout')));
    const { session, opts } = opened(c);
    const run = await runTurn(session, speechEvent(WORDS, true), opts);
    expect(c.requests).toHaveLength(2);
    expect(run.result.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_libraryTopic' });
    expect(run.record.followUp).toMatchObject({ error: { message: 'timeout' }, answers: null, source: 'error' });
    expect(run.record.source).toBe('jev');
    expect(run.record.error).toBeNull();
    // A cassette miss on it is counted as one.
    const missed = client((req, n) => (n === 1 ? main(req) : new JevClientError('cassette miss: abc')));
    const second = opened(missed);
    expect(isCassetteMiss((await runTurn(second.session, speechEvent(WORDS, true), second.opts)).record)).toBe(true);
  });

  it('is not made when retrieval nominates nothing: the topic question is the aside\'s own', async () => {
    const c = client((req) => main(req));
    const { session, opts } = opened(c);
    const run = await runTurn(session, speechEvent('I have a question', true), opts);
    expect(c.requests).toHaveLength(1);
    expect(run.record.followUp).toBeUndefined();
    expect(run.result.decision).toMatchObject({ promptId: 'ask_libraryTopic' });
  });

  it('is not made on any other turn: an answer to the form\'s question makes its one request', async () => {
    const c = client((req) => ({ ...main(req), intent: choice({ none: 0.95, other: 0.05 }), intentChange: choice({ answering: 0.95, adding: 0.03, replacing: 0.02 }), book: choice({ clockwork_garden: 0.95, none: 0.05 }) }));
    const { session, opts } = opened(c);
    const run = await runTurn(session, speechEvent(WORDS, true), opts);
    expect(c.requests).toHaveLength(1);
    expect(run.record.followUp).toBeUndefined();
    expect(run.record.retrieval).toBeUndefined();
  });

  it('is not made for words the screen quarantined', async () => {
    const c = client((req) => {
      const a = main(req);
      for (const id of Object.keys(req.questions)) if (!(id in BASE) && !(id in QUESTION(null)) && req.questions[id]!.type === 'noul') a[id] = noul(0.99);
      return a;
    });
    const { session, opts } = opened(c);
    const run = await runTurn(session, speechEvent(WORDS, true), opts);
    expect(run.result.quarantined).toBe(true);
    expect(c.requests).toHaveLength(1);
  });
});
