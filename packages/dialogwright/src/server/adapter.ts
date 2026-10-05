import { endDropsSpeechOf, playbackEventOf, readsPlaybackEvents, setupCallIdOf, textLastOf } from './voice/registry';
import type { PlaybackEvent } from './voice/provider';
import type { InboundFrame, OutboundFrame } from '../channel/relay/frames';
import { bargeInFrame, serviceResultFrame, endFrame, silenceFrame, textFrame } from '../channel/relay/frames';
import { DEFAULT_END_PLAYBACK_MAX_MS, DEFAULT_NO_INPUT_AFTER_SPEECH_MS, DEFAULT_RESUME_AFTER_PAUSE_MS, DEFAULT_RESUME_INTO_REPLY_MS, END_PLAYBACK_LEAD_MS, END_PLAYBACK_MARGIN_MS, type BargeIn, type EndAfterPlayback } from '../channel/voiceProviders';
import { parseInbound, serializeOutbound } from '../channel/relay/wire';
import { actionsToFrames, frameToEvent, isInboundFrameType } from '../channel/relay/map';
import { serviceResultEvent, silenceEvent, type SessionEvent } from '../channel/events';
import { cutShort, playbackEstimateMs } from '../channel/relay/playback';
import { arrivalContext, CODE_DIGIT, type Arrival } from '../run/turn';
import { CONTINUE_MAX_FRAGMENTS, Continuation, continueWithinMsOf, undoable, type ContinuedRun } from '../run/continuation';
import { pronounce, pronounceFor, unpronounce, type PronounceList } from '../channel/pronounce';
import { localeOf } from '../core/locale';
import { digitAtRun, promptEpoch, sensitiveDigit, type ArrivalDigit, type TurnResult } from '../core/turn';
import { maskSpokenCode, spokenCodeMinDigits } from '../core/spokenCode';
import { DEFAULT_SCREEN_MODE, requestsPerTurn } from '../core/screen';
import type { Session } from '../core/session';
import type { CallEntry, SessionStore, SocketLike } from './sessions';
import type { CallTokens } from './tokens';
import type { DashboardBus } from './dashboard/bus';
import { maskNumber, redactDeep, type DashboardEvent } from './dashboard/events';
import { deliveryFactOf, interruptFact } from './dashboard/delivery';
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
  /** When it fires: what a hold keeps, so the caller heard speaking neither shortens nor lengthens the wait. */
  dueAtMs: number;
}
const noInputTimers = new Map<string, NoInput>();

export { DEFAULT_NO_INPUT_AFTER_SPEECH_MS };

/**
 * The longest a no-input wait is held for a caller the carrier reports speaking with no report that they
 * stopped. A stop that never comes (a lost event) must not leave the call with no wait at all: past this,
 * the stop is taken as given and the wait resumes as it would after one.
 */
export const NO_INPUT_HOLD_MAX_MS = 30_000;

/**
 * A no-input wait held while the carrier reports the caller speaking (Telnyx's clientSpeaking): no
 * silence turn runs over a caller who is talking. `dueAtMs` is when the wait would have run out; the
 * stop resumes it (resumeNoInput). `limit` is the NO_INPUT_HOLD_MAX_MS backstop.
 */
interface HeldNoInput {
  dueAtMs: number;
  limit: ReturnType<typeof setTimeout>;
}
const noInputHeld = new Map<string, HeldNoInput>();

/** Release a call's held wait, if any, without resuming it. */
function releaseHeld(callSid: string): void {
  const held = noInputHeld.get(callSid);
  if (!held) return;
  clearTimeout(held.limit);
  noInputHeld.delete(callSid);
}
/**
 * Bumped every time a call's no-input timer is cleared or re-armed. A fired timer's queued
 * closure carries the generation it was armed with, so a turn that got in first (the caller
 * answered at the last second) turns the queued silence turn into a no-op.
 *
 * It outlives a socket close on purpose, so a reconnect cannot hand an already-queued closure a
 * generation it would match again. Only `forgetNoInput` drops it, once the call itself is gone.
 */
const noInputGeneration = new Map<string, number>();

/**
 * A call whose no-input timer has fired and whose silence turn waits in the call's queue behind another,
 * by the generation it carries. A report of the caller speaking before it runs holds it as it would an
 * armed wait (onCallerSpeech); any clear drops it, since the generation it carries no longer matches.
 */
const silenceQueued = new Map<string, number>();

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

/**
 * Each call's Continuation (run/continuation.ts): the fragments of a caller who had not finished, the
 * session before the first, and whether the reply to the last was cut off. Every turn of the call runs
 * through it (turn, below), in the order the store runs them. Kept here, like the no-input timers,
 * and never saved: a server restarted mid-answer runs the next prompt alone.
 */
const continuations = new Map<string, Continuation>();

/** The call's Continuation: made as the call starts, or, for a call loaded after a restart, on its first turn here. */
function continuationOf(entry: CallEntry): Continuation {
  let c = continuations.get(entry.callSid);
  if (c === undefined) {
    c = new Continuation(continueWithinMsOf(appOf(entry.session)));
    continuations.set(entry.callSid, c);
  }
  return c;
}

/** Consecutive turns that threw, per call, reset by any turn that produces a decision. */
const turnFailures = new Map<string, number>();

/**
 * Thrown turns in a row before the no-input wait stops re-arming. Each one speaks the apology and
 * the wait asks the question again, so a client that is down would otherwise loop for the life of
 * the call; three attempts is enough to ride out a blip.
 */
export const TURN_FAILURE_LIMIT = 3;

/** Cancel any armed or held no-input wait for a call and invalidate whatever it already queued. */
function clearNoInput(callSid: string): void {
  const armed = noInputTimers.get(callSid);
  if (armed) {
    clearTimeout(armed.timer);
    noInputTimers.delete(callSid);
  }
  releaseHeld(callSid);
  silenceQueued.delete(callSid);
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
  releaseHeld(callSid);
  silenceQueued.delete(callSid);
  noInputGeneration.delete(callSid);
  lastPlayback.delete(callSid);
  turnFailures.delete(callSid);
  continuations.delete(callSid);
  unwatch(callSid);
  callerSpeaking.delete(callSid);
  heldEnds.get(callSid)?.release('closed');
  reportsPlayback.delete(callSid);
  forgetResumed(callSid);
  settleHeard(callSid);
  releaseReply(callSid, 'sent');
}

/**
 * Arm the no-input timer: `noInputMs` after the frames have (approximately) finished playing.
 * When it fires the silence turn goes through the same per-call queue as a socket message, so it
 * can never interleave with a real turn.
 *
 * `frames` is what actually went out. An empty list means the caller was heard from but nothing
 * was said back (a barge-in, a keypad terminator, a partial), so the wait is measured from the
 * end of whatever is still playing rather than from now.
 *
 * Armed while the carrier reports the caller speaking (a reply to the words so far, as they go on), the
 * wait is held from the start, and their stop resumes it (onCallerSpeech).
 */
function armNoInput(deps: AdapterDeps, entry: CallEntry, frames: readonly OutboundFrame[]): void {
  const wait = deps.noInputMs ?? 0;
  if (wait <= 0) return;
  clearNoInput(entry.callSid);
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
  if (callerSpeaking.has(entry.callSid)) {
    holdNoInput(deps, entry, nowMs + delay);
    return;
  }
  scheduleNoInput(deps, entry, delay);
  // Only for a re-arm that had something to say. Partials arrive several times a second while the
  // caller speaks, and a line each would drown the frame log in bookkeeping.
  if (frames.length > 0) entry.frames.write('log', { noInputArmedMs: delay });
}

/** Start the no-input timer: a silence turn `delay` ms from now, unless a turn or a clear gets in first. */
function scheduleNoInput(deps: AdapterDeps, entry: CallEntry, delay: number): void {
  const generation = noInputGeneration.get(entry.callSid) ?? 0;
  const timer = setTimeout(() => {
    noInputTimers.delete(entry.callSid);
    silenceQueued.set(entry.callSid, generation);
    void enqueueUnsettled(deps, entry.callSid, async (e) => {
      if (silenceQueued.get(e.callSid) === generation) silenceQueued.delete(e.callSid);
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
  noInputTimers.set(entry.callSid, { timer, generation, dueAtMs: Date.now() + delay });
}

/** Hold a call's no-input wait, due at `dueAtMs`, while the caller is heard speaking. Nothing is armed meanwhile. */
function holdNoInput(deps: AdapterDeps, entry: CallEntry, dueAtMs: number): void {
  const callSid = entry.callSid;
  releaseHeld(callSid);
  const limit = setTimeout(() => {
    // No stop came: taken as given, so the caller is no longer counted as speaking anywhere.
    callerSpeaking.delete(callSid);
    const e = deps.store.get(callSid);
    if (e && !e.ended) resumeNoInput(deps, e, 'holdLimit');
    else releaseHeld(callSid);
  }, NO_INPUT_HOLD_MAX_MS);
  limit.unref?.();
  noInputHeld.set(callSid, { dueAtMs, limit });
  entry.frames.write('log', { noInputHeld: 'speaking' });
}

/**
 * Resume a held wait: the silence turn comes when the wait would have run out, but never sooner than
 * NO_INPUT_AFTER_SPEECH_MS after the caller stopped, so the carrier's transcript of what they said gets
 * in first. A cough with the wait half run leaves the caller's wait as it was; speech that ran past the
 * deadline is followed by the settle, not by a whole new NO_INPUT_MS, and a transcript in that time
 * clears it as any prompt does. `after` says, in the frame log, why it resumed.
 */
function resumeNoInput(deps: AdapterDeps, entry: CallEntry, after: 'speech' | 'holdLimit'): void {
  const held = noInputHeld.get(entry.callSid);
  if (!held) return;
  clearNoInput(entry.callSid);
  const settle = deps.noInputAfterSpeechMs ?? DEFAULT_NO_INPUT_AFTER_SPEECH_MS;
  const delay = Math.max(held.dueAtMs - Date.now(), settle);
  scheduleNoInput(deps, entry, delay);
  entry.frames.write('log', { noInputArmedMs: delay, after });
}

/**
 * Arm the no-input wait as already due, for a caller heard going on over a reply held and never said
 * (holdReply): held while they speak, and run NO_INPUT_AFTER_SPEECH_MS after they stop (resumeNoInput), or
 * that long from now when they have stopped already. Their prompt in that time clears it, as any does.
 */
function armDue(deps: AdapterDeps, entry: CallEntry): void {
  if ((deps.noInputMs ?? 0) <= 0) return;
  clearNoInput(entry.callSid);
  if (callerSpeaking.has(entry.callSid)) holdNoInput(deps, entry, Date.now());
  else scheduleNoInput(deps, entry, deps.noInputAfterSpeechMs ?? DEFAULT_NO_INPUT_AFTER_SPEECH_MS);
}

/**
 * The carrier heard the caller start or stop speaking (a PlaybackEvent `caller speaking`, read by the
 * carrier's provider: Telnyx's clientSpeaking; Twilio reports none, and sends partial prompts instead).
 * The caller is not silent while they speak, so an armed no-input wait is held; their stop resumes it
 * (resumeNoInput). Seen on a live Telnyx call (2026-10-05): with no partials, the wait ran out while the
 * caller was finishing a long sentence, and "I didn't hear anything." went out just before Telnyx's
 * transcript of it.
 */
function onCallerSpeech(deps: AdapterDeps, entry: CallEntry, speaking: boolean): void {
  const callSid = entry.callSid;
  // Whether this is a caller coming back in over the reply to their last final prompt.
  followResumed(deps, entry, speaking);
  if (speaking) {
    callerSpeaking.add(callSid);
    // Nor is a line the carrier stopped playing then one to say again (RESAY_CUT_LINES), nor an interrupt
    // settling one the caller did not make (a spurious interrupt).
    callerHeard(callSid);
    // A reply held for a caller who had not finished is not said: they went on (holdReply).
    releaseReply(callSid, 'speech');
    if (noInputHeld.has(callSid)) return;
    // An armed wait keeps its deadline. A silence turn already queued behind a busy one (its timer fired)
    // has a deadline just passed: it is held too, rather than said over the caller once the queue frees.
    const armed = noInputTimers.get(callSid);
    const dueAtMs = armed ? armed.dueAtMs : silenceQueued.has(callSid) ? Date.now() : null;
    if (dueAtMs === null) return;
    clearNoInput(callSid);
    holdNoInput(deps, entry, dueAtMs);
    return;
  }
  callerSpeaking.delete(callSid);
  resumeNoInput(deps, entry, 'speech');
}

/**
 * A turn's lines the carrier is playing, watched for a playback it cuts short (RESAY_CUT_LINES). Seen on
 * Telnyx (server/voice/telnyx.ts): a reply right after the caller spoke was reported played in full 0.67 s
 * into a 9.6 s line, with no interrupt and no caller heard, and the caller heard nothing of it. What a
 * carrier reports is read into the engine's terms by its provider (VoiceProvider.readEvent); a carrier
 * that reports nothing is never watched.
 */
interface Watched {
  /** The lines as the turn decided them (text and clips), before the wire's rewriting, which sendFrames does again. */
  frames: OutboundFrame[];
  /** The decision they say, for the frame log's masking (sendFrames). */
  decision: unknown;
  /** The turn's last text as it went out, whitespace folded: what a report of the whole turn played names. */
  lastText: string | null;
  /** How long the lines were estimated to take (playbackEstimateMs, as for the no-input wait). */
  expectedMs: number;
  sentAtMs: number;
  /** When the carrier said it started playing them; null until it does (then the time is from the send). */
  startedAtMs: number | null;
  /** These lines are already a re-send: never said a third time. */
  resent: boolean;
  /** The caller was heard after the lines went out (an interrupt, speech, a digit, a prompt). */
  heard: boolean;
  /** A finish that looked cut short, waiting out the settle; null while the lines play. */
  finished: { heardMs: number; timer: ReturnType<typeof setTimeout> } | null;
  /** Decided: finished in time, heard over, said again, or given up. */
  done: boolean;
}
const watched = new Map<string, Watched>();

/** Calls whose caller the carrier reports speaking now (a PlaybackEvent `caller speaking`). */
const callerSpeaking = new Set<string>();

/**
 * A caller who came back in (App.voice.continueWithinMs, run/continuation.ts), on a carrier that reports
 * the caller's voice (VoiceProvider.readEvent: Telnyx's clientSpeaking). A carrier's interrupt within the
 * window of the reply to a final prompt says the caller had not finished; with the relay's barge-in off
 * (BARGE_IN none or dtmf) no interrupt ever comes, and a recognizer that ends a prompt at a short pause
 * splits what the caller says in two. Seen on Telnyx (2026-10-05): "...for one two" came as a final
 * prompt 0.31 s after the caller stopped, the reply went out 0.21 s later, the caller was heard again
 * 24 ms after it, and "three four" came as a prompt of its own. On another call the caller stopped, the
 * prompt came 0.79 s later, the reply went out 0.19 s after that, and the caller came back in 0.70 s
 * after the reply went out (1.68 s after they had stopped) with the rest of their address. An interrupt
 * window from the reply's send alone would miss the second: the caller's own pause is what says it.
 *
 * - **Coming back in.** The caller starts speaking again no later than RESUME_AFTER_PAUSE_MS after the
 *   speech that gave their last final prompt stopped, and no later than RESUME_INTO_REPLY_MS after the
 *   reply to that prompt went out (or before it went out): an answer to the reply cannot start before
 *   the caller has heard some of it. A caller speaking as the prompt comes is back in already.
 * - **To the next final prompt.** From there their speech runs on across pauses no longer than
 *   RESUME_AFTER_PAUSE_MS; a longer one ends it (an "mm", a listen, then an answer is a new utterance).
 *   When the next final prompt comes with them speaking, or no later than NO_INPUT_AFTER_SPEECH_MS (the
 *   carrier's transcript time) after they stopped, they had not finished: the Continuation is told
 *   (Continuation.resumed), as an interrupt within the window would tell it, and the prompt continues the
 *   one before it. Nothing is cut and no turn runs for it. The joined turn's reply goes out as any line
 *   does; whether it stops the reply still playing is the carrier's (on Telnyx a new frame was not seen
 *   to stop one, server/voice/telnyx.ts), so the caller may hear the rest of that first.
 * - **For replay.** The frame log has `{ callerResumed: { pauseMs, intoReplyMs } }` just before the prompt
 *   it joins, and replay tells its Continuation there (harness-text/replay.ts).
 *
 * A carrier's own interrupt joins as before, within continueWithinMs. One later than that, with the
 * relay's barge-in on, is an ordinary barge-in unless the caller came back in as above: then it is that
 * same speech cutting the reply off, before or after the clientSpeaking that says they are back in, and it
 * ends no join (seen on Telnyx, 2026-10-05: back in 0.52 s into the re-ask, the interrupt 0.30 s later at
 * 730 ms into the line, the rest of the address 1.96 s after that). An app whose continueWithinMs is 0
 * joins nothing either way.
 */
interface AfterPrompt {
  /** When the speech that gave the prompt stopped (for a caller speaking as it came with no stop since the prompt before: when they began). */
  speechEndMs: number;
  /** When the reply to it went out (its first line); null until it has. */
  sentAtMs: number | null;
  /** When the caller came back in; null until they have. */
  resumedAtMs: number | null;
}

/** Each call's last final prompt, while a caller coming back in over the reply to it may still be continuing it. */
const afterPrompts = new Map<string, AfterPrompt>();
/** When the carrier last reported the caller starting, and stopping, to speak. */
const lastStart = new Map<string, number>();
const lastStop = new Map<string, number>();
/** Calls whose caller has stopped speaking since their last final prompt came. */
const stoppedSincePrompt = new Set<string>();

/** RESUME_AFTER_PAUSE_MS: the longest pause that leaves a caller not finished. */
function resumeAfterPauseOf(deps: AdapterDeps): number {
  return deps.resumeAfterPauseMs ?? DEFAULT_RESUME_AFTER_PAUSE_MS;
}

/** Drop what is known of a caller coming back in (a reconnect, a close, a call gone). */
function forgetResumed(callSid: string): void {
  afterPrompts.delete(callSid);
  lastStart.delete(callSid);
  lastStop.delete(callSid);
  stoppedSincePrompt.delete(callSid);
}

/** The caller started or stopped speaking: whether they are coming back in over the reply to their last final prompt. */
function followResumed(deps: AdapterDeps, entry: CallEntry, speaking: boolean): void {
  const callSid = entry.callSid;
  const now = Date.now();
  if (!speaking) {
    lastStop.set(callSid, now);
    stoppedSincePrompt.add(callSid);
    return;
  }
  lastStart.set(callSid, now);
  const r = afterPrompts.get(callSid);
  if (!r) return;
  const pauseMs = resumeAfterPauseOf(deps);
  if (r.resumedAtMs === null) {
    const soonAfterPause = now - r.speechEndMs <= pauseMs;
    const soonIntoReply = r.sentAtMs === null || now - r.sentAtMs <= (deps.resumeIntoReplyMs ?? DEFAULT_RESUME_INTO_REPLY_MS);
    if (soonAfterPause && soonIntoReply) r.resumedAtMs = now;
    else afterPrompts.delete(callSid);
    return;
  }
  // Back in already: a pause longer than the limit since then ends it, and what they say now is new.
  const stop = lastStop.get(callSid);
  if (stop !== undefined && stop >= r.resumedAtMs && now - stop > pauseMs) afterPrompts.delete(callSid);
}

/**
 * A final prompt came (after takeResumed has read the one before): the speech that gave it, from which a
 * caller coming back in is measured. A carrier that reported no stop of the caller since the prompt before,
 * with the caller not speaking, reported nothing of this speech, and nothing is followed.
 */
function notePrompt(deps: AdapterDeps, entry: CallEntry): void {
  const callSid = entry.callSid;
  const now = Date.now();
  const stopped = stoppedSincePrompt.has(callSid) ? lastStop.get(callSid) : undefined;
  stoppedSincePrompt.delete(callSid);
  afterPrompts.delete(callSid);
  if (callerSpeaking.has(callSid)) {
    // Speaking as it came: back in already, from when they began again (after the stop, if any).
    const began = lastStart.get(callSid) ?? now;
    if (stopped === undefined || began - stopped <= resumeAfterPauseOf(deps)) {
      afterPrompts.set(callSid, { speechEndMs: stopped ?? began, sentAtMs: null, resumedAtMs: began });
    }
    return;
  }
  if (stopped !== undefined) afterPrompts.set(callSid, { speechEndMs: stopped, sentAtMs: null, resumedAtMs: null });
}

/**
 * A turn's lines went out (`sentAtMs`, the first of them): a reply to a final prompt is the one a caller
 * may come back in over; any other turn's lines end what was followed of the last prompt.
 */
function noteReply(entry: CallEntry, event: SessionEvent, sentAtMs: number): void {
  const r = afterPrompts.get(entry.callSid);
  if (!r) return;
  if (event.type !== 'user.speech' || !event.final) {
    afterPrompts.delete(entry.callSid);
    return;
  }
  r.sentAtMs = sentAtMs;
}

/**
 * A final prompt arrived: when the caller came back in over the reply to the last one and is still
 * speaking, or stopped no longer than NO_INPUT_AFTER_SPEECH_MS ago, it continues the prompt before it
 * (Continuation.resumed, through the call's queue ahead of the prompt's turn). Logged for replay before
 * the prompt's own line.
 */
function takeResumed(deps: AdapterDeps, entry: CallEntry): void {
  const callSid = entry.callSid;
  const r = afterPrompts.get(callSid);
  afterPrompts.delete(callSid);
  if (!r || r.resumedAtMs === null || continuationOf(entry).withinMs === 0) return;
  if (!callerSpeaking.has(callSid)) {
    const stop = lastStop.get(callSid);
    const settle = deps.noInputAfterSpeechMs ?? DEFAULT_NO_INPUT_AFTER_SPEECH_MS;
    if (stop === undefined || Date.now() - stop > settle) return;
  }
  const pauseMs = r.resumedAtMs - r.speechEndMs;
  const intoReplyMs = r.sentAtMs === null ? 0 : Math.max(0, r.resumedAtMs - r.sentAtMs);
  logDelivery(deps, entry, { callerResumed: { pauseMs, intoReplyMs } });
  void deps.store.enqueue(callSid, async () => continuationOf(entry).resumed());
}

/** Words compared as a carrier reports them back: whitespace folded. */
function folded(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Stop watching a call's lines, with any re-send still waiting out its settle. */
function unwatch(callSid: string): void {
  const w = watched.get(callSid);
  if (w?.finished) clearTimeout(w.finished.timer);
  watched.delete(callSid);
}

/**
 * Watch the lines a turn just sent (or a re-send of them), in place of whatever was watched before.
 * Only on a carrier that reports its playback, with RESAY_CUT_LINES or RESAY_SPURIOUS_INTERRUPTS on; never
 * a turn that ends the call or sends digits, and never one whose lines did not all reach the wire.
 */
function watchPlayback(deps: AdapterDeps, entry: CallEntry, frames: readonly OutboundFrame[], decision: unknown, sent: readonly OutboundFrame[], resent: boolean): void {
  unwatch(entry.callSid);
  if ((!deps.resay && !deps.spuriousInterrupts) || !readsPlaybackEvents(entry.provider)) return;
  if (frames.some((f) => f.type === 'end' || f.type === 'sendDigits')) return;
  const said = frames.filter((f) => f.type === 'text' || f.type === 'play');
  const out = sent.filter((f) => f.type === 'text' || f.type === 'play');
  if (said.length === 0 || out.length !== said.length) return;
  const last = [...out].reverse().find((f) => f.type === 'text');
  watched.set(entry.callSid, {
    frames: said, decision, lastText: last?.type === 'text' ? folded(last.token) : null,
    expectedMs: playbackEstimateMs(out, deps.clipDurations ?? new Map()), sentAtMs: Date.now(), startedAtMs: null,
    resent, heard: false, finished: null, done: false,
  });
}

/**
 * The caller was heard: the lines watched are not said again, whatever the carrier reports of them, and an
 * interrupt settling (settleInterrupt) was theirs.
 */
function callerHeard(callSid: string): void {
  const w = watched.get(callSid);
  if (w) w.heard = true;
  settleHeard(callSid);
}

/**
 * How long a carrier's interrupt with no caller heard around it waits for a report of the caller speaking
 * before it is taken as not theirs (settleInterrupt). Telnyx reports the caller and fires its barge-in
 * independently: on a live call (2026-10-05) clientSpeaking went on 0.30 s before the interrupt, and a
 * report can come after it as well. 400 ms is over the largest gap seen between the two, and short enough
 * that the lines said again follow the cut with less than half a second more of silence.
 */
export const SPURIOUS_INTERRUPT_SETTLE_MS = 400;

/**
 * The settle instead, for an interrupt on a call whose carrier has not reported the caller's voice at all
 * yet (quietMs null): there no report of the caller can be counted on, and only their words can say the
 * interrupt was theirs. Telnyx sent no clientSpeaking while a call's first line played (about 13 live
 * calls, one with any), so a caller talking over the greeting is not heard until their transcript comes,
 * about a second after they stop. A short barge-in ("agent", "operator") is over before the lines could go
 * again, and on Telnyx lines once sent play on to their end (a frame sent mid-line does not stop them): with
 * the 0.4 s settle the caller would hear the whole greeting again before the answer to what they said.
 * 2 s takes in the transcript of a barge-in up to about a second long; a longer one is still going when the
 * lines go again. A greeting cut with no caller at all comes back 2 s after the cut, not 0.4 s.
 */
export const SPURIOUS_INTERRUPT_UNREPORTED_SETTLE_MS = 2_000;

/**
 * A spurious interrupt (RESAY_SPURIOUS_INTERRUPTS), on a carrier that reports the caller's voice. A
 * carrier's barge-in can fire with no caller speaking: on Telnyx (2026-10-05, BARGE_IN=speech) an
 * `interrupt` came 1704 ms into the greeting with no clientSpeaking at all, and the caller, hearing
 * nothing, was silent for about 11 s. An interrupt that comes with the caller not speaking, and not heard
 * starting or stopping within SPURIOUS_INTERRUPT_WINDOW_MS before it, waits SPURIOUS_INTERRUPT_SETTLE_MS
 * (SPURIOUS_INTERRUPT_UNREPORTED_SETTLE_MS before the carrier has reported the caller's voice on the call) in
 * the call's queue (so nothing runs ahead of it): the caller heard meanwhile (speaking, a prompt, a digit,
 * another interrupt), or the socket gone, makes it theirs, and it is taken as before. Otherwise it was not
 * theirs:
 *
 * - **Not a barge-in.** No turn runs for it: the core never sees it, so the next answer is not told of a
 *   barge-in and a Continuation does not take it as a caller who had not finished. The frame log has
 *   `{ spuriousInterrupt: { afterMs, quietMs } }` (how far into the line it came, and how long since the
 *   caller was last heard, null for never) after the interrupt's own line, before any caller frame after
 *   it, and replay skips the interrupt there (harness-text/replay.ts).
 * - **Said again.** The interrupted turn's lines (the ones watched, watchPlayback) go again from the start,
 *   once, as a cut line does (resay): `{ resaid: { reason: 'spurious-interrupt', afterMs, expectedMs } }`
 *   before the frames, and the no-input wait armed from them. Not when a turn has said anything since,
 *   the lines are already a re-send, the caller is speaking, or the call is over; never a turn that ends
 *   the call or sends digits (it is never watched).
 */
interface Settling {
  timer: ReturnType<typeof setTimeout>;
  resolve: (spurious: boolean) => void;
}
const settling = new Map<string, Settling>();

/**
 * Whether a carrier's interrupt arriving now settles before it is taken (a spurious interrupt): with the
 * setting on, on a carrier that reads its events, the caller not speaking and not heard within the window.
 * The quiet before it, for the log; null when the interrupt is the caller's at once.
 */
function interruptUnheard(deps: AdapterDeps, entry: CallEntry): { quietMs: number | null } | null {
  const settings = deps.spuriousInterrupts;
  const callSid = entry.callSid;
  if (!settings || !readsPlaybackEvents(entry.provider) || callerSpeaking.has(callSid)) return null;
  const now = Date.now();
  const last = Math.max(lastStart.get(callSid) ?? -Infinity, lastStop.get(callSid) ?? -Infinity);
  if (now - last <= settings.windowMs) return null;
  return { quietMs: Number.isFinite(last) ? now - last : null };
}

/** Wait out the settle for an interrupt: true when no caller was heard in it (logged then), false when one was. */
function settleInterrupt(deps: AdapterDeps, entry: CallEntry, afterMs: number, quietMs: number | null): Promise<boolean> {
  const callSid = entry.callSid;
  settleHeard(callSid);
  return new Promise((resolve) => {
    const s: Settling = {
      timer: setTimeout(() => {
        if (settling.get(callSid) !== s) return;
        settling.delete(callSid);
        // Written as it is decided, before any caller frame after it, where replay looks for it.
        logDelivery(deps, entry, { spuriousInterrupt: { afterMs, quietMs } });
        resolve(true);
      }, quietMs === null ? SPURIOUS_INTERRUPT_UNREPORTED_SETTLE_MS : SPURIOUS_INTERRUPT_SETTLE_MS),
      resolve,
    };
    s.timer.unref?.();
    settling.set(callSid, s);
  });
}

/** The caller was heard, or the call's socket went: an interrupt settling is taken as theirs. */
function settleHeard(callSid: string): void {
  const s = settling.get(callSid);
  if (!s) return;
  clearTimeout(s.timer);
  settling.delete(callSid);
  s.resolve(false);
}

/**
 * After a spurious interrupt, in the call's queue: the interrupted lines (`w`, watched as it came) said
 * again from the start, once, or, when they cannot be, the no-input wait armed again as the interrupt's
 * own turn would have.
 */
async function recoverSpurious(deps: AdapterDeps, e: CallEntry, w: Watched | undefined, afterMs: number): Promise<void> {
  const callSid = e.callSid;
  if (e.ended) return;
  if (w === undefined || watched.get(callSid) !== w || w.resent || e.socket === null || callerSpeaking.has(callSid)) {
    if (w?.resent && watched.get(callSid) === w) deps.log(`${callSid}: interrupted again with no caller heard, not said a third time`);
    if (e.session.promptedFor !== null && e.session.pendingService === null) armNoInput(deps, e, []);
    return;
  }
  w.done = true;
  deps.log(`${callSid}: interrupted ${seconds(afterMs, 2)} into the lines with no caller heard, lines said again`);
  logDelivery(deps, e, { resaid: { reason: 'spurious-interrupt', afterMs, expectedMs: w.expectedMs } });
  const sent = await sendFrames(deps, e, w.frames, w.decision);
  watchPlayback(deps, e, w.frames, w.decision, sent, true);
  // As the turn that said them armed it.
  const kind = (w.decision as { kind?: unknown } | null)?.kind;
  if (e.session.pendingService === null && (kind === 'prompt' || e.session.promptedFor !== null)) armNoInput(deps, e, sent);
}

/**
 * A reply held for a caller clearly not finished (INCOMPLETE_WAIT_MS, INCOMPLETE_WAIT_BELOW), on a carrier
 * that reports the caller's voice. A recognizer that ends a prompt at a short pause splits an answer: on
 * Telnyx (2026-10-05) "seventy six" came as a final prompt, the re-ask went out 0.16 s later, and the
 * caller, going on with the rest of the address 0.52 s into it, talked over it. The caller-resumed join
 * (takeResumed) joins the two prompts, but the re-ask has been said over the caller by then. The model
 * reads every final prompt's words for whether the caller finished (utteranceComplete, in the same request,
 * so no time is added to a finished one); the gates only note a low reading on a final prompt. Here, when
 * a final prompt's turn reads under INCOMPLETE_WAIT_BELOW (the call's GATE_COMPLETE unless set) and the
 * turn only spoke (run/continuation.ts undoable: nothing went through the gate, no service, no end, no
 * quarantine), its reply is held, after the turn ran and before any frame goes, for up to
 * INCOMPLETE_WAIT_MS:
 *
 * - **The caller goes on** (the carrier reports them speaking, or a prompt comes, in the wait; or they
 *   were speaking again already when the turn ended): the reply is never said. The Continuation is told
 *   (Continuation.resumed), so the next final prompt continues this one, joined and run on the session
 *   before the first fragment, as after an early interrupt.
 * - **They do not**: the reply goes when the wait has passed, as any reply does.
 *
 * Not on a carrier that reports no caller speaking (Twilio), where no wait could end early; not for an app
 * whose continueWithinMs is 0 (it joins nothing); not past CONTINUE_MAX_FRAGMENTS. A key pressed in the
 * wait, or the socket gone, sends it at once. The no-input wait does not run during the hold: it is
 * cleared, and armed by the turn afterwards from the reply's send. A reply not said leaves it to the prompt
 * that went on, whose own turn arms it; or, for a caller only heard going on (a cough, too, with no prompt
 * after it), it is due at once: held while they speak, it runs NO_INPUT_AFTER_SPEECH_MS after they stop,
 * as for any caller heard past the wait's deadline (resumeNoInput), not a whole NO_INPUT_MS later. The
 * frame log has `{ replyHeld: { ms, outcome: 'joined' | 'sent', utteranceComplete, turn } }`
 * when it ends, `turn` being the held turn's turnIndex, by which replay tells its Continuation after that
 * turn, as here (harness-text/replay.ts).
 */
interface HeldReply {
  timer: ReturnType<typeof setTimeout>;
  resolve: (outcome: HeldOutcome) => void;
}
const heldReplies = new Map<string, HeldReply>();

/** How a held reply ended: the caller went on, heard speaking (`speech`) or with a prompt (`prompt`); or it goes (`sent`). */
type HeldOutcome = 'speech' | 'prompt' | 'sent';

/** End a call's held reply, if any. */
function releaseReply(callSid: string, outcome: HeldOutcome): void {
  const h = heldReplies.get(callSid);
  if (!h) return;
  clearTimeout(h.timer);
  heldReplies.delete(callSid);
  h.resolve(outcome);
}

/**
 * Whether a turn's reply may be held for a caller not finished: the model's utteranceComplete reading when
 * it is under `below` and the turn only spoke (undoable); null otherwise, or when the words were not read.
 */
export function holdsReply(result: TurnResult, below: number): number | null {
  if (!undoable(result)) return null;
  const value = result.rows.find((r) => r.gate === 'utteranceComplete')?.value;
  return typeof value === 'number' && value < below ? value : null;
}

/**
 * Hold a final prompt's reply for a caller not finished (above), in the call's queue; null when it is not
 * one to hold. `promptAtMs` is when the prompt came: a caller heard starting since then has gone on.
 */
async function holdReply(deps: AdapterDeps, entry: CallEntry, event: SessionEvent, run: ContinuedRun, promptAtMs: number | undefined): Promise<HeldOutcome | null> {
  const wait = deps.incompleteWait;
  // A socket already gone has no one to wait for (and nothing left to end the wait early).
  if (!wait || wait.waitMs <= 0 || !readsPlaybackEvents(entry.provider) || entry.socket === null) return null;
  if (event.type !== 'user.speech' || !event.final) return null;
  const continuation = continuationOf(entry);
  if (continuation.withinMs === 0 || (run.joined?.length ?? 1) >= CONTINUE_MAX_FRAGMENTS) return null;
  const complete = holdsReply(run.result, wait.below ?? entry.opts.thresholds.GATE_COMPLETE);
  if (complete === null) return null;
  const callSid = entry.callSid;
  // No silence turn over the hold: the turn arms the wait once it ends.
  clearNoInput(callSid);
  const heldAtMs = Date.now();
  const back = callerSpeaking.has(callSid) || (lastStart.get(callSid) ?? -Infinity) >= (promptAtMs ?? heldAtMs);
  const ended = back ? 'speech' : await new Promise<HeldOutcome>((resolve) => {
    releaseReply(callSid, 'sent');
    const h: HeldReply = { timer: setTimeout(() => releaseReply(callSid, 'sent'), wait.waitMs), resolve };
    h.timer.unref?.();
    heldReplies.set(callSid, h);
  });
  const outcome = ended === 'sent' ? 'sent' : 'joined';
  logDelivery(deps, entry, { replyHeld: { ms: Date.now() - heldAtMs, outcome, utteranceComplete: complete, turn: run.result.session.turnIndex } });
  if (outcome === 'joined') continuation.resumed();
  return ended;
}

/**
 * How a held `end` (END_AFTER_PLAYBACK) came to go, as the frame log's `endAfter` says it: the carrier
 * reported the lines played; their estimate passed on a call whose carrier reports nothing; the ceiling
 * passed (the estimate and a margin with no report, or END_PLAYBACK_MAX_MS); or the socket closed first
 * (the caller hung up), and no `end` was sent.
 */
type EndAfter = 'played' | 'estimate' | 'timeout' | 'closed';

/** A turn's `end` frame held until the lines before it have played (holdEnd). */
interface HeldEnd {
  /**
   * The last line as it went out (pronounced and spelled as sent), whitespace folded: a carrier's report
   * of it playing names it. Null when the lines end with a clip, which no report names.
   */
  lastText: string | null;
  /** The carrier has started playing since the lines went out: a stop after that is the end of them. */
  started: boolean;
  /** A stop with no line named, waiting out RESAY_SETTLE_MS in case more plays; null otherwise. */
  settle: ReturnType<typeof setTimeout> | null;
  ceiling: ReturnType<typeof setTimeout>;
  release: (after: EndAfter) => void;
}
const heldEnds = new Map<string, HeldEnd>();

/**
 * Calls whose carrier has reported its playback (Telnyx with TELNYX_EVENTS reports the greeting's), so a
 * held `end` waits for the report, up to the estimate and a margin; on any other call the estimate is all
 * there is to go by.
 */
const reportsPlayback = new Set<string>();

/** Whether a call's `end` is held until its lines have played: END_AFTER_PLAYBACK, auto by the carrier. */
function holdsEnd(deps: AdapterDeps, provider: string | undefined): boolean {
  const mode = deps.endAfterPlayback ?? 'auto';
  return mode === 'on' || (mode === 'auto' && endDropsSpeechOf(provider));
}

/**
 * Wait until the lines a turn that ends the call just sent (`sent`) have played: until the carrier reports
 * the last of them played (or stopped, and stayed stopped for RESAY_SETTLE_MS, after it started), else
 * until the ceiling. The ceiling is the lines' estimate (playbackEstimateMs, as for the no-input wait) and
 * END_PLAYBACK_MARGIN_MS on a call whose carrier reports its playback, or the estimate and
 * END_PLAYBACK_LEAD_MS on one that reports nothing; never more than END_PLAYBACK_MAX_MS. A socket close
 * meanwhile ends the wait as `closed` (handleSocketClose).
 */
function holdEnd(deps: AdapterDeps, callSid: string, sent: readonly OutboundFrame[]): Promise<{ after: EndAfter; heldMs: number; expectedMs: number }> {
  const said = sent.filter((f) => f.type === 'text' || f.type === 'play');
  const expectedMs = playbackEstimateMs(said, deps.clipDurations ?? new Map());
  const reported = reportsPlayback.has(callSid);
  const wanted = expectedMs + (reported ? END_PLAYBACK_MARGIN_MS : END_PLAYBACK_LEAD_MS);
  const waitMs = Math.min(deps.endPlaybackMaxMs ?? DEFAULT_END_PLAYBACK_MAX_MS, wanted);
  // The last thing said, when it is a line: a clip after the last line still plays once the line has.
  const last = said.at(-1);
  heldEnds.get(callSid)?.release('closed');
  const heldAtMs = Date.now();
  return new Promise((resolve) => {
    const held: HeldEnd = {
      lastText: last?.type === 'text' ? folded(last.token) : null,
      started: false,
      settle: null,
      ceiling: setTimeout(() => held.release(reported || waitMs < wanted ? 'timeout' : 'estimate'), waitMs),
      release: (after) => {
        if (heldEnds.get(callSid) !== held) return;
        heldEnds.delete(callSid);
        clearTimeout(held.ceiling);
        if (held.settle) clearTimeout(held.settle);
        resolve({ after, heldMs: Date.now() - heldAtMs, expectedMs });
      },
    };
    held.ceiling.unref?.();
    heldEnds.set(callSid, held);
  });
}

/** A carrier's report of its playback, for a call whose `end` is held (holdEnd). */
function onHeldEndEvent(callSid: string, ev: PlaybackEvent): void {
  const held = heldEnds.get(callSid);
  if (!held || ev.kind !== 'playback') return;
  if (ev.state === 'started') {
    held.started = true;
    if (held.settle) {
      clearTimeout(held.settle);
      held.settle = null;
    }
    return;
  }
  // The report of a line played: the end of the lines when it ends with the last one. Telnyx may report
  // a turn's lines as one, run together ("...an outage.What's the street..."), seen on a live call.
  if (ev.text !== undefined) {
    if (held.lastText !== null && folded(ev.text).endsWith(held.lastText)) held.release('played');
    return;
  }
  // A stop that names no line: only once the lines have started (a stop before is of what played before
  // them), and only once it has stayed stopped (a carrier may stop between lines).
  if (!held.started || held.settle) return;
  held.settle = setTimeout(() => held.release('played'), RESAY_SETTLE_MS);
  held.settle.unref?.();
}

/**
 * Send a turn's `end` frame (`end`, with anything after it) once the lines before it have played
 * (holdEnd), with the end-close grace after it as for any `end`. The call is ended first, in the store
 * and for its token, so a socket that closes during the wait is a call that ended, never one to
 * reconnect (http.ts decideAction), and a turn queued behind this one says nothing. A transfer's `end`
 * keeps its handoff data on the call until it is sent (CallEntry.heldHandoffData): a socket that closes
 * first with the caller still on the line is put through all the same. Not awaited by the
 * turn: the call's queue has nothing more to run, and a carrier's report must reach the wait meanwhile.
 * Returns false, having sent nothing, when no line went out or the socket is gone: there is nothing to wait for.
 */
function sendEndAfterPlayback(deps: AdapterDeps, entry: CallEntry, end: OutboundFrame[], sent: readonly OutboundFrame[], decision: unknown): boolean {
  if (entry.socket === null || !sent.some((f) => f.type === 'text' || f.type === 'play')) return false;
  const callSid = entry.callSid;
  deps.store.end(callSid);
  deps.tokens.revoke(callSid);
  // A transfer still owed should the socket close first with the caller on the line (http.ts decideAction).
  const handoffData = end.find((f) => f.type === 'end')?.handoffData;
  if (handoffData !== undefined) entry.heldHandoffData = handoffData;
  const done: Promise<void> = holdEnd(deps, callSid, sent)
    .then(async ({ after, heldMs, expectedMs }) => {
      logDelivery(deps, entry, { endAfter: after, endHeldMs: heldMs, expectedMs });
      if (after === 'closed') return;
      if (after === 'timeout' && reportsPlayback.has(callSid)) {
        deps.log(`${callSid}: end sent after ${seconds(heldMs, 2)} with no report the lines finished (~${seconds(expectedMs, 1)} estimated)`);
      }
      const out = await sendFrames(deps, entry, end, decision);
      if (out.some((f) => f.type === 'end')) entry.heldHandoffData = null;
      armEndGrace(deps, entry);
    })
    .catch((err: unknown) => deps.log(`${callSid}: sending the held end failed: ${describe(err).message}`))
    .finally(() => {
      if (endSends.get(callSid)?.done === done) endSends.delete(callSid);
    });
  endSends.set(callSid, { entry, done });
  return true;
}

/**
 * Each held `end`'s whole send (the wait, then the frame), by call, with the call it is for: what a
 * stopping server waits for (heldEndsOf).
 */
const endSends = new Map<string, { entry: CallEntry; done: Promise<void> }>();

/**
 * The held `end`s (END_AFTER_PLAYBACK) of the calls `store` holds, each settled once its `end` has gone or
 * its socket closed first. Such a call has ended for the store, but its goodbye or transfer line is still
 * playing: a stopping server waits for it as for a live call (index.ts drain and close), or its caller
 * loses the line, and a transfer its `end`.
 */
export function heldEndsOf(store: { get(callSid: string): CallEntry | undefined }): Promise<void>[] {
  return [...endSends].filter(([callSid, s]) => store.get(callSid) === s.entry).map(([, s]) => s.done);
}

/**
 * After `end`, Twilio plays the queued frames and closes the socket itself; closing it here would drop
 * the completion (live call, error 64105). The backstop closes it after END_CLOSE_GRACE_MS if the
 * carrier never does; the socket's close cancels it.
 */
function armEndGrace(deps: AdapterDeps, entry: CallEntry): void {
  const socket = entry.socket;
  if (!socket) return;
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

/** Seconds for the log: `0.67 s`. */
function seconds(ms: number, digits: number): string {
  return `${(ms / 1000).toFixed(digits)} s`;
}

/**
 * A carrier's report of its playback or of the caller's voice (PlaybackEvent). The watched lines are
 * finished when the carrier says it stopped playing, or that it played the turn's last line; a finish
 * under RESAY_MIN_FRACTION of their estimate, with the caller not heard since they went out, is a cut,
 * and the lines go again once the settle has passed with nothing more played (resay). A re-send cut as
 * well is logged and left: the no-input wait asks again, as before.
 */
function onPlaybackEvent(deps: AdapterDeps, entry: CallEntry, ev: PlaybackEvent, settings: ResaySettings): void {
  const callSid = entry.callSid;
  // The caller's voice is read for every carrier that reports it, resay or not (onCallerSpeech).
  if (ev.kind === 'caller') return;
  const w = watched.get(callSid);
  if (!w || w.done) return;
  const now = Date.now();
  if (ev.state === 'started') {
    // More of the turn plays after a stop: the stop was between its lines, not the end of them.
    if (w.finished) {
      clearTimeout(w.finished.timer);
      w.finished = null;
    }
    if (w.startedAtMs === null) w.startedAtMs = now;
    return;
  }
  // Already finished (the stop after the report of the last line), or the report of an earlier line.
  if (w.finished) return;
  if (ev.text !== undefined && (w.lastText === null || folded(ev.text) !== w.lastText)) return;
  const heardMs = now - (w.startedAtMs ?? w.sentAtMs);
  if (w.heard || !cutShort(heardMs, w.expectedMs, settings.minFraction)) {
    w.done = true;
    return;
  }
  if (w.resent) {
    w.done = true;
    deps.log(`${callSid}: playback cut short again (${seconds(heardMs, 2)} of ~${seconds(w.expectedMs, 1)}), not said a third time`);
    logDelivery(deps, entry, { cutAgain: { heardMs, expectedMs: w.expectedMs } });
    return;
  }
  const timer = setTimeout(() => resay(deps, callSid, w), RESAY_SETTLE_MS);
  timer.unref?.();
  w.finished = { heardMs, timer };
}

/**
 * Say a cut turn's lines again, once: the same frames, through sendFrames (so `last` is the carrier's,
 * textLast), in the call's queue so no turn runs between. Not a turn: nothing reaches the core, the
 * trace or replay, which reads only what came in. The frame log has `{ resaid: { heardMs, expectedMs } }`
 * before the frames, and the no-input wait, if one is armed, is armed again from the new playback.
 * Nothing goes when a turn ran since, the caller was heard or is speaking, or the call is over.
 */
function resay(deps: AdapterDeps, callSid: string, w: Watched): void {
  void deps.store.enqueue(callSid, async (e) => {
    if (watched.get(callSid) !== w || w.done || w.heard || w.finished === null) return;
    w.done = true;
    if (e.ended || !e.socket || callerSpeaking.has(callSid)) return;
    const { heardMs } = w.finished;
    deps.log(`${callSid}: playback cut short (${seconds(heardMs, 2)} of ~${seconds(w.expectedMs, 1)}), lines said again`);
    logDelivery(deps, e, { resaid: { heardMs, expectedMs: w.expectedMs } });
    const sent = await sendFrames(deps, e, w.frames, w.decision);
    watchPlayback(deps, e, w.frames, w.decision, sent, true);
    if (noInputTimers.has(callSid)) armNoInput(deps, e, sent);
  }).catch((err: unknown) => deps.log(`${callSid}: saying the cut lines again failed: ${describe(err).message}`));
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
  /**
   * NO_INPUT_AFTER_SPEECH_MS: on a carrier that reports the caller's voice, the least a held no-input wait
   * runs after the caller stops speaking, for the transcript to arrive (resumeNoInput). Absent:
   * DEFAULT_NO_INPUT_AFTER_SPEECH_MS.
   */
  noInputAfterSpeechMs?: number;
  /**
   * RESUME_AFTER_PAUSE_MS and RESUME_INTO_REPLY_MS: on a carrier that reports the caller's voice, how soon
   * after their own pause, and after the reply going out, a caller coming back in had not finished
   * (followResumed). Absent: DEFAULT_RESUME_AFTER_PAUSE_MS, DEFAULT_RESUME_INTO_REPLY_MS.
   */
  resumeAfterPauseMs?: number;
  resumeIntoReplyMs?: number;
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
  /**
   * RESAY_CUT_LINES: a turn's lines the carrier cut short are said again (watchPlayback, below). Absent:
   * off. Active only on a carrier that reports its playback (VoiceProvider.readEvent).
   */
  resay?: ResaySettings;
  /**
   * BARGE_IN: who may talk over a line. With none or dtmf the text and clip frames sent say they are
   * not interruptible (channel/relay/frames.ts bargeInFrame). Absent: any, the lines' own flags.
   */
  bargeIn?: BargeIn;
  /**
   * END_AFTER_PLAYBACK: whether a turn that ends the call holds its `end` until the lines before it have
   * played (sendEndAfterPlayback). Absent: auto, held on a carrier that drops unsaid lines at `end`
   * (VoiceProvider.endDropsSpeech).
   */
  endAfterPlayback?: EndAfterPlayback;
  /** END_PLAYBACK_MAX_MS: the longest an `end` is held. Absent: DEFAULT_END_PLAYBACK_MAX_MS. */
  endPlaybackMaxMs?: number;
  /**
   * RESAY_SPURIOUS_INTERRUPTS and SPURIOUS_INTERRUPT_WINDOW_MS: a carrier's interrupt with no caller heard
   * around it is not the caller's, and the lines it cut are said again (a spurious interrupt, above).
   * Absent: off. The server sets it only where the carrier is asked to report the caller's voice (Telnyx
   * with TELNYX_EVENTS speaker-events), and it acts only on a call whose carrier reads its events.
   */
  spuriousInterrupts?: SpuriousInterruptSettings;
  /**
   * INCOMPLETE_WAIT_MS and INCOMPLETE_WAIT_BELOW: the reply to a final prompt the model reads as unfinished
   * is held for the caller to go on (a reply held, above). Absent: off; set, as spuriousInterrupts is.
   */
  incompleteWait?: IncompleteWaitSettings;
}

/** A spurious interrupt's setting: how recently before it the caller must have been heard for it to be theirs. */
export interface SpuriousInterruptSettings {
  windowMs: number;
}

/** A held reply's settings: the longest it is held, and the utteranceComplete reading under which it is (absent: the call's GATE_COMPLETE). */
export interface IncompleteWaitSettings {
  waitMs: number;
  below?: number;
}

/** How the adapter says again a line the carrier cut short (RESAY_CUT_LINES, RESAY_MIN_FRACTION). */
export interface ResaySettings {
  /** Under this fraction of the lines' estimated length (playbackEstimateMs), a finished playback was cut short. */
  minFraction: number;
}

/**
 * How long a playback that looks cut short must stay finished, with nothing more played and the caller
 * not heard, before its lines are said again: a carrier that reports a turn's lines one by one, stopping
 * between them, starts playing again within it, and a caller who answers at once is heard within it.
 */
export const RESAY_SETTLE_MS = 250;

/**
 * Hand one call moment to the dashboard. A missing bus (the dashboard is off) makes every
 * publishing site below a no-op, and a throwing subscriber is swallowed by the bus itself: a
 * watcher of a call can never change the call.
 */
function publish(deps: AdapterDeps, event: DashboardEvent): void {
  deps.bus?.publish(event);
}

/**
 * Write a frame-log line that is a delivery fact (dashboard/delivery.ts: a line said again, a join, a
 * held end), and hand the fact to the dashboard, which notes it under the line it concerns (view.js
 * DELIVERY_NOTES). A reload of the call reads the same fact back from the frame log.
 */
function logDelivery(deps: AdapterDeps, entry: CallEntry, msg: Record<string, unknown>): void {
  entry.frames.write('log', msg);
  const fact = deliveryFactOf(msg);
  if (fact) publish(deps, { type: 'delivery', callSid: entry.callSid, at: Date.now(), fact });
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

/** A text frame with the words the voice says another way respelled (channel/pronounce.ts); any other frame as it is. */
function respelled(frame: OutboundFrame, list: PronounceList | undefined): OutboundFrame {
  return frame.type === 'text' && list ? { ...frame, token: pronounce(frame.token, list) } : frame;
}

async function sendFrames(deps: AdapterDeps, entry: CallEntry, frames: OutboundFrame[], decision: unknown = null): Promise<OutboundFrame[]> {
  const log = deps.log;
  const timeoutMs = deps.sendTimeoutMs ?? SEND_TIMEOUT_MS;
  const sent: OutboundFrame[] = [];
  // Built from the session as it is now (its slots and readback) and the decision the frames say.
  const scrub = turnScrubber(entry.session, decision, 'length', appOf(entry.session));
  // A carrier that ends the reply at the first last: true gets it on the turn's final text frame only.
  const lastText = textLastOf(entry.provider) === 'final' ? frames.map((f) => f.type).lastIndexOf('text') : -1;
  const voice = appOf(entry.session).voice;
  // The words the voice says another way, for the language the lines are in (channel/pronounce.ts).
  const respell = pronounceFor(voice, localeOf(entry.session));
  for (const [i, original] of frames.entries()) {
    // Digits spelled out first, by rules written against the lines as written (a respelled lead word
    // still leads its digits), then the respellings. The frame log records what actually went out,
    // digit spacing and respellings and all, but with a redacted value masked before it is
    // respelled: masking finds the value as written, never a respelling of it.
    const spoken: OutboundFrame = original.type === 'text'
      ? { ...original, token: spokenDigits(original.token, voice?.spokenDigits), ...(lastText >= 0 && i !== lastText ? { last: false } : {}) }
      : original;
    const frame = bargeInFrame(respelled(spoken, respell), deps.bargeIn ?? 'any');
    const logged = bargeInFrame(respelled(loggedFrame(spoken, scrub), respell), deps.bargeIn ?? 'any');
    const socket = entry.socket;
    if (!socket) {
      log(`${entry.callSid}: no socket, dropped ${frame.type}`);
      entry.frames.write('log', { dropped: logged });
      continue;
    }
    try {
      await sendOne(socket, frame, timeoutMs);
      entry.frames.write('out', logged);
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
function queueService(deps: AdapterDeps, entry: CallEntry, effect: Effect, pending: PendingEffect): void {
  // Recorded with its key before it is sent: the turn that left it saved it with the call (turn, below;
  // SESSION_STORE=file), so a server that loads the call after a restart sends it again with the same
  // key (and its scrub). Sent after that save, since the request waits for the turn to finish.
  entry.pending = pending;
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

/** The request a turn leaves for a service, with its key and its scrub as data: what is saved with the call. */
function pendingOf(entry: CallEntry, effect: Effect): PendingEffect {
  return { effect, idempotencyKey: serviceIdempotencyKey(entry.session, effect), ...(scrubPartsOf(effect) ?? {}) };
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

/**
 * Run one turn and send what it decided. False when the turn threw (the apology was spoken instead).
 * `promptAtMs`, for a prompt, is when it came (a reply held for a caller not finished, holdReply).
 */
async function turn(deps: AdapterDeps, entry: CallEntry, event: SessionEvent, arrival?: Arrival, promptAtMs?: number): Promise<boolean> {
  let ending = false;
  // The turn's `end` waits for its lines to play, and is sent (with the grace after it) by the wait.
  let endHeld = false;
  try {
    // Through the call's Continuation: a final prompt that continues one whose reply the caller cut
    // off at once runs as the words joined, on the session from before the first of them.
    const run = await continuationOf(entry).run(entry.session, event, entry.opts, arrival);
    if (run.joined) logDelivery(deps, entry, { joined: run.joined.length });
    turnFailures.delete(entry.callSid);
    entry.session = run.result.session;
    // Kept on the call's own entry whether or not the console is on: the handoff summary reads it.
    entry.auditEntries.push(...run.audit);
    const kind = run.result.decision.kind;
    ending = kind === 'complete' || kind === 'handoff';
    // Work handed to a downstream service: recorded with its key now, so the save below holds it.
    const service = ending ? undefined : run.result.effects.find((e) => e.kind === 'service');
    const pending = service ? pendingOf(entry, service) : undefined;
    if (pending) entry.pending = pending;
    // Saved before what the turn says goes out (SESSION_STORE=file; nothing with the memory store), so a
    // restart after the caller heard a question resumes at that question.
    await deps.store.persist(entry.callSid);
    if (run.result.decision.kind === 'handoff') {
      publish(deps, { type: 'handoff', callSid: entry.callSid, at: Date.now(), reason: run.result.decision.reason, number: maskNumber(deps.handoffNumber) });
      fireHandoffSummary(deps, entry);
    }
    if (ending) publish(deps, { type: 'ended', callSid: entry.callSid, at: Date.now(), reason: kind === 'complete' ? 'completed' : 'handoff' });
    // Defensive: nothing can be armed here today, because whatever drove this turn cleared the
    // timer on its way in. Kept so a future path that arms and then ends cannot strand a timer.
    if (ending) clearNoInput(entry.callSid);
    // A reply to words the model reads as unfinished waits for the caller to go on (INCOMPLETE_WAIT_MS),
    // and is never said when they do: the next final prompt continues this one.
    const held = await holdReply(deps, entry, event, run, promptAtMs);
    const said = held !== 'speech' && held !== 'prompt';
    const frames = said ? actionsToFrames(run.result.actions) : [];
    // A carrier that acts on `end` at once drops the lines not yet said (END_AFTER_PLAYBACK): the
    // goodbye or the transfer line goes now, and the `end` once it has played.
    const at = ending && holdsEnd(deps, entry.provider) ? frames.findIndex((f) => f.type === 'end') : -1;
    const sentAtMs = Date.now();
    const sent = await sendFrames(deps, entry, at >= 0 ? frames.slice(0, at) : frames, run.result.decision);
    // A caller may come back in over the reply to a final prompt (a caller who had not finished).
    if (sent.some((f) => f.type === 'text' || f.type === 'play')) noteReply(entry, event, sentAtMs);
    if (at >= 0) {
      endHeld = sendEndAfterPlayback(deps, entry, frames.slice(at), sent, run.result.decision);
      if (!endHeld) sent.push(...(await sendFrames(deps, entry, frames.slice(at), run.result.decision)));
    }
    // Lines a carrier that reports its playback may cut short, said again if it does (RESAY_CUT_LINES).
    watchPlayback(deps, entry, frames, run.result.decision, sent, false);
    // Work handed to a downstream service: its answer is the next turn, and it arms the wait itself.
    if (service && pending) queueService(deps, entry, service, pending);
    // A prompt restarts the wait - including the silence turn's own re-ask, which is how the
    // ladder walks itself. So does anything that left the caller still owing an answer: an
    // ignored digit mid-slot, a barge-in, a relay error frame. Those produce no frames of their
    // own, so the wait is the bare `noInputMs` from the moment the frame arrived.
    else if (!ending && (kind === 'prompt' || entry.session.promptedFor !== null)) {
      // A reply held and not said: the prompt that went on arms the wait in its own turn; a caller only
      // heard going on is asked again soon after they stop, should no prompt come (holdReply).
      if (held === 'speech') armDue(deps, entry);
      else if (said) armNoInput(deps, entry, sent);
    }
    return true;
  } catch (err) {
    const info = describe(err);
    deps.log(`${entry.callSid}: turn failed: ${info.name}: ${info.message}`);
    entry.frames.write('log', { turnFailed: info });
    const failures = (turnFailures.get(entry.callSid) ?? 0) + 1;
    turnFailures.set(entry.callSid, failures);
    unwatch(entry.callSid);
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
      // closing here drops the completion (live call, error 64105). A held `end` arms it once sent.
      if (!endHeld) armEndGrace(deps, entry);
    }
  }
}

/** The type of a JSON message the relay wire does not know (a carrier's event), or null. */
export function carrierEventName(raw: string): string | null {
  try {
    const m: unknown = JSON.parse(raw);
    if (typeof m !== 'object' || m === null || Array.isArray(m)) return null;
    const t = (m as { type?: unknown }).type;
    if (typeof t !== 'string' || !/^[A-Za-z_.-]{1,40}$/.test(t)) return null;
    return isInboundFrameType(t) ? null : t;
  } catch {
    return null;
  }
}

/**
 * A refused message's shape for the log: its field names and the kind of each value, with only the
 * `type` value itself (a carrier's own word, never a caller's), so a carrier whose messages differ from
 * its documentation can be read from the log without one phone number or id written to it.
 */
export function messageShape(raw: string): string {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return `not JSON (${raw.length} chars)`;
  }
  const kind = (v: unknown): string => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return `array(${v.length})`;
    if (typeof v === 'object') return `{${Object.keys(v as object).slice(0, 20).join(',')}}`;
    if (typeof v === 'string') return `string(${v.length})`;
    return typeof v;
  };
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return kind(m);
  const fields = Object.entries(m as Record<string, unknown>).slice(0, 40).map(([k, v]) =>
    k === 'type' && typeof v === 'string' && /^[A-Za-z_.-]{1,40}$/.test(v) ? `type="${v}"` : `${k}:${kind(v)}`);
  return `{${fields.join(' ')}}`;
}

/** Handle one raw socket message for a connection. Safe to call concurrently; turns are serialized per call by the store. */
export async function handleSocketMessage(deps: AdapterDeps, socket: SocketLike, ctx: ConnectionContext, raw: string): Promise<void> {
  const parsed = parseInbound(raw);
  if (!parsed && carrierEventName(raw) !== null) {
    // A message of a type the relay wire does not know, from a carrier's optional event streams (Telnyx's
    // speaker-events, tokens-played): written to the call's frame log as it came, never acted on or counted
    // as malformed. Before a setup there is no call to write it to.
    // A carrier that reports its playback has it read into the engine's terms, for a line it cut short.
    const entry = ctx.callSid ? deps.store.get(ctx.callSid) : undefined;
    if (!entry) {
      deps.log(`unknown: carrier event before setup: ${messageShape(raw)}`);
      return;
    }
    const message = JSON.parse(raw) as unknown;
    entry.frames.write('in', { carrierEvent: message });
    // Read for a held `end` too (END_AFTER_PLAYBACK), which waits for the report that its lines played.
    const ev = playbackEventOf(ctx.provider, message);
    if (ev) {
      if (ev.kind === 'playback') reportsPlayback.add(entry.callSid);
      // The caller heard speaking holds the no-input wait, on any carrier whose provider reports it.
      else onCallerSpeech(deps, entry, ev.speaking);
      onHeldEndEvent(entry.callSid, ev);
      if (deps.resay) onPlaybackEvent(deps, entry, ev, deps.resay);
    }
    return;
  }
  if (!parsed) {
    ctx.malformed += 1;
    deps.log(`${ctx.callSid ?? 'unknown'}: malformed inbound message (${ctx.malformed}): ${messageShape(raw)}`);
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
    const callId = setupCallIdOf(ctx.provider, parsed);
    if (!ctx.token || !deps.tokens.verify(ctx.token, callId, ctx.provider)) {
      deps.log(`${callId}: setup refused, bad token`);
      await sendOne(socket, endFrame('unauthorized'), deps.sendTimeoutMs ?? SEND_TIMEOUT_MS).catch(() => undefined);
      socket.close(1008, 'unauthorized');
      return;
    }
    ctx.callSid = callId;
    // A call this server does not hold may have been saved by the one before it (SESSION_STORE=file): a
    // planned restart's handover answered its carrier's callback there, so its socket comes here with no
    // callback first. Loaded, it resumes; one saved in a shape this server cannot read is ended toward a
    // person (the carrier's callback with that handoff dials HANDOFF_NUMBER), never begun again as a new
    // call. With the memory store there is never one to load.
    if (deps.store.get(callId) === undefined && deps.store.durable) {
      const loaded = await deps.store.restore(callId, ctx.provider);
      if (loaded === 'unreadable') {
        await sendOne(socket, endFrame('unreadable'), deps.sendTimeoutMs ?? SEND_TIMEOUT_MS).catch(() => undefined);
        deps.tokens.revoke(callId);
        return;
      }
    }
    const existing = deps.store.get(callId);
    if (existing) {
      // Masked at write time, not only when the dashboard reads it back: the setup frame carries
      // the caller's whole number, and the file on disk must never hold it either.
      existing.frames.write('in', redactDeep(parsed));
      if (existing.ended) {
        deps.log(`${callId}: setup for an ended call, closing`);
        socket.close(1000, 'call ended');
        return;
      }
      // The wait the old connection was counting down no longer means anything. The replay below
      // starts a fresh one; this clear is what covers a reconnect with no prompt to replay yet.
      clearNoInput(callId);
      // Nor do the lines it was playing, or what it heard of the caller.
      unwatch(callId);
      callerSpeaking.delete(callId);
      forgetResumed(callId);
      settleHeard(callId);
      releaseReply(callId, 'sent');
      const previous = existing.socket;
      if (previous && previous !== socket) {
        // Twilio reconnected before the old socket's close reached us; retire it explicitly so
        // nothing is written to two sockets for one call.
        deps.log(`${callId}: reconnect replaced a live socket`);
        existing.frames.write('log', { replacedSocket: true });
        previous.close(1000, 'replaced by reconnect');
      }
      const entry = deps.store.attach(callId, socket) ?? existing;
      // A call loaded from the session store after a restart (SESSION_STORE=file): its caller heard
      // nothing for a moment, and is told so before the question is asked again.
      const restarted = deps.store.takeRestored(callId);
      entry.frames.write('log', { resumed: true, sessionId: parsed.sessionId, ...(restarted ? { afterRestart: true } : {}) });
      if (restarted) deps.log(`${callId}: resumed after a restart`);
      publish(deps, { type: 'reconnect', callSid: callId, at: Date.now(), attempt: entry.reconnects });
      await deps.store.enqueue(callId, async (e) => {
        // The caller hears the question again, so nothing said before the drop is continued (replay
        // resets at the repeated setup too). In the queue, after the turns before it.
        continuations.get(callId)?.reset();
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
    const entry = deps.store.create(callId, socket, ctx.provider);
    entry.frames.write('in', redactDeep(parsed));
    // The call's window for a caller who had not finished, once, for replay (harness-text/replay.ts),
    // which joins where this call does by it; a log without the line is one that never joined.
    const within = continueWithinMsOf(appOf(entry.session));
    continuations.set(callId, new Continuation(within));
    if (within > 0) entry.frames.write('log', { continueWithinMs: within });
    // Ahead of the greeting turn, and it is what resets the bus's history: the page follows this call now.
    publish(deps, {
      type: 'call_started', callSid: callId, at: Date.now(),
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
    await enqueueUnsettled(deps, callId, async (e) => {
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
  // A final prompt from a caller who came back in over the last reply continues the one before it;
  // logged ahead of the prompt's own line, where replay reads it. Then this prompt's speech is the one followed.
  if (frame.type === 'prompt' && frame.last && !entry.ended) {
    takeResumed(deps, entry);
    notePrompt(deps, entry);
  }
  entry.frames.write('in', logged);
  if (entry.ended) {
    deps.log(`${ctx.callSid}: ${frame.type} after end, ignored`);
    return;
  }
  // The caller is audibly there, so the no-input wait is over - before any of the early returns
  // below, because a partial prompt or a bare `#` is still a caller who is not silent.
  if (frame.type === 'prompt' || frame.type === 'dtmf' || frame.type === 'interrupt') {
    clearNoInput(ctx.callSid);
    // Nor is a line the carrier stopped playing then one to say again, nor an interrupt settling one the caller did not make.
    callerHeard(ctx.callSid);
  }
  // A reply held for a caller not finished: more words are the caller going on; a key sends it now.
  if (frame.type === 'prompt') releaseReply(ctx.callSid, 'prompt');
  else if (frame.type === 'dtmf') releaseReply(ctx.callSid, 'sent');
  // Before the ignore/turn split below: a digit the adapter drops is still a digit the caller pressed.
  if (logged.type === 'dtmf') publish(deps, { type: 'dtmf', callSid: ctx.callSid, at: Date.now(), digit: logged.digit });
  if (frame.type === 'interrupt') {
    // Our line as written, as the turn will record it (run/turn.ts): the carrier echoes the respellings it was sent.
    const heard = unpronounce(frame.utteranceUntilInterrupt, pronounceFor(appOf(entry.session).voice, localeOf(entry.session)));
    publish(deps, { type: 'interrupt', callSid: ctx.callSid, at: Date.now(), utteranceUntilInterrupt: heard });
    // Whether it was the caller's is decided below (a spurious interrupt), and is a fact of its own.
    publish(deps, { type: 'delivery', callSid: ctx.callSid, at: Date.now(), fact: interruptFact(frame.durationUntilInterruptMs) });
  }
  // The slots have fixed digit lengths, so the keypad terminators carry no meaning yet.
  if (frame.type === 'dtmf' && (frame.digit === '#' || frame.digit === '*')) {
    entry.frames.write('log', { ignoredDigit: frame.digit });
    // A key pressed ends a caller's unfinished words: through the queue, after the turns before it.
    void deps.store.enqueue(ctx.callSid, async () => continuations.get(ctx.callSid!)?.reset());
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
  const arrivedAtMs = Date.now();
  // An interrupt with no caller heard around it settles before it is taken (a spurious interrupt), and the
  // lines it cut, as they are watched now, are said again when no caller is heard in that time either.
  const unheard = event.type === 'user.interrupt' ? interruptUnheard(deps, entry) : null;
  const settled = event.type === 'user.interrupt' && unheard ? settleInterrupt(deps, entry, event.afterMs, unheard.quietMs) : null;
  const cutLines = settled ? watched.get(ctx.callSid) : undefined;
  const run = async (e: CallEntry): Promise<void> => {
    if (settled && event.type === 'user.interrupt' && (await settled)) {
      await recoverSpurious(deps, e, cutLines, event.afterMs);
      return;
    }
    // Whether a digit keyed ahead is taken is only known now, as its turn runs. Taken, it is not
    // sensitive where it lands, so the log keeps its value for replay; one line either way, in the
    // order the digits run, which is the order they arrived (the store runs a call's turns in order).
    if (event.type === 'user.key' && arrival.sensitive === 'ahead') {
      const taken = digitAtRun(e.session, event, arrivalContext(e.session, event, arrival)) === null;
      e.frames.write('log', taken ? { aheadAccepted: event.digit } : { aheadIgnored: true });
    }
    await turn(deps, e, event, arrival, arrivedAtMs);
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
  unwatch(ctx.callSid);
  callerSpeaking.delete(ctx.callSid);
  forgetResumed(ctx.callSid);
  settleHeard(ctx.callSid);
  releaseReply(ctx.callSid, 'sent');
  // A held `end` has no one left to hear its lines: it is not sent (the call already ended for the store).
  heldEnds.get(ctx.callSid)?.release('closed');
  entry.frames.write('log', { socketClosed: true, ended: entry.ended });
  deps.store.detach(ctx.callSid);
}
