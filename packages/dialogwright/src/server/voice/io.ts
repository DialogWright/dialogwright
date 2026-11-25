import type { EndFrame, OutboundFrame } from '../../channel/relay/frames';
import { serializeOutbound } from '../../channel/relay/wire';
import { playbackEstimateMs } from '../../channel/relay/playback';
import { DEFAULT_END_PLAYBACK_FACTOR, DEFAULT_END_PLAYBACK_MARGIN_MS, DEFAULT_END_PLAYBACK_MAX_MS, END_PLAYBACK_LEAD_MS } from '../../channel/voiceProviders';
import { endDropsSpeechOf, textLastOf } from './registry';
import type { PlaybackEvent } from './provider';
import type { AnyCallEntry, SessionStore, SocketLike } from '../sessions';
import type { DashboardEvent } from '../dashboard/events';
import { deliveryFactOf } from '../dashboard/delivery';
import { parseHandoff } from '../transfer';
import type { AdapterDeps } from '../adapter';

/**
 * A voice call's I/O on this server, whichever runtime takes its turns: its frames sent on the socket
 * (the spacing a carrier that joins a turn's lines needs, the send timeout, the frame log), its `end` held
 * until the lines before it have played where the carrier drops what it has not said (END_AFTER_PLAYBACK),
 * the console's events, its save, and its end here (the store, the token, the close grace). Moved out of
 * server/adapter.ts as it was: the scripted turn-taking stays there and reaches the socket through this.
 * It reads only the call's transport (CallEntryBase), never a runtime's state.
 */

/**
 * How long one outbound frame may sit in the socket's write queue before the send is abandoned.
 * `ws` only invokes the write callback when the frame is actually flushed, so a peer that stops
 * reading (a half-open TCP connection Twilio never closes) would otherwise park a turn forever
 * and, with it, everything queued behind it for that call.
 */
export const SEND_TIMEOUT_MS = 5_000;

/**
 * After sending `end`, Twilio still has to play the queued frames before it closes the socket
 * itself. If it never does (a bug on either side, or a call that never really reached Twilio),
 * this is the backstop before we close it ourselves so the connection doesn't leak forever.
 */
export const END_CLOSE_GRACE_MS = 30_000;

/**
 * How long a playback that looks cut short must stay finished, with nothing more played and the caller
 * not heard, before its lines are said again: a carrier that reports a turn's lines one by one, stopping
 * between them, starts playing again within it, and a caller who answers at once is heard within it.
 */
export const RESAY_SETTLE_MS = 250;

/** What a call's I/O is given: the store, the tokens and the server's settings for sending and for a held `end`. */
export type AdapterTransportDeps = Pick<
  AdapterDeps,
  'store' | 'tokens' | 'log' | 'sendTimeoutMs' | 'endCloseGraceMs' | 'bus' | 'clipDurations' | 'endAfterPlayback' | 'endPlaybackMaxMs' | 'endPlaybackFactor' | 'endPlaybackMarginMs'
>;

/** Grace timers armed after `end`, keyed by call SID, so the socket's close event can cancel the backstop. */
const endGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * How a held `end` (END_AFTER_PLAYBACK) came to go, as the frame log's `endAfter` says it: the carrier
 * reported the lines played; their estimate passed on a call whose carrier reports nothing; the ceiling
 * passed (the estimate and a margin with no report, or END_PLAYBACK_MAX_MS); or the socket closed first
 * (the caller hung up), and no `end` was sent.
 */
export type EndAfter = 'played' | 'estimate' | 'timeout' | 'closed';

/** How a wait for lines to play (VoiceIo.holdEnd) ended, how long it held, and the lines' estimate. */
export interface HeldEndResult {
  after: EndAfter;
  heldMs: number;
  expectedMs: number;
}

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
 * held `end` waits for the report, up to a multiple of the estimate and a margin; on any other call the
 * estimate is all there is to go by.
 */
const reportsPlayback = new Set<string>();

/**
 * Each held `end`'s whole send (the wait, then the frame), by call, with the call it is for: what a
 * stopping server waits for (heldEndsOf).
 */
const endSends = new Map<string, { entry: AnyCallEntry; done: Promise<void> }>();

/**
 * The held `end`s (END_AFTER_PLAYBACK) of the calls `store` holds, each settled once its `end` has gone or
 * its socket closed first. Such a call has ended for the store, but its goodbye or transfer line is still
 * playing: a stopping server waits for it as for a live call (index.ts drain and close), or its caller
 * loses the line, and a transfer its `end`.
 */
export function heldEndsOf(store: Pick<SessionStore, 'getAny'>): Promise<void>[] {
  return [...endSends].filter(([callSid, s]) => store.getAny(callSid) === s.entry).map(([, s]) => s.done);
}

/** A call's held `end`, if any, let go unsent: no one is left to hear its lines (the socket closed, the call forgotten). */
export function releaseHeldEnd(callSid: string): void {
  heldEnds.get(callSid)?.release('closed');
}

/** A call's carrier's playback reports forgotten (the call forgotten). */
export function forgetPlaybackReports(callSid: string): void {
  reportsPlayback.delete(callSid);
}

/** The end-close backstop of a call cancelled: its socket has closed. */
export function cancelEndGrace(callSid: string): void {
  const timer = endGraceTimers.get(callSid);
  if (timer) {
    clearTimeout(timer);
    endGraceTimers.delete(callSid);
  }
}

/**
 * Hand one call moment to the dashboard. A missing bus (the dashboard is off) makes every
 * publishing site a no-op, and a throwing subscriber is swallowed by the bus itself: a
 * watcher of a call can never change the call.
 */
export function publish(deps: Pick<AdapterTransportDeps, 'bus'>, event: DashboardEvent): void {
  deps.bus?.publish(event);
}

/**
 * Write a frame-log line that is a delivery fact (dashboard/delivery.ts: a line said again, a join, a
 * held end), and hand the fact to the dashboard, which notes it under the line it concerns (view.js
 * DELIVERY_NOTES). A reload of the call reads the same fact back from the frame log.
 */
export function logDelivery(deps: Pick<AdapterTransportDeps, 'bus'>, entry: AnyCallEntry, msg: Record<string, unknown>): void {
  entry.frames.write('log', msg);
  const fact = deliveryFactOf(msg);
  if (fact) publish(deps, { type: 'delivery', callSid: entry.callSid, at: Date.now(), fact });
}

export function describe(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
  return { name: 'NonError', message: String(err) };
}

/** Seconds for the log: `0.67 s`. */
export function seconds(ms: number, digits: number): string {
  return `${(ms / 1000).toFixed(digits)} s`;
}

/** Words compared as a carrier reports them back: whitespace folded. */
export function folded(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function sendOne(socket: SocketLike, frame: OutboundFrame, timeoutMs: number): Promise<void> {
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

/** A line the carrier runs into the next one, ending with a space (VoiceIo.sendShaped). */
const spaced = (token: string, joined: boolean): string => (joined && !/\s$/.test(token) ? `${token} ` : token);

/**
 * What a runtime makes of each frame it sends (VoiceIo.sendShaped), around the spacing the io gives a
 * line its carrier runs into the next: absent, a frame goes and is logged as it is.
 */
export interface FrameShape {
  /** A frame's words before the spacing (the scripted adapter: digits spelled out). */
  words?(frame: OutboundFrame): OutboundFrame;
  /** The spaced frame as it goes on the wire, and as the frame log records it. */
  wire?(spoken: OutboundFrame): { frame: OutboundFrame; logged: OutboundFrame };
  /** Told of each frame once it is on the wire. */
  sent?(frame: OutboundFrame): void;
}

/** A call's I/O (voiceIoOf). */
export interface VoiceIo {
  /** Sends frames on the call's socket, as the adapter did (textLast spacing, timeout, the frame log); false when not delivered. */
  send(frames: readonly OutboundFrame[]): Promise<boolean>;
  /**
   * Sends the call's end, held until the lines before it have played where the carrier needs it
   * (END_AFTER_PLAYBACK): `said`, else the frames the last send delivered. A held end ends the call here
   * itself (the store, the token, the close grace once sent), so a `finish` after it does nothing more.
   */
  sendEnd(end: EndFrame, said?: readonly OutboundFrame[]): Promise<void>;
  /** Logs a frame in or out in the call's frame log. */
  record(dir: 'in' | 'out', message: unknown): void;
  /** Publishes a console event for the call. */
  publish(event: DashboardEvent): void;
  /** Saves the call (SessionStore.persist). */
  save(): Promise<void>;
  /**
   * Ends the call on this server, once: the store's end and the token revoked (where this server still
   * holds the call), the close grace armed (unless `grace: false`, for an `end` still held, whose send
   * arms it).
   */
  finish(o?: { readonly grace?: boolean }): Promise<void>;
  /** Hands the io a carrier's playback event, for the held end (the adapter's onHeldEndEvent). */
  playback(event: PlaybackEvent): void;

  // The scripted adapter's: the same transport, with its own shaping of each frame and its own sends.
  /**
   * Send frames in order, and return the ones that actually reached the wire, rewritten exactly as they
   * were sent. A frame is logged `out` only once it is actually on the wire; a frame with no socket is
   * logged as dropped. A send failure detaches the socket and the remaining frames are dropped.
   */
  sendShaped(frames: readonly OutboundFrame[], shape?: FrameShape): Promise<OutboundFrame[]>;
  /** A delivery fact in the frame log and on the console (logDelivery). */
  logDelivery(msg: Record<string, unknown>): void;
  /** Whether this server may end the call (holds, below). */
  holds(): boolean;
  /** Whether the call's `end` is held until its lines have played: END_AFTER_PLAYBACK, auto by the carrier. */
  holdsEnd(): boolean;
  /** The wait until lines just sent (`sent`) have played (holdEnd, below). */
  holdEnd(sent: readonly OutboundFrame[]): Promise<HeldEndResult>;
  /**
   * Send `end` (the `end` frame and anything after it) by `send` once `sent` has played; false, having
   * sent nothing, when no line went out or the socket is gone (sendEndAfterPlayback, below).
   */
  endAfterPlayback(end: OutboundFrame[], sent: readonly OutboundFrame[], send: (frames: OutboundFrame[]) => Promise<OutboundFrame[]>): boolean;
  /** The end-close backstop armed (armEndGrace, below). */
  armEndGrace(): void;
}

/** Each call's io, made once for its entry. */
const ios = new WeakMap<AnyCallEntry, { deps: AdapterTransportDeps; io: VoiceIo }>();

/** The I/O of the call `entry` holds, on this server's `deps`. */
export function voiceIoOf(entry: AnyCallEntry, deps: AdapterTransportDeps): VoiceIo {
  const made = ios.get(entry);
  if (made && made.deps === deps) return made.io;
  const io = makeVoiceIo(entry, deps);
  ios.set(entry, { deps, io });
  return io;
}

function makeVoiceIo(entry: AnyCallEntry, deps: AdapterTransportDeps): VoiceIo {
  let finished = false;
  let lastSent: readonly OutboundFrame[] = [];

  /**
   * Whether this server may end the call `entry` is for: always with the memory and file stores; with a
   * store many servers share, only while it still holds the call (a turn that outlived its hold, the call
   * since taken over by another server, ends nothing and revokes no token the other minted).
   */
  const holds = (): boolean => !deps.store.shared || deps.store.getAny(entry.callSid) === entry;

  const sendShaped = async (frames: readonly OutboundFrame[], shape: FrameShape = {}): Promise<OutboundFrame[]> => {
    const log = deps.log;
    const timeoutMs = deps.sendTimeoutMs ?? SEND_TIMEOUT_MS;
    const sent: OutboundFrame[] = [];
    // A carrier that ends the reply at the first last: true gets it on the turn's final text frame only.
    const lastText = textLastOf(entry.provider) === 'final' ? frames.map((f) => f.type).lastIndexOf('text') : -1;
    for (const [i, original] of frames.entries()) {
      // Such a carrier joins the turn's text frames into one utterance as sent, so a line before the
      // last ends with a space: without it "outage." ran into "What's", which a voice read as "outage
      // dot what's" (Telnyx, seen on a live call).
      const joined = lastText >= 0 && i !== lastText;
      const said = shape.words ? shape.words(original) : original;
      const spoken: OutboundFrame = said.type === 'text'
        ? { ...said, token: spaced(said.token, joined), ...(joined ? { last: false } : {}) }
        : said;
      const { frame, logged } = shape.wire ? shape.wire(spoken) : { frame: spoken, logged: spoken };
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
        shape.sent?.(frame);
      } catch (err) {
        const info = describe(err);
        log(`${entry.callSid}: send failed for ${frame.type}: ${info.name}: ${info.message}`);
        entry.frames.write('log', { sendFailed: frame.type, error: info });
        // The socket is unusable; drop it so the rest of this decision and later turns are logged
        // as dropped rather than failing one by one.
        if (entry.socket === socket) entry.socket = null;
      }
    }
    lastSent = sent;
    return sent;
  };

  /** Whether a call's `end` is held until its lines have played: END_AFTER_PLAYBACK, auto by the carrier. */
  const holdsEnd = (): boolean => {
    const mode = deps.endAfterPlayback ?? 'auto';
    return mode === 'on' || (mode === 'auto' && endDropsSpeechOf(entry.provider));
  };

  /**
   * Wait until the lines a turn that ends the call just sent (`sent`) have played: until the carrier reports
   * the last of them played (or stopped, and stayed stopped for RESAY_SETTLE_MS, after it started), else
   * until the ceiling. On a call whose carrier reports its playback, the report is what ends the wait, and
   * the ceiling is only an outer limit for a report that never comes: the lines' estimate
   * (playbackEstimateMs, as for the no-input wait) times END_PLAYBACK_FACTOR, plus END_PLAYBACK_MARGIN_MS,
   * so a voice slower than the estimate is not cut (seen on a live call, 2026-10-13: at the estimate and 2 s
   * the goodbye was still playing). On a call that reports nothing the estimate is all there is: the
   * estimate and END_PLAYBACK_LEAD_MS. Never more than END_PLAYBACK_MAX_MS. A socket close meanwhile ends
   * the wait as `closed` (the adapter's handleSocketClose, releaseHeldEnd).
   */
  const holdEnd = (sent: readonly OutboundFrame[]): Promise<HeldEndResult> => {
    const callSid = entry.callSid;
    const said = sent.filter((f) => f.type === 'text' || f.type === 'play');
    const expectedMs = playbackEstimateMs(said, deps.clipDurations ?? new Map());
    const reported = reportsPlayback.has(callSid);
    const wanted = reported
      ? Math.round(expectedMs * (deps.endPlaybackFactor ?? DEFAULT_END_PLAYBACK_FACTOR)) + (deps.endPlaybackMarginMs ?? DEFAULT_END_PLAYBACK_MARGIN_MS)
      : expectedMs + END_PLAYBACK_LEAD_MS;
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
  };

  /** A carrier's report of its playback, for a call whose `end` is held (holdEnd). */
  const onHeldEndEvent = (ev: PlaybackEvent): void => {
    const held = heldEnds.get(entry.callSid);
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
  };

  /**
   * After `end`, Twilio plays the queued frames and closes the socket itself; closing it here would drop
   * the completion (live call, error 64105). The backstop closes it after END_CLOSE_GRACE_MS if the
   * carrier never does; the socket's close cancels it.
   */
  const armEndGrace = (): void => {
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
  };

  /**
   * Send a turn's `end` frame (`end`, with anything after it) once the lines before it have played
   * (holdEnd), with the end-close grace after it as for any `end`. The call is ended first, in the store
   * and for its token, so a socket that closes during the wait is a call that ended, never one to
   * reconnect (http.ts decideAction), and a turn queued behind this one says nothing. A transfer's `end`
   * keeps its handoff data on the call until it is sent (CallEntry.heldHandoffData): a socket that closes
   * first with the caller still on the line is put through all the same. Not awaited by the
   * turn: the call's queue has nothing more to run, and a carrier's report must reach the wait meanwhile.
   * Null, having sent nothing, when no line went out or the socket is gone: there is nothing to wait for.
   */
  const sendEndAfterPlayback = (end: OutboundFrame[], sent: readonly OutboundFrame[], send: (frames: OutboundFrame[]) => Promise<OutboundFrame[]>): Promise<void> | null => {
    if (entry.socket === null || !sent.some((f) => f.type === 'text' || f.type === 'play')) return null;
    const callSid = entry.callSid;
    // A transfer still owed should the socket close first with the caller on the line (http.ts decideAction).
    const handoffData = end.find((f) => f.type === 'end')?.handoffData;
    // With a store many servers share, only a server that still holds the call ends it.
    if (holds()) {
      // With a durable store the transfer is saved with the call until it is sent, so whichever server the
      // carrier's callback reaches puts the caller through (SessionStore.endHolding); a goodbye is not owed.
      if (handoffData !== undefined && deps.store.durable && isTransfer(handoffData)) deps.store.endHolding(callSid, handoffData);
      else deps.store.end(callSid);
      deps.tokens.revoke(callSid);
    }
    if (handoffData !== undefined) entry.heldHandoffData = handoffData;
    const done: Promise<void> = holdEnd(sent)
      .then(async ({ after, heldMs, expectedMs }) => {
        logDelivery(deps, entry, { endAfter: after, endHeldMs: heldMs, expectedMs });
        if (after === 'closed') return;
        if (after === 'timeout' && reportsPlayback.has(callSid)) {
          deps.log(`${callSid}: end sent after ${seconds(heldMs, 2)} with no report the lines finished (~${seconds(expectedMs, 1)} estimated)`);
        }
        const out = await send(end);
        if (out.some((f) => f.type === 'end')) {
          entry.heldHandoffData = null;
          deps.store.heldSent(callSid);
        }
        armEndGrace();
      })
      .catch((err: unknown) => deps.log(`${callSid}: sending the held end failed: ${describe(err).message}`))
      .finally(() => {
        if (endSends.get(callSid)?.done === done) endSends.delete(callSid);
      });
    endSends.set(callSid, { entry, done });
    return done;
  };

  return {
    async send(frames) {
      const sent = await sendShaped(frames);
      return sent.length === frames.length;
    },
    async sendEnd(end, said = lastSent) {
      const held = holdsEnd() ? sendEndAfterPlayback([end], said, (frames) => sendShaped(frames)) : null;
      if (held === null) {
        await sendShaped([end]);
        return;
      }
      // The call has ended here, and its grace is armed once the `end` is sent.
      finished = true;
      await held;
    },
    record(dir, message) {
      entry.frames.write(dir, message);
    },
    publish(event) {
      publish(deps, event);
    },
    save() {
      return deps.store.persist(entry.callSid);
    },
    finish(o = {}) {
      if (!finished) {
        finished = true;
        if (holds()) {
          deps.store.end(entry.callSid);
          deps.tokens.revoke(entry.callSid);
        }
        // Twilio closes the socket after it has played the queued frames and processed `end`;
        // closing here drops the completion (live call, error 64105). A held `end` arms it once sent.
        if (o.grace !== false) armEndGrace();
      }
      return Promise.resolve();
    },
    playback(ev) {
      if (ev.kind === 'playback') reportsPlayback.add(entry.callSid);
      onHeldEndEvent(ev);
    },
    sendShaped,
    logDelivery(msg) {
      logDelivery(deps, entry, msg);
    },
    holds,
    holdsEnd,
    holdEnd,
    endAfterPlayback(end, sent, send) {
      return sendEndAfterPlayback(end, sent, send) !== null;
    },
    armEndGrace,
  };
}

/** Whether an `end`'s handoff puts the caller through (a goodbye's does not). */
function isTransfer(handoffData: string): boolean {
  try {
    return parseHandoff(handoffData).reasonCode !== 'completed';
  } catch {
    return true;
  }
}
