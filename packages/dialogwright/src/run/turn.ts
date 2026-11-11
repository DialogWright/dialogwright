import { recordingTexts, textAuditRow, type TextKeys, type TextLimits } from '../texts/record';
import type { TextProvider, TextRecord } from '../texts/types';
import { performance } from 'node:perf_hooks';
import { wordsOf, type SessionEvent } from '../channel/events';
import { agentSettledWithout, followUpOf, followUpQuestions, plan, sensitiveDigit, slotContext, type ArrivalDigit, type DigitArrivalContext, type FollowUp, type TurnContext, type TurnError, type TurnResult } from '../core/turn';
import { cloneSession, type Session } from '../core/session';
import { maskCodeEvent, maskSpokenCode, saidCode } from '../core/spokenCode';
import { pronounceFor, unpronounce } from '../channel/pronounce';
import { maskId } from '../gate/principal';
import { isAnonymous } from '../gate/types';
import { demoTools, type Tools } from '../core/tools';
import type { TurnState } from '../core/state';
import type { Thresholds } from '../core/thresholds';
import { DEFAULT_SCREEN_MODE, inlineScreenQuestions, screenQuestions, screenResult, screenState, splitInlineAnswers, withInlineScreen, type ScreenMode, type ScreenResult } from '../core/screen';
import { codeLengthOf } from '../core/app/lookup';
import { appOf } from '../core/app/registry';
import { JevClientError, isNoul, noulValue, type AnswerMap, type JevClient, type JevResponse, type JevUsage, type JsonValue, type QuestionMap } from '../jev/types';
import type { RenderContext } from '../prompts/render';
import { buildTraceRecord, type TraceSink } from '../trace/writer';
import type { FollowUpRecord, TraceRecord } from '../trace/types';
import type { AuditDraft, AuditEntry, Chained } from '../audit/types';
import { topicsListening, type TurnKnowledge } from '../core/knowledge';
import { localeOf } from '../core/locale';
import { retrieve, type Retrieved } from './retrieve';
import { calledVariables } from '../core/routes';
import { renderTurn, withRenderAudit, type EarlyLines } from '../render/turn';
import { holdAgentLine, judgeTextValues } from '../render/agentLine';
import { DRIFT_FIRE } from '../render/checks';
import { DEFAULT_RENDER_CHECK_TIMEOUT_MS } from '../render/types';
import { defaultRenderPrice } from '../render/providers';
import type { Renderer } from '../render/types';
import type { Action } from '../channel/actions';
import { TOOL_TIMEOUT_MS, waitingOf } from '../core/toolWait';
import { agentFiller, resolveWaiting } from './waiting';
import { agentAsks, agentContextOf, agentSentRecord, fullLeftOut, narrowedFields, NO_AGENT_CLIENT, withFirstValues, type AgentSentRecord, type AgentTurnRecord } from '../core/agentTurn';
import { isYesNoField } from '../core/questions';
import { DEFAULT_AGENT_TIMEOUT_MS, type AgentContext, type AgentResult, type AgentRunner, type SeenResult } from '../agent/types';

export interface TurnObserver {
  /**
   * The request to the model is about to leave; `questions` are perception's (the trace record's
   * `questions`). With the screen inline the request also carries the screen's question, whose
   * reading is the record's `screen`.
   */
  asked(questions: QuestionMap, turnState: TurnState, at: number): void;
  /** The turn is resolved; `record` is the trace record as written. Fires whether or not the model was asked. */
  turn(record: TraceRecord, at: number): void;
  /** The turn's audit entries, as appended to the chain; only on a turn that had any. */
  audit?(entries: readonly AuditEntry[], at: number): void;
}

/**
 * Where a turn's audit drafts are chained: the server's AuditLog (day files), its Postgres audit
 * (AUDIT_STORE=postgres, audit/postgres.ts), or a test's collector. A sink that chains at once returns
 * the entry; one that chains in a database returns a promise of it.
 */
export interface AuditSink {
  append(callId: string, channel: string, d: AuditDraft): Chained<AuditEntry>;
  /** A turn's drafts chained together (in one transaction, for a database); absent, each is appended in turn. */
  appendAll?(callId: string, channel: string, ds: readonly AuditDraft[]): Promise<AuditEntry[]>;
}

/** `ds` chained in order: at once from a sink that chains at once (as it always was), else a promise of the entries. */
export function chainDrafts(sink: AuditSink, callId: string, channel: string, ds: readonly AuditDraft[]): Chained<AuditEntry[]> {
  if (sink.appendAll && ds.length > 0) return sink.appendAll(callId, channel, ds);
  const out = ds.map((d) => sink.append(callId, channel, d));
  return out.some((e) => e instanceof Promise) ? Promise.all(out) : (out as AuditEntry[]);
}

/** `fn` with what was chained: at once when it is there, else once it is (a failure goes to `onError`, never thrown). */
export function whenChained<T>(x: Chained<T>, fn: (t: T) => void, onError: (err: unknown) => void): void {
  if (x instanceof Promise) x.then(fn, onError);
  else fn(x);
}

export interface RunOptions {
  client: JevClient;
  thresholds: Thresholds;
  todayIso: string;
  trace?: TraceSink | null;
  now?: () => number;
  /** Server-only. The text harness scores the words said, not clips, and must leave this unset. */
  render?: RenderContext | null;
  /** A live watcher of the dialogue (the dashboard). Unset in the harness and the CLI. */
  observe?: TurnObserver | null;
  /**
   * The app's systems, reached only through the gate. A caller running several turns must pass
   * one instance for all of them, so a record created on one turn is there on the next: the scenario
   * runner passes one per scenario, the server one per process (so a record created on one call can be
   * checked on the next). Unset, each turn gets a fresh copy of the app's seed data.
   */
  tools?: Tools;
  /** The audit chain each turn's drafts are appended to, in order. Unset, the drafts are only returned. */
  audit?: AuditSink | null;
  /**
   * Where the injection screen is asked (core/screen.ts ScreenMode): 'inline', the default, in
   * perception's own request; 'separate', in a request of its own beside it. A recorded cassette
   * holds one or the other's requests, so a replay must use the mode it was recorded in.
   */
  screen?: ScreenMode;
  /**
   * Where the variables the app's conditions name are read from (a route's or a transfer target's
   * `called`, `env.<NAME>`; TurnContext.env): runTurn hands the turn only those names, never anything
   * else. The server passes the values it checked as it started; the text CLI its own environment; a
   * scripted call its `env`. Unset, none is set, and such a condition never holds.
   */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * The app's own settings, which its code reads by name with ctx.env (TurnContext.settings): the server
   * passes the app's environment (on a host, its own settings file over the server's). Unset, `env` is
   * read (the text CLI's environment, a scripted call's `env`), so a scripted call is the same wherever
   * it runs; with neither, every setting is unset. Never written to the trace or any other record.
   */
  settings?: Readonly<Record<string, string | undefined>>;
  /**
   * How long a turn waits for the app's knowledge retriever (run/retrieve.ts RETRIEVE_BUDGET_MS,
   * unset). Tests shorten it; a retriever not back in time nominates nothing.
   */
  retrieveBudgetMs?: number;
  /**
   * How lines the app generates are worded (generated wording, render/types.ts Renderer): its client
   * (a model, its recording, or a fake), RENDER_SHARE and RENDER_TIMEOUT_MS. Unset, or for an app that
   * generates no line, every line is its fixed text and the turn is exactly as it was.
   */
  renderer?: Renderer | null;
  /**
   * A channel that can say lines before the turn has ended (the voice relay, the chat socket): handed a
   * knowledge answer's hold line, with the turn's lines before it, as soon as the answer's wording runs
   * past its line's budget (render/turn.ts EarlyLines). True when it said them; the turn's run then says
   * how many of its actions went early (TurnRun.early). Unset (the harness, the CLI, a chat that answers
   * one request with one reply), every line goes with the turn, the hold line in its place.
   */
  early?: EarlyLines;
  /**
   * How long lines take to play, by the channel's estimate (the voice relay's, from its clips' lengths):
   * how a turn waiting on a tool paces its thinking sound (app.yaml `waiting.sound`, run/waiting.ts), one
   * clip once the last should have played. Unset (a chat, the harness), no sound is played.
   */
  playMs?: (actions: readonly Action[]) => number;
  /**
   * The agent model of an app in agent mode (core/agentTurn.ts): its client and its budgets per channel
   * (AGENT_TIMEOUT_VOICE_MS, AGENT_TIMEOUT_CHAT_MS). Asked beside the decision model on each turn of words
   * it can answer, so it adds no wait of its own beyond the slower of the two. Unset on a run of an app in
   * agent mode (no key), the call runs as a scripted app from that turn on (core/agentTurn.ts
   * scriptedFromNow); every other app never asks it.
   */
  agent?: AgentRunner | null;
  /**
   * The server's text sender for the app (texts/types.ts; the guide's 13.17): its provider, the number it
   * sends from and the keys it has sent with. Each turn gives the app's code a sender (ToolContext.texts)
   * that records every text in the turn's audit and trace. Unset (no TEXT_FROM, the harness, the CLI), the
   * app's code has none and no text is sent.
   */
  texts?: TurnTexts | null;
}

/** What a run sends texts with (RunOptions.texts). */
export interface TurnTexts {
  readonly provider: TextProvider;
  readonly from: string;
  readonly keys: TextKeys;
  /** The sender's abuse limits (texts/record.ts TextLimits); absent, none (a test's). */
  readonly limits?: TextLimits;
}

/**
 * What a sensitive keypad digit (sensitiveDigit: a digit of the one-time code, the account ID or the
 * date of birth) is recorded as, in every log. The name is historical: it masks all three.
 */
export const CODE_DIGIT = '•';

/**
 * The turn's environment (TurnContext.env): the variables the app's conditions name (calledVariables),
 * each as `env` holds it, and nothing else, frozen. None for an app whose conditions name none, so its
 * turns are as they were; an empty record where `env` is unset.
 */
function conditionEnv(session: Session, env: RunOptions['env']): Pick<TurnContext, 'env'> {
  const names = calledVariables(appOf(session));
  if (names.length === 0) return {};
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = env !== undefined && Object.hasOwn(env, name) ? env[name] : undefined;
    if (value !== undefined) picked[name] = value;
  }
  return { env: Object.freeze(picked) };
}

/** The app's settings its code reads (TurnContext.settings): RunOptions.settings, else RunOptions.env; none with neither. */
function settingsOf(opts: RunOptions): Pick<TurnContext, 'settings'> {
  const from = opts.settings ?? opts.env;
  if (from === undefined) return {};
  return { settings: (name) => (Object.hasOwn(from, name) ? from[name] : undefined) };
}

export function nowOf(opts: RunOptions): () => number {
  return opts.now ?? (() => Date.now());
}

export interface TurnRun {
  result: TurnResult;
  questions: QuestionMap | null;
  response: JevResponse | null;
  error: TurnError | null;
  /**
   * the injection screen's own response when it was asked separately; null when it was not asked,
   * failed, or rode in perception's request (inline: its answer is split out of `response`, its
   * reading is `record.screen`)
   */
  screenResponse: JevResponse | null;
  /** The turn's second request (core/turn.ts FollowUp), when it made one: its questions, and its response or error. */
  followUp: FollowUpRun | null;
  record: TraceRecord;
  /** the turn's audit entries as the sink chained them; empty when no sink is set */
  audit: AuditEntry[];
  /**
   * How many of `result.actions`, from the first, the channel already said before the turn ended
   * (RunOptions.early: a knowledge answer's hold line and the lines before it); absent or 0 on every other turn.
   */
  early?: number;
}

/** A turn's second request (core/turn.ts FollowUp) as it went: what it asked, and what came back or why nothing did. */
export interface FollowUpRun {
  readonly followUp: FollowUp;
  readonly questions: QuestionMap;
  readonly response: JevResponse | null;
  readonly error: TurnError | null;
}

/** A follow-up's error when the turn's budget for the model (JEV_TIMEOUT_MS) was spent before it could be asked: no request is made. */
export const FOLLOW_UP_NO_TIME = 'no time left of JEV_TIMEOUT_MS';

/**
 * The turn's second request, for what its answers turned out to need (core/turn.ts followUpOf): made
 * only when the gates settle on an aside to the form in hand whose topic is unknown. Retrieval runs
 * for the words then (a topic slot asks only about what it nominates), and, when it nominated anything
 * the turn's answers do not already answer, the topic slot's question alone is asked of the same words
 * with the same turn state: a request of its own, keyed by its own state and question in a cassette.
 * Every other turn makes no second request and retrieves nothing more, so its request is the one it
 * always made. The words were screened with the turn's own request (a quarantined turn never gets here).
 *
 * Its budget is what is left of the turn's (JEV_TIMEOUT_MS, counted from `askedAt`, when the turn's own
 * request went out): the caller waits on the model no longer than a turn without a follow-up could
 * make them, and a run that raises JEV_TIMEOUT_MS (a recording) raises it with it. Nothing left, no
 * request is made. A failed, late or unmade follow-up is no answer: the turn goes on, and the aside asks
 * its slot's own question. Only a client's failure is taken so (clientFailure): anything else is a bug,
 * and is thrown.
 */
async function askFollowUp(session: Session, event: SessionEvent, words: string, turnState: unknown, answers: AnswerMap, tc: TurnContext, screen: ScreenResult | null, opts: RunOptions, askedAt: number): Promise<{ tc: TurnContext; answers: AnswerMap; run: FollowUpRun | null; retrieved: Retrieved | null; ms: number | null }> {
  const followUp = followUpOf(session, event, answers, tc, screen);
  if (followUp === null) return { tc, answers, run: null, retrieved: null, ms: null };
  const knowledge = appOf(session).knowledge;
  const retrieved = knowledge !== undefined && tc.knowledge === undefined
    ? await retrieve(knowledge, { text: words, locale: localeOf(session), todayIso: opts.todayIso, ...earlierOf(session), ...factsOf(session) }, opts.retrieveBudgetMs)
    : null;
  const known: TurnContext = retrieved ? { ...tc, knowledge: knowledgeOf(retrieved) } : tc;
  const questions = followUpQuestions(session, followUp, words, known);
  // Nothing to ask, or nothing the turn's own answers do not already answer.
  if (Object.keys(questions).length === 0 || Object.keys(questions).every((id) => Object.hasOwn(answers, id))) return { tc: known, answers, run: null, retrieved, ms: null };
  const left = Math.floor(opts.thresholds.JEV_TIMEOUT_MS - (performance.now() - askedAt));
  if (left <= 0) return { tc: known, answers, run: { followUp, questions, response: null, error: { name: 'JevClientError', message: FOLLOW_UP_NO_TIME } }, retrieved, ms: 0 };
  const t0 = performance.now();
  const asked = await settle(opts.client.ask({ state: turnState as JsonValue, questions, timeoutMs: left }));
  const ms = performance.now() - t0;
  if (asked.status === 'rejected') return { tc: known, answers, run: { followUp, questions, response: null, error: clientFailure(asked.reason) }, retrieved, ms };
  // Only the follow-up's own questions are taken from it: the turn's answers stand as they came.
  const added = Object.fromEntries(Object.entries(asked.value.answers).filter(([id]) => Object.hasOwn(questions, id) && !Object.hasOwn(answers, id)));
  return { tc: known, answers: { ...answers, ...added }, run: { followUp, questions, response: asked.value, error: null }, retrieved, ms };
}

/** The caller's earlier question, for a retriever that reads a follow-up with it (kb.yaml documents.followUps); nothing where none was kept. */
const earlierOf = (session: Session): { earlier?: string; earlierSections?: readonly string[] } => (session.kbEarlier !== undefined ? { earlier: session.kbEarlier.question, ...(session.kbEarlier.sections !== undefined ? { earlierSections: session.kbEarlier.sections } : {}) } : {});
/** The caller's facts for kb.yaml's applies, where the app gives them (App.knowledge.facts): retrieval offers the sections of the documents for them alone. */
const factsOf = (session: Session): { facts?: Readonly<Record<string, string | undefined>> } => {
  const k = appOf(session).knowledge;
  if (k?.kb === undefined || k.facts === undefined) return {};
  return { facts: k.facts(session) ?? {} };
};

/** What retrieval gives the turn (TurnContext.knowledge): the topics, and the sections where the app nominates any. */
function knowledgeOf(retrieved: Retrieved): TurnKnowledge {
  return { nominated: retrieved.nominated, ...(retrieved.sections !== undefined ? { sections: retrieved.sections } : {}) };
}

/** The trace's account of a follow-up (TraceRecord.followUp). */
function followUpRecord(run: FollowUpRun): FollowUpRecord {
  return {
    reason: run.followUp.reason,
    slot: run.followUp.slot,
    questions: run.questions,
    answers: run.response?.answers ?? null,
    source: run.error ? 'error' : run.response!.source,
    error: run.error,
    usage: run.response?.usage ?? null,
  };
}

/**
 * A JevClientError is a client-level failure (timeout, transport) the harness models as part of
 * the run. Anything else is a bug in the corpus/fixture authoring (e.g. a bad label) and should
 * stop the run rather than being scored as a client failure.
 */
function clientFailure(reason: unknown): TurnError {
  if (!(reason instanceof JevClientError)) throw reason;
  return { name: reason.name, message: reason.message };
}

/**
 * The agent model asked for a turn, within its channel's budget (AgentRunner.timeoutMs, else
 * DEFAULT_AGENT_TIMEOUT_MS): its answer, or why there is none. A client never rejects; one that does is an
 * error all the same, its kind and never its message. No client set: NO_AGENT_CLIENT, at once.
 */
async function askAgent(runner: AgentRunner | null, ctx: Parameters<AgentRunner['client']['answer']>[0], speech: boolean, left?: number, attempt = 1): Promise<AgentResult> {
  if (runner === null) return NO_AGENT_CLIENT;
  const budget = left ?? agentBudget(runner, speech);
  const t0 = performance.now();
  // The budget is held here too, so a client that does not keep to it cannot hold the turn.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<AgentResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'timeout', detail: `no answer within ${budget} ms`, ms: budget }), budget);
  });
  try {
    return await Promise.race([attempt === 1 ? runner.client.answer(ctx, budget) : runner.client.answer(ctx, budget, attempt), late]);
  } catch (err) {
    return { ok: false, reason: 'error', detail: `the agent client threw (${err instanceof Error ? err.name : 'error'})`, ms: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
  }
}

/** The agent model's budget for a turn, ms, on its channel (AgentRunner.timeoutMs, else DEFAULT_AGENT_TIMEOUT_MS). */
function agentBudget(runner: AgentRunner, speech: boolean): number {
  return (runner.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS)[speech ? 'voice' : 'chat'];
}

/**
 * The scripted reading of a form's read-back in agent mode (the agent-mode design, calls 38 and 54): the
 * questions the decision model asks there as an app with no key asks them (each slot's, and those
 * correctingFill reads), asked in the turn's own request beside the agent's ask, so the reading is in hand
 * whenever the agent's answer fails, however late it fails. `session` is the session as a scripted app's for
 * this turn alone (Session.agent.scripted), an optional field left empty held as declined (as in agent mode,
 * where the read-back comes once every required field is filled), so it is not asked on the way back. Null
 * where the turn is not at a form's read-back the agent is asked at.
 */
interface ReadBackReading {
  session: Session;
  questions: QuestionMap;
  /** The optional fields held as declined for this turn alone. */
  skipped: string[];
}

function readBackReading(session: Session, event: SessionEvent, tc: TurnContext): ReadBackReading | null {
  const pc = session.pendingConfirmation;
  if (pc === null || pc.target !== 'form') return null;
  const scripted = cloneSession(session);
  scripted.agent = { conversation: scripted.agent?.conversation ?? [], failures: scripted.agent?.failures ?? 0, ...scripted.agent, scripted: true };
  const skipped = (appOf(session).agent?.forms[pc.form]?.fields ?? []).filter((f) => !f.required && scripted.slots[f.slot]?.value === null && scripted.slots[f.slot]?.declined !== true).map((f) => f.slot);
  for (const slot of skipped) scripted.slots[slot]!.declined = true;
  const p = plan(scripted, event, tc);
  if (!p.needsModel || p.questions === null) return null;
  // A choice of yes and no (a consent: "Is it OK if we text you?") is not read here: the caller's yes to the
  // read-back answers its question too, and was taken as the field's new value, a no to texts turned to a yes
  // (the agent-mode design, call 55's recording). A correction of it waits for the agent, or for "What should
  // I change?".
  // The core fills none from the yes either (core/turn.ts yesNoSlotsOf), so the call run scripted on its own is held the same.
  const app = appOf(session);
  const yesNo = (app.agent?.forms[pc.form]?.fields ?? []).filter(isYesNoField).map((f) => f.slot);
  const dropped = new Set(yesNo.flatMap((slot) => app.slots[slot]?.questionIds ?? [slot]));
  const questions = Object.fromEntries(Object.entries(p.questions).filter(([id]) => !dropped.has(id)));
  return { session: scripted, questions, skipped };
}

/** The answers of `answers` to the questions of `questions` alone. */
function answersTo(answers: AnswerMap, questions: QuestionMap): AnswerMap {
  return Object.fromEntries(Object.entries(answers).filter(([id]) => Object.hasOwn(questions, id)));
}

/**
 * The turn of an app in agent mode whose agent answer failed (a timeout, an answer not in its shape, an
 * error) at a form's read-back, decided the scripted way from the reading asked beside the agent
 * (readBackReading; the agent-mode design, calls 38 and 54): a plain yes completes the form, a yes or a no
 * with a correction corrects it and says the read-back again. The reading's answers came in the turn's own
 * request, so they are there however late the agent failed: no second request is made, and none is charged.
 * Where the turn's request failed, or carried no reading, the turn stands as it first did (the read-back again,
 * nothing done; `scripted: 'none'`). The second failure in a row hands off as ever: the reading is not used
 * (`scripted: 'unused'`). Where the agent answered, the reading was asked and not needed (`unused`). The session
 * goes on in agent mode, its failure counted. Null for every other turn.
 */
async function scriptedReading(
  session: Session, event: SessionEvent, first: TurnResult, tc: TurnContext, screen: ScreenResult | null, reading: ReadBackReading | null, answers: AnswerMap | null,
  channel: Parameters<typeof resolveWaiting>[6], toolTimeout: number,
): Promise<{ result: TurnResult; waited: Awaited<ReturnType<typeof resolveWaiting>>['waited'] | undefined } | null> {
  const pc = session.pendingConfirmation;
  if (pc === null || pc.target !== 'form' || first.agent === undefined) return null;
  const marked = (scripted: 'read' | 'none' | 'unused') => ({ result: { ...first, agent: { ...first.agent!, scripted } }, waited: undefined });
  // A turn quarantined, or one the screen fired on, is decided without the words: the reading, asked, is not used.
  if (first.quarantined || screen?.fired === true) return reading !== null ? marked('unused') : null;
  if (first.agent.use !== 'failed') return reading !== null && answers !== null ? marked('unused') : null;
  if (reading === null || answers === null) return marked('none');
  // The second failure in a row hands off, as on any turn: the reading is not used.
  if ((first.session.agent?.failures ?? 0) >= 2) return marked('unused');
  const scripted = cloneSession(reading.session);
  const next = await resolveWaiting(scripted, event, answersTo(answers, reading.questions), { ...tc }, null, screen, channel, toolTimeout);
  // The call goes on in agent mode: only this turn was the scripted one; the failure is counted as the first reading counted it.
  const s = next.result.session;
  for (const slot of reading.skipped) delete s.slots[slot]?.declined;
  const { scripted: _scripted, ...agent } = s.agent ?? { conversation: [], failures: 0 };
  s.agent = { ...agent, failures: first.session.agent?.failures ?? agent.failures };
  // What the turn decided of the cancel question at the read-back (call 55), decided here from the reading.
  const cancel = next.result.cancel?.step;
  return { result: { ...next.result, session: s, agent: { ...first.agent, scripted: 'read', ...(cancel !== undefined ? { cancel } : {}) } }, waited: next.waited };
}

/** The detail of a second answer not asked, the turn's budget spent before it (askAgain). */
export const AGENT_AGAIN_NO_TIME = "no time left of the agent's budget";

/**
 * The agent model asked again on a turn whose values ran a tool it sees (TurnResult.agentAgain; core/agentTurn.ts),
 * now shown the checked results: within what is left of the turn's budget, counted from when it was first
 * asked, so the two answers together take no longer than one may. Nothing left, it is not asked.
 */
async function askAgain(runner: AgentRunner, first: AgentContext, seen: readonly SeenResult[], speech: boolean, askedAt: number, budgetMs: number = agentBudget(runner, speech)): Promise<{ result: AgentResult; ctx: AgentContext }> {
  const ctx: AgentContext = { ...first, seen: seen.map(({ tool, result }) => ({ tool, result })) };
  const left = Math.floor(budgetMs - (performance.now() - askedAt));
  if (left <= 0) return { result: { ok: false, reason: 'timeout', detail: AGENT_AGAIN_NO_TIME, ms: 0 }, ctx };
  return { result: await askAgent(runner, ctx, speech, left), ctx };
}

/**
 * The agent model asked once more, the same request, after an answer not in its shape on a turn that needed it
 * (AgentRunner.retry, AGENT_RETRY; the maintainer's decision, 2026-11-10, call 60): only an `invalid` answer,
 * never one cut off at the token limit (a runaway, which tends to run away again, and has spent the most time),
 * a timeout (no time is left) or an error; and only where the time left of the turn's budget, counted from when
 * the model was first asked, is at least what the first answer took (the second, the same request, is taken to
 * take about as long; asked with less, it would most likely time out, the caller hearing nothing the while).
 * Asked within what is left. Null where it is not asked.
 */
async function retryAgent(runner: AgentRunner, ctx: AgentContext, budgetMs: number, askedAt: number, first: AgentResult): Promise<AgentResult | null> {
  if (runner.retry === false || first.ok || first.reason !== 'invalid' || first.cutOff === true) return null;
  // The first answer's own time, or the time since it was asked where that is longer (a client that reports less).
  const spent = Math.max(first.ms, performance.now() - askedAt);
  const left = Math.floor(budgetMs - spent);
  if (left < first.ms || left <= 0) return null;
  return askAgent(runner, ctx, ctx.channel === 'voice', left, 2);
}

/** Two answers' tokens and costs added (agentSpent of each). */
function bothSpent(a: ReturnType<typeof agentSpent>, b: ReturnType<typeof agentSpent>): ReturnType<typeof agentSpent> {
  const usage = a.usage === undefined ? b.usage : b.usage === undefined ? a.usage : { inputTokens: a.usage.inputTokens + b.usage.inputTokens, outputTokens: a.usage.outputTokens + b.usage.outputTokens };
  const costUsd = a.costUsd === undefined ? b.costUsd : b.costUsd === undefined ? a.costUsd : a.costUsd + b.costUsd;
  return { ...(usage !== undefined ? { usage } : {}), ...(costUsd !== undefined ? { costUsd } : {}) };
}

/** An answer's tokens and cost: the provider's own cost where it gives one, else the tokens at the model's price. */
function agentSpent(r: AgentResult, runner: AgentRunner | null | undefined): { usage?: { inputTokens: number; outputTokens: number }; costUsd?: number } {
  if (r.usage === undefined) return r.costUsd !== undefined ? { costUsd: r.costUsd } : {};
  const price = runner?.price ?? defaultRenderPrice(runner?.client.model);
  const costUsd = r.costUsd ?? (r.usage.inputTokens * price.input + r.usage.outputTokens * price.output) / 1_000_000;
  return { usage: { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens }, costUsd };
}

/**
 * The trace's record of the agent's answer (TraceRecord.agent): the turn's, with its tokens and cost, what
 * it was sent (the second time, where it was asked again), and the second asking (`again`): both answers'
 * time and cost together.
 */
function agentRecord(record: AgentTurnRecord, first: AgentResult | null, again: { result: AgentResult; tools: string[] } | null, runner: AgentRunner | null | undefined, sent: AgentSentRecord | null, retry: AgentResult | null = null): AgentTurnRecord & { sent?: AgentSentRecord } {
  const firstSpent = first === null ? {} : retry === null ? agentSpent(first, runner) : bothSpent(agentSpent(first, runner), agentSpent(retry, runner));
  const spent = again === null ? firstSpent : bothSpent(firstSpent, agentSpent(again.result, runner));
  const firstMs = (first?.ms ?? 0) + (retry?.ms ?? 0);
  // Asked once more after an answer not in its shape: why the first was not, the second's own time, and why it failed too where it did.
  const retried = retry === null || first === null || first.ok ? {} : {
    ms: firstMs,
    retried: { invalid: first.detail, ms: retry.ms, ...(retry.ok ? {} : { fallback: retry.reason, detail: retry.detail }) },
  };
  const asked = again === null ? {} : {
    ms: firstMs + again.result.ms,
    again: { tools: again.tools, ms: again.result.ms, ...(again.result.ok ? {} : { fallback: again.result.reason, detail: again.result.detail }) },
  };
  return { ...record, ...spent, ...retried, ...asked, ...(sent !== null ? { sent } : {}) };
}

/** Two usages of the decision model added; null where neither was spent. */
function sumUsage(a: JevUsage | null, b: JevUsage | null): JevUsage | null {
  if (a === null) return b;
  if (b === null) return a;
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, estimated: a.estimated || b.estimated };
}

/** The separate screen's error when it had not answered SCREEN_GRACE_MS after perception did. */
export const SCREEN_LATE = 'screen late';

function settle<T>(p: Promise<T>): Promise<PromiseSettledResult<T>> {
  return p.then((value) => ({ status: 'fulfilled', value }), (reason: unknown) => ({ status: 'rejected', reason }));
}

/** `settled` as it stands after at most `ms` more, or 'late'. */
async function settledWithin<T>(settled: Promise<PromiseSettledResult<T>>, ms: number): Promise<PromiseSettledResult<T> | 'late'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), ms);
  });
  try {
    return await Promise.race([settled, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** What the server decided about an event when it arrived, before the turn ran. */
export interface Arrival {
  /** A keypad digit's class on arrival; see TurnContext.digitClass. Null for any other event. */
  sensitive: ArrivalDigit;
  /** Whether session.pendingService was set when the event arrived; see TurnContext.duringService. */
  duringService?: boolean;
  /** A keypad digit's question on arrival; see TurnContext.digitPromptedFor. */
  promptedFor?: Session['promptedFor'];
  /** promptEpoch on arrival, for a digit keyed ahead; see TurnContext.digitEpoch. */
  epoch?: number;
}

/**
 * The turn context's arrival fields for `event`: from `arrival` when the server decided them, or,
 * unset, from `session`, which is the same moment for a caller that runs each event as it arrives.
 */
export function arrivalContext(session: Session, event: SessionEvent, arrival?: Arrival): DigitArrivalContext {
  return {
    digitClass: arrival ? arrival.sensitive : sensitiveDigit(session, event),
    duringService: arrival?.duringService === true,
    ...(arrival?.promptedFor !== undefined ? { digitPromptedFor: arrival.promptedFor } : {}),
    ...(arrival?.epoch !== undefined ? { digitEpoch: arrival.epoch } : {}),
  };
}

/**
 * An interruption's `heard` is our own line as far as the carrier had played it, echoed in the text
 * it was sent, so with the app's respellings (voice.pronounce): each whole one is mapped back to its
 * word, so the session, the trace and the console read the line as it was written, and a redacted
 * value in it is masked as written (trace/redact.ts). Any other event is as it came.
 */
function heardAsWritten(session: Session, event: SessionEvent): SessionEvent {
  if (event.type !== 'user.interrupt') return event;
  const heard = unpronounce(event.heard, pronounceFor(appOf(session).voice, localeOf(session)));
  return heard === event.heard ? event : { ...event, heard };
}

/**
 * `arrival` is the server's once-only decision about the event, made when it came off the wire.
 * Unset (the harness, the CLI, which run each event as it arrives), it is made here from `session`,
 * by the same predicate. `joined` is set only by a Continuation (run/continuation.ts), for a turn
 * whose words join the final prompts of a caller who had not finished: the prompts, in order, which
 * the trace record keeps beside the joined words; and by the voice server for words it held for the
 * rest of a value, with `waitedFor`, the slot whose value they began (run/continuation.ts HeldWords).
 * `setAsideAs`, a Continuation's only: the session a joined turn set aside as speech over a line returns
 * (TurnContext.setAsideAs).
 */
export async function runTurn(session: Session, heard: SessionEvent, opts: RunOptions, arrival?: Arrival, joined?: readonly string[], waitedFor?: string, setAsideAs?: Session): Promise<TurnRun> {
  // A code said aloud at the code prompt goes no further than this, whoever called: the screen,
  // perception, the core and the trace all get the masked words. This is the same masking the voice
  // adapter applies to the wire frame (maskCodeFrame) before its frame log, so there it is already
  // masked and this is a no-op; this covers every other way in.
  const event = heardAsWritten(session, maskCodeEvent(session.promptedFor, heard, codeLengthOf(appOf(session))));
  // The prompts a joined turn's words join, kept beside them in the trace: where the joined words
  // held a code said aloud, every digit of each prompt is masked, as no one prompt held enough of it
  // to be masked on its own (the code may have been said across them).
  const fragments = joined && event !== heard && event.type === 'user.speech' && saidCode(event.text)
    ? joined.map((f) => maskSpokenCode(f, 1).text)
    : joined;
  const words = wordsOf(event);
  const now = nowOf(opts);
  const digit = arrivalContext(session, event, arrival);
  const sensitive = digit.digitClass ?? null;
  // The texts this turn's tools send, recorded as they go (the audit's text_sent, the trace's texts).
  const sentTexts: TextRecord[] = [];
  const texts = opts.texts != null ? recordingTexts(opts.texts.provider, opts.texts.from, opts.texts.keys, (r) => sentTexts.push(r), opts.texts.limits ?? null) : null;
  const base: TurnContext = {
    nowMs: now(),
    todayIso: opts.todayIso,
    thresholds: opts.thresholds,
    tools: opts.tools ?? demoTools(),
    render: opts.render ?? null,
    ...conditionEnv(session, opts.env),
    ...settingsOf(opts),
    ...(texts !== null ? { texts } : {}),
    ...digit,
    // A joined turn set aside as speech over a line returns the session it was given (TurnContext.setAsideAs).
    ...(setAsideAs !== undefined ? { setAsideAs } : {}),
    // An app in agent mode run with no agent client: its call runs as a scripted app (core/agentTurn.ts agentLed).
    ...(appOf(session).mode === 'agent' && (opts.agent ?? null) === null ? { noAgentClient: true as const } : {}),
  };
  const tr = performance.now();
  // Retrieval, the turn's one async step before planning: questions are built synchronously, so the
  // topics a topic slot asks about are nominated first, once, and plan() and resolve() both see them.
  // Only when a topic slot is listening (an app with a knowledge base, words, such a slot active): any
  // other turn's context, and so its request, is exactly as it was.
  const retrieved = topicsListening(session, event, base.duringService)
    ? await retrieve(appOf(session).knowledge!, { text: words!, locale: localeOf(session), todayIso: opts.todayIso, ...earlierOf(session), ...factsOf(session) }, opts.retrieveBudgetMs)
    : null;
  const tc: TurnContext = retrieved ? { ...base, knowledge: knowledgeOf(retrieved) } : base;
  const t0 = performance.now();
  const own = plan(session, event, tc);
  // At a form's read-back the agent is asked at, the form's own questions ride in the turn's request beside the
  // agent's ask (readBackReading), so the scripted reading is in hand if the agent fails (call 54).
  const reading = agentAsks(session, event, base) && opts.agent != null && own.needsModel && own.questions !== null ? readBackReading(session, event, tc) : null;
  const p = reading !== null ? { ...own, questions: { ...reading.questions, ...own.questions } } : own;
  const t1 = performance.now();
  // Typed by cast, not narrowed: askJev, below, sets them.
  let response = null as JevResponse | null;
  let error = null as TurnError | null;
  let screenResponse = null as JevResponse | null;
  let screen = null as ScreenResult | null;
  // The agent model, for a turn of an app in agent mode it can answer: asked now, beside the decision model.
  const agentCtx = agentAsks(session, event, base) ? agentContextOf(session, event, base) : null;
  const agentSent: AgentSentRecord | null = agentCtx !== null ? agentSentRecord(agentCtx) : null;
  const agentAskedAt = performance.now();
  // On a call, an app that says what the caller hears while the model is slow (business.yaml's `waiting`): the
  // turn waits for the answer up to its upToMs (the runner's budget where that is longer), and past its afterMs,
  // the answer not in, one of its lines is said at once (run/waiting.ts agentFiller). Absent, the runner's budget.
  // Not at a form's read-back, which is read the scripted way where the answer fails (scriptedReading): there the
  // turn waits the runner's own budget, says no line and asks nothing again, so a failure never delays the reading.
  const atReadBack = reading !== null;
  const agentWait = agentCtx !== null && opts.agent != null && session.caps.speech && !atReadBack ? (appOf(session).agent?.waiting ?? null) : null;
  const ownBudgetMs = opts.agent != null ? agentBudget(opts.agent, session.caps.speech) : 0;
  const agentBudgetMs = Math.max(ownBudgetMs, agentWait?.upToMs ?? 0);
  const filler = agentWait !== null ? agentFiller(session, agentWait, { ...(opts.early !== undefined ? { early: opts.early } : {}), render: opts.render ?? null }, agentAskedAt) : null;
  // A turn the decision model's reading shows will be decided without the answer (agentSettledWithout) waits no
  // longer for it than the runner's own budget: past it, the answer is taken as late, as it was before the setting.
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  let capAgent: (() => void) | null = null;
  const capped = new Promise<AgentResult>((resolve) => {
    capAgent = () => {
      capTimer = setTimeout(() => resolve({ ok: false, reason: 'timeout', detail: `no answer within ${ownBudgetMs} ms (the turn decided without it)`, ms: ownBudgetMs }), Math.max(0, ownBudgetMs - (performance.now() - agentAskedAt)));
      capTimer.unref?.();
    };
  });
  // The decision model's reading is in: the line is said only where it would not be said over a caller not finished,
  // and never on a turn that will not use the answer (then the wait is the runner's own budget too).
  const readingIn = (): void => {
    if (filler === null) return;
    const answers = response?.answers ?? null;
    if (agentSettledWithout(session, event, error !== null ? null : answers, tc, screen)) {
      filler.stop();
      capAgent?.();
      return;
    }
    filler.readingIn(answers !== null && isNoul(answers.utteranceComplete) ? noulValue(answers, 'utteranceComplete') : null);
  };
  try {
    // Its answer in, the line waits: a turn still waiting on the decision model or a tool is not the model being slow.
    const agentAsked: Promise<AgentResult | null> = agentCtx === null
      ? Promise.resolve(null)
      : Promise.race([askAgent(opts.agent ?? null, agentCtx, session.caps.speech, agentBudgetMs), capped]).then((r) => (filler?.pause(), r));
    const askJev = async (): Promise<void> => {
      if (p.needsModel && words !== null) {
        try {
          opts.observe?.asked(p.questions!, p.turnState as TurnState, now());
        } catch {
          /* observers are best effort */
        }
        const timeoutMs = opts.thresholds.JEV_TIMEOUT_MS;
        if ((opts.screen ?? DEFAULT_SCREEN_MODE) === 'inline') {
          // The screen's question rides in perception's request: one request, one timeout. The model
          // answers each question on its own, and the screen's is told to read asr.text alone, the same
          // words the separate screen is given. A failed request fails both: the turn takes its
          // client-failure path, and the screen reports the same error (fails open, as ever).
          const screenQs = inlineScreenQuestions(appOf(session));
          const asked = await settle(opts.client.ask({ state: p.turnState as unknown as JsonValue, questions: withInlineScreen(p.questions!, screenQs), timeoutMs }));
          if (asked.status === 'fulfilled') {
            const split = splitInlineAnswers(asked.value.answers, screenQs);
            response = { ...asked.value, answers: split.perception };
            screen = screenResult(split.screen, null, opts.thresholds, true);
          } else {
            error = clientFailure(asked.reason);
            screen = screenResult(null, error.message, opts.thresholds, true);
          }
        } else {
          // The injection screen goes out beside perception, so it costs no latency. Its request holds
          // the caller's words and nothing else: no session state can sway it. A keypad turn
          // never gets here, so a digit of the code is never screened. Settled as it is made, so a screen
          // left behind as late never surfaces as an unhandled rejection.
          const screening = settle(opts.client.ask({ state: screenState(words), questions: screenQuestions(appOf(session)), timeoutMs }));
          const perceived = await settle(opts.client.ask({ state: p.turnState as unknown as JsonValue, questions: p.questions!, timeoutMs }));
          if (perceived.status === 'fulfilled') response = perceived.value;
          else error = clientFailure(perceived.reason);
          // Once perception is back the screen gets SCREEN_GRACE_MS more, not the full timeout: the
          // caller is waiting on it. The screen fails open: a failed or late screen leaves the turn to
          // perception and the gate, and says so in the trace.
          const screened = await settledWithin(screening, opts.thresholds.SCREEN_GRACE_MS);
          if (screened === 'late') {
            screen = screenResult(null, SCREEN_LATE, opts.thresholds);
          } else if (screened.status === 'fulfilled') {
            screenResponse = screened.value;
            screen = screenResult(screened.value.answers, null, opts.thresholds);
          } else {
            screen = screenResult(null, clientFailure(screened.reason).message, opts.thresholds);
          }
        }
      }
    };
    // The decision model and the agent at once: the turn waits for the slower, never the two in turn.
    const [, agentResult] = await Promise.all([askJev().then(readingIn), agentAsked]);
    if (capTimer !== undefined) clearTimeout(capTimer);
    const t2 = performance.now();
    // The turn reads only its own questions' answers: the read-back reading's are the scripted reading's alone
    // (scriptedReading), so neither a follow-up nor the agent turn sees them.
    const ownAnswers = (a: AnswerMap | null): AnswerMap | null => (a === null || reading === null || own.questions === null ? a : answersTo(a, own.questions));
    // A second request on the same words, when the answers turn out to need one (askFollowUp).
    const second = response !== null && words !== null && p.turnState !== null
      ? await askFollowUp(session, event, words, p.turnState, ownAnswers(response.answers)!, tc, screen, opts, t1)
      : null;
    let turnTc: TurnContext = { ...(second?.tc ?? tc), ...(agentResult !== null ? { agent: agentResult } : {}) };
    const t2f = performance.now();
    // The core, run again while a tool it called is still to reply (core/toolWait.ts), with the app's hold
    // line and thinking sound said while it waits (run/waiting.ts); once for a turn whose tools reply at once.
    const turnAnswers = ownAnswers(second?.answers ?? response?.answers ?? null);
    const channel = {
      ...(opts.early !== undefined ? { early: opts.early } : {}),
      ...(opts.playMs !== undefined ? { playMs: opts.playMs } : {}),
      render: opts.render ?? null,
    };
    const toolTimeout = waitingOf(appOf(session)).timeoutMs ?? TOOL_TIMEOUT_MS;
    const first = await resolveWaiting(session, event, turnAnswers, turnTc, error, screen, channel, toolTimeout);
    let { result: resolved, waited } = first;
    // An app in agent mode whose answer was not in its shape on a turn that needed it (its fallback said): the same
    // request asked once more, where the turn's budget leaves time for it (retryAgent), and the turn resolved again
    // from the start with its answer, used as any answer (the calls already made kept). Where it fails too, the turn
    // as it first stood: the fallback.
    let retry: AgentResult | null = null;
    if (agentCtx !== null && opts.agent != null && agentResult !== null && !atReadBack && resolved.agent?.use === 'failed' && resolved.agent.fallback === 'invalid') {
      filler?.resume();
      retry = await retryAgent(opts.agent, agentCtx, agentBudgetMs, agentAskedAt, agentResult);
      filler?.pause();
      if (retry !== null && retry.ok) {
        turnTc = { ...turnTc, agent: retry };
        const next = await resolveWaiting(session, event, turnAnswers, turnTc, error, screen, channel, toolTimeout, first.memo);
        resolved = next.result;
        waited = next.waited ?? waited;
      }
    }
    // An app in agent mode whose values ran a tool the model sees: the model asked again, shown its checked
    // result, within what is left of its budget, and the turn resolved again from the start with that answer
    // (the calls already made kept, none made twice). Where no second answer comes, the turn as it first stood.
    let agentShown = agentCtx;
    let again: { result: AgentResult; tools: string[] } | null = null;
    // The agent answer the turn was last resolved with, and its context (for the text values' judge below).
    let used: TurnContext | null = turnTc.agent?.ok === true ? turnTc : null;
    if (resolved.agentAgain !== undefined && agentCtx !== null && opts.agent != null) {
      const seen = resolved.agentAgain.seen;
      // A choice held to the result (`freeFrom`) is offered with its free options only, for the day the turn now holds (call 54).
      const narrowed: AgentContext = { ...agentCtx, fields: narrowedFields(appOf(session), resolved.session, agentCtx.fields, seen) };
      filler?.resume();
      const asked = await askAgain(opts.agent, narrowed, seen, session.caps.speech, agentAskedAt, agentBudgetMs);
      filler?.pause();
      again = { result: asked.result, tools: [...new Set(seen.map((x) => x.tool))] };
      if (asked.result.ok) {
        // The first answer's accepted values the second leaves out are kept (call 39), a free-from field's only while the result lists it.
        const carried: AgentResult = resolved.agent !== undefined ? { ...asked.result, answer: withFirstValues(appOf(session), resolved.agent, resolved.session.form, asked.result.answer, seen) } : asked.result;
        // An option the first answer gave that the result shows full, left out by the second: its full line is said (call 54).
        const full = resolved.agent !== undefined ? fullLeftOut(appOf(session), opts.todayIso, resolved.agent, resolved.session.form, asked.result.answer, seen) : [];
        used = { ...turnTc, agent: carried, agentSeen: { seen, ...(resolved.agentAgain.changed === true ? { changed: true as const } : {}), ...(full.length > 0 ? { full } : {}) } };
        const next = await resolveWaiting(session, event, turnAnswers, used, error, screen, channel, toolTimeout, first.memo);
        resolved = next.result;
        waited = next.waited ?? waited;
        agentShown = asked.ctx;
      }
    }
    // The model's last answer is in (or its wait is over): no line for its slowness is said after this.
    filler?.stop();
    const fillerSaid = filler?.record() ?? null;
    // An app in agent mode at a form's read-back: where the agent answer failed, the turn decided the scripted way
    // from the form's own questions, asked in the turn's own request beside the agent (a yes completes, "yes, but
    // make it three" corrects and reads it back); the record says what became of the reading (the agent-mode
    // design, calls 38 and 54).
    const reread = agentResult !== null && opts.agent != null && words !== null
      ? await scriptedReading(session, event, resolved, tc, screen, reading, response?.answers ?? null, channel, toolTimeout)
      : null;
    if (reread !== null) {
      resolved = reread.result;
      waited = reread.waited ?? waited;
    }
    const rereadUsed = reread !== null && reread.result.agent?.scripted === 'read';
    // The text values the agent gave that are not the caller's words as cited, each held to them by the drift
    // judge a framed summary is (call 40): one it refuses, or does not read in time, is not held (call 45: never
    // as its cited words either), and the turn is resolved again without it, its field's question asked again
    // (the tools already called kept, none called twice).
    let textUsage: JevUsage | null = null;
    if (!rereadUsed && used !== null && used.agent?.ok === true && resolved.agent?.use === 'used' && resolved.agent.values.length > 0) {
      const app = appOf(session);
      const budget = (opts.agent?.checkTimeoutMs ?? opts.renderer?.checkTimeoutMs ?? DEFAULT_RENDER_CHECK_TIMEOUT_MS)[session.caps.speech ? 'voice' : 'chat'];
      const { judged, usage } = await judgeTextValues(app, resolved.agent.values, opts.renderer?.drift ?? opts.client, budget, app.agent?.style.refuseAt ?? DRIFT_FIRE, localeOf(session));
      textUsage = usage;
      if (judged.length > 0) {
        const refusedText = [...new Set(judged.filter((j) => j.held === 'before').map((j) => j.field))];
        if (refusedText.length > 0) {
          const next = await resolveWaiting(session, event, turnAnswers, { ...used, agentTextRefused: refusedText }, error, screen, channel, toolTimeout, first.memo);
          // What became of the read-back reading stays on the record of the turn resolved again.
          const scripted = resolved.agent?.scripted;
          resolved = scripted !== undefined && next.result.agent !== undefined ? { ...next.result, agent: { ...next.result.agent, scripted } } : next.result;
          waited = next.waited ?? waited;
        }
        if (resolved.agent !== undefined) resolved = { ...resolved, agent: { ...resolved.agent, textJudged: judged } };
      }
    }
    const t3 = performance.now();
    // Retrieval run for the follow-up rather than before planning: its record and its time are the turn's all the same.
    const retrievedAny = retrieved ?? second?.retrieved ?? null;
    // An app in agent mode: the agent's reply, where the turn says it, held to the facts by the checks and the
    // drift judge (render/agentLine.ts), its fixed line said in its place where one fails, and the records with it.
    // The line said while the model was slow: the call's next is another (Session.agent.waitLine).
    if (fillerSaid?.said === true) {
      const a = resolved.session.agent ?? { conversation: [], failures: 0 };
      resolved = { ...resolved, session: { ...resolved.session, agent: { ...a, waitLine: fillerSaid.index } } };
    }
    const held = appOf(session).mode === 'agent'
      ? await holdAgentLine({
        result: resolved, event, judge: opts.renderer?.drift ?? opts.client, clips: opts.render ?? null, seen: agentShown?.seen ?? [], todayIso: opts.todayIso,
        slotContext: () => slotContext(resolved.session, '', turnTc),
        // The judge's budget, RENDER_CHECK_TIMEOUT_MS: the agent runner's (an app in agent mode need generate no line), else the renderer's.
        ...((opts.agent?.checkTimeoutMs ?? opts.renderer?.checkTimeoutMs) !== undefined ? { checkTimeoutMs: (opts.agent?.checkTimeoutMs ?? opts.renderer?.checkTimeoutMs)! } : {}),
      })
      : null;
    const decided = held?.result ?? resolved;
    // Generated wording, once the core has decided: only for an app that generates a line, on a run with a
    // renderer. The lines are worded and checked; the decision, the session and its fixed lines stand.
    const rendered = opts.renderer ? await renderTurn({ before: session, result: decided, event, renderer: opts.renderer, client: opts.client, thresholds: opts.thresholds, clips: opts.render ?? null, ...(opts.early !== undefined ? { early: opts.early } : {}) }) : null;
    // A turn whose answer line words its answer: its knowledge record says whether the passage or a wording of it was said.
    const kb = rendered?.kbSaid !== undefined && decided.kb !== null ? { ...decided.kb, said: rendered.kbSaid } : decided.kb;
    const worded = rendered ? { ...decided, actions: rendered.actions, audit: withRenderAudit(decided.audit, rendered.audit), kb } : decided;
    // The texts the turn's tools sent, each a row of its audit (text_sent), after what the turn did.
    const result = sentTexts.length > 0 ? { ...worded, audit: [...worded.audit, ...sentTexts.map(textAuditRow)] } : worded;
    // The decision model's checks this turn: the agent line's judge and generated wording's, together.
    // The text values' judge (call 40) is the decision model's too.
    const driftUsage = sumUsage(sumUsage(held?.usage ?? null, rendered?.driftUsage ?? null), textUsage);
    // Chained before anything else is written: the audit is the record of what the turn did.
    // The audit entries are recorded under the session's own channel kind.
    const chained = opts.audit ? chainDrafts(opts.audit, result.session.sessionId, result.session.channel, result.audit) : [];
    // A sink that chains in a database is waited for; one that chains at once is not (nothing more to wait for).
    const audited = Array.isArray(chained) ? chained : await chained;
    // A sensitive digit (the code, the account ID, the date of birth, or one keyed ahead of the
    // question that may ask for one) is recorded as keyed, never as the digit: the trace (and the dashboard, which is fed from it) must not be able to rebuild any
    // of them. The same decision the turn itself acted on, so the frame log, the dashboard and the
    // trace can never disagree.
    // A portal sign-in names who signed in: the trace (and the console, fed from it) keeps their kind,
    // level and first name, and the last four of their id only; their name, contact and the app's own
    // attributes are left out.
    const traced: SessionEvent = event.type === 'user.key' && sensitive !== null
      ? { type: 'user.key', digit: CODE_DIGIT }
      : event.type === 'auth.signed_in' && !isAnonymous(event.principal)
        ? { ...event, principal: { kind: event.principal.kind, level: event.principal.level, id: maskId(String(event.principal.id)), first: event.principal.first } }
        : event;
    const record = buildTraceRecord({
      result, event: traced, questions: p.questions, response, error, screenUsage: screenResponse?.usage ?? null,
      // What answers the call, on its first record only, and only from a client that asks a model.
      answeredBy: event.type === 'session.start' ? opts.client.answeredBy ?? null : null,
      // Retrieval's time only on a turn a retriever ran; its total then counts from before it. A
      // follow-up's time (its retrieval and its request) only on a turn that made one.
      timing: {
        ...(retrieved?.ms != null
          ? { retrieveMs: retrieved.ms, planMs: t1 - t0, askMs: t2 - t1, resolveMs: t3 - t2f, totalMs: t3 - tr }
          : { planMs: t1 - t0, askMs: t2 - t1, resolveMs: t3 - t2f, totalMs: t3 - t0 }),
        ...(second?.retrieved?.ms != null ? { retrieveMs: second.retrieved.ms } : {}),
        ...(second?.ms != null ? { followUpMs: second.ms } : {}),
        ...(agentResult !== null ? { agentMs: agentResult.ms + (retry?.ms ?? 0) + (again?.result.ms ?? 0) } : {}),
        // A turn that rendered a generated line, or held an agent line, counts its rendering too.
        ...(rendered?.record.ms !== undefined || held !== null ? { renderMs: (rendered?.record.ms ?? 0) + (held?.ms ?? 0), totalMs: performance.now() - (retrieved?.ms != null ? tr : t0) } : {}),
      },
      render: rendered?.record ?? null,
      ...(result.agent !== undefined ? { agent: agentRecord(result.agent, agentResult, again, opts.agent, agentShown !== null ? agentSentRecord(agentShown) : agentSent, retry) } : {}),
      // The line said while the model was slow, whatever became of the turn.
      ...(fillerSaid !== null ? { filler: { promptId: fillerSaid.promptId, atMs: fillerSaid.atMs, said: fillerSaid.said } } : {}),
      driftUsage,
      retrieval: retrievedAny?.record ?? null,
      followUp: second?.run ? followUpRecord(second.run) : null,
      waited,
      joined: fragments ?? null,
      ...(fragments && waitedFor !== undefined ? { joinedWaitedFor: waitedFor } : {}),
      ts: new Date(now()).toISOString(),
      pricePerMtok: opts.thresholds.JEV_PRICE_PER_MTOK,
    });
    if (sentTexts.length > 0) record.texts = [...sentTexts];
    opts.trace?.write(record);
    try {
      opts.observe?.turn(record, now());
    } catch {
      /* observers are best effort */
    }
    if (audited.length > 0) {
      try {
        opts.observe?.audit?.(audited, now());
      } catch {
        /* observers are best effort */
      }
    }
    return { result, questions: p.questions, response, error, screenResponse, followUp: second?.run ?? null, record, audit: audited, ...(rendered !== null && rendered.early > 0 ? { early: rendered.early } : {}) };
  } finally {
    // A turn that threw, or one that ended before its answer (the filler stopped already): no line said after it.
    filler?.stop();
  }
}
