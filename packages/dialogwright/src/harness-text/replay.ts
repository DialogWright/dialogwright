import { readFrameLog, type ReadFrameLogLine } from '../server/frameLog';
import { promptEpoch, sensitiveDigitAt } from '../core/turn';
import { parseInbound } from '../channel/relay/wire';
import { newSession, type Session } from '../core/session';
import { CODE_DIGIT, type Arrival, type RunOptions, type TurnRun } from '../run/turn';
import type { TraceRecord } from '../trace/types';
import { frameToEvent } from '../channel/relay/map';
import { serviceResultEvent, keyEvents, silenceEvent, type ServiceResult, type SessionEvent } from '../channel/events';
import { VOICE_RELAY } from '../channel/caps';
import { appOf, defaultAppId, getApp } from '../core/app/registry';
import { Continuation, MAX_CONTINUE_WITHIN_MS } from '../run/continuation';

export interface ReplayResult {
  runs: TurnRun[];
  records: TraceRecord[];
  skipped: string[];
}

function rawType(msg: unknown): string {
  return typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string'
    ? (msg as { type: string }).type
    : 'message';
}

/**
 * `parseInbound` never accepts `{ type: 'silence' }`: a silence frame is server-generated
 * (the no-input timer), never sent over the wire, so the wire parser keeps rejecting it. A
 * recorded frame log is our own trusted output, though -- the adapter logs the silence frame it
 * synthesized the same as any other inbound message -- so replay special-cases the exact shape
 * here rather than loosening parseInbound itself.
 */
function isRecordedSilence(msg: unknown): boolean {
  return typeof msg === 'object' && msg !== null && Object.keys(msg).length === 1 && (msg as { type?: unknown }).type === 'silence';
}

/**
 * A carrier's own event as the adapter logged it, `{ carrierEvent: ... }` (server/adapter.ts): its report
 * of its playback or of the caller's voice (TELNYX_EVENTS), never a turn. What the adapter did with one
 * (a cut line said again, RESAY_CUT_LINES) is outbound only, so replay passes over it as nothing to run.
 */
function isCarrierEvent(msg: unknown): boolean {
  return typeof msg === 'object' && msg !== null && Object.keys(msg).length === 1 && 'carrierEvent' in msg;
}

/**
 * A downstream service's answer as the adapter logged it: `{ type: 'service_result', service, result }`.
 * Like silence it is server-made and parseInbound refuses it off the wire, so replay reads our own
 * log's line here. The result goes through the service's own check again (ServiceDef.fromLog: a
 * hand-edited log gets no further than the service's reply would have); one that fails replays as no
 * answer. A service the session's app does not have is not a line replay can read.
 */
function recordedServiceResult(msg: unknown, session: Session | null): ServiceResult | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as { type?: unknown; service?: unknown; result?: unknown };
  if (m.type !== 'service_result' || typeof m.service !== 'string' || !('result' in m)) return null;
  // Before setup there is no session yet; a replayed session is the default app's (newSession below).
  const service = (session ? appOf(session) : getApp(defaultAppId())).services?.[m.service];
  if (!service) return null;
  return serviceResultEvent(m.service, service.fromLog(m.result));
}

/**
 * What replay keys for a digit of the one-time code when the app does not say
 * (App.testing.replay.codeDigit). The adapter logs each one masked (CODE_DIGIT), so the code itself
 * is never in the log and cannot be replayed; the app names a digit its verifier accepts, so that
 * a replayed call that failed the code on the wire passes it here.
 */
const DEFAULT_CODE_DIGIT = '0';

/** A keypad digit masked by the adapter: `{ type: 'dtmf', digit: '•' }`. */
function isRecordedMaskedDigit(msg: unknown): boolean {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as { type?: unknown; digit?: unknown };
  return Object.keys(m).length === 2 && m.type === 'dtmf' && m.digit === CODE_DIGIT;
}

/**
 * The digit to key for a masked one, decided by where the replayed session stands, as the adapter
 * decided to mask it by where the live one stood. At an identity question (App.testing.replay
 * .identityKeys, by slot) it is the app's own identity, digit by digit at the position the slot's
 * keypad buffer has reached: the adapter masks those digits as it masks the code, so the identity
 * the caller keyed is not in the log, and a recorded call that keyed another identity, or a wrong
 * one, replays as the app's verifying. Spoken identity is in the log as spoken (the transcript is
 * kept), so a spoken one replays as it was. At the code prompt (or anywhere else, which only a
 * prompt that moved under the digit could produce) it is the app's code digit.
 */
function unmaskedDigit(session: Session | null): string {
  const replay = (session ? appOf(session) : getApp(defaultAppId())).testing?.replay;
  const at = session?.promptedFor;
  const keys = at && replay?.identityKeys && Object.hasOwn(replay.identityKeys, at) ? replay.identityKeys[at]! : null;
  if (session && keys !== null) return keys[session.dtmfBuffer.length % keys.length]!;
  return replay?.codeDigit ?? DEFAULT_CODE_DIGIT;
}

/**
 * The adapter's arrival decisions that replay cannot rebuild from the session it replays: a frame
 * that arrived while a downstream service's answer was awaited, and a digit keyed ahead of a question
 * still being decided. The adapter writes them as a `log` line directly after the frame's own `in`
 * line (server/adapter.ts arrivalFlags); null when the next line is not one.
 */
function arrivalFlags(next: ReadFrameLogLine | undefined): { duringService: boolean; ahead: boolean; keyedAt?: Session['promptedFor'] } | null {
  if (!next || next.dir !== 'log' || typeof next.msg !== 'object' || next.msg === null) return null;
  const m = next.msg as { ignoredDuringService?: unknown; keyedAhead?: unknown; keyedAt?: unknown };
  const duringService = m.ignoredDuringService === true;
  const ahead = m.keyedAhead === true;
  const keyedAt = typeof m.keyedAt === 'string' || m.keyedAt === null ? { keyedAt: m.keyedAt as Session['promptedFor'] } : {};
  return duringService || ahead || 'keyedAt' in keyedAt ? { duringService, ahead, ...keyedAt } : null;
}

/**
 * What became of each digit keyed ahead, in the order they ran, which is the order they arrived:
 * the digit when it was taken (`{ aheadAccepted: '1' }`), null when it was not (`{ aheadIgnored:
 * true }`). The adapter logs one as each such digit's turn starts (server/adapter.ts), which can be
 * well after the digit's own line, so replay reads them all first. A log from before these lines
 * has none, and its digits keyed ahead replay as ignored, as they then were.
 */
function aheadOutcomes(lines: readonly ReadFrameLogLine[]): (string | null)[] {
  const out: (string | null)[] = [];
  for (const line of lines) {
    if (line.dir !== 'log' || typeof line.msg !== 'object' || line.msg === null) continue;
    const m = line.msg as { aheadAccepted?: unknown; aheadIgnored?: unknown };
    if (typeof m.aheadAccepted === 'string' && /^\d$/.test(m.aheadAccepted)) out.push(m.aheadAccepted);
    else if (m.aheadIgnored === true) out.push(null);
  }
  return out;
}

/**
 * The live call's window for a caller who had not finished (voice.continueWithinMs), as the adapter
 * logged it when the call started: `{ continueWithinMs: 300 }`. A log without one is of a call that
 * never joined (the option off, or a log from before it), and replays as that call ran: 0. Replay
 * follows the log rather than the app as it is now, so a call replays as it was taken.
 */
function loggedContinueWithinMs(lines: readonly ReadFrameLogLine[]): number {
  for (const line of lines) {
    if (line.dir !== 'log' || typeof line.msg !== 'object' || line.msg === null) continue;
    const ms = (line.msg as { continueWithinMs?: unknown }).continueWithinMs;
    if (typeof ms === 'number' && Number.isInteger(ms) && ms >= 0 && ms <= MAX_CONTINUE_WITHIN_MS) return ms;
  }
  return 0;
}

/** The adapter gave up on a downstream service's answer (server/adapter.ts queueService). */
function isServiceWaitAbandoned(line: ReadFrameLogLine): boolean {
  if (line.dir !== 'log' || typeof line.msg !== 'object' || line.msg === null) return false;
  return (line.msg as { serviceWaitAbandoned?: unknown }).serviceWaitAbandoned === true;
}

/** One inbound frame ready to run, as the core's event, with what replay knows of its arrival. */
interface Pending {
  event: SessionEvent;
  /** The frame's wire type, for what is skipped. */
  type: string;
  lineMs: number;
  lineNumber: number;
  arrival: Arrival | undefined;
}

/**
 * Feed every inbound message of a recorded call through runTurn, in order, exactly as the
 * adapter did: non-final prompts are skipped, a repeated setup (reconnect) is skipped, `#`/`*` DTMF
 * digits are skipped since the adapter logs them as `in` before dropping them, and everything
 * after the call ends is skipped and reported rather than fed to a dead session. A carrier's own
 * events (`{ carrierEvent }`) are passed over without a word: they are its reports, never a turn, and a
 * line the adapter said again on one (RESAY_CUT_LINES) is outbound only. A line with a
 * missing or unparsable `ts` is skipped and reported rather than throwing or driving the clock
 * with `NaN`. The arrival decisions the adapter logged (arrivalFlags) are honored, and a frame that
 * arrived during the service wait runs after the service's answer, as it did live. Every turn runs
 * through one Continuation with the window the log names (loggedContinueWithinMs), as the adapter ran
 * the live call's, so the final prompts of a caller who had not finished are joined where they were.
 *
 * Each turn runs with the clock and default date the recording actually happened under: `now`
 * returns the frame line's own timestamp, and `todayIso` is the setup line's date unless the
 * caller overrides it. `opts.todayIso` is never the date a turn runs under -- RunOptions requires
 * one, and the recording's own date is the honest answer -- so the override has a name of its own
 * rather than shadowing a field the caller has already had to fill in.
 */
export async function replayFrameLog(
  path: string,
  opts: RunOptions,
  onRun?: (run: TurnRun) => void,
  options?: { todayIsoOverride?: string },
): Promise<ReplayResult> {
  const skipped: string[] = [];
  const lines = readFrameLog(path, (lineNumber) => skipped.push(`line ${lineNumber}: unparsable`));
  const runs: TurnRun[] = [];
  let session: Session | null = null;
  let setupDate: string | null = null;
  let ended = false;
  /** Frames that arrived during the service wait, run once the service's answer has (see below). */
  const deferred: Pending[] = [];
  // Every turn through one Continuation, as the adapter runs the live call's (run/continuation.ts).
  const continuation = new Continuation(loggedContinueWithinMs(lines));
  const run = async (p: Pending): Promise<void> => {
    const turnOpts: RunOptions = { ...opts, now: () => p.lineMs, todayIso: options?.todayIsoOverride ?? setupDate! };
    try {
      const r = await continuation.run(session!, p.event, turnOpts, p.arrival);
      session = r.result.session;
      runs.push(r);
      onRun?.(r);
      if (session.ended) ended = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      skipped.push(`line ${p.lineNumber}: turn failed: ${message}`);
    }
  };
  const ahead = aheadOutcomes(lines);
  const flushDeferred = async (): Promise<void> => {
    for (const d of deferred.splice(0)) {
      if (ended) skipped.push(`line ${d.lineNumber}: ${d.type} after the call ended`);
      else await run(d);
    }
  };
  for (const [index, line] of lines.entries()) {
    // Live, the wait is given up without a turn of its own: the session simply stops awaiting the
    // answer, and what was said meanwhile, queued behind it, then runs (and is ignored, as said
    // during the wait).
    // (`session` is assigned in `run` too, which the compiler does not follow; hence the cast.)
    const current = session as Session | null;
    if (isServiceWaitAbandoned(line) && current && !ended) {
      session = { ...current, pendingService: null };
      await flushDeferred();
      continue;
    }
    if (line.dir !== 'in') continue;
    if (isCarrierEvent(line.msg)) continue;
    const lineNumber = line.line;
    const lineMs = typeof line.ts === 'string' ? Date.parse(line.ts) : NaN;
    if (Number.isNaN(lineMs)) {
      skipped.push(`line ${lineNumber}: missing or invalid ts`);
      continue;
    }
    if (ended) {
      skipped.push(`line ${lineNumber}: ${rawType(line.msg)} after the call ended`);
      continue;
    }
    // A wire message is read as the adapter read it (parseInbound, then frameToEvent); the
    // server-made lines of our own log are read here.
    const frame = parseInbound(JSON.stringify(line.msg));
    let event: SessionEvent | null = frame ? frameToEvent(frame)
      : isRecordedSilence(line.msg) ? silenceEvent() : isRecordedMaskedDigit(line.msg) ? keyEvents(unmaskedDigit(session))[0]! : recordedServiceResult(line.msg, session);
    if (!event) {
      skipped.push(`line ${lineNumber}: unrecognized message`);
      continue;
    }
    const type = rawType(line.msg);
    if (frame?.type === 'setup') {
      if (session) {
        skipped.push(`line ${lineNumber}: setup for ${frame.callSid} after the session started`);
        // A reconnect: the adapter asks the question again, and continues nothing said before the drop.
        continuation.reset();
        continue;
      }
      setupDate = line.ts.slice(0, 10);
      session = newSession(frame.callSid, lineMs, VOICE_RELAY);
    }
    if (!session) {
      skipped.push(`line ${lineNumber}: ${type} before setup`);
      continue;
    }
    // The adapter logs every inbound frame before deciding to ignore it; `#`/`*` digits are
    // dropped there without ever reaching runTurn, so replay must drop them too.
    // It ends a caller's unfinished words there too (the adapter resets its Continuation behind the turns before it).
    if (event.type === 'user.key' && (event.digit === '#' || event.digit === '*')) {
      continuation.reset();
      continue;
    }
    // The adapter logs a non-final prompt and waits for the final one rather than running a turn
    // on half an utterance; replaying it would invent a turn the call never had.
    if (event.type === 'user.speech' && !event.final) {
      skipped.push(`line ${lineNumber}: non-final prompt`);
      continue;
    }
    // Otherwise runTurn decides the arrival from the replayed session, as the adapter did live.
    const flags = arrivalFlags(lines[index + 1]);
    let arrival: Arrival | undefined;
    if (flags) {
      const at = flags.keyedAt !== undefined ? flags.keyedAt : session.promptedFor;
      const decided: Arrival = { sensitive: flags.ahead ? 'ahead' : sensitiveDigitAt(appOf(session), at, event), duringService: flags.duringService, promptedFor: at };
      arrival = decided;
      // A digit keyed ahead that was taken runs as the digit it was, against the replayed session's
      // own epoch: live, no prompt was spoken between its arrival and its turn. One that was not
      // taken carries no epoch, and runs as ignored.
      if (flags.ahead && event.type === 'user.key') {
        const taken = ahead.shift() ?? null;
        if (taken !== null) {
          event = keyEvents(taken)[0]!;
          arrival = { ...decided, epoch: promptEpoch(session) };
        }
      }
    }
    const pending: Pending = { event, type, lineMs, lineNumber, arrival };
    // Live, a frame that arrived during the service wait was queued behind the service's answer, so
    // its turn ran after the answer's even though its line is logged before the answer's.
    if (flags?.duringService && session.pendingService !== null) {
      deferred.push(pending);
      continue;
    }
    await run(pending);
    if (event.type === 'service.result') await flushDeferred();
  }
  for (const d of deferred) skipped.push(`line ${d.lineNumber}: ${d.type} during a downstream service's wait that never ended`);
  return { runs, records: runs.map((r) => r.record), skipped };
}
