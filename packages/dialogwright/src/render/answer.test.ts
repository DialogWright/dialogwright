import { afterAll, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { sayText, type Action } from '../channel/actions';
import { WEB_CHAT } from '../channel/caps';
import { speechEvent, startEvent, textEvent, type SessionEvent } from '../channel/events';
import type { App } from '../core/app/types';
import { newSession, type Session } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { resolve, type TurnResult } from '../core/turn';
import { fillSlots } from '../core/fia';
import { slotSpecOf } from '../core/app/lookup';
import type { SlotContext } from '../core/slots/types';
import { ANONYMOUS } from '../gate/principal';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { noulAnswer } from '../jev/distributions';
import type { JevClient } from '../jev/types';
import { APP_EDITS, BASE, call, cleanScratch, codeFor, folder, libraryKbApp, nominated, TODAY } from '../kb/__fixtures__/libraryKbApp';
import { defineApp } from '../define/defineApp';
import { registerApp } from '../core/app/registry';
import { fixedRetriever } from '../testing/retrievers';
import { runTurn } from '../run/turn';
import type { AnswerMap } from '../jev/types';
import { choice, noul } from '../testing/answers';
import { policyCardText } from '../testing/policyCard';
import { ANSWER_DRIFT_QUESTION_ID } from './checks';
import { KB_QUESTION_VAR } from './config';
import { FakeRenderClient, type FakeRenderOptions } from './fake';
import { ANSWER_INSTRUCTIONS, instructionsOf } from './prompt';
import { DEFAULT_HOLD_TEXT, renderTurn, type RenderedTurn } from './turn';
import type { Renderer, SpanAct } from './types';

/**
 * A knowledge answer worded for the caller's question (the maintainer's decision, 2026-10-16), on the
 * library's line with its knowledge base (kb/__fixtures__): the answer line framed with a span worded from
 * the answer, and two of its three topics marked `risk: low` (the opening hours, as the fixture has it,
 * and the late fees, with their account line); the card renewal stays regulated. Each turn is resolved by
 * the core, then rendered as runTurn renders it, with the fake renderer and the stub's judge.
 */

afterAll(cleanScratch);

const FRAMED_ANSWER = `  kb_answer:
    text: '{answer}'
    interruptible: false
    generate:
      answer:
        from: answer
        goal: Answer the caller's question from the passage.
  kb_hold:
    text: Just a moment while I look that up.
    interruptible: false
`;
const framed = (t: string): string => APP_EDITS['prompts.yaml']!(t).replace("  kb_answer:\n    text: '{answer}'\n    interruptible: false\n", FRAMED_ANSWER);
const lowFees = (t: string): string => t.replace('    from: getFees\n', '    from: getFees\n  risk: low\n');
/** The library with its answer line framed and the late fees marked low risk. */
const FRAMED = libraryKbApp('library-kb-worded', { 'prompts.yaml': framed, 'kb/topics.yaml': lowFees });
/** The same, its answer line not framed: every answer word for word, whatever the topics say. */
const PLAIN = libraryKbApp('library-kb-plain', { 'kb/topics.yaml': lowFees });
/** The answer line framed, but no hold line of the app's own: the engine's words. */
const NO_HOLD = libraryKbApp('library-kb-no-hold', { 'prompts.yaml': (t) => framed(t).replace("  kb_hold:\n    text: Just a moment while I look that up.\n    interruptible: false\n", ''), 'kb/topics.yaml': lowFees });

const FEES = 'Late books on an adult card cost 25 cents a day, up to 5 dollars a book.';
const ACCOUNT = 'Your card has 2 dollars in late fees right now.';
const RENEWAL = "An adult card lasts three years. To renew it, bring a photo ID to any branch desk. There's no charge.";

/** A turn resolved as runTurn resolves it, its words screened and not flagged: the session before it, the event and the result. */
interface Turn { before: Session; event: SessionEvent; result: TurnResult }

function asked(app: App, topic: string, text = `a question about ${topic}`, chat = false): Turn {
  const t = call(app).t;
  const start = chat
    ? resolve(newSession(`${app.id}-chat`, 0, WEB_CHAT, ANONYMOUS, app.id), startEvent({}), null, t).session
    : call(app).last.session;
  const event: SessionEvent = chat ? textEvent(text) : speechEvent(text, true);
  const result = resolve(start, event, { ...BASE, intent: choice({ ask_library: 0.95, none: 0.05 }), libraryTopicTopic: choice({ [topic]: 0.92, none: 0.08 }) }, { ...t, knowledge: { nominated: nominated(topic) } });
  return { before: start, event, result: { ...result, screen: { value: 0.02, fired: false, error: null } } };
}

const judge = (app: App): JevClient => new HeuristicStubClient({ todayIso: TODAY, app });
const renderer = (opts: FakeRenderOptions = {}, more: Omit<Partial<Renderer>, 'client'> = {}): Renderer & { client: FakeRenderClient } => ({ ...more, client: new FakeRenderClient(opts), share: 100 });

async function rendered(app: App, turn: Turn, r: Renderer & { client: FakeRenderClient }, early?: (actions: readonly Action[], result: TurnResult) => boolean, drift: JevClient = judge(app)): Promise<RenderedTurn> {
  const out = await renderTurn({ before: turn.before, result: turn.result, event: turn.event, renderer: { ...r, drift }, client: drift, thresholds: DEFAULT_THRESHOLDS, ...(early !== undefined ? { early } : {}) });
  expect(out).not.toBeNull();
  return out!;
}

const said = (out: RenderedTurn): string => sayText(out.actions);
const answerLine = (out: RenderedTurn) => out.record.lines.find((l) => l.promptId === 'kb_answer')!;

describe('the two switches: a topic marked risk: low, and the answer line framed from the answer', () => {
  it('both: the passage worded for the caller\'s question, the account line after it word for word, and the record says so', async () => {
    const turn = asked(FRAMED, 'late_fees', 'how much is it a day for a late book');
    const r = renderer({ eachSpan: () => 'A late book costs 25 cents a day, up to 5 dollars a book.' });
    const out = await rendered(FRAMED, turn, r);
    expect(said(out)).toBe(`Sure, I can help you answer a question. A late book costs 25 cents a day, up to 5 dollars a book. ${ACCOUNT} Is there anything else I can help with?`);
    // What the model was sent: the goal, the sentence, the passage alone and the question in the caller's words; never the account line.
    const act = r.client.askedSpans[0]!.act as SpanAct;
    expect(act).toEqual({
      kind: 'span', goal: "Answer the caller's question from the passage.", sentence: '____', content: [{ name: 'answer', value: FEES }],
      channel: 'voice', language: 'en-US', style: { persona: 'a calm, plain-spoken agent', words: 17, avoid: [] }, answer: { question: 'how much is it a day for a late book' },
    });
    expect(instructionsOf(act)).toBe(ANSWER_INSTRUCTIONS);
    expect(JSON.stringify(act)).not.toContain('2 dollars in late fees');
    // The record: the wording beside the passage, the passage named; the knowledge record's said; kb_worded in the audit.
    expect(answerLine(out)).toMatchObject({ promptId: 'kb_answer', span: 'answer', mode: 'generated', fixed: FEES, said: 'A late book costs 25 cents a day, up to 5 dollars a book.', answer: { passageId: 'late-fees-adult', topic: 'late_fees' } });
    expect(out.kbSaid).toBe('worded');
    expect(out.audit).toEqual([{ type: 'kb_worded', detail: { prompt: 'kb_answer', passageId: 'late-fees-adult', version: '2026.1', approvalHash: turn.result.kb!.approvalHash! } }]);
    expect(out.record.hold).toBeUndefined();
    expect(out.early).toBe(0);
  });

  it('a regulated topic (the default): the passage word for word, byte for byte, nothing asked of a model', async () => {
    const turn = asked(FRAMED, 'card_renewal');
    const r = renderer();
    const out = await rendered(FRAMED, turn, r);
    expect(said(out)).toBe(sayText(turn.result.actions));
    expect(said(out)).toContain(RENEWAL);
    expect(r.client.askedSpans).toEqual([]);
    expect(answerLine(out)).toMatchObject({ mode: 'fixed', skipped: 'regulated', fixed: RENEWAL });
    expect(out.kbSaid).toBe('passage');
    expect(out.audit).toEqual([]);
  });

  it('a low-risk topic whose answer line is not framed: no line is generated, and the turn is exactly as it was', async () => {
    const turn = asked(PLAIN, 'late_fees');
    expect(await renderTurn({ before: turn.before, result: turn.result, event: turn.event, renderer: renderer(), client: judge(PLAIN), thresholds: DEFAULT_THRESHOLDS })).toBeNull();
    // Nor is the caller's question kept, nor given to the line.
    expect(turn.result.decision.kind !== 'handoff' && 'acks' in turn.result.decision ? turn.result.decision.acks.find((a) => a.promptId === 'kb_answer')!.vars : {}).toEqual({ answer: `${FEES} ${ACCOUNT}` });
  });

  it('the question is kept on the topic slot only for a form whose answer line words its answer', () => {
    const framedTurn = asked(FRAMED, 'late_fees', 'how much is it a day');
    const ack = (r: TurnResult) => ('acks' in r.decision ? r.decision.acks.find((a) => a.promptId === 'kb_answer')!.vars : {});
    expect(ack(framedTurn.result)[KB_QUESTION_VAR]).toBe('how much is it a day');
    expect(ack(asked(PLAIN, 'late_fees', 'how much is it a day').result)).not.toHaveProperty(KB_QUESTION_VAR);
  });

  it('never from words said at a question whose answer is sensitive (a one-time code, an identity factor, a slot the records mask)', () => {
    const fill = (promptedFor: Session['promptedFor']): Session['slots'][string] => {
      const session = { ...call(FRAMED).last.session, promptedFor };
      const ctx: SlotContext = { text: 'and is late_fees covered', candidateSpans: [], candidateWordSpans: [], todayIso: TODAY, thresholds: { ...DEFAULT_THRESHOLDS }, window: null, current: null, records: [], prompted: false, nominated: nominated('late_fees') };
      fillSlots(session, { libraryTopicTopic: choice({ late_fees: 0.92, none: 0.08 }) }, ctx, [slotSpecOf(FRAMED, 'libraryTopic')]);
      return session.slots.libraryTopic!;
    };
    expect(fill('intent')).toMatchObject({ value: 'late_fees', heard: 'and is late_fees covered' });
    const coded = fill('otp');
    expect(coded.value).toBe('late_fees');
    expect(coded).not.toHaveProperty('heard');
  });

  it('with no question of the caller\'s (a call saved before it was kept), the passage word for word', async () => {
    const turn = asked(FRAMED, 'late_fees');
    const acks = 'acks' in turn.result.decision ? turn.result.decision.acks : [];
    const vars = acks.find((a) => a.promptId === 'kb_answer')!.vars as Record<string, string>;
    delete vars[KB_QUESTION_VAR];
    const r = renderer();
    const out = await rendered(FRAMED, turn, r);
    expect(answerLine(out)).toMatchObject({ mode: 'fixed', skipped: 'no-question' });
    expect(r.client.askedSpans).toEqual([]);
  });

  it('the fake renderer\'s own wording of a one-sentence passage is the passage: said unchanged, with nothing asked of the judge', async () => {
    const turn = asked(FRAMED, 'late_fees');
    const asks: string[] = [];
    const base = judge(FRAMED);
    const out = await rendered(FRAMED, turn, renderer(), undefined, { ask: (req) => { asks.push(Object.keys(req.questions).join(',')); return base.ask(req); } });
    expect(answerLine(out)).toMatchObject({ mode: 'fixed', unchanged: true });
    expect(said(out)).toContain(`${FEES} ${ACCOUNT}`);
    // The question screened again (the caller's words, kept from the turn they asked it on), and no drift check.
    expect(asks).toEqual(['manipulation']);
  });
});

describe('the checks and the judge: the passage word for word whenever one refuses', () => {
  const refused = async (wording: string, reason: string, more: Partial<Renderer> = {}, drift?: JevClient): Promise<void> => {
    const turn = asked(FRAMED, 'late_fees', 'how much is a late book');
    const out = await rendered(FRAMED, turn, renderer({ eachSpan: () => wording }, more), undefined, drift);
    expect(answerLine(out)).toMatchObject({ mode: 'fixed', fallback: reason, refused: wording });
    expect(said(out)).toContain(`${FEES} ${ACCOUNT}`);
    expect(out.kbSaid).toBe('passage');
    expect(out.audit).toEqual([{ type: 'render_fallback', detail: { prompt: 'kb_answer', span: 'answer', reason } }]);
  };

  it('a figure the passage does not have', () => refused('A late book costs 50 cents a day.', 'foreign'));
  it('a name the passage does not have', () => refused('Late books cost 25 cents a day at the Riverside branch, up to 5 dollars a book.', 'foreign'));
  it('over its budget (the passage\'s own word count)', () => refused('Late books on an adult card cost 25 cents for each and every day they are late, up to 5 dollars a book.', 'words'));
  it('a question', () => refused('Late books cost 25 cents a day, up to 5 dollars a book. Anything else?', 'question'));
  it('the drift judge\'s refusal (a limit left out)', async () => {
    const base = judge(FRAMED);
    const refusing: JevClient = { ask: async (req) => (Object.hasOwn(req.questions, ANSWER_DRIFT_QUESTION_ID) ? { answers: { [ANSWER_DRIFT_QUESTION_ID]: noulAnswer(0.9) }, model: 'stub', usage: { inputTokens: 0, outputTokens: 0, estimated: false }, latencyMs: 0, source: 'stub:heuristic' } : base.ask(req)) };
    await refused('Late books on an adult card cost 25 cents a day.', 'drift', {}, refusing);
  });
  it('the stub\'s judge, holding the 5 dollars a book', () => refused('Late books on an adult card cost 25 cents a day.', 'drift'));
  it('the model failing', async () => {
    const turn = asked(FRAMED, 'late_fees');
    const out = await rendered(FRAMED, turn, renderer({ eachSpan: () => new Error('down') }));
    expect(answerLine(out)).toMatchObject({ mode: 'fixed', fallback: 'error' });
    expect(said(out)).toContain(`${FEES} ${ACCOUNT}`);
  });
});

describe('room for a long passage: the hold line, then the answer, within its own limit', () => {
  // The line's budgets small (30 ms and 20 ms), the answer's limit 1000 ms: a wording that takes 150 ms runs past the first.
  const slow = (delayMs: number, answerMs = 1000, channel: 'voice' | 'chat' = 'voice') => renderer(
    { delayMs, eachSpan: () => 'A late book costs 25 cents a day, up to 5 dollars a book.' },
    { timeoutMs: { voice: channel === 'voice' ? 30 : 5000, chat: channel === 'chat' ? 30 : 5000 }, checkTimeoutMs: { voice: 20, chat: 20 }, answerTimeoutMs: { voice: answerMs, chat: answerMs } },
  );

  it('on a call: the lines before the answer and the hold line go to the channel at once, the answer when it is ready', async () => {
    const turn = asked(FRAMED, 'late_fees', 'how much for a late book');
    const handed: string[] = [];
    const out = await rendered(FRAMED, turn, slow(150), (actions) => {
      handed.push(sayText(actions));
      return true;
    });
    expect(handed).toEqual(['Sure, I can help you answer a question. Just a moment while I look that up.']);
    expect(said(out)).toBe(`Sure, I can help you answer a question. Just a moment while I look that up. A late book costs 25 cents a day, up to 5 dollars a book. ${ACCOUNT} Is there anything else I can help with?`);
    expect(out.early).toBe(2);
    expect(out.record.hold).toMatchObject({ index: 1, promptId: 'kb_hold', early: true });
    expect(answerLine(out)).toMatchObject({ index: 2, mode: 'generated' });
    expect(out.kbSaid).toBe('worded');
  });

  it('in a chat, on its own budgets', async () => {
    const turn = asked(FRAMED, 'late_fees', 'how much for a late book', true);
    const out = await rendered(FRAMED, turn, slow(150, 1000, 'chat'), () => true);
    expect(said(out)).toContain('Just a moment while I look that up. A late book costs 25 cents a day');
    expect(out.record.hold).toMatchObject({ promptId: 'kb_hold', early: true });
  });

  it('a channel that cannot say lines early (the harness): the hold line in its place, said with the rest', async () => {
    const out = await rendered(FRAMED, asked(FRAMED, 'late_fees', 'how much for a late book'), slow(150));
    expect(out.early).toBe(0);
    expect(out.record.hold).toMatchObject({ index: 1, early: false });
    expect(said(out)).toContain('Just a moment while I look that up. A late book costs');
  });

  it('an app with no kb_hold of its own: the engine\'s words', async () => {
    const out = await rendered(NO_HOLD, asked(NO_HOLD, 'late_fees', 'how much for a late book'), slow(150));
    expect(out.record.hold).toMatchObject({ promptId: null });
    expect(said(out)).toContain(`${DEFAULT_HOLD_TEXT} A late book costs`);
  });

  it('not ready by its own limit: the hold line, then the passage word for word', async () => {
    const out = await rendered(FRAMED, asked(FRAMED, 'late_fees', 'how much for a late book'), slow(400, 150));
    expect(said(out)).toBe(`Sure, I can help you answer a question. Just a moment while I look that up. ${FEES} ${ACCOUNT} Is there anything else I can help with?`);
    expect(answerLine(out)).toMatchObject({ mode: 'fixed', fallback: 'timeout' });
    expect(out.kbSaid).toBe('passage');
  });

  it('ready within the line\'s budgets: no hold line', async () => {
    const out = await rendered(FRAMED, asked(FRAMED, 'late_fees', 'how much for a late book'), renderer({ eachSpan: () => 'A late book costs 25 cents a day, up to 5 dollars a book.' }));
    expect(out.record.hold).toBeUndefined();
    expect(said(out)).not.toContain('Just a moment');
  });
});

describe('the hold line in the call\'s language', () => {
  // The answer line's span given a goal in Spanish too, so a Spanish call words the opening hours' Spanish passage.
  const spanish = (withHold: boolean) => (t: string): string => APP_EDITS['locale/es/prompts.yaml']!(t).replace(
    "  kb_answer:\n    text: '{answer}'\n    interruptible: false\n",
    `  kb_answer:\n    text: '{answer}'\n    interruptible: false\n    generate:\n      answer:\n        goal: Responder la pregunta con el pasaje.\n${withHold ? '  kb_hold:\n    text: Un momento, por favor.\n    interruptible: false\n' : ''}`,
  );
  const ES = libraryKbApp('library-kb-es', { 'prompts.yaml': framed, 'locale/es/prompts.yaml': spanish(false) });
  const ES_HOLD = libraryKbApp('library-kb-es-hold', { 'prompts.yaml': framed, 'locale/es/prompts.yaml': spanish(true) });
  const inSpanish = (app: App): Turn => {
    const c = call(app, { locale: 'es' });
    const event = speechEvent('¿a qué hora abren?', true, 'es');
    const result = resolve(c.last.session, event, { ...BASE, intent: choice({ ask_library: 0.95, none: 0.05 }), libraryTopicTopic: choice({ opening_hours: 0.92, none: 0.08 }) }, { ...c.t, knowledge: { nominated: nominated('opening_hours') } });
    return { before: c.last.session, event, result: { ...result, screen: { value: 0.02, fired: false, error: null } } };
  };
  const slowly = () => renderer({ delayMs: 150, eachSpan: () => 'Abrimos de lunes a viernes de 9 de la mañana a 8 de la noche, y los sábados de 10 a 4.' }, { timeoutMs: { voice: 30, chat: 30 }, checkTimeoutMs: { voice: 20, chat: 20 }, answerTimeoutMs: { voice: 1000, chat: 1000 } });

  it('a locale\'s own kb_hold is said in it', async () => {
    const out = await rendered(ES_HOLD, inSpanish(ES_HOLD), slowly());
    expect(out.record.hold).toMatchObject({ promptId: 'kb_hold' });
    expect(said(out)).toContain('Un momento, por favor.');
  });

  it('in a language the app gives no hold line, none is said, and the answer has only a line\'s budget: the passage word for word', async () => {
    const out = await rendered(ES, inSpanish(ES), slowly());
    expect(out.record.hold).toBeUndefined();
    expect(said(out)).not.toContain('moment');
    expect(answerLine(out)).toMatchObject({ mode: 'fixed', fallback: 'timeout', fixed: 'Abrimos de lunes a viernes de 9 de la mañana a 8 de la noche, y los sábados de 10 a 4. Los domingos cerramos.' });
  });
});

describe('the policy card', () => {
  it('lists the answer line, its goal and budget, and the topics whose answer may be worded', () => {
    const card = policyCardText(FRAMED, tmpdir());
    expect(card).toContain('| `kb_answer` | `{answer}` | Answer the caller\'s question from the passage. | the passage\'s own word count | `opening_hours` (Opening hours), `late_fees` (Late fees) |');
    expect(card).toContain('the caller first hears the hold line ("Just a moment while I look that up.")');
    expect(policyCardText(PLAIN, tmpdir())).not.toContain('may word it for the caller\'s question');
  });
});

describe('through runTurn: the trace\'s knowledge record and the lines a channel said early', () => {
  const dir = folder('library-kb-run', { 'prompts.yaml': framed, 'kb/topics.yaml': lowFees });
  const QUESTION = 'how much for a late book';
  const RUN = defineApp(dir, { ...codeFor(dir), knowledge: { retriever: fixedRetriever({ [QUESTION]: ['late_fees'] }) } });
  registerApp(RUN);
  const ANSWERS: AnswerMap = { ...BASE, intent: choice({ ask_library: 0.95, none: 0.05 }), libraryTopicTopic: choice({ late_fees: 0.92, none: 0.08 }), manipulation: noul(0.02) };
  const client: JevClient = {
    ask: async (req) => ({ answers: Object.fromEntries(Object.keys(req.questions).filter((k) => Object.hasOwn(ANSWERS, k)).map((k) => [k, ANSWERS[k]!])), model: 'stub', usage: { inputTokens: 0, outputTokens: 0, estimated: true }, latencyMs: 0, source: 'stub:heuristic' }),
  };
  const run = async (r: Renderer, early?: (actions: readonly Action[], result: TurnResult) => boolean) => {
    // The library's own systems, as a server gives them (call() does the same for a resolved turn).
    const tools = call(RUN).t.tools;
    const start = await runTurn(newSession('run-1', 0, WEB_CHAT, ANONYMOUS, RUN.id), startEvent({}), { client, thresholds: DEFAULT_THRESHOLDS, todayIso: TODAY, now: () => 0, tools });
    return runTurn(start.result.session, textEvent(QUESTION), { client, thresholds: DEFAULT_THRESHOLDS, todayIso: TODAY, now: () => 0, tools, renderer: { ...r, drift: judge(RUN) }, ...(early !== undefined ? { early } : {}) });
  };

  it('a wording said: the trace\'s knowledge record says so, beside the render line with the wording and the passage', async () => {
    const t = await run(renderer({ eachSpan: () => 'A late book costs 25 cents a day, up to 5 dollars a book.' }));
    expect(t.record.kb).toMatchObject({ passageId: 'late-fees-adult', said: 'worded' });
    expect(t.record.render!.lines.find((l) => l.promptId === 'kb_answer')).toMatchObject({ mode: 'generated', fixed: FEES });
    expect(t.audit).toEqual([]);
    expect(t.result.audit.map((a) => a.type)).toContain('kb_worded');
    expect(t.early).toBeUndefined();
  });

  it('a slow wording: the run says how many of its lines the channel said early, and the trace holds the hold line', async () => {
    const t = await run(renderer({ delayMs: 150, eachSpan: () => 'A late book costs 25 cents a day, up to 5 dollars a book.' }, { timeoutMs: { voice: 30, chat: 30 }, checkTimeoutMs: { voice: 20, chat: 20 }, answerTimeoutMs: { voice: 1000, chat: 1000 } }), () => true);
    expect(t.early).toBe(2);
    expect(t.record.render!.hold).toMatchObject({ index: 1, promptId: 'kb_hold', early: true });
    expect(sayText(t.result.actions.slice(t.early))).toBe(`A late book costs 25 cents a day, up to 5 dollars a book. ${ACCOUNT} Is there anything else I can help with?`);
  });
});
