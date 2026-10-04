import type { InboundFrame, OutboundFrame } from '../channel/relay/frames';
import { serviceResultFrame, endFrame, silenceFrame, textFrame } from '../channel/relay/frames';
import { parseInbound, serializeOutbound } from '../channel/relay/wire';
import { actionsToFrames, frameToEvent } from '../channel/relay/map';
import { serviceResultEvent, silenceEvent, type SessionEvent } from '../channel/events';
import { playbackEstimateMs } from '../channel/relay/playback';
import { arrivalContext, CODE_DIGIT, runTurn, type Arrival } from '../run/turn';
import { digitAtRun, promptEpoch, sensitiveDigit, type ArrivalDigit } from '../core/turn';
import { maskSpokenCode, spokenCodeMinDigits } from '../core/spokenCode';
import { DEFAULT_SCREEN_MODE, requestsPerTurn } from '../core/screen';
import type { Session } from '../core/session';
import type { CallEntry, SessionStore, SocketLike } from './sessions';
import type { CallTokens } from './tokens';
import type { DashboardBus } from './dashboard/bus';
import { maskNumber, redactDeep, type DashboardEvent } from './dashboard/events';
import { redactHandoffData, turnScrubber } from '../trace/redact';
import { resolveService, type ServiceUrls } from './services';
import { codeLengthOf } from '../core/app/lookup';
import { appOf } from '../core/app/registry';
import { lineLang, promptText } from '../prompts/render';
import type { HandoffWording, SpokenDigitRule } from '../core/app/types';
import type { Effect } from '../core/lifecycle';
import { summarizeHandoff as summarizeHandoffDefault, type SummaryOptions } from '../handoff/summary';
import type { AuditEntry } from '../audit/types';
import { carryScrub, registerScrub, scrubberOf, scrubFromParts, scrubParts, type Scrub, type ScrubPart } from '../core/recording';
import { serviceIdempotencyKey } from '../core/idempotency';
import type { PendingEffect } from './stores/types';

/**
 * Said first when a call comes back after its server restarted (SESSION_STORE=file), before the
 * question the caller was last asked: the engine's line, unless the app's prompts.yaml has one called
 * `resumed` (said in the call's language where its locale has the line). The engine's line is English: an
 * app in another language gives its own.
 */
export const RESUMED_TEXT = 'Sorry, I lost you for a moment.';

/** The line a call resumed after a restart hears first: the app's `resumed` prompt, or RESUMED_TEXT. */
export function resumedLine(session: Session): string {
  const app = appOf(session);
  // A locale's own line is a translation of prompts.yaml's (check refuses one prompts.yaml lacks).
  return Object.hasOwn(app.prompts.manifest, 'resumed') ? promptText(app, 'resumed', {}, session.locale) : RESUMED_TEXT;
}

/** Spoken when a turn throws, so a failure is a retry rather than dead air. */
export const TURN_ERROR_TEXT = 'Sorry, something went wrong on my end. Please say that again.';

/**
 * How long one outbound frame may sit in the socket's write queue before the send is abandoned.
 * `ws` only invokes the write callback when the frame is actually flushed, so a peer that stops
 * reading (a half-open TCP connection Twilio never closes) would otherwise park a turn forever
 * and, with it, everything queued behind it for that call.
 */
export const SEND_TIMEOUT_MS = 5_000;

/** Unparsable messages (cumulative, never reset) before the connection is treated as something other than ConversationRelay. */
export const MALFORMED_LIMIT = 10;

/**
 * After sending `end`, Twilio still has to play the queued frames before it closes the socket
 * itself. If it never does (a bug on either side, or a call that never really reached Twilio),
 * this is the backstop before we close it ourselves so the connection doesn't leak forever.
 */
export const END_CLOSE_GRACE_MS = 30_000;

/** Grace timers armed after `end`, keyed by call SID, so the socket's close event can cancel the backstop. */
const endGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * The armed no-input timer for a call, with the generation it was armed under.
 *
 * Both this and the generation counter live here rather than on `CallEntry`, the way
 * `endGraceTimers` does: the timer is the adapter's business, so `sessions.ts` stays a store.
 */
interface NoInput {
  timer: ReturnType<typeof setTimeout>;
  generation: number;
}
const noInputTimers = new Map<string, NoInput>();
/**
 * Bumped every time a call's no-input timer is cleared or re-armed. A fired timer's queued
 * closure carries the generation it was armed with, so a turn that got in first (the caller
 * answered at the last second) turns the queued silence turn into a no-op.
 *
 * It outlives a socket close on purpose, so a reconnect cannot hand an already-queued closure a
 * generation it would match again. Only `forgetNoInput` drops it, once the call itself is gone.
 */
const noInputGeneration = new Map<string, number>();

/** When a call's last frames went out and how long they were estimated to take to play. */
interface Playback {
  sentAtMs: number;
  estimateMs: number;
}
/**
 * So a re-arm that speaks nothing of its own still waits for the prompt already playing to
 * finish. A barge-in one second into an eleven second menu clip would otherwise restart a bare
 * `noInputMs` and fire a silence turn over the top of the menu.
 */
const lastPlayback = new Map<string, Playback>();

/**
 * Turns queued or running per call that can move the prompt: the greeting, a spoken prompt, a
 * silence re-ask, a downstream service's answer. A keypad digit that arrives while any is outstanding
 * was keyed ahead of a question the caller has not heard yet (ArrivalDigit 'ahead'). Keypad turns
 * are not counted: a run of digits at one prompt is the caller answering the prompt they heard.
 */
const unsettledTurns = new Map<string, number>();

/**
 * Turns queued or running per call, of any kind, keypad turns included. A digit that arrives while
 * any is outstanding may find its question moved on by the time its own turn runs (a keypad turn
 * completes one identity factor and asks for the next), so where it was keyed is logged for
 * replay (arrivalFlags keyedAt), which runs every turn before reading the next frame.
 */
const pendingTurns = new Map<string, number>();

function bump(counts: Map<string, number>, callSid: string, by: 1 | -1): void {
  const n = (counts.get(callSid) ?? 0) + by;
  if (n > 0) counts.set(callSid, n);
  else counts.delete(callSid);
}

/** Enqueue a turn, counted in `pendingTurns`, and in `unsettledTurns` too when it can move the prompt, until it has run. */
function enqueueTurn(deps: AdapterDeps, callSid: string, fn: (entry: CallEntry) => Promise<void>, movesPrompt: boolean): Promise<void> {
  bump(pendingTurns, callSid, 1);
  if (movesPrompt) bump(unsettledTurns, callSid, 1);
  return deps.store.enqueue(callSid, fn).finally(() => {
    bump(pendingTurns, callSid, -1);
    if (movesPrompt) bump(unsettledTurns, callSid, -1);
  });
}

/** Enqueue a turn that can move the prompt. */
function enqueueUnsettled(deps: AdapterDeps, callSid: string, fn: (entry: CallEntry) => Promise<void>): Promise<void> {
  return enqueueTurn(deps, callSid, fn, true);
}

/** Consecutive turns that threw, per call, reset by any turn that produces a decision. */
const turnFailures = new Map<string, number>();

/**
 * Thrown turns in a row before the no-input wait stops re-arming. Each one speaks the apology and
 * the wait asks the question again, so a client that is down would otherwise loop for the life of
 * the call; three attempts is enough to ride out a blip.
 */
export const TURN_FAILURE_LIMIT = 3;

/** Cancel any armed no-input timer for a call and invalidate whatever it already queued. */
function clearNoInput(callSid: string): void {
  const armed = noInputTimers.get(callSid);
  if (armed) {
    clearTimeout(armed.timer);
    noInputTimers.delete(callSid);
  }
  noInputGeneration.set(callSid, (noInputGeneration.get(callSid) ?? 0) + 1);
}

/** Whether a no-input wait is armed for the call right now. For tests. */
export function noInputArmed(callSid: string): boolean {
  return noInputTimers.has(callSid);
}

/**
 * Drop a gone call's no-input bookkeeping entirely, so neither map outlives the call. Called from
 * the socket close of a call the store no longer has, and from the idle sweep for one whose socket
 * had already gone; both maps would otherwise grow by an entry per call for the process's life.
 */
export function forgetNoInput(callSid: string): void {
  const armed = noInputTimers.get(callSid);
  if (armed) clearTimeout(armed.timer);
  noInputTimers.delete(callSid);
  noInputGeneration.delete(callSid);
  lastPlayback.delete(callSid);
  turnFailures.delete(callSid);
}

/**
 * Arm the no-input timer: `noInputMs` after the frames have (approximately) finished playing.
 * When it fires the silence turn goes through the same per-call queue as a socket message, so it
 * can never interleave with a real turn.
 *
 * `frames` is what actually went out. An empty list means the caller was heard from but nothing
 * was said back (a barge-in, a keypad terminator, a partial), so the wait is measured from the
 * end of whatever is still playing rather than from now.
 */
function armNoInput(deps: AdapterDeps, entry: CallEntry, frames: readonly OutboundFrame[]): void {
  const wait = deps.noInputMs ?? 0;
  if (wait <= 0) return;
  clearNoInput(entry.callSid);
  const generation = noInputGeneration.get(entry.callSid) ?? 0;
  const nowMs = Date.now();
  let remainingMs: number;
  if (frames.length > 0) {
    const estimateMs = playbackEstimateMs(frames, deps.clipDurations ?? new Map());
    lastPlayback.set(entry.callSid, { sentAtMs: nowMs, estimateMs });
    remainingMs = estimateMs;
  } else {
    const last = lastPlayback.get(entry.callSid);
    remainingMs = last ? Math.max(0, last.sentAtMs + last.estimateMs - nowMs) : 0;
  }
  const delay = wait + remainingMs;
  const timer = setTimeout(() => {
    noInputTimers.delete(entry.callSid);
    void enqueueUnsettled(deps, entry.callSid, async (e) => {
      // A real turn ran between the arm and now (it bumped the generation), or the call is
      // over: either way the caller is not silent and this turn has nothing to say.
      if (e.ended || (noInputGeneration.get(e.callSid) ?? 0) !== generation) return;
      // Published before the turn, so the page shows the pause and then what it produced.
      publish(deps, { type: 'silence', callSid: e.callSid, at: Date.now(), promptId: e.session.lastPromptId });
      e.frames.write('in', silenceFrame());
      await turn(deps, e, silenceEvent());
    }).catch((err: unknown) => deps.log(`${entry.callSid}: silence turn failed: ${describe(err).message}`));
  }, delay);
  timer.unref?.();
  noInputTimers.set(entry.callSid, { timer, generation });
  // Only for a re-arm that had something to say. Partials arrive several times a second while the
  // caller speaks, and a line each would drown the frame log in bookkeeping.
  if (frames.length > 0) entry.frames.write('log', { noInputArmedMs: delay });
}

/**
 * Rewrite the identifiers in an outbound text so Twilio's TTS reads them one digit at a time, by the
 * app's rules (App.voice.spokenDigits), in order. A `lead` rule keeps the words before the digits:
 * "order 4702" becomes "order 4 7 0 2". A `groups` rule spells each space-separated group out, with
 * a comma (a short pause) between: "4471 8293" becomes "4 4 7 1, 8 2 9 3", the groups the caller
 * sees on their card. Only what goes on the wire is rewritten; the session text, the trace record
 * and the prompt manifest keep the readable form. Without rules, the text goes out as it is.
 *
 * Framework seam: a slot declaring how its own value is spoken would replace this pattern matching
 * at the wire.
 */
export function spokenDigits(text: string, rules: readonly SpokenDigitRule[] = []): string {
  const spell = (digits: string): string => [...digits].join(' ');
  let out = text;
  for (const rule of rules) {
    out = rule.spell === 'lead'
      ? out.replace(rule.pattern, (_whole: string, lead: string, n: string) => `${lead} ${spell(n)}`)
      : out.replace(rule.pattern, (run) => run.split(' ').map(spell).join(', '));
  }
  return out;
}

export interface ConnectionContext {
  token: string | null;
  /** The socket this connection owns, so a late close cannot detach a socket a reconnect installed. */
  socket: SocketLike | null;
  callSid: string | null;
  malformed: number;
  /** Partial prompts are dropped silently after the first; one log line per connection is the signal. */
  partialLogged: boolean;
  /** The voice provider whose socket path this connection came in on (server/voice/registry.ts). */
  provider: string;
}

export interface AdapterDeps {
  store: SessionStore;
  tokens: CallTokens;
  log: (line: string) => void;
  /** Overridable so a test can prove the timeout fires without waiting five seconds. */
  sendTimeoutMs?: number;
  /** Overridable so a test can prove the end-close backstop fires without waiting 30 seconds. */
  endCloseGraceMs?: number;
  /** Silence after a prompt's estimated playback before a silence turn runs; 0 (the default) disables. */
  noInputMs?: number;
  /** wav filename -> ms, from clipDurations(audioDir); how long a `play` frame is assumed to take. */
  clipDurations?: ReadonlyMap<string, number>;
  /** The dashboard's event bus; absent when the dashboard is off. */
  bus?: DashboardBus;
  /** For the masked number on a handoff event. */
  handoffNumber?: string;
  /**
   * Where each of the app's downstream services (App.services) is reached, by name. A service with no
   * url is not running, and a request to it is answered at once with no result.
   */
  serviceUrls?: ServiceUrls;
  /** The budget for one service request; the service's own unless a test shortens it. */
  serviceTimeoutMs?: number;
  /** Claude Haiku's key for the handoff summary (src/handoff/summary.ts); absent, the summary is always null. */
  anthropicApiKey?: string | null;
  /** HANDOFF_SUMMARY; default on. Effective only with `anthropicApiKey` set. */
  handoffSummaryOn?: boolean;
  /** Overridable so a test can inject a fake without reaching the real Anthropic endpoint. */
  summarizeHandoff?: (entries: readonly AuditEntry[], o: SummaryOptions, wording?: HandoffWording) => Promise<string | null>;
}

/**
 * Hand one call moment to the dashboard. A missing bus (the dashboard is off) makes every
 * publishing site below a no-op, and a throwing subscriber is swallowed by the bus itself: a
 * watcher of a call can never change the call.
 */
function publish(deps: AdapterDeps, event: DashboardEvent): void {
  deps.bus?.publish(event);
}

export function newConnectionContext(token: string | null, socket: SocketLike | null = null, provider = 'twilio'): ConnectionContext {
  return { token, socket, callSid: null, malformed: 0, partialLogged: false, provider };
}

function describe(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
  return { name: 'NonError', message: String(err) };
}

function sendOne(socket: SocketLike, frame: OutboundFrame, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('send timeout'));
    }, timeoutMs);
    timer.unref?.();
    socket.send(serializeOutbound(frame), (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Send a decision's frames in order, and return the ones that actually reached the wire, rewritten
 * exactly as they were sent. A frame is logged `out` only once it is actually on the wire; a frame
 * with no socket is logged as dropped. A send failure detaches the socket and the remaining frames
 * of the decision are dropped, but the caller still runs its end-of-call work.
 *
 * The return value is what the no-input estimate is measured on: only frames Twilio received are
 * frames Twilio will spend time playing, and the digit spacing changes how long an identifier takes
 * to read out loud.
 */
/**
 * A frame as the frame log records it. The `end` frame's handoff data carries what the call
 * collected, as the app's handoff data option lets it leave the engine (handoff/data.ts: by default
 * no identity factor, a redacted slot masked); the handoff data is masked again here, at write time,
 * the way the trace writer masks it, so the file can never hold an identity value whatever a future
 * decision puts in it, even one an app sends the carrier as it is.
 */
export function loggedFrame(frame: OutboundFrame, scrub: Scrub | null): OutboundFrame {
  if (frame.type === 'end') return { ...frame, handoffData: redactHandoffData(frame.handoffData, 'length') };
  // A text frame says our line, which may read a redacted slot back (a readback, a summary): its
  // raw value, display and digits as the wire spells them out are masked as the trace masks them.
  if (frame.type === 'text' && scrub !== null) return { ...frame, token: scrub(frame.token) };
  return frame;
}

async function sendFrames(deps: AdapterDeps, entry: CallEntry, frames: OutboundFrame[], decision: unknown = null): Promise<OutboundFrame[]> {
  const log = deps.log;
  const timeoutMs = deps.sendTimeoutMs ?? SEND_TIMEOUT_MS;
  const sent: OutboundFrame[] = [];
  // Built from the session as it is now (its slots and readback) and the decision the frames say.
  const scrub = turnScrubber(entry.session, decision, 'length', appOf(entry.session));
  for (const original of frames) {
    // The frame log records what actually went out, digit spacing and all.
    const frame: OutboundFrame = original.type === 'text' ? { ...original, token: spokenDigits(original.token, appOf(entry.session).voice?.spokenDigits) } : original;
    const socket = entry.socket;
    if (!socket) {
      log(`${entry.callSid}: no socket, dropped ${frame.type}`);
      entry.frames.write('log', { dropped: loggedFrame(frame, scrub) });
      continue;
    }
    try {
      await sendOne(socket, frame, timeoutMs);
      entry.frames.write('out', loggedFrame(frame, scrub));
      sent.push(frame);
    } catch (err) {
      const info = describe(err);
      log(`${entry.callSid}: send failed for ${frame.type}: ${info.name}: ${info.message}`);
      entry.frames.write('log', { sendFailed: frame.type, error: info });
      // The socket is unusable; drop it so the rest of this decision and later turns are logged
      // as dropped rather than failing one by one.
      if (entry.socket === socket) entry.socket = null;
    }
  }
  return sent;
}

/**
 * A turn's service effect (work a tool handed to a downstream service): ask the app's service, then run
 * its answer as the call's next turn (service_result). Queued behind the turn that left it, so what
 * that turn said (a record's number, say) is spoken first. Anything the caller says or keys
 * meanwhile is still queued, and so runs after the answer, but it was marked on arrival as said
 * during the wait (Arrival.duringService), and the core ignores it: the caller had not yet heard what
 * the answer's turn asks. The no-input wait is not armed until the answer's own turn arms it: a
 * silence re-ask here would be a question nobody asked.
 *
 * The answer, or null for no answer (a timeout, an error, no service, a reply that does not parse),
 * is logged as an inbound frame like the synthesized silence, so replay can follow the call. An
 * answer whose turn throws is followed by no answer, and if even that throws the wait is given up,
 * so a call is never left ignoring its caller. The log lines' keys are `serviceAfterEnd` (replay
 * does not act on it) and `serviceWaitAbandoned` (replay clears the wait there, as here).
 */
function queueService(deps: AdapterDeps, entry: CallEntry, effect: Effect, again?: PendingEffect): void {
  // Recorded with its key before it is sent (saved with the call: SESSION_STORE=file), so a server that
  // loads the call after a restart sends it again with the same key (`again`, then, with its scrub).
  const pending: PendingEffect = again ?? {
    effect,
    idempotencyKey: serviceIdempotencyKey(entry.session, effect),
    ...(scrubPartsOf(effect) ?? {}),
  };
  entry.pending = pending;
  if (again === undefined) void deps.store.persist(entry.callSid);
  void enqueueUnsettled(deps, entry.callSid, async (e) => {
    const answer = await resolveService(appOf(e.session), effect, deps.serviceUrls, deps.serviceTimeoutMs, pending.idempotencyKey);
    // The caller hung up while the service was thinking: there is no one to tell.
    if (e.ended) {
      e.frames.write('log', { serviceAfterEnd: true });
      return;
    }
    // Answered: the turn that runs it saves the call without it.
    if (e.pending === pending) e.pending = null;
    // Logged as the frame replay reads back (frameToEvent gives this event again).
    e.frames.write('in', serviceResultFrame(answer.service, answer.result, answer.note));
    if (await turn(deps, e, answer)) return;
    if (e.ended || e.session.pendingService === null) return;
    if (answer.result !== null) {
      e.frames.write('in', serviceResultFrame(effect.service, null));
      const none = serviceResultEvent(effect.service, null);
      carryScrub(effect, none);
      if ((await turn(deps, e, none)) || e.ended || e.session.pendingService === null) return;
    }
    e.session = { ...e.session, pendingService: null };
    e.frames.write('log', { serviceWaitAbandoned: true });
    await deps.store.persist(e.callSid);
  });
}

/** An effect's scrub as data, for a pending request saved with the call; null when it has none it can write down. */
function scrubPartsOf(effect: Effect): { scrub: ScrubPart[] } | null {
  const parts = scrubParts(scrubberOf(effect));
  return parts === null ? null : { scrub: parts };
}

/** A request saved with the call, as the effect a server sends again after a restart: its scrub made again from data. */
function revived(pending: PendingEffect): Effect {
  const effect: Effect = { ...pending.effect, params: { ...pending.effect.params } };
  const scrub = pending.scrub ? scrubFromParts(pending.scrub) : null;
  if (scrub !== null) registerScrub(effect, scrub);
  return effect;
}

/** Words in a handoff summary, for the audit draft; a null summary has none. */
function wordCount(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

/**
 * The handoff summary (src/handoff/summary.ts): fired once a turn's decision is `handoff`, never
 * awaited by the turn that triggers it -- the caller has already been told to expect the transfer,
 * and the note is for the human picking up, not for the wire. `entry.auditEntries` is the call's
 * whole chain so far, kept on the entry by `turn` after every turn. No key, or the
 * switch off, skips the network call outright rather than sending one that could only fail.
 */
function fireHandoffSummary(deps: AdapterDeps, entry: CallEntry): void {
  const apiKey = deps.anthropicApiKey ?? null;
  const enabled = (deps.handoffSummaryOn ?? true) && apiKey !== null;
  const summarize = deps.summarizeHandoff ?? summarizeHandoffDefault;
  const summary = enabled ? summarize(entry.auditEntries, { apiKey: apiKey! }, appOf(entry.session).handoff) : Promise.resolve(null);
  void summary
    .then((text) => {
      publish(deps, { type: 'handoff_summary', callSid: entry.callSid, at: Date.now(), text });
      const draft = { type: 'handoff_summary' as const, detail: { generated: text !== null, words: text !== null ? wordCount(text) : 0 } };
      const audited = entry.opts.audit?.append(entry.session.sessionId, entry.session.channel, draft);
      if (audited) entry.auditEntries.push(audited);
    })
    .catch((err: unknown) => deps.log(`${entry.callSid}: handoff summary failed: ${describe(err).message}`));
}

/** Run one turn and send what it decided. False when the turn threw (the apology was spoken instead). */
async function turn(deps: AdapterDeps, entry: CallEntry, event: SessionEvent, arrival?: Arrival): Promise<boolean> {
  let ending = false;
  try {
    const run = await runTurn(entry.session, event, entry.opts, arrival);
    turnFailures.delete(entry.callSid);
    entry.session = run.result.session;
    // Kept on the call's own entry whether or not the console is on: the handoff summary reads it.
    entry.auditEntries.push(...run.audit);
    // Saved before what the turn says goes out (SESSION_STORE=file; nothing with the memory store), so a
    // restart after the caller heard a question resumes at that question.
    await deps.store.persist(entry.callSid);
    const kind = run.result.decision.kind;
    ending = kind === 'complete' || kind === 'handoff';
    if (run.result.decision.kind === 'handoff') {
      publish(deps, { type: 'handoff', callSid: entry.callSid, at: Date.now(), reason: run.result.decision.reason, number: maskNumber(deps.handoffNumber) });
      fireHandoffSummary(deps, entry);
    }
    if (ending) publish(deps, { type: 'ended', callSid: entry.callSid, at: Date.now(), reason: kind === 'complete' ? 'completed' : 'handoff' });
    // Defensive: nothing can be armed here today, because whatever drove this turn cleared the
    // timer on its way in. Kept so a future path that arms and then ends cannot strand a timer.
    if (ending) clearNoInput(entry.callSid);
    const sent = await sendFrames(deps, entry, actionsToFrames(run.result.actions), run.result.decision);
    const service = run.result.effects.find((e) => e.kind === 'service');
    // Work handed to a downstream service: its answer is the next turn, and it arms the wait itself.
    if (service && !ending) queueService(deps, entry, service);
    // A prompt restarts the wait - including the silence turn's own re-ask, which is how the
    // ladder walks itself. So does anything that left the caller still owing an answer: an
    // ignored digit mid-slot, a barge-in, a relay error frame. Those produce no frames of their
    // own, so the wait is the bare `noInputMs` from the moment the frame arrived.
    else if (!ending && (kind === 'prompt' || entry.session.promptedFor !== null)) armNoInput(deps, entry, sent);
    return true;
  } catch (err) {
    const info = describe(err);
    deps.log(`${entry.callSid}: turn failed: ${info.name}: ${info.message}`);
    entry.frames.write('log', { turnFailed: info });
    const failures = (turnFailures.get(entry.callSid) ?? 0) + 1;
    turnFailures.set(entry.callSid, failures);
    const sent = await sendFrames(deps, entry, [textFrame(TURN_ERROR_TEXT, true)]);
    // "Please say that again" is a question like any other: a caller who then says nothing must
    // not be left listening to an open line. But the wait asking it again is what turns a client
    // that is down into an apology every few seconds until the caller hangs up, so it stops after
    // a few tries and leaves the line open rather than talking over a caller who has given up.
    if (failures >= TURN_FAILURE_LIMIT) {
      if (failures === TURN_FAILURE_LIMIT) {
        deps.log(`${entry.callSid}: ${failures} consecutive turn failures, no-input wait stopped`);
        entry.frames.write('log', { noInputStopped: failures });
      }
      clearNoInput(entry.callSid);
    } else if (entry.session.promptedFor !== null) {
      armNoInput(deps, entry, sent);
    }
    return false;
  } finally {
    // Runs even when sending the decision failed: the call is over either way.
    if (ending) {
      deps.store.end(entry.callSid);
      deps.tokens.revoke(entry.callSid);
      // Twilio closes the socket after it has played the queued frames and processed `end`;
      // closing here drops the completion (live call, error 64105).
      const socket = entry.socket;
      if (socket) {
        const graceMs = deps.endCloseGraceMs ?? END_CLOSE_GRACE_MS;
        const timer = setTimeout(() => {
          endGraceTimers.delete(entry.callSid);
          if (entry.socket === socket) {
            deps.log(`${entry.callSid}: Twilio did not close after end within ${graceMs} ms, closing`);
            socket.close(1000, 'end grace elapsed');
          }
        }, graceMs);
        timer.unref?.();
        endGraceTimers.set(entry.callSid, timer);
      }
    }
  }
}

/** Handle one raw socket message for a connection. Safe to call concurrently; turns are serialized per call by the store. */
export async function handleSocketMessage(deps: AdapterDeps, socket: SocketLike, ctx: ConnectionContext, raw: string): Promise<void> {
  const parsed = parseInbound(raw);
  if (!parsed) {
    ctx.malformed += 1;
    deps.log(`${ctx.callSid ?? 'unknown'}: malformed inbound message (${ctx.malformed})`);
    const entry = ctx.callSid ? deps.store.get(ctx.callSid) : undefined;
    entry?.frames.write('log', { malformed: raw.slice(0, 200) });
    // Whatever is on the other end is not ConversationRelay; stop paying for its messages.
    if (ctx.malformed >= MALFORMED_LIMIT) {
      if (ctx.malformed === MALFORMED_LIMIT) deps.log(`${ctx.callSid ?? 'unknown'}: closing after ${ctx.malformed} malformed messages`);
      entry?.frames.write('log', { malformedLimit: ctx.malformed });
      socket.close(1007, 'malformed messages');
    }
    return;
  }

  if (parsed.type === 'setup') {
    if (!ctx.token || !deps.tokens.verify(ctx.token, parsed.callSid, ctx.provider)) {
      deps.log(`${parsed.callSid}: setup refused, bad token`);
      await sendOne(socket, endFrame('unauthorized'), deps.sendTimeoutMs ?? SEND_TIMEOUT_MS).catch(() => undefined);
      socket.close(1008, 'unauthorized');
      return;
    }
    ctx.callSid = parsed.callSid;
    const existing = deps.store.get(parsed.callSid);
    if (existing) {
      // Masked at write time, not only when the dashboard reads it back: the setup frame carries
      // the caller's whole number, and the file on disk must never hold it either.
      existing.frames.write('in', redactDeep(parsed));
      if (existing.ended) {
        deps.log(`${parsed.callSid}: setup for an ended call, closing`);
        socket.close(1000, 'call ended');
        return;
      }
      // The wait the old connection was counting down no longer means anything. The replay below
      // starts a fresh one; this clear is what covers a reconnect with no prompt to replay yet.
      clearNoInput(parsed.callSid);
      const previous = existing.socket;
      if (previous && previous !== socket) {
        // Twilio reconnected before the old socket's close reached us; retire it explicitly so
        // nothing is written to two sockets for one call.
        deps.log(`${parsed.callSid}: reconnect replaced a live socket`);
        existing.frames.write('log', { replacedSocket: true });
        previous.close(1000, 'replaced by reconnect');
      }
      const entry = deps.store.attach(parsed.callSid, socket) ?? existing;
      // A call loaded from the session store after a restart (SESSION_STORE=file): its caller heard
      // nothing for a moment, and is told so before the question is asked again.
      const restarted = deps.store.takeRestored(parsed.callSid);
      entry.frames.write('log', { resumed: true, sessionId: parsed.sessionId, ...(restarted ? { afterRestart: true } : {}) });
      if (restarted) deps.log(`${parsed.callSid}: resumed after a restart`);
      publish(deps, { type: 'reconnect', callSid: parsed.callSid, at: Date.now(), attempt: entry.reconnects });
      await deps.store.enqueue(parsed.callSid, async (e) => {
        const again = restarted ? [resumedLine(e.session), e.session.lastPromptText].filter(Boolean).join(' ') : e.session.lastPromptText;
        if (!again) return;
        // In the language the call is in, as the line was said (Say.lang); en-US for an app without locales.
        const sent = await sendFrames(deps, e, [textFrame(again, true, lineLang(appOf(e.session), e.session.locale))]);
        // A request the call was waiting on when its server went away: sent again, with the same key, and its
        // answer is the next turn, which arms the wait itself.
        const pending = restarted ? e.pending : null;
        if (pending && e.session.pendingService === pending.effect.service) {
          deps.log(`${e.callSid}: sending the ${pending.effect.service} request again, with the same key`);
          e.frames.write('log', { serviceResent: pending.effect.service });
          queueService(deps, e, revived(pending), pending);
          return;
        }
        // The replay is a question the caller has to answer, so it starts a wait of its own; the
        // reconnect is not a turn, so nothing else would.
        armNoInput(deps, e, sent);
      });
      return;
    }
    const entry = deps.store.create(parsed.callSid, socket, ctx.provider);
    entry.frames.write('in', redactDeep(parsed));
    // Ahead of the greeting turn, and it is what resets the bus's history: the page follows this call now.
    publish(deps, {
      type: 'call_started', callSid: parsed.callSid, at: Date.now(),
      from: maskNumber(parsed.from), todayIso: entry.opts.todayIso, thresholds: entry.opts.thresholds,
      // Voice only, here, with the carrier it came in on; an app's chat (an AppRoute,
      // src/server/appRoutes.ts) is the other publisher of this event, and there `caller` names who is chatting.
      channel: 'voice', provider: ctx.provider, caller: null,
    });
    // Open the connection to the model while the greeting plays, so the caller's first answer does
    // not pay for its setup. Not awaited and never allowed to fail the call; a reconnect keeps the
    // connection the call already had, so only a new call warms.
    try {
      void entry.opts.client.warm?.(requestsPerTurn(entry.opts.screen ?? DEFAULT_SCREEN_MODE)).catch(() => undefined);
    } catch {
      // A client whose warm throws synchronously is no reason to drop the call.
    }
    const start = frameToEvent(parsed);
    await enqueueUnsettled(deps, parsed.callSid, async (e) => {
      await turn(deps, e, start);
    });
    return;
  }

  if (!ctx.callSid) {
    deps.log(`message of type ${parsed.type} before setup, ignored`);
    return;
  }
  const entry = deps.store.get(ctx.callSid);
  if (!entry) {
    deps.log(`${ctx.callSid}: ${parsed.type} for an unknown call, ignored`);
    return;
  }
  // A one-time code said aloud (not keyed) is masked here, before the frame log or anything after
  // it sees the words: at the code prompt, a run of digits in what the caller said becomes `[code]`
  // (core/spokenCode.ts). The recognizer has heard it; nothing downstream of this line does.
  const frame = maskCodeFrame(entry.session.promptedFor, parsed, codeLengthOf(appOf(entry.session)));
  // The core's event for it: everything below that is not about the wire itself reads this.
  const event = frameToEvent(frame);
  // Logged before any decision to ignore it: the frame log is a record of the wire, not of the
  // frames the adapter chose to act on -- except a sensitive digit (the one-time code, an identity
  // factor, or one keyed ahead of a question that may ask for one), which is
  // recorded as keyed and never as the digit, here, on the dashboard and in the trace alike.
  // Whether it is one is decided here, once, on the session as it stands now, and the turn is told:
  // a turn still in flight may move the prompt before this digit's turn runs. So is whether the
  // a downstream service's answer is still awaited: a frame that arrived during that wait answers nothing,
  // even though its turn only runs once the answer is in.
  // A digit also keeps the question it was keyed at, and the prompt epoch then: a digit keyed ahead
  // is taken only if no prompt was spoken before its turn runs (core/turn.ts digitAtRun).
  const arrival: Arrival = {
    sensitive: arrivalDigit(entry, event),
    duringService: entry.session.pendingService !== null,
    ...(event.type === 'user.key' ? { promptedFor: entry.session.promptedFor, epoch: promptEpoch(entry.session) } : {}),
  };
  const logged: InboundFrame = frame.type === 'dtmf' && arrival.sensitive !== null ? { type: 'dtmf', digit: CODE_DIGIT } : frame;
  entry.frames.write('in', logged);
  if (entry.ended) {
    deps.log(`${ctx.callSid}: ${frame.type} after end, ignored`);
    return;
  }
  // The caller is audibly there, so the no-input wait is over - before any of the early returns
  // below, because a partial prompt or a bare `#` is still a caller who is not silent.
  if (frame.type === 'prompt' || frame.type === 'dtmf' || frame.type === 'interrupt') clearNoInput(ctx.callSid);
  // Before the ignore/turn split below: a digit the adapter drops is still a digit the caller pressed.
  if (logged.type === 'dtmf') publish(deps, { type: 'dtmf', callSid: ctx.callSid, at: Date.now(), digit: logged.digit });
  if (frame.type === 'interrupt') {
    publish(deps, { type: 'interrupt', callSid: ctx.callSid, at: Date.now(), utteranceUntilInterrupt: frame.utteranceUntilInterrupt ?? null });
  }
  // The slots have fixed digit lengths, so the keypad terminators carry no meaning yet.
  if (frame.type === 'dtmf' && (frame.digit === '#' || frame.digit === '*')) {
    entry.frames.write('log', { ignoredDigit: frame.digit });
    // No turn runs, so nothing downstream would restart the wait the digit just cancelled -- unless
    // a downstream service's answer is awaited, whose own turn arms it.
    if (entry.session.pendingService === null) armNoInput(deps, entry, []);
    return;
  }
  // Partial prompts are on in the TwiML so the no-input wait can be cancelled at the caller's
  // first syllable, but a non-final prompt is not something the core was built to score: treating
  // one as the complete utterance would run a turn on half a sentence and then run another on the
  // whole of it. Record it, restart the wait (not during a service wait, as above), and hold out
  // for the final.
  if (frame.type === 'prompt' && !frame.last) {
    entry.frames.write('log', { droppedPartial: frame.voicePrompt.slice(0, 80) });
    if (!ctx.partialLogged) {
      ctx.partialLogged = true;
      deps.log(`${ctx.callSid}: dropped a non-final prompt; partials only cancel the no-input wait`);
    }
    if (entry.session.pendingService === null) armNoInput(deps, entry, []);
    return;
  }
  // What replay cannot work out from the session it rebuilds: that this frame arrived during a
  // service wait, or that this digit was keyed ahead. On the line after the frame's own, which is
  // where replay (harness-text/replay.ts arrivalFlags) looks for it.
  const flags = arrivalFlags(event, arrival, (pendingTurns.get(ctx.callSid) ?? 0) > 0);
  if (flags) entry.frames.write('log', flags);
  const run = async (e: CallEntry): Promise<void> => {
    // Whether a digit keyed ahead is taken is only known now, as its turn runs. Taken, it is not
    // sensitive where it lands, so the log keeps its value for replay; one line either way, in the
    // order the digits run, which is the order they arrived (the store runs a call's turns in order).
    if (event.type === 'user.key' && arrival.sensitive === 'ahead') {
      const taken = digitAtRun(e.session, event, arrivalContext(e.session, event, arrival)) === null;
      e.frames.write('log', taken ? { aheadAccepted: event.digit } : { aheadIgnored: true });
    }
    await turn(deps, e, event, arrival);
  };
  // Only speech can move the prompt; an interrupt or relay error is state, not a turn.
  await enqueueTurn(deps, ctx.callSid, run, event.type === 'user.speech');
}

/**
 * The frame as the frame log may keep it: at the code prompt, a spoken turn with its digits masked
 * (core/spokenCode.ts); any other frame as it came. The core masks its event again as the turn
 * runs (run/turn.ts maskCodeEvent), a no-op on words already masked.
 */
function maskCodeFrame(promptedFor: Session['promptedFor'], frame: InboundFrame, codeLength: number): InboundFrame {
  // Only a spoken turn carries the caller's words; an `interrupt`'s utteranceUntilInterrupt is our own prompt.
  if (promptedFor !== 'otp' || frame.type !== 'prompt') return frame;
  const m = maskSpokenCode(frame.voicePrompt, spokenCodeMinDigits(codeLength));
  return m.masked ? { ...frame, voicePrompt: m.text } : frame;
}

/**
 * A keypad digit's class on arrival: sensitiveDigit on the session as it stands, or, for a digit
 * that would otherwise be logged as itself, 'ahead' while a turn that can move the prompt is still
 * outstanding (the caller asked something and is keying the answer before the question).
 */
function arrivalDigit(entry: CallEntry, event: SessionEvent): ArrivalDigit {
  const now = sensitiveDigit(entry.session, event);
  if (now !== null || event.type !== 'user.key' || !/^\d$/.test(event.digit)) return now;
  return (unsettledTurns.get(entry.callSid) ?? 0) > 0 ? 'ahead' : null;
}

/** The frame-log line for an arrival replay has to be told about. */
interface ArrivalFlags {
  /** Arrived during a downstream service's wait. */
  ignoredDuringService?: true;
  keyedAhead?: true;
  /** The question a digit was keyed at, when turns were outstanding that might move it first. */
  keyedAt?: Session['promptedFor'];
}

/**
 * The frame-log flags for an arrival replay has to be told about, or null when there are none.
 * `pending` is whether any turn was queued or running as the frame arrived: replay has run them all
 * by the time it reads the frame, so it cannot see the question a digit was keyed at then.
 */
function arrivalFlags(event: SessionEvent, arrival: Arrival, pending: boolean): ArrivalFlags | null {
  const during = arrival.duringService === true && (event.type === 'user.speech' || event.type === 'user.key');
  const ahead = arrival.sensitive === 'ahead';
  const keyedAt = !ahead && pending && event.type === 'user.key' && /^\d$/.test(event.digit) && arrival.promptedFor !== undefined;
  if (!during && !ahead && !keyedAt) return null;
  return {
    ...(during ? { ignoredDuringService: true as const } : {}),
    ...(ahead ? { keyedAhead: true as const } : {}),
    ...(keyedAt ? { keyedAt: arrival.promptedFor ?? null } : {}),
  };
}

export async function handleSocketClose(deps: AdapterDeps, ctx: ConnectionContext): Promise<void> {
  if (!ctx.callSid) return;
  const entry = deps.store.get(ctx.callSid);
  if (!entry) {
    // The call is gone from the store, so nothing will ever consult its no-input bookkeeping again.
    forgetNoInput(ctx.callSid);
    return;
  }
  if (ctx.socket && entry.socket !== ctx.socket) {
    // A close from a socket a reconnect already replaced; the live one must stay attached.
    entry.frames.write('log', { staleSocketClosed: true });
    return;
  }
  const timer = endGraceTimers.get(ctx.callSid);
  if (timer) {
    clearTimeout(timer);
    endGraceTimers.delete(ctx.callSid);
  }
  // A close of the live socket of a call that never ended is not yet a hangup: the reconnect
  // Twilio drives from `/cr-action` gets here too, and in that order (socket close, then the
  // action webhook, then the new setup) this handler cannot tell the two apart. The action
  // webhook can, so the `ended{hangup}` event is published there (`decideActionTwiml` in http.ts).
  // Nobody is listening on the other end; a re-ask would be played to a closed socket.
  clearNoInput(ctx.callSid);
  entry.frames.write('log', { socketClosed: true, ended: entry.ended });
  deps.store.detach(ctx.callSid);
}
