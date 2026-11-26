import type { ConverseApp } from '../../converse/app';
import { lineOn } from '../../converse/business/schema';
import { accountOf } from '../../converse/sources/accounts';
import { speakableOn } from '../../converse/speakable';
import { businessZone, type ConverseState } from '../../converse/state';
import { ConverseTurnError, converseTurn, lineSaid, READ_BACK_HEARD_AT, type ConverseDeps, type Heard, type Input, type Out } from '../../converse/turn';
import { E164 } from '../../core/numberLocales';
import { localDateIso } from '../../core/localDate';
import { endFrame, textFrame, type EndFrame, type InboundFrame, type OutboundFrame, type TextFrame } from '../../channel/relay/frames';
import { textEstimateMs } from '../../channel/playbackEstimate';
import { readsPlaybackEvents } from './registry';
import type { PlaybackEvent } from './provider';
import type { VoiceIo } from './io';
import type { ConverseCallEntry } from '../sessions';

/**
 * An agent app's phone call (docs/designs/2026-11-11-agent-runtime.md, "The conversation loop" and "Settled
 * after the builder's review" items 4 and 5): each call a ConverseState, each turn converseTurn, its words sent
 * to the carrier on the call's io (server/voice/io.ts) as the chat runtime sends them on the chat wire
 * (server/chat/converseRuntime.ts). The adapter (server/adapter.ts) hands a converse call's setup, frames,
 * carrier events, socket close and reconnect here before any scripted code runs; the http callback hands it
 * the caller's hangup.
 *
 * - Sending. On a call the turn makes every line speakable before it is said (converse/speakable.ts: a range in
 *   words, a screen's list as speech, the caller's last four digit by digit), so the text sent, the text kept and
 *   a read-back's text waiting for the yes are the same, and what the carrier reports played is compared with them
 *   as sent; the line this runtime says itself after a turn threw is made speakable here.
 *   Each piece of the model's reply goes out as it is said: a sentence as a text frame with
 *   `last: false` (with a space after it, as the carrier joins the pieces), the reply's last piece with
 *   `last: true`, every one interruptible by speech (the converse line always is: plan ruling 2). The bridge
 *   (lines.bridge) goes whole, not interruptible. The call's end follows the turn that ended it: the closing
 *   end, or the handoff's transfer end where agent.yaml names a transfer number (the completed end where it
 *   names none), held for the lines before it where the carrier needs it (VoiceIo.sendEnd), never awaited
 *   in the call's queue (a carrier's playback report must reach the wait meanwhile).
 * - One turn at a time, on the call's queue. A final prompt while a turn runs stops it (converseTurn's
 *   `signal`) and is the next turn, so a recognizer that ended the caller's words early is one turn on both
 *   texts (the model is sent them as one message). Speech over the bridge stops nothing: it is the next turn.
 * - What was heard, given with each of the caller's turns (Input's `heard`): whether they cut in on the last
 *   reply, what of it they heard (Twilio's `utteranceUntilInterrupt`, the `tokensPlayed` text Telnyx reported
 *   since it began, else the sentences whose estimated playback ended before they began to speak), and
 *   whether they began to speak before it began. Twilio's `interrupt` is a cut-in; on Telnyx only the caller
 *   heard speaking (`clientSpeaking: on`) while the line plays, or before the reply's last line is reported
 *   played, is, never an `interrupt` alone (Telnyx sends them with no caller speaking). Where the carrier
 *   reports its playback, the caller began before the reply unless it reported the reply begun first: its
 *   events' order is not trusted to fail open (clientSpeaking has come before agentSpeaking on).
 * - Keys are logged and otherwise ignored (plan ruling 5); a partial prompt only marks when the caller began.
 * - A correction from the check after speaking is said once the reply has played, and dropped where the
 *   caller began to speak first (the next turn is then told they heard none of it).
 * - The frame log keeps each line as the trace keeps it (each value the records mask, masked), written at the
 *   turn's end; an `end` by its reason and the actions done.
 * - Saved after every turn, and before a caller's turn with its words (ConverseCallEntry.turnWords): a server
 *   that resumes the call asks the model again on them, and a change the caller confirmed is not done twice
 *   (its idempotency key). A socket that closes stops the turn running, which is asked again when the carrier
 *   reconnects unless a change it confirmed ran (then nothing is said, as on any reconnect).
 * - Each end is recorded in the audit as `call_ended` (completed, handoff, hangup), and in the frame log as
 *   `{ ended }` (closing, handoff, caller), as a converse chat's is.
 * - The server's hooks, as on a converse chat: `onTurnEnd` once a turn has sent all it says (its correction
 *   included), `onClaimsRead` with what the check after speaking read.
 */

/** What the converse voice runtime is given. */
export interface ConverseVoiceDeps {
  /** The agent apps this server runs, by id. */
  apps: ReadonlyMap<string, ConverseApp>;
  /** A turn's dependencies for a call in `app` (the model, the decision model, the audit, the tools); its trace is the call's own. */
  converseDeps: (app: ConverseApp, callId: string) => ConverseDeps;
  now: () => number;
  /** The call's turn queue (SessionStore.enqueueConverse); absent, the runtime chains on the entry's tail itself. */
  enqueue?: (entry: ConverseCallEntry, fn: (entry: ConverseCallEntry) => Promise<void>) => Promise<void>;
  log?: (line: string) => void;
  /**
   * Called once a turn (the greeting, the caller's words, a turn asked again) has sent all it says: its reply,
   * and its correction where one waited for the reply to play (said or dropped). As a converse chat's (chat
   * runtime's `onTurnEnd`): the simulated callers' driver ends a reply on it. A hook that throws is logged.
   * Absent on a deployment.
   */
  onTurnEnd?: (callId: string) => void;
  /** Called with what the check after speaking was sent for a reply and what it read (ConverseDeps.onClaimsRead), as a converse chat's. Absent on a deployment. */
  onClaimsRead?: ConverseDeps['onClaimsRead'];
}

export interface ConverseVoiceRuntime {
  /** Whether `appId` is one of this runtime's apps: a call in it is a converse call. */
  serves(appId: string): boolean;
  /** The call's setup: the state's caller number and account, then the greeting turn. */
  open(entry: ConverseCallEntry, setup: { callerNumber: string | null; provider: string }, io: VoiceIo): Promise<void>;
  /** A relay frame from the carrier: prompt, interrupt, dtmf or error. */
  frame(entry: ConverseCallEntry, frame: InboundFrame, io: VoiceIo): Promise<void>;
  /** A carrier playback event (Telnyx's agentSpeaking, clientSpeaking, tokensPlayed). */
  playback(entry: ConverseCallEntry, event: PlaybackEvent, io: VoiceIo): void;
  /**
   * A carrier's event as the frame log keeps it: a report of a line played (tokensPlayed) says the line as it was
   * sent, so its text is masked as the trace masked the line (the call's turns' maskings), or by its length while
   * a turn is running (the line may be that turn's, whose masking comes at its end) or none has been given yet.
   */
  loggedEvent(entry: ConverseCallEntry, message: unknown, event: PlaybackEvent | null): unknown;
  /** The call's socket closed: the turn running is stopped, to be asked again should the carrier reconnect. */
  closed(entry: ConverseCallEntry): void;
  /** A socket replaced after the carrier reconnected: a turn cut by the drop is asked again. */
  resumed(entry: ConverseCallEntry, io: VoiceIo): Promise<void>;
  /** The lines and `end` a turn ended the call with while it had no socket (CallEntryBase.undelivered), sent on this one, once. */
  replay(entry: ConverseCallEntry, io: VoiceIo): Promise<void>;
  /** The caller hung up (the carrier's callback): a running turn stopped, the left turn run, its audit row. */
  hangup(entry: ConverseCallEntry): Promise<void>;
  /** What the runtime keeps of a call beside its state, forgotten (the call evicted): a correction waiting is dropped. */
  forget(callSid: string): void;
}

/** A line the reply said, as sent, and when. */
interface Sent {
  text: string;
  at: number;
}

/** The line's last reply to the caller, as the channel knows it was played. */
interface Reply {
  /** Its text frames as sent, in order (never the bridge). */
  frames: Sent[];
  /** The bridge said with it, folded, so its report is not taken for the reply's. */
  bridge: string | null;
  /** The text the carrier reported played since it began (Telnyx's tokensPlayed). */
  played: string;
  /** What Twilio's interrupt said was spoken of it. */
  interrupted: string | null;
  /** The caller spoke over it while it played. */
  cutIn: boolean;
  /** A correction after it was dropped, the caller having begun to speak: they heard none of it. */
  unheard: boolean;
  /**
   * Its held read-back (said again after the caller spoke over it before hearing it, not interruptible: Out.say's
   * `held`), its last frame; null: it holds none. Speech that begins before it has played is ignored (heldEnd).
   */
  held: Sent | null;
  /** When the carrier reported the held read-back played (Telnyx's tokensPlayed); null: not yet, or no report. */
  heldPlayedAt: number | null;
  /**
   * The carrier reported it begun before the caller began to speak: a playback start after its first line was
   * sent, or a report of its own words played. Where the carrier reports its playback, a caller with no such
   * report spoke before it (fail closed on the events' order: Telnyx has sent clientSpeaking before agentSpeaking on).
   */
  began: boolean;
}

/** The turn running on a call. */
interface Running {
  ac: AbortController;
  /** Settles once the turn's work is all done (its state kept, its end sent or saved). */
  done: Promise<void>;
  /** The bridge was said this turn. */
  bridged: boolean;
  /** Stopped because the socket closed: asked again when the carrier reconnects. */
  dropped: boolean;
}

/** A correction from the check after speaking, waiting for the reply before it to play. */
interface Correction {
  pieces: string[];
  /** The reply it corrects: a later reply (or a turn begun) drops it. */
  after: Reply;
  scrub: ((text: string) => string) | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Told once the correction is said or dropped: its turn's end (ConverseVoiceDeps.onTurnEnd). */
  settled: () => void;
}

/** What the runtime keeps of a call beside its saved state: never saved. */
interface Live {
  io: VoiceIo | null;
  running: Running | null;
  reply: Reply | null;
  /** When the caller's speech since their last final words began (a partial prompt, clientSpeaking on); null: not yet. */
  speechAt: number | null;
  /** The carrier is playing the line's words (Telnyx's agentSpeaking). */
  agentSpeaking: boolean;
  /** The carrier reports its playback on this call: one of its playback events (a line played, the caller heard speaking) came. */
  reports: boolean;
  /**
   * A turn ended without giving its masking (it threw) after saying lines: a carrier's report of what played is
   * kept by its length from then on, as the line may be that turn's.
   */
  unmasked: boolean;
  correction: Correction | null;
  /** The caller's final words counted so far: a turn queued for earlier words than the latest runs already stopped (superseded). */
  generation: number;
  /** How the trace masked what the line said, turn by turn (the latest last, a few kept): what a carrier's report of a line is masked by. */
  scrubs: ((text: string) => string)[];
  /** The caller's utterances ignored over a held read-back since the last turn, each by its length: told to the next turn (Input's `ignored`). */
  ignored: number[];
}

/** The turns' maskings kept for a carrier's reports of what played. */
const SCRUBS_KEPT = 8;

/** A piece that runs into the next on the carrier ends with a space. */
const spaced = (text: string): string => (/\s$/.test(text) ? text : `${text} `);

/** Words compared as a carrier reports them back: whitespace folded. */
const folded = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Text pieces joined with a space between them. */
const joined = (a: string, b: string): string => (a === '' ? b : `${a}${/\s$/.test(a) ? '' : ' '}${b}`);

const newReply = (): Reply => ({ frames: [], bridge: null, played: '', interrupted: null, cutIn: false, unheard: false, began: false, held: null, heldPlayedAt: null });

/** When the reply's held read-back is estimated to begin playing: when it was sent, or once the lines before it have played. */
function heldStart(r: Reply): number | null {
  let t: number | null = null;
  for (const f of r.frames) {
    const start = Math.max(t ?? f.at, f.at);
    if (f === r.held) return start;
    t = start + textEstimateMs(f.text);
  }
  return null;
}

/** When the reply's lines are estimated to have played, from when each was sent; null: none was. */
function estimatedEnd(r: Reply): number | null {
  let t: number | null = null;
  for (const f of r.frames) t = Math.max(t ?? f.at, f.at) + textEstimateMs(f.text);
  return t;
}

/** The reply's sentences whose estimated playback ended by `atMs`. */
function estimatedHeard(r: Reply, atMs: number): string {
  let t: number | null = null;
  let heard = '';
  for (const f of r.frames) {
    t = Math.max(t ?? f.at, f.at) + textEstimateMs(f.text);
    if (t > atMs) break;
    heard += f.text;
  }
  return heard;
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** A text frame as the frame log keeps it: its words masked as the trace masks them, or by their length where the turn gave no masking. */
function loggedText(frame: TextFrame, scrub: ((text: string) => string) | null): TextFrame {
  return { ...frame, token: scrub === null ? `<${frame.token.length} chars>` : scrub(frame.token) };
}

/** An `end` as the frame log keeps it: its reason and the actions done, nothing else of its handoff. */
function loggedEnd(frame: OutboundFrame): OutboundFrame {
  if (frame.type !== 'end') return frame;
  let reasonCode: unknown = 'unknown';
  let completed: unknown;
  try {
    const data = JSON.parse(frame.handoffData) as { reasonCode?: unknown; completed?: unknown };
    reasonCode = data.reasonCode;
    completed = data.completed;
  } catch {
    // Not JSON: logged as an end of no known reason.
  }
  const shown = { reasonCode: typeof reasonCode === 'string' ? reasonCode : 'unknown', ...(Array.isArray(completed) ? { completed: completed.filter((c) => typeof c === 'string') } : {}) };
  return { type: 'end', handoffData: JSON.stringify(shown) };
}

/** An inbound frame as the frame log keeps it: what an interrupt says of the line by its length (the line may say a masked value). */
function loggedIn(frame: InboundFrame): InboundFrame {
  return frame.type === 'interrupt' ? { ...frame, utteranceUntilInterrupt: `<${frame.utteranceUntilInterrupt.length} chars>` } : frame;
}

/** A turn's Out that says nothing (the caller has left). */
const SILENT: Out = { say() {}, end() {} };

export function converseVoiceRuntime(deps: ConverseVoiceDeps): ConverseVoiceRuntime {
  const { now } = deps;
  const log = deps.log ?? (() => {});
  const lives = new Map<string, Live>();

  const liveOf = (e: ConverseCallEntry): Live => {
    let l = lives.get(e.callSid);
    if (l === undefined) {
      l = { io: null, running: null, reply: null, speechAt: null, agentSpeaking: false, reports: false, unmasked: false, correction: null, generation: 0, scrubs: [], ignored: [] };
      lives.set(e.callSid, l);
    }
    return l;
  };

  const appOf = (e: ConverseCallEntry): ConverseApp => {
    const app = deps.apps.get(e.session.appId);
    if (app === undefined) throw new Error(`${e.callSid}: "${e.session.appId}" is not an agent app this server runs`);
    return app;
  };

  /** A turn's dependencies: the app's, each trace record written to the call's own trace. */
  const turnDeps = (app: ConverseApp, e: ConverseCallEntry): ConverseDeps => ({ ...deps.converseDeps(app, e.callSid), trace: (r) => e.trace.write(r), ...(claimsRead !== undefined ? { onClaimsRead: claimsRead } : {}) });

  /** A turn's end told (deps.onTurnEnd); a hook that throws is logged, never the call's failure. */
  const turnEnded = (callId: string): void => {
    if (deps.onTurnEnd === undefined) return;
    try {
      deps.onTurnEnd(callId);
    } catch (err) {
      log(`${callId}: the turn's end hook failed: ${describe(err)}`);
    }
  };

  /** The check's input told (deps.onClaimsRead); a hook that throws is logged, never the call's failure. */
  const claimsRead: ConverseDeps['onClaimsRead'] = deps.onClaimsRead === undefined ? undefined : (callId, read) => {
    try {
      deps.onClaimsRead!(callId, read);
    } catch (err) {
      log(`${callId}: the check's input hook failed: ${describe(err)}`);
    }
  };

  const enqueue = (e: ConverseCallEntry, fn: (e: ConverseCallEntry) => Promise<void>): Promise<void> => {
    if (deps.enqueue !== undefined) return deps.enqueue(e, fn);
    const run = e.tail.then(() => (e.ended ? undefined : fn(e))).catch((err: unknown) => log(`${e.callSid}: converse turn failed: ${describe(err)}`));
    e.tail = run;
    return run;
  };

  /** The call's end in its app's audit (call_ended), as a converse chat's is. */
  const audited = (app: ConverseApp, callId: string, reason: string): void => {
    try {
      const r = deps.converseDeps(app, callId).audit.append(callId, 'voice', { type: 'call_ended', detail: { reason } });
      if (r instanceof Promise) r.catch((err: unknown) => log(`${callId}: the end's audit entry failed: ${describe(err)}`));
    } catch (err) {
      log(`${callId}: the end's audit entry failed: ${describe(err)}`);
    }
  };

  /** Whether what plays is the bridge alone: said this turn, and nothing of the reply yet. Speech over it is the next turn. */
  const overBridge = (l: Live): boolean => l.running !== null && l.running.bridged && (l.reply?.frames.length ?? 0) === 0;

  /** A correction waiting is dropped: the caller began to speak, or a turn began. The next turn is told they heard none of it. */
  const dropCorrection = (l: Live): void => {
    const c = l.correction;
    if (c === null) return;
    if (c.timer !== null) clearTimeout(c.timer);
    l.correction = null;
    c.after.unheard = true;
    c.settled();
  };

  /** What the caller heard of the line's last reply as they finished speaking (`atMs`), or undefined where there is no reply. */
  const heardOf = (l: Live, atMs: number): Heard | undefined => {
    const r = l.reply;
    if (r === null) return undefined;
    if (r.unheard) return { cutIn: false, text: null, spokeBefore: true };
    const first = r.frames[0]?.at;
    // Where the carrier reports its playback, the caller spoke before the reply unless it reported the reply begun first.
    const spokeBefore = first === undefined || (l.reports ? !r.began : l.speechAt !== null && l.speechAt < first);
    const text = r.interrupted ?? (l.reports ? r.played : estimatedHeard(r, l.speechAt ?? atMs));
    return { cutIn: r.cutIn, text, spokeBefore };
  };

  /**
   * When the last reply's held read-back counts as played, or null where it holds none: with the carrier's playback reports
   * (Telnyx), its report that the line played, else (not yet reported) twice its estimate and two seconds from when it
   * began, a ceiling, as a correction waits; with none (Twilio, which reports nothing of a line's playback), when
   * READ_BACK_HEARD_AT of its estimate has played: an estimate a little long would otherwise ignore a caller who waited
   * for the end of a voice faster than it, and one who begins past that point has heard what a yes needs heard.
   */
  const heldEnd = (l: Live): number | null => {
    const r = l.reply;
    if (r === null || r.held === null) return null;
    if (r.heldPlayedAt !== null) return r.heldPlayedAt;
    const start = heldStart(r) ?? r.held.at;
    const estimate = textEstimateMs(r.held.text);
    return l.reports ? start + estimate * 2 + 2000 : start + READ_BACK_HEARD_AT * estimate;
  };

  /** Whether a held read-back plays now: speech over it is no cut-in, and stops nothing. */
  const holding = (l: Live): boolean => {
    const end = heldEnd(l);
    return end !== null && now() < end;
  };

  /** The caller spoke over the line: the reply playing is cut in on (not the bridge alone, nor a held read-back), and the turn running is stopped. */
  const cutIn = (l: Live, interrupted?: string): void => {
    l.speechAt ??= now();
    dropCorrection(l);
    if (overBridge(l) || holding(l)) return;
    const r = l.reply;
    if (r !== null && r.frames.length > 0) {
      r.cutIn = true;
      if (interrupted !== undefined) r.interrupted = interrupted;
    }
    l.running?.ac.abort();
  };

  /** Sends a waiting correction once the reply before it has played, unless the caller has begun to speak or a turn has begun. */
  const sayCorrection = (l: Live, c: Correction): void => {
    if (l.correction !== c) return;
    if (c.timer !== null) clearTimeout(c.timer);
    l.correction = null;
    const io = l.io;
    if (l.speechAt !== null || l.running !== null || l.reply !== c.after || io === null) {
      c.after.unheard = true;
      c.settled();
      return;
    }
    const reply = newReply();
    l.reply = reply;
    const frames = c.pieces.map((p, i) => {
      const last = i === c.pieces.length - 1;
      const token = last ? p : spaced(p);
      reply.frames.push({ text: token, at: now() });
      return { ...textFrame(token, true), last };
    });
    void io.send(frames, { logged: (f) => (f.type === 'text' ? loggedText(f, c.scrub) : f) })
      .catch((err: unknown) => log(`correction not sent: ${describe(err)}`))
      .finally(c.settled);
  };

  /** Whether the carrier reported the reply's last line played. */
  const playedOut = (r: Reply): boolean => {
    const last = r.frames.at(-1);
    return last !== undefined && folded(r.played).endsWith(folded(last.text));
  };

  /** Whether the line has sent a reply whose last line the carrier has not reported played: it may be playing. */
  const unplayed = (r: Reply | null): boolean => r !== null && r.frames.length > 0 && !playedOut(r);

  /** A correction armed: said once the reply has played (the carrier's report, else its estimate; with reports, the estimate twice and two seconds as a ceiling). */
  const armCorrection = (l: Live, c: Correction): void => {
    l.correction = c;
    if (l.reports && playedOut(c.after)) return sayCorrection(l, c);
    const end = estimatedEnd(c.after) ?? now();
    const estimateMs = Math.max(0, end - now());
    const waitMs = l.reports ? estimateMs * 2 + 2000 : estimateMs;
    c.timer = setTimeout(() => sayCorrection(l, c), waitMs);
    c.timer.unref?.();
  };

  /**
   * One turn, run now (in the call's queue): its words sent as they are said, its state kept, the call ended
   * where it ended it, else saved.
   */
  const runNow = async (e: ConverseCallEntry, input: Input, io: VoiceIo, generation?: number): Promise<void> => {
    if (e.session.ended !== undefined) return;
    const app = appOf(e);
    const l = liveOf(e);
    l.io = io;
    dropCorrection(l);
    let settle!: () => void;
    const running: Running = { ac: new AbortController(), done: new Promise<void>((r) => (settle = r)), bridged: false, dropped: false };
    // Running from here: a final prompt, a cut-in or the hangup reaches it even while its words are saved.
    // (Stopped before the turn begins, the turn still runs, at once stopped: the caller's words are kept.)
    const reply = newReply();
    l.reply = reply;
    l.running = running;
    // Words the caller went on from before this turn began (a later final prompt): it runs already stopped,
    // so its words are kept in the conversation and the latest turn answers them all at once.
    if (generation !== undefined && generation < l.generation) running.ac.abort();
    // The turn's end is told here, or by the correction it leaves waiting once that is said or dropped.
    let endTold = false;
    try {
      const before = e.session;
      const words = input.kind === 'text' ? input.text : null;
      if (words !== null) {
        e.turnWords = words;
        // What the caller had heard as they said them: a turn asked again is told the same (a yes over a read-back heard in part stays one).
        if (input.kind === 'text' && input.heard !== undefined) e.turnHeard = input.heard;
        else delete e.turnHeard;
        await io.save();
      }
      /** Each frame sent this turn, in order, with whether it reached the wire. */
      const sent: { frame: TextFrame; delivered: Promise<boolean> }[] = [];
      let chain: Promise<unknown> = Promise.resolve();
      const send = (frame: TextFrame): void => {
        const delivered = chain.then(() => io.send([frame], { logged: () => null })).catch(() => false);
        chain = delivered;
        sent.push({ frame, delivered });
      };
      let finalSent = false;
      // A change the caller confirmed ran this turn, and the caller has heard no reply after it (the turn's own
      // rule, Out.replied: a fixed line or a read-back said after it does not count).
      let changeRan = false;
      const correction: string[] = [];
      let scrub: ((text: string) => string) | null = null;
      const out: Out = {
        say(text, final, held) {
          // After the reply's final piece, the check after speaking's correction: said once the reply has played.
          if (finalSent) {
            correction.push(text);
            return;
          }
          const token = final ? text : spaced(text);
          const sentNow: Sent = { text: token, at: now() };
          reply.frames.push(sentNow);
          // A held read-back goes whole, not interruptible: speech over it is ignored (finalWords), never a cut-in.
          if (held === true) reply.held = sentNow;
          if (final) finalSent = true;
          send({ ...textFrame(token, held !== true), last: final });
        },
        // The end is read from the state the turn returns (ConverseState.ended).
        end() {},
        scrubbed(s) {
          scrub = s;
        },
        confirmed() {
          changeRan = true;
        },
        replied() {
          changeRan = false;
        },
        bridge(text) {
          running.bridged = true;
          reply.bridge = folded(text);
          send(textFrame(text, false));
        },
      };
      let state: ConverseState = before;
      try {
        state = await converseTurn(before, input, turnDeps(app, e), out, running.ac.signal);
      } catch (thrown) {
        const err = thrown instanceof ConverseTurnError ? thrown.cause : thrown;
        log(`${e.callSid}: converse turn failed: ${describe(err)}`);
        io.record('log', { turnFailed: describe(err) });
        // Where a change the caller confirmed ran, the call goes on from as far as the turn reached, so the change
        // is never read back or answered again; else from before the turn.
        if (thrown instanceof ConverseTurnError && (thrown.state.done?.length ?? 0) > (before.done?.length ?? 0)) {
          // The kept state moves on past the turn, as a turn that ends does (its record below holds its index).
          state = { ...thrown.state, turnIndex: thrown.state.turnIndex + 1 };
        }
        // The caller is not left in silence, unless the turn was stopped (the caller spoke, or left) or had already
        // sent its final reply: the done line where a change the caller confirmed has just run (as the turn's own
        // failure says it), else the business's recovery line.
        let line: string | null = null;
        if (!running.ac.signal.aborted && !finalSent) {
          line = speakableOn(state, lineOn(changeRan ? app.business.lines.done : app.business.lines.recovery, 'voice'));
          if (state !== before) lineSaid(state, line);
          reply.frames.push({ text: line, at: now() });
          finalSent = true;
          send({ ...textFrame(line, true), last: true });
        }
        // The turn's trace record, as far as it reached, with the line said after it: the turn is in the console as
        // it is in the audit. A trace that cannot be written is logged, never the call's failure.
        if (thrown instanceof ConverseTurnError && thrown.record !== null) {
          try {
            e.trace.write({ ...thrown.record, replies: [...thrown.record.replies, ...(line !== null ? [line] : [])] });
          } catch (traceErr) {
            log(`${e.callSid}: the failed turn's trace record could not be written: ${describe(traceErr)}`);
          }
        }
      } finally {
        // The turn's masking kept before it lets go of the call: a carrier's report of its line from here on is
        // masked by it (while it runs, such a report is kept by its length).
        const given = scrub as ((text: string) => string) | null;
        if (given !== null) l.scrubs = [...l.scrubs, given].slice(-SCRUBS_KEPT);
        else if (reply.frames.length > 0) l.unmasked = true;
        l.running = null;
      }
      await chain;
      // The frame log keeps each line as the trace keeps it: each value the records mask, masked.
      const masked = scrub as ((text: string) => string) | null;
      for (const s of sent) if (await s.delivered) io.record('out', loggedText(s.frame, masked));
      // Stopped as its socket closed, with no change the caller confirmed having run: the call goes on from
      // before it, and its words are asked again when the carrier reconnects.
      if (running.dropped && (state.done?.length ?? 0) === (before.done?.length ?? 0)) {
        e.session = before;
        await io.save();
        return;
      }
      e.session = state;
      delete e.turnWords;
      delete e.turnHeard;
      const ended = state.ended;
      if (ended === 'closing' || ended === 'handoff') {
        endCall(e, app, ended, sent.map((s) => s.frame), io);
        return;
      }
      if (correction.length > 0) {
        endTold = true;
        armCorrection(l, { pieces: correction, after: reply, scrub: masked, timer: null, settled: () => turnEnded(e.callSid) });
      }
      await io.save();
    } finally {
      settle();
      if (!endTold) turnEnded(e.callSid);
    }
  };

  /** The call ended by its turn: the audit's row, the console told, the `end` sent once the lines before it have played (or kept for the next socket). */
  const endCall = (e: ConverseCallEntry, app: ConverseApp, ended: 'closing' | 'handoff', lines: readonly OutboundFrame[], io: VoiceIo): void => {
    const reason = ended === 'closing' ? 'completed' : 'handoff';
    audited(app, e.callSid, reason);
    // How the call ended, in the frame log as a converse chat's (the console's Calls page reads it: view.js converseRow).
    io.record('log', { ended });
    io.publish({ type: 'ended', callSid: e.callSid, at: now(), reason });
    lives.delete(e.callSid);
    const completed = (e.session.done ?? []).map((d) => d.action);
    // A handoff goes to the business's transfer number where it names one (http.ts dials it); else the call ends as a goodbye does.
    const end: EndFrame = ended === 'handoff' && app.business.transfer !== undefined ? endFrame('handoff', completed) : endFrame('completed', completed);
    // No socket to take them: kept for the next one, where the store outlives this server.
    if (e.socket === null && io.keepUndelivered([...lines, end])) return;
    // Not awaited: the carrier's playback report must reach the held end's wait (VoiceIo.sendEnd).
    void io.sendEnd(end, lines, { logged: loggedEnd })
      .then(() => io.finish())
      .catch((err: unknown) => log(`${e.callSid}: the end failed: ${describe(err)}`));
  };

  /** A turn queued on the call. */
  const runTurn = (e: ConverseCallEntry, input: Input, io: VoiceIo, generation?: number): Promise<void> => enqueue(e, (held) => runNow(held, input, io, generation));

  /**
   * The caller's final words: what they heard of the last reply, the turn running stopped (unless the bridge alone plays),
   * their turn queued. Words whose speech began before a held read-back had played are ignored, not held (transcripts
   * that kept coming behind a line that could not be interrupted were acted on stale): no turn, nothing stopped, their
   * length kept for the next turn's record and in the frame log. When the speech began is the first sign of it the
   * carrier gave (a partial prompt on Twilio, the caller heard speaking on Telnyx, an interrupt: Live.speechAt), else,
   * with none, the final words' arrival less their estimated length (a short answer's sign may be the final alone).
   */
  const finalWords = (e: ConverseCallEntry, l: Live, text: string, io: VoiceIo): Promise<void> => {
    const end = heldEnd(l);
    const began = l.speechAt ?? now() - textEstimateMs(text);
    if (end !== null && began < end) {
      l.speechAt = null;
      l.ignored.push(text.length);
      io.record('log', { ignoredOverHeld: text.length });
      return Promise.resolve();
    }
    // A correction still waiting was not heard: dropped first, so the turn is told so.
    dropCorrection(l);
    const heard = heardOf(l, now());
    const overTheBridge = overBridge(l);
    l.speechAt = null;
    if (!overTheBridge) l.running?.ac.abort();
    l.generation += 1;
    const ignored = l.ignored.splice(0);
    return runTurn(e, { kind: 'text', text, ...(heard !== undefined ? { heard } : {}), ...(ignored.length > 0 ? { ignored } : {}) }, io, l.generation);
  };

  return {
    serves: (appId) => deps.apps.has(appId),

    async open(entry, setup, io) {
      const app = appOf(entry);
      const l = liveOf(entry);
      l.io = io;
      const number = setup.callerNumber !== null && E164.test(setup.callerNumber) ? setup.callerNumber : undefined;
      if (number !== undefined) entry.session = { ...entry.session, caller: { number, account: accountOf(app.business, number) } };
      io.publish({
        type: 'call_started', callSid: entry.callSid, at: now(), from: number !== undefined ? `...${number.slice(-4)}` : 'unknown',
        todayIso: localDateIso(now(), businessZone(app.business)), thresholds: {}, channel: 'voice', provider: setup.provider, caller: null, app: app.id,
      });
      await runTurn(entry, { kind: 'start' }, io);
    },

    async frame(entry, frame, io) {
      const l = liveOf(entry);
      l.io = io;
      io.record('in', loggedIn(frame));
      switch (frame.type) {
        case 'prompt':
          // A partial prompt marks only when the caller began.
          if (!frame.last) {
            l.speechAt ??= now();
            dropCorrection(l);
            return;
          }
          if (frame.voicePrompt.trim() === '') return;
          return finalWords(entry, l, frame.voicePrompt, io);
        case 'interrupt':
          // Telnyx sends interrupts with no caller speaking: only the caller heard over the line is a cut-in there.
          if (readsPlaybackEvents(entry.provider)) return;
          cutIn(l, frame.utteranceUntilInterrupt);
          return;
        case 'error':
          log(`${entry.callSid}: the carrier reported: ${frame.description.slice(0, 200)}`);
          return;
        default:
          // Keys are logged and otherwise ignored (the converse line has no keypad menu).
          return;
      }
    },

    playback(entry, ev, io) {
      const l = liveOf(entry);
      l.io = io;
      l.reports = true;
      const r = l.reply;
      if (ev.kind === 'caller') {
        if (!ev.speaking) return;
        l.speechAt ??= now();
        // Fail closed on the events' order: speech while a reply's last line is not reported played is a cut-in,
        // whether or not agentSpeaking on came first (Telnyx has sent clientSpeaking 24 ms after a reply, before it).
        if (l.agentSpeaking || unplayed(r)) cutIn(l);
        else dropCorrection(l);
        return;
      }
      // A held read-back plays on whatever the caller says over it: its playback counts as it is reported.
      const holds = r !== null && r.held !== null;
      if (ev.state === 'started') {
        l.agentSpeaking = true;
        if (r !== null && r.frames.length > 0 && (l.speechAt === null || holds)) r.began = true;
      } else if (ev.text === undefined) l.agentSpeaking = false;
      // What played is what the carrier reported before the caller began to speak: Telnyx reports the text it
      // handed to its voice, a whole line at once even when the audio stopped on the caller's barge-in.
      else if (r !== null && (l.speechAt === null || holds) && !r.cutIn && folded(ev.text) !== r.bridge) {
        r.played = joined(r.played, ev.text);
        if (r.frames.length > 0) r.began = true;
        if (holds && r.heldPlayedAt === null && playedOut(r)) r.heldPlayedAt = now();
      }
      const c = l.correction;
      if (c !== null && playedOut(c.after)) sayCorrection(l, c);
    },

    loggedEvent(entry, message, ev) {
      if (ev === null || ev.kind !== 'playback' || ev.state !== 'finished' || ev.text === undefined) return message;
      const l = lives.get(entry.callSid);
      const scrubs = l?.scrubs ?? [];
      // A turn still running has not yet given its masking, and the line reported may be its own: by its length.
      const byLength = l === undefined || l.running !== null || l.unmasked || scrubs.length === 0;
      const mask = (text: string): string => (byLength ? `<${text.length} chars>` : scrubs.reduceRight((t, s) => s(t), text));
      const walk = (v: unknown): unknown => {
        if (typeof v === 'string') return v === ev.text ? mask(v) : v;
        if (Array.isArray(v)) return v.map(walk);
        if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
        return v;
      };
      return walk(message);
    },

    closed(entry) {
      const l = lives.get(entry.callSid);
      if (l === undefined) return;
      dropCorrection(l);
      l.io = null;
      l.speechAt = null;
      l.agentSpeaking = false;
      if (l.running !== null) {
        l.running.dropped = true;
        l.running.ac.abort();
      }
    },

    async resumed(entry, io) {
      const l = liveOf(entry);
      l.io = io;
      l.reply = null;
      l.speechAt = null;
      l.agentSpeaking = false;
      // In the queue, after the turn the drop stopped: its words, where it is to be asked again.
      await enqueue(entry, async (e) => {
        const words = e.turnWords;
        if (words === undefined || e.session.ended !== undefined) return;
        io.record('log', { askedAgain: true });
        const heard = e.turnHeard;
        await runNow(e, { kind: 'text', text: words, ...(heard !== undefined ? { heard } : {}) }, io);
      });
    },

    async replay(entry, io) {
      const frames = [...(entry.undelivered ?? [])] as unknown as OutboundFrame[];
      delete entry.undelivered;
      io.record('log', { replayedEnd: frames.map((f) => f.type) });
      const at = frames.findIndex((f) => f.type === 'end');
      const lines = at >= 0 ? frames.slice(0, at) : frames;
      // Kept without the turn's masking: each line by its length.
      await io.send(lines, { logged: (f) => (f.type === 'text' ? loggedText(f, null) : f) });
      const end = at >= 0 ? frames[at] : undefined;
      if (end === undefined || end.type !== 'end') {
        await io.finish();
        return;
      }
      void io.sendEnd(end, lines, { logged: loggedEnd })
        .then(() => io.finish())
        .catch((err: unknown) => log(`${entry.callSid}: the replayed end failed: ${describe(err)}`));
    },

    forget(callSid) {
      const l = lives.get(callSid);
      if (l === undefined) return;
      dropCorrection(l);
      lives.delete(callSid);
    },

    async hangup(entry) {
      const l = lives.get(entry.callSid);
      lives.delete(entry.callSid);
      if (l !== undefined) {
        dropCorrection(l);
        l.running?.ac.abort();
        await l.running?.done;
      }
      const app = deps.apps.get(entry.session.appId);
      if (app === undefined) return;
      delete entry.turnWords;
      delete entry.turnHeard;
      // The turn's own record of a caller leaving (converse_left, a read-back waiting dropped), then the end.
      try {
        const ignored = l?.ignored.splice(0) ?? [];
        entry.session = await converseTurn(entry.session, { kind: 'left', ...(ignored.length > 0 ? { ignored } : {}) }, turnDeps(app, entry), SILENT);
      } catch (err) {
        log(`${entry.callSid}: the caller's leaving was not recorded: ${describe(err)}`);
      } finally {
        audited(app, entry.callSid, 'hangup');
        // In the frame log as a converse chat's caller leaving (view.js converseRow).
        entry.frames.write('log', { ended: 'caller' });
      }
    },
  };
}
