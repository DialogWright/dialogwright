import { performance } from 'node:perf_hooks';
import { wordsOf, type SessionEvent } from '../channel/events';
import { plan, resolve, sensitiveDigit, type ArrivalDigit, type DigitArrivalContext, type TurnContext, type TurnError, type TurnResult } from '../core/turn';
import type { Session } from '../core/session';
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
import { JevClientError, type JevClient, type JevResponse, type JsonValue, type QuestionMap } from '../jev/types';
import type { RenderContext } from '../prompts/render';
import { buildTraceRecord, type TraceSink } from '../trace/writer';
import type { TraceRecord } from '../trace/types';
import type { AuditDraft, AuditEntry, Chained } from '../audit/types';
import { topicsListening } from '../core/knowledge';
import { localeOf } from '../core/locale';
import { retrieve } from './retrieve';
import { calledVariables } from '../core/routes';
import { renderTurn, withRenderAudit } from '../render/turn';
import type { Renderer } from '../render/types';

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
  record: TraceRecord;
  /** the turn's audit entries as the sink chained them; empty when no sink is set */
  audit: AuditEntry[];
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
 * the trace record keeps beside the joined words.
 */
export async function runTurn(session: Session, heard: SessionEvent, opts: RunOptions, arrival?: Arrival, joined?: readonly string[]): Promise<TurnRun> {
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
  const base: TurnContext = {
    nowMs: now(),
    todayIso: opts.todayIso,
    thresholds: opts.thresholds,
    tools: opts.tools ?? demoTools(),
    render: opts.render ?? null,
    ...conditionEnv(session, opts.env),
    ...digit,
  };
  const tr = performance.now();
  // Retrieval, the turn's one async step before planning: questions are built synchronously, so the
  // topics a topic slot asks about are nominated first, once, and plan() and resolve() both see them.
  // Only when a topic slot is listening (an app with a knowledge base, words, such a slot active): any
  // other turn's context, and so its request, is exactly as it was.
  const retrieved = topicsListening(session, event, base.duringService)
    ? await retrieve(appOf(session).knowledge!, { text: words!, locale: localeOf(session), todayIso: opts.todayIso }, opts.retrieveBudgetMs)
    : null;
  const tc: TurnContext = retrieved ? { ...base, knowledge: { nominated: retrieved.nominated } } : base;
  const t0 = performance.now();
  const p = plan(session, event, tc);
  const t1 = performance.now();
  let response: JevResponse | null = null;
  let error: TurnError | null = null;
  let screenResponse: JevResponse | null = null;
  let screen: ScreenResult | null = null;
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
  const t2 = performance.now();
  const resolved = resolve(session, event, response?.answers ?? null, tc, error, screen);
  const t3 = performance.now();
  // Generated wording, once the core has decided: only for an app that generates a line, on a run with a
  // renderer. The lines are worded and checked; the decision, the session and its fixed lines stand.
  const rendered = opts.renderer ? await renderTurn({ before: session, result: resolved, event, renderer: opts.renderer, client: opts.client }) : null;
  const result = rendered ? { ...resolved, actions: rendered.actions, audit: withRenderAudit(resolved.audit, rendered.audit) } : resolved;
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
    // Retrieval's time only on a turn a retriever ran; its total then counts from before it.
    timing: {
      ...(retrieved?.ms != null
        ? { retrieveMs: retrieved.ms, planMs: t1 - t0, askMs: t2 - t1, resolveMs: t3 - t2, totalMs: t3 - tr }
        : { planMs: t1 - t0, askMs: t2 - t1, resolveMs: t3 - t2, totalMs: t3 - t0 }),
      // A turn that rendered a generated line counts its rendering too.
      ...(rendered?.record.ms !== undefined ? { renderMs: rendered.record.ms, totalMs: performance.now() - (retrieved?.ms != null ? tr : t0) } : {}),
    },
    render: rendered?.record ?? null,
    driftUsage: rendered?.driftUsage ?? null,
    retrieval: retrieved?.record ?? null,
    joined: fragments ?? null,
    ts: new Date(now()).toISOString(),
    pricePerMtok: opts.thresholds.JEV_PRICE_PER_MTOK,
  });
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
  return { result, questions: p.questions, response, error, screenResponse, record, audit: audited };
}
