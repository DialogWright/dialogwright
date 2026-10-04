import { describe, expect, it } from 'vitest';
import { RETRIEVE_BUDGET_MS, retrieve } from './retrieve';
import { runTurn, type RunOptions, type TurnRun } from './turn';
import { registerApp } from '../core/app/registry';
import type { App } from '../core/app/types';
import { isTopicSlot, topicsListening } from '../core/knowledge';
import { newSession, type Session } from '../core/session';
import type { SlotContext, SlotSpec } from '../core/slots/types';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { resolve, slotContext, type TurnContext } from '../core/turn';
import { keyEvents, silenceEvent, speechEvent, startEvent, textEvent } from '../channel/events';
import { VOICE_RELAY, WEB_CHAT } from '../channel/caps';
import type { AppKnowledge, KnowledgeBase, Nomination, Retriever } from '../kb/types';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { loadCorpus } from '../jev/corpus';
import type { AnswerMap, JevClient, JevRequest } from '../jev/types';
import { choice, noul, score } from '../testing/answers';
import { useTestkit } from '../testing/apps';
import { testkitApp } from '../testing/testkit';
import { CUSTOMERS } from '../testing/testkit/domain/data';
import { customerPrincipal } from '../testing/testkit/domain/principals';
import { defaultCorpusFile } from './client';

/**
 * Retrieval in the turn: runTurn nominates knowledge-base topics once, before the turn is planned,
 * when the app has a knowledge base, the turn has words and a topic slot (SlotSpec.nominates) is
 * listening; the nominations reach that slot's questions and fill (SlotContext.nominated), and the
 * trace records what the retriever did. On the testkit, whose `missingNote` slot is wrapped here to
 * opt in and to keep every context it is given; the knowledge base is a one-topic one written here.
 */
useTestkit();

const TODAY = '2026-09-18';

const KB: KnowledgeBase = {
  settings: { action: 'getParcel', applies: {}, localeFallback: 'none', maxAnswerChars: 400, retrieval: { cap: 8 } },
  defaultLocale: 'en-US',
  topics: { opening_hours: { id: 'opening_hours', title: 'Opening hours', keywords: ['open'], asks: ['When are you open?'], risk: 'low', locales: {} } },
  passages: {},
  sources: {},
};

const NOMINATED: readonly Nomination[] = [
  { topic: 'opening_hours', title: 'Opening hours', score: 0.82, via: 'app' },
  { topic: 'returns', title: 'Returns', score: 0.4, via: 'keyword' },
];

/** A retriever that always nominates NOMINATED, counting its calls and keeping what it was asked. */
function fixedRetriever(id = 'fixed'): Retriever & { calls: Array<{ text: string; locale: string; todayIso: string }> } {
  const calls: Array<{ text: string; locale: string; todayIso: string }> = [];
  return { id, indexHash: 'abc123', calls, nominate: (input) => (calls.push({ ...input }), NOMINATED) };
}

/** Every context the wrapped slot is given, by what it was given for. */
interface Seen {
  questions: SlotContext[];
  fill: SlotContext[];
}

/** `missingNote`, opting in to nominations (when `nominates`), keeping every context, and asking about the nominated topics when there are any. */
function watched(nominates: boolean, seen: Seen): SlotSpec {
  const spec = testkitApp.slots.missingNote!;
  return {
    ...spec,
    ...(nominates ? { nominates: true } : {}),
    ...(spec.questionIds ? { questionIds: [...spec.questionIds, 'knowledgeTopic'] } : {}),
    questions: (ctx) => {
      seen.questions.push(ctx);
      const own = spec.questions(ctx);
      const nominated = ctx.nominated ?? [];
      if (nominated.length === 0) return own;
      const criteria: Record<string, string | null> = Object.fromEntries(nominated.map((n) => [n.topic, `Asks about ${n.title.toLowerCase()}`]));
      return { ...own, knowledgeTopic: { type: 'choice', instructions: 'Read asr.text. Which topic does the caller ask about?', criteria: { ...criteria, none: 'None of these' } } };
    },
    fill: (answers, ctx) => {
      seen.fill.push(ctx);
      return spec.fill(answers, ctx);
    },
  };
}

let registered = 0;
/** The testkit as an app of its own, with the watched slot and, when given, knowledge. */
function appWith(opts: { knowledge?: AppKnowledge; nominates?: boolean }): { app: App; seen: Seen } {
  const seen: Seen = { questions: [], fill: [] };
  registered += 1;
  const app: App = {
    ...testkitApp,
    id: `knowing-${registered}`,
    slots: { ...testkitApp.slots, missingNote: watched(opts.nominates ?? true, seen) },
    ...(opts.knowledge ? { knowledge: opts.knowledge } : {}),
  };
  registerApp(app);
  // Registering tries each slot's questions on made-up turns (validateApp); only the call's are kept.
  seen.questions.length = 0;
  seen.fill.length = 0;
  return { app, seen };
}

/** A client that answers as the testkit's corpus does (the topic question by the heuristic), keeping every request. */
function recordingClient(): JevClient & { requests: JevRequest[] } {
  const inner = new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: 0.9, fallback: new HeuristicStubClient() });
  const requests: JevRequest[] = [];
  return { requests, ask: (req) => (requests.push(req), inner.ask(req)) };
}

function runOpts(client: JevClient, extra: Partial<RunOptions> = {}): RunOptions {
  return { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 1_000, ...extra };
}

const CUSTOMER = customerPrincipal(CUSTOMERS[0]!, 2);
const SAID = 'a parcel is missing, it was a small box left at the back door';

/** A signed-in customer's chat on `app`, greeted, then `said`. */
async function call(app: App, client: JevClient, said: string, extra: Partial<RunOptions> = {}): Promise<{ greeted: TurnRun; turn: TurnRun; session: Session }> {
  const o = runOpts(client, extra);
  const session = newSession('kb-1', 0, WEB_CHAT, CUSTOMER, app.id);
  const greeted = await runTurn(session, startEvent(), o);
  const turn = await runTurn(greeted.result.session, textEvent(said), o);
  return { greeted, turn, session: turn.result.session };
}

describe('the retrieval step in runTurn', () => {
  it('nominates once, before planning, and the topic slot asks and fills with the nominations', async () => {
    const retriever = fixedRetriever();
    const { app, seen } = appWith({ knowledge: { kb: KB, retriever } });
    const client = recordingClient();
    const { greeted, turn } = await call(app, client, SAID);
    // The greeting has no words: nothing is nominated, and its record is as it always was.
    expect(greeted.record.retrieval).toBeUndefined();
    expect(greeted.record.timing.retrieveMs).toBeUndefined();
    // One call for the words turn, with the words, the session's locale and the day.
    expect(retriever.calls).toEqual([{ text: SAID, locale: 'en-US', todayIso: TODAY }]);
    // The slot's questions saw the nominations, and so did its fill when the form was entered.
    expect(seen.questions.length).toBeGreaterThan(0);
    for (const ctx of seen.questions) expect(ctx.nominated).toEqual(NOMINATED);
    expect(seen.fill.length).toBeGreaterThan(0);
    for (const ctx of seen.fill) expect(ctx.nominated).toEqual(NOMINATED);
    expect(turn.result.session.form).toBe('report_missing');
    // The question built from them went out in the request.
    const asked = client.requests.at(-1)!.questions;
    expect(Object.keys((asked.knowledgeTopic as { criteria: Record<string, unknown> }).criteria)).toEqual(['opening_hours', 'returns', 'none']);
    // The trace: what was nominated, with scores and how each was found, the retriever and its index; and how long it took.
    expect(turn.record.retrieval).toEqual({
      retrieverId: 'fixed',
      indexHash: 'abc123',
      nominated: [{ topic: 'opening_hours', score: 0.82, via: 'app' }, { topic: 'returns', score: 0.4, via: 'keyword' }],
    });
    expect(typeof turn.record.timing.retrieveMs).toBe('number');
    expect(Object.keys(turn.record.timing)).toEqual(['retrieveMs', 'planMs', 'askMs', 'resolveMs', 'totalMs']);
  });

  it('runs on a spoken turn as on a typed one, and not on a keypad, silence or start turn', async () => {
    const retriever = fixedRetriever();
    const { app } = appWith({ knowledge: { kb: KB, retriever } });
    const o = runOpts(recordingClient());
    const greeted = await runTurn(newSession('kb-2', 0, VOICE_RELAY, CUSTOMER, app.id), startEvent(), o);
    const silent = await runTurn(greeted.result.session, silenceEvent(), o);
    const keyed = await runTurn(silent.result.session, keyEvents('9')[0]!, o);
    expect(retriever.calls).toEqual([]);
    for (const r of [greeted, silent, keyed]) expect(r.record.retrieval).toBeUndefined();
    const spoken = await runTurn(keyed.result.session, speechEvent('when are you open'), o);
    expect(retriever.calls.map((c) => c.text)).toEqual(['when are you open']);
    expect(spoken.record.retrieval?.nominated).toHaveLength(2);
  });

  it('does not run when no topic slot is listening: inside a form without one, or with no slot opting in', async () => {
    const retriever = fixedRetriever();
    const { app, seen } = appWith({ knowledge: { kb: KB, retriever }, nominates: false });
    const { turn } = await call(app, recordingClient(), SAID);
    expect(retriever.calls).toEqual([]);
    expect(turn.record.retrieval).toBeUndefined();
    expect(turn.record.timing.retrieveMs).toBeUndefined();
    for (const ctx of [...seen.questions, ...seen.fill]) expect('nominated' in ctx).toBe(false);

    // In the delivery window form, whose slots do not read nominations, the opting-in slot is not active.
    const listening = appWith({ knowledge: { kb: KB, retriever } });
    const session = { ...newSession('kb-3', 0, WEB_CHAT, CUSTOMER, listening.app.id), form: 'delivery_window' };
    expect(topicsListening(session as Session, textEvent('tomorrow'), undefined)).toBe(false);
    expect(topicsListening({ ...session, form: 'report_missing' } as Session, textEvent('tomorrow'), undefined)).toBe(true);
    expect(topicsListening({ ...session, form: 'report_missing' } as Session, textEvent('tomorrow'), true)).toBe(false);
    expect(topicsListening({ ...session, form: 'report_missing', ended: true } as Session, textEvent('tomorrow'), undefined)).toBe(false);
  });

  it('an app with a knowledge base but no retriever: an empty list on the context, nothing traced or timed', async () => {
    const { app, seen } = appWith({ knowledge: { kb: KB } });
    const { turn } = await call(app, recordingClient(), SAID);
    expect(turn.record.retrieval).toBeUndefined();
    expect(turn.record.timing.retrieveMs).toBeUndefined();
    expect(seen.questions.length).toBeGreaterThan(0);
    for (const ctx of [...seen.questions, ...seen.fill]) expect(ctx.nominated).toEqual([]);
  });

  it('an app without a knowledge base: contexts and requests exactly as before (no nominated key)', async () => {
    const plain = appWith({ nominates: false });
    const a = recordingClient();
    const b = recordingClient();
    const x = await call(plain.app, a, SAID);
    const y = await call(testkitApp, b, SAID);
    expect(a.requests).toEqual(b.requests);
    expect(plain.seen.questions.length).toBeGreaterThan(0);
    for (const ctx of [...plain.seen.questions, ...plain.seen.fill]) expect(Object.keys(ctx)).not.toContain('nominated');
    expect(x.turn.record.retrieval).toBeUndefined();
    expect(Object.keys(x.turn.record.timing)).toEqual(['planMs', 'askMs', 'resolveMs', 'totalMs']);
    expect(x.turn.record.decision).toEqual(y.turn.record.decision);
  });

  it('an app without knowledge may not have a slot that reads nominations: it would never ask', () => {
    expect(() => appWith({ nominates: true })).toThrow('slot "missingNote" asks about the topics retrieval nominates, but the app has no knowledge');
  });

  it('fails open: a retriever that throws, rejects, returns nonsense or is late nominates nothing, the turn goes on, and the trace says why', async () => {
    const cases: Array<[Retriever, object]> = [
      [{ id: 'throws', nominate: () => { throw new Error('index missing'); } }, { failed: 'error', message: 'Error: index missing' }],
      [{ id: 'rejects', nominate: () => Promise.reject(new TypeError('bad')) }, { failed: 'error', message: 'TypeError: bad' }],
      [{ id: 'nonsense', nominate: () => [{ topic: 'opening_hours', score: 1 }] as never }, { failed: 'invalid' }],
      [{ id: 'slow', nominate: () => new Promise<readonly Nomination[]>((r) => setTimeout(() => r(NOMINATED), 200)) }, { failed: 'late' }],
    ];
    for (const [retriever, failure] of cases) {
      const { app, seen } = appWith({ knowledge: { kb: KB, retriever } });
      const { turn } = await call(app, recordingClient(), SAID, { retrieveBudgetMs: 20 });
      expect(turn.record.retrieval, retriever.id).toEqual({ retrieverId: retriever.id, nominated: [], ...failure });
      expect(typeof turn.record.timing.retrieveMs).toBe('number');
      for (const ctx of [...seen.questions, ...seen.fill]) expect(ctx.nominated).toEqual([]);
      // The turn went on: the caller's report form was entered as without knowledge.
      expect(turn.result.session.form, retriever.id).toBe('report_missing');
    }
  });
});

describe('retrieve', () => {
  const input = { text: 'when are you open', locale: 'en-US', todayIso: TODAY };

  it('copies each nomination to exactly its four fields, in the order given', async () => {
    const extra = [{ topic: 'a', title: 'A', score: 2, via: 'dense', secret: 'x' }] as never;
    const r = await retrieve({ kb: KB, retriever: { id: 'r', nominate: () => extra } }, input);
    expect(r.nominated).toEqual([{ topic: 'a', title: 'A', score: 2, via: 'dense' }]);
    expect(r.record).toEqual({ retrieverId: 'r', nominated: [{ topic: 'a', score: 2, via: 'dense' }] });
  });

  it('waits RETRIEVE_BUDGET_MS by default, and a late answer is never used', async () => {
    expect(RETRIEVE_BUDGET_MS).toBe(150);
    let settle: (n: readonly Nomination[]) => void = () => {};
    const late = await retrieve({ kb: KB, retriever: { id: 'r', nominate: () => new Promise((r) => (settle = r)) } }, input, 5);
    settle(NOMINATED);
    expect(late.nominated).toEqual([]);
    expect(late.record?.failed).toBe('late');
  });

  it('a late retriever that rejects afterwards surfaces nothing', async () => {
    let fail: (e: Error) => void = () => {};
    const late = await retrieve({ kb: KB, retriever: { id: 'r', nominate: () => new Promise((_, reject) => (fail = reject)) } }, input, 5);
    fail(new Error('after'));
    await new Promise((r) => setTimeout(r, 5));
    expect(late.record?.failed).toBe('late');
  });

  it('nothing runs without a retriever', async () => {
    expect(await retrieve({ kb: KB }, input)).toEqual({ nominated: [], record: null, ms: null });
  });
});

describe('the nominations in plan and resolve', () => {
  const tc = (knowledge?: TurnContext['knowledge']): TurnContext => ({
    nowMs: 0, todayIso: TODAY, thresholds: { ...DEFAULT_THRESHOLDS }, tools: {} as never, ...(knowledge ? { knowledge } : {}),
  });

  it('slotContext carries them only when the turn has them', () => {
    const session = newSession('kb-4', 0, WEB_CHAT, CUSTOMER);
    expect('nominated' in slotContext(session, 'hi', tc())).toBe(false);
    expect(slotContext(session, 'hi', tc({ nominated: NOMINATED })).nominated).toEqual(NOMINATED);
    expect(slotContext(session, 'hi', tc({ nominated: [] })).nominated).toEqual([]);
  });

  /** The routing words' answers: everything heard, a tentative report, and the note described. */
  const ROUTE: AnswerMap = {
    addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
    rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05), frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }),
    intent: choice({ report_missing: 0.97, none: 0.03 }), intentTentative: noul(0.9), describesParcel: noul(0.95),
  };
  const YES: AnswerMap = { ...ROUTE, intent: choice({ none: 0.95, report_missing: 0.05 }), intentTentative: noul(0.05), confirmsYes: noul(0.95), confirmsNo: noul(0.02) };
  const MAYBE = 'maybe report a missing parcel, it was a small box left at the gate';

  it('a yes that confirms an intent fills the form from the earlier words with the topics nominated for them, kept with the confirmation', () => {
    const { app, seen } = appWith({ knowledge: { kb: KB, retriever: fixedRetriever() } });
    const greeted = resolve(newSession('kb-5', 0, WEB_CHAT, CUSTOMER, app.id), startEvent(), null, tc());
    const asked = resolve(greeted.session, textEvent(MAYBE), ROUTE, tc({ nominated: NOMINATED }));
    expect(asked.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_intent_explicit' });
    expect(asked.session.pendingConfirmation).toEqual({ target: 'intent', intent: 'report_missing', answers: ROUTE, text: MAYBE, nominated: NOMINATED });
    seen.fill.length = 0;
    // The yes turn retrieved for "yes" and found nothing; the form fills from the words before it.
    const yes = resolve(asked.session, textEvent('yes'), YES, tc({ nominated: [] }));
    expect(yes.session.form).toBe('report_missing');
    expect(yes.session.slots.missingNote!.value).toBe(MAYBE);
    const earlier = seen.fill.filter((ctx) => ctx.text === MAYBE);
    expect(earlier.length).toBeGreaterThan(0);
    for (const ctx of earlier) expect(ctx.nominated).toEqual(NOMINATED);
    // What the yes itself fills (the form hears it too) sees the yes turn's own nominations.
    for (const ctx of seen.fill.filter((c) => c.text === 'yes')) expect(ctx.nominated).toEqual([]);
  });

  it('without retrieval on the earlier turn, the confirmation keeps no nominations and the form fills without them', () => {
    const { app, seen } = appWith({ knowledge: { kb: KB, retriever: fixedRetriever() } });
    const greeted = resolve(newSession('kb-6', 0, WEB_CHAT, CUSTOMER, app.id), startEvent(), null, tc());
    const asked = resolve(greeted.session, textEvent(MAYBE), ROUTE, tc());
    expect(asked.session.pendingConfirmation).toEqual({ target: 'intent', intent: 'report_missing', answers: ROUTE, text: MAYBE });
    seen.fill.length = 0;
    const yes = resolve(asked.session, textEvent('yes'), YES, tc({ nominated: NOMINATED }));
    expect(yes.session.form).toBe('report_missing');
    const earlier = seen.fill.filter((ctx) => ctx.text === MAYBE);
    expect(earlier.length).toBeGreaterThan(0);
    for (const ctx of earlier) expect('nominated' in ctx).toBe(false);
  });

  it('isTopicSlot is the slot\'s own opt-in', () => {
    expect(isTopicSlot(testkitApp.slots.missingNote!)).toBe(false);
    expect(isTopicSlot({ ...testkitApp.slots.missingNote!, nominates: true })).toBe(true);
    expect(Object.values(testkitApp.slots).some(isTopicSlot)).toBe(false);
  });
});
