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
   * `held`), its last frame; null: it holds none. Only the read-back is sent not interruptible (the model's words before
   * it go as they came: a cut over them, as over the read-back, makes it unheard), and speech that begins before it has
   * played is ignored (heldEnd).
   */
  held: Sent | null;
  /** The bridge said with it, as sent: a held read-back after it begins once it has played (heldStart). */
  bridgeSent: Sent | null;
  /** When the carrier reported the held read-back played (Telnyx's tokensPlayed); null: not yet, or no report. */
  heldPlayedAt: number | null;
  /** When the carrier reported the reply played to its end (its last line reported, or the voice stopping after it); null: not yet, or no report. */
  playedAt: number | null;
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
  /** A turn on the caller's silence: a sign of their speech before it has sent anything stops it, and it counts for nothing. */
  silence: boolean;
  /** It has sent a line (the bridge among them). */
  spoke: boolean;
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
  /** The run of speech signs since the caller's last final words (a partial, an interrupt, the caller heard speaking); null: none. */
  run: Run | null;
  /** The run before it, where no final words came between them. */
  prevRun: Run | null;
  /** Telnyx reports the caller speaking now (clientSpeaking on, not yet off). */
  callerSpeaking: boolean;
  /** The lines sent, oldest first, each with its reply (a few kept): a carrier's report of a line played is the first of them with its words. */
  sentLines: { reply: Reply; line: Sent }[];
  /** The silence wait (agent.yaml's `silence`) while it runs: a turn on the silence when it ends; null: none runs. */
  silenceTimer: ReturnType<typeof setTimeout> | null;
  /** Silences in a row the line has answered, since caller speech was last taken. */
  silences: number;
  /** The call this is kept for: its entry as last handed to the runtime (a reconnect or a takeover gives a new one). */
  entry: ConverseCallEntry;
  /** Signs of the caller's speech so far (partials, the caller heard speaking, interrupts, finals): a silence turn queued before one is not run. */
  speechSigns: number;
  /** When the caller was last heard beginning to speak (Telnyx's clientSpeaking on), while they are; null: not speaking. */
  speakingSince: number | null;
}

/**
 * The longest the caller heard speaking (Telnyx's clientSpeaking on, with no off and no final words) holds off the silence
 * wait: a stray on that is never turned off must not keep the line from ever answering a silence. Used for nothing else.
 */
export const SILENCE_SPEAKING_HOLD_MS = 20_000;

/** The lines kept to match a carrier's reports of what played against, by the order they were sent. */
const SENT_LINES_KEPT = 32;

/**
 * The longest pause between two signs of the caller's speech within one run of it. Twilio sends a partial prompt every
 * few hundred milliseconds while a caller speaks, so a second with none is a pause between utterances, or a stray sign
 * (a cough, a noise) before the words that follow: the start of the caller's words is the start of the last run.
 */
export const SPEECH_RUN_GAP_MS = 1000;

/**
 * No report that a held read-back has played ends its hold sooner than this share of its estimate after it began: no
 * voice plays a line in half its estimate, so an earlier report is a late one of another line (a held read-back with no
 * brief one says the first one's words) or a report out of turn, and the hold goes on.
 */
const HELD_REPORT_AT = 0.5;

/**
 * How much earlier than its estimate a sign of speech may be and still be the start of the words its final prompt
 * brings, when a held read-back decides whether those words began over it. Real speech runs slower than
 * textEstimateMs's 2.5 words a second, with pauses, and the recognizer's final comes some time after the words end;
 * a sign earlier than that is taken to be a stray one (a noise partial, Telnyx's caller heard speaking with no
 * transcript after it) that never became words, and is not the start of these.
 */
export const SPEECH_START_SLACK_MS = 3000;

/** The turns' maskings kept for a carrier's reports of what played. */
const SCRUBS_KEPT = 8;

/** A piece that runs into the next on the carrier ends with a space. */
const spaced = (text: string): string => (/\s$/.test(text) ? text : `${text} `);

/** Words compared as a carrier reports them back: whitespace folded. */
const folded = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Text pieces joined with a space between them. */
const joined = (a: string, b: string): string => (a === '' ? b : `${a}${/\s$/.test(a) ? '' : ' '}${b}`);

const newReply = (): Reply => ({ frames: [], bridge: null, played: '', interrupted: null, cutIn: false, unheard: false, began: false, held: null, bridgeSent: null, heldPlayedAt: null, playedAt: null });

/** Every line of the reply as sent, the bridge among them, in the order sent. */
const linesOf = (r: Reply): Sent[] => [...(r.bridgeSent !== null ? [r.bridgeSent] : []), ...r.frames].sort((a, b) => a.at - b.at);

/**
 * When the reply's held read-back is estimated to begin playing: the reply's lines played in turn from its first (the
 * bridge included), each from when it was sent or once the one before it has played.
 */
function heldStart(r: Reply): number | null {
  let t: number | null = null;
  for (const f of linesOf(r)) {
    const start = Math.max(t ?? f.at, f.at);
    if (f === r.held) return start;
    t = start + textEstimateMs(f.text);
  }
  return null;
}

/** When the reply's lines are estimated to have played, each from when it was sent or once the one before it has (the bridge included); null: none was sent. */
function linesEnd(r: Reply): number | null {
  let t: number | null = null;
  for (const f of linesOf(r)) t = Math.max(t ?? f.at, f.at) + textEstimateMs(f.text);
  return t;
}

/** When the held reply's first line was sent (the bridge included): speech signs from before it are not of words over it. */
const heldSentAt = (r: Reply): number => linesOf(r)[0]?.at ?? r.held?.at ?? 0;

/** A run of the caller's speech signs: when its first came, its last, and whether it is still going (Telnyx's caller heard speaking, not yet reported stopped). */
interface Run {
  start: number;
  last: number;
  open: boolean;
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
      l = { io: null, running: null, reply: null, speechAt: null, agentSpeaking: false, reports: false, unmasked: false, correction: null, generation: 0, scrubs: [], ignored: [], run: null, prevRun: null, callerSpeaking: false, sentLines: [], silenceTimer: null, silences: 0, entry: e, speechSigns: 0, speakingSince: null };
      lives.set(e.callSid, l);
    }
    l.entry = e;
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
   * (Telnyx), its report that the line played (heldReported), else (not yet reported) one and a half times its estimate
   * and two seconds from when it began, a ceiling; with none (Twilio, which reports nothing of a line's playback), when
   * READ_BACK_HEARD_AT of its estimate has played (the maintainer's ruling, 2026-11-26: a line 85% heard already counts
   * as heard, READ_BACK_HEARD_AT, so a caller who begins past that point has heard what a yes needs heard; an estimate a
   * little long would otherwise ignore a caller who waited for the end of a voice faster than it). It begins once the
   * reply's lines before it have played, the bridge among them (heldStart).
   */
  const heldEnd = (l: Live): number | null => {
    const r = l.reply;
    if (r === null || r.held === null) return null;
    if (r.heldPlayedAt !== null) return r.heldPlayedAt;
    const start = heldStart(r) ?? r.held.at;
    const estimate = textEstimateMs(r.held.text);
    return l.reports ? start + estimate * 1.5 + 2000 : start + READ_BACK_HEARD_AT * estimate;
  };

  /** When a run's last sign came; a run still going (Telnyx's caller heard speaking, not yet stopped), now. */
  const runLast = (r: Run): number => (r.open ? now() : r.last);

  /** A sign of the caller's speech: a partial prompt or an interrupt (`tick`, within a run unless after a pause), Telnyx's caller heard speaking (`on` starts a run, `off` ends it). */
  const sign = (l: Live, kind: 'tick' | 'on' | 'off'): void => {
    const at = now();
    const r = l.run;
    if (kind === 'off') {
      if (r !== null) {
        r.last = at;
        r.open = false;
      }
      return;
    }
    if (kind === 'tick' && r !== null && (r.open || at - r.last <= SPEECH_RUN_GAP_MS)) {
      r.last = at;
      return;
    }
    if (r !== null) l.prevRun = r;
    l.run = { start: at, last: at, open: kind === 'on' };
  };

  /** The signs of the caller's speech let go: final words came (an empty final among them), as a run's words are said. */
  const signsSaid = (l: Live): void => {
    l.run = null;
    l.prevRun = null;
  };

  /**
   * When the speech of the final words `text` began, for the held read-back's decision (finalWords): the start of the
   * last run of signs, where it fits these words, else their arrival less their estimated length. A run fits unless it
   * is stale: nothing of it came since the held reply was sent (a sign from before it), it was over more than a run's
   * pause before these words began, or it began more than SPEECH_START_SLACK_MS before their estimated start and was not
   * still going up to them.
   */
  const speechBegan = (l: Live, text: string): number => {
    const arrival = now();
    const estimated = arrival - textEstimateMs(text);
    const run = l.run;
    if (run === null || l.reply === null) return estimated;
    const last = runLast(run);
    const stray = last < heldSentAt(l.reply);
    const over = last < estimated - SPEECH_RUN_GAP_MS;
    const fits = run.start >= estimated - SPEECH_START_SLACK_MS || last >= arrival - SPEECH_RUN_GAP_MS;
    return !stray && !over && fits ? run.start : estimated;
  };

  /** Whether a held read-back plays now: speech over it is no cut-in, and stops nothing. */
  const holding = (l: Live): boolean => {
    const end = heldEnd(l);
    return end !== null && now() < end;
  };

  /**
   * The carrier cut the held read-back (an interrupt over it): it played on as far as the carrier says, so it is recorded
   * as cut in on (fail closed: the yes after it confirms nothing), but nothing stops, and the words over it are ignored.
   */
  const heldCut = (l: Live, interrupted?: string): void => {
    const r = l.reply;
    if (r === null) return;
    r.cutIn = true;
    if (interrupted !== undefined) r.interrupted = interrupted;
  };

  /**
   * The caller spoke over the line: the reply playing is cut in on (not the bridge alone), and the turn running is
   * stopped. Over a held read-back nothing stops: an interrupt (`carrierCut`, the carrier's word that it cut the line)
   * is recorded as a cut, and the caller heard speaking over it, as speech it plays on through.
   */
  const cutIn = (l: Live, interrupted?: string, carrierCut = false): void => {
    l.speechAt ??= now();
    dropCorrection(l);
    if (overBridge(l)) return;
    if (holding(l)) {
      if (carrierCut) heldCut(l, interrupted);
      return;
    }
    const r = l.reply;
    if (r !== null && r.frames.length > 0) {
      r.cutIn = true;
      if (interrupted !== undefined) r.interrupted = interrupted;
    }
    l.running?.ac.abort();
  };

  /** A line sent, kept to match a carrier's report of it against (a few kept). */
  const keepSent = (l: Live, reply: Reply, line: Sent): void => {
    l.sentLines.push({ reply, line });
    if (l.sentLines.length > SENT_LINES_KEPT) l.sentLines.splice(0, l.sentLines.length - SENT_LINES_KEPT);
  };

  /** The first line sent with the words `text` reported played, by the order sent, taken off the lines kept with those before it (never reported); null: none. */
  const takeReported = (l: Live, text: string): { reply: Reply; line: Sent } | null => {
    const at = l.sentLines.findIndex((s) => folded(s.line.text) === folded(text));
    if (at < 0) return null;
    const found = l.sentLines[at]!;
    l.sentLines.splice(0, at + 1);
    return found;
  };

  /**
   * Whether a carrier's report ends the hold of the reply's held read-back (Telnyx): never sooner than HELD_REPORT_AT of its
   * estimate after it began; then the report of its own line, matched by the order the lines were sent (`reported`); or,
   * where no line sent matches the report, one whose words end with the held read-back's (the reply's lines joined,
   * playedOut); or the voice stopping (agentSpeaking off, `reported` undefined). A report matched to an earlier line (a
   * late one of the first read-back's same words) never ends it.
   */
  const heldReported = (r: Reply, reported: { line: Sent } | null | undefined): boolean => {
    const held = r.held;
    if (held === null || r.heldPlayedAt !== null) return false;
    if (now() < (heldStart(r) ?? held.at) + HELD_REPORT_AT * textEstimateMs(held.text)) return false;
    if (reported === undefined) return true;
    if (reported !== null) return reported.line === held;
    return playedOut(r);
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
      const sentNow: Sent = { text: token, at: now() };
      reply.frames.push(sentNow);
      keepSent(l, reply, sentNow);
      return { ...textFrame(token, true), last };
    });
    void io.send(frames, { logged: (f) => (f.type === 'text' ? loggedText(f, c.scrub) : f) })
      .catch((err: unknown) => log(`correction not sent: ${describe(err)}`))
      .finally(() => {
        c.settled();
        armSilence(l.entry, l);
      });
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

  /** Whether half the estimate of the reply's last line has passed since it was estimated to begin: a report of the voice stopping sooner is of a line before it. */
  const lastLineDue = (r: Reply): boolean => {
    const lines = linesOf(r);
    const last = lines.at(-1);
    if (last === undefined || r.frames.length === 0) return false;
    let t: number | null = null;
    let start = last.at;
    for (const f of lines) {
      start = Math.max(t ?? f.at, f.at);
      t = start + textEstimateMs(f.text);
    }
    return now() >= start + 0.5 * textEstimateMs(last.text);
  };

  /** The silence wait stopped. */
  const clearSilence = (l: Live): void => {
    if (l.silenceTimer !== null) clearTimeout(l.silenceTimer);
    l.silenceTimer = null;
  };

  /**
   * When the line's last reply has played, for the silence wait: with the carrier's playback reports (Telnyx), its
   * report that it played (a held read-back's, heldEnd; any other's, `playedAt`, never sooner than half its last line's
   * estimate), else its ceiling (silenceCeiling); with none (Twilio), its lines' estimate at 100%, the bridge among them,
   * a held read-back's too (the 85% is for speech over it alone).
   */
  const replyEnd = (l: Live): number => {
    const r = l.reply;
    if (r === null) return now();
    if (l.reports) {
      const reported = r.held !== null ? r.heldPlayedAt : r.playedAt;
      return reported ?? silenceCeiling(l);
    }
    return linesEnd(r) ?? now();
  };

  /** The latest a reply counts as played with no report of it: one and a half times its lines' estimate and two seconds from its first line. */
  const silenceCeiling = (l: Live): number => {
    const r = l.reply;
    const end = r === null ? null : linesEnd(r);
    if (r === null || end === null) return now();
    const first = linesOf(r)[0]!.at;
    return first + (end - first) * 1.5 + 2000;
  };

  /**
   * The silence wait (agent.yaml's `silence`; the maintainer's decision, 2026-11-26), started again: `afterMs` once the
   * line's last reply has played (replyEnd), or from now where that is past (a sign of the caller's speech starts it
   * again). Never while a turn runs, a correction waits to be said, the call has ended, or where the app turns it off.
   * While the caller is heard speaking (for at most SILENCE_SPEAKING_HOLD_MS with no words) or the carrier reports its
   * voice still playing (until the reply's ceiling), it waits for that to end. When it ends with nothing heard: a turn on
   * the silence.
   */
  const armSilence = (e: ConverseCallEntry, l: Live): void => {
    clearSilence(l);
    const app = deps.apps.get(e.session.appId);
    const cfg = app?.business.silence;
    if (cfg === undefined || cfg === 'off' || e.session.ended !== undefined || e.ended || lives.get(e.callSid) !== l) return;
    if (l.running !== null || l.correction !== null) return;
    const at = now();
    if (l.callerSpeaking && l.speakingSince !== null && at - l.speakingSince < SILENCE_SPEAKING_HOLD_MS) {
      // Speaking: the wait starts once they stop (clientSpeaking off arms it), or at the hold's end with no words.
      l.silenceTimer = setTimeout(() => armSilence(l.entry, l), l.speakingSince + SILENCE_SPEAKING_HOLD_MS - at);
      l.silenceTimer.unref?.();
      return;
    }
    let start = Math.max(replyEnd(l), at);
    // The carrier's voice still playing: the wait starts when it stops (agentSpeaking off arms it), or at the ceiling.
    if (l.agentSpeaking) start = Math.max(start, silenceCeiling(l));
    l.silenceTimer = setTimeout(() => silenceDue(l, cfg), start + cfg.afterMs - at);
    l.silenceTimer.unref?.();
  };

  /**
   * The silence wait ended with nothing heard: a turn on the silence, the model told of it; after `reprompts` of them
   * in a row, the last, which says lines.silenceEnd and ends the call. It runs only where no sign of the caller's speech
   * came before it starts (speechSigns), and counts only once it has sent a line (Running.spoke).
   */
  const silenceDue = (l: Live, cfg: { afterMs: number; reprompts: number }): void => {
    l.silenceTimer = null;
    const e = l.entry;
    const io = l.io;
    if (io === null || e.session.ended !== undefined || e.ended || lives.get(e.callSid) !== l || l.running !== null) return;
    const end = l.silences >= cfg.reprompts;
    const ignored = l.ignored.splice(0);
    void runTurn(e, { kind: 'silence', ms: cfg.afterMs, count: l.silences + 1, ...(end ? { end: true as const } : {}), ...(ignored.length > 0 ? { ignored } : {}) }, io, undefined, l.speechSigns);
  };

  /** A sign of the caller's speech: counted, and a turn on their silence that has sent nothing yet is stopped (it counts for nothing). */
  const speechSign = (l: Live): void => {
    l.speechSigns += 1;
    if (l.running !== null && l.running.silence && !l.running.spoke) l.running.ac.abort();
  };

  /**
   * One turn, run now (in the call's queue): its words sent as they are said, its state kept, the call ended
   * where it ended it, else saved.
   */
  const runNow = async (e: ConverseCallEntry, input: Input, io: VoiceIo, generation?: number, silenceSigns?: number): Promise<void> => {
    if (e.session.ended !== undefined) return;
    const app = appOf(e);
    const l = liveOf(e);
    // A turn on a silence the caller broke before it began (a sign of their speech since its wait ended): not run.
    if (input.kind === 'silence' && silenceSigns !== undefined && silenceSigns !== l.speechSigns) return;
    l.io = io;
    dropCorrection(l);
    clearSilence(l);
    let settle!: () => void;
    const running: Running = { ac: new AbortController(), done: new Promise<void>((r) => (settle = r)), bridged: false, dropped: false, silence: input.kind === 'silence', spoke: false };
    /**
     * A line sent: a turn on a silence counts from its first (the silences in a row), and only then is its reply the line's
     * last (until then what the caller heard is of the reply before it, so their words over a silence turn stopped
     * unsaid are heard as after that reply).
     */
    const spoke = (): void => {
      if (running.spoke) return;
      running.spoke = true;
      if (input.kind === 'silence') {
        l.silences = input.count;
        l.reply = reply;
      }
    };
    // Running from here: a final prompt, a cut-in or the hangup reaches it even while its words are saved.
    // (Stopped before the turn begins, the turn still runs, at once stopped: the caller's words are kept.)
    const reply = newReply();
    if (input.kind !== 'silence') l.reply = reply;
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
          spoke();
          reply.frames.push(sentNow);
          keepSent(l, reply, sentNow);
          // A held read-back goes whole, not interruptible, the reply's final piece: speech over it is ignored (finalWords).
          if (held === true && final) reply.held = sentNow;
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
          spoke();
          running.bridged = true;
          reply.bridge = folded(text);
          reply.bridgeSent = { text, at: now() };
          keepSent(l, reply, reply.bridgeSent);
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
      // A turn on a silence stopped by the caller's speech before it said anything: as if it never ran (its trace record,
      // stopped with nothing said, stands), and the silence wait starts again.
      if (running.silence && running.ac.signal.aborted && !running.spoke) {
        e.session = { ...before, turnIndex: state.turnIndex };
        await io.save();
        armSilence(e, l);
        return;
      }
      e.session = state;
      delete e.turnWords;
      delete e.turnHeard;
      const ended = state.ended;
      if (ended === 'closing' || ended === 'handoff') {
        endCall(e, app, ended, sent.map((s) => s.frame), io, input.kind === 'silence' && input.end === true ? 'silence' : undefined);
        return;
      }
      if (correction.length > 0) {
        endTold = true;
        armCorrection(l, { pieces: correction, after: reply, scrub: masked, timer: null, settled: () => turnEnded(e.callSid) });
      }
      await io.save();
      // The reply handed the turn back: the silence wait from when it has played.
      armSilence(e, l);
    } finally {
      settle();
      if (!endTold) turnEnded(e.callSid);
    }
  };

  /** The call ended by its turn: the audit's row, the console told, the `end` sent once the lines before it have played (or kept for the next socket). */
  const endCall = (e: ConverseCallEntry, app: ConverseApp, ended: 'closing' | 'handoff', lines: readonly OutboundFrame[], io: VoiceIo, why?: 'silence'): void => {
    const reason = ended === 'closing' ? 'completed' : 'handoff';
    // An end on silence is the line's own: said so in the audit and the frame log (the console's Live list counts it completed).
    audited(app, e.callSid, why ?? reason);
    // How the call ended, in the frame log as a converse chat's (the console's Calls page reads it: view.js converseRow).
    io.record('log', { ended: why ?? ended });
    io.publish({ type: 'ended', callSid: e.callSid, at: now(), reason });
    const gone = lives.get(e.callSid);
    if (gone !== undefined) clearSilence(gone);
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
  const runTurn = (e: ConverseCallEntry, input: Input, io: VoiceIo, generation?: number, silenceSigns?: number): Promise<void> => enqueue(e, (held) => runNow(held, input, io, generation, silenceSigns));

  /**
   * The caller's final words: what they heard of the last reply, the turn running stopped (unless the bridge alone plays),
   * their turn queued. Words whose speech began before a held read-back had played are ignored, not held (transcripts
   * that kept coming behind a line that could not be interrupted were acted on stale): no turn, nothing stopped, their
   * length kept for the next turn's record and in the frame log. When the speech began is the first sign of it the
   * carrier gave (a partial prompt on Twilio, the caller heard speaking on Telnyx, an interrupt: Live.speechAt), else,
   * with none, the final words' arrival less their estimated length (a short answer's sign may be the final alone). A
   * sign that does not fit these words is stale and taken as none: one from before the held read-back was sent, or one
   * earlier than their estimated start by more than SPEECH_START_SLACK_MS (a stray sign that became no words, so a
   * caller's real answer after the line is never dropped for it: the converse line has no no-input wait to recover it).
   */
  const finalWords = (e: ConverseCallEntry, l: Live, text: string, io: VoiceIo): Promise<void> => {
    speechSign(l);
    const end = heldEnd(l);
    if (end !== null) {
      const began = speechBegan(l, text);
      if (began < end) {
        // The run of signs is kept: more of the same speech (signs within a run's pause, Telnyx's caller still heard
        // speaking) begins before the line's end too, and is ignored with it. A new run is new speech.
        l.prevRun = null;
        l.speechAt = null;
        l.ignored.push(text.length);
        io.record('log', { ignoredOverHeld: text.length });
        // Speech, though ignored: the silence wait starts again from it.
        armSilence(e, l);
        return Promise.resolve();
      }
      // Taken after a held read-back: what the caller heard of it is read from when these words began (any sign before
      // them was of other speech, or of speech over the line, which is ignored, and never these words' start).
      signsSaid(l);
      l.speechAt = began;
    } else signsSaid(l);
    // A correction still waiting was not heard: dropped first, so the turn is told so.
    dropCorrection(l);
    // The caller's speech taken: the silences in a row begin again.
    clearSilence(l);
    l.silences = 0;
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
            sign(l, 'tick');
            speechSign(l);
            dropCorrection(l);
            // A sign of speech: the silence wait starts again from it.
            armSilence(entry, l);
            return;
          }
          // An empty final says nothing, but ends the run of signs before it, as words do.
          if (frame.voicePrompt.trim() === '') {
            l.speechAt = null;
            signsSaid(l);
            armSilence(entry, l);
            return;
          }
          return finalWords(entry, l, frame.voicePrompt, io);
        case 'interrupt':
          // Telnyx sends interrupts with no caller speaking: only the caller heard over the line is a cut-in there. Over a
          // held read-back, one with the caller heard speaking is the carrier's cut of it, recorded as such (fail closed).
          if (readsPlaybackEvents(entry.provider)) {
            if (holding(l) && l.callerSpeaking) heldCut(l, frame.utteranceUntilInterrupt);
            if (l.callerSpeaking) speechSign(l);
            return;
          }
          sign(l, 'tick');
          speechSign(l);
          cutIn(l, frame.utteranceUntilInterrupt, true);
          armSilence(entry, l);
          return;
        case 'error':
          log(`${entry.callSid}: the carrier reported: ${frame.description.slice(0, 200)}`);
          return;
        default:
          // Keys are logged and otherwise ignored (the converse line has no keypad menu), but start the silence wait again.
          armSilence(entry, l);
          return;
      }
    },

    playback(entry, ev, io) {
      const l = liveOf(entry);
      l.io = io;
      l.reports = true;
      const r = l.reply;
      if (ev.kind === 'caller') {
        l.callerSpeaking = ev.speaking;
        l.speakingSince = ev.speaking ? now() : null;
        if (ev.speaking) speechSign(l);
        // No silence while the caller is heard speaking; it starts again when they stop.
        armSilence(entry, l);
        sign(l, ev.speaking ? 'on' : 'off');
        if (!ev.speaking) return;
        l.speechAt ??= now();
        // Fail closed on the events' order: speech while a reply's last line is not reported played is a cut-in,
        // whether or not agentSpeaking on came first (Telnyx has sent clientSpeaking 24 ms after a reply, before it).
        // A held read-back whose hold has ended (its report, the voice stopping, or the ceiling) has played: speech after it is no cut-in.
        const heldOver = r !== null && r.held !== null && (heldEnd(l) ?? Infinity) <= now();
        if (l.agentSpeaking || (unplayed(r) && !heldOver)) cutIn(l);
        else dropCorrection(l);
        return;
      }
      // A held read-back plays on whatever the caller says over it: its playback counts as it is reported.
      const holds = r !== null && r.held !== null;
      const endedBefore = r === null ? null : (r.heldPlayedAt ?? r.playedAt);
      if (ev.state === 'started') {
        l.agentSpeaking = true;
        if (r !== null && r.frames.length > 0 && (l.speechAt === null || holds)) r.began = true;
      } else if (ev.text === undefined) {
        l.agentSpeaking = false;
        // The voice stopped: the held read-back has played, where it is not too soon (heldReported); so has any other reply,
        // once half its last line's estimate has passed since it began (for the silence wait).
        if (holds && heldReported(r, undefined)) r.heldPlayedAt = now();
        else if (r !== null && !holds && r.playedAt === null && lastLineDue(r)) r.playedAt = now();
      } else {
        const reported = takeReported(l, ev.text);
        // What played is what the carrier reported before the caller began to speak: Telnyx reports the text it
        // handed to its voice, a whole line at once even when the audio stopped on the caller's barge-in.
        if (r !== null && (l.speechAt === null || holds) && !r.cutIn && folded(ev.text) !== r.bridge) {
          r.played = joined(r.played, ev.text);
          if (r.frames.length > 0) r.began = true;
        }
        // The held read-back's end is its own report, matched by the order the lines were sent, never a late one of the
        // earlier read-back's same words; a cut one ends too, as reported (the cut is kept: its yes confirms nothing).
        if (holds && heldReported(r, reported)) r.heldPlayedAt = now();
        // Any other reply has played once its last line is reported (for the silence wait).
        else if (r !== null && !holds && r.playedAt === null && r.frames.length > 0 && playedOut(r) && lastLineDue(r)) r.playedAt = now();
      }
      // The reply reported played, or the voice stopped: the silence wait starts from now.
      if (r !== null && ((endedBefore === null && (r.heldPlayedAt ?? r.playedAt) !== null) || (ev.state !== 'started' && ev.text === undefined))) armSilence(entry, l);
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
      clearSilence(l);
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
      // The silence wait from the resume, as after a reply (a takeover's server counts the silences in a row afresh).
      armSilence(entry, l);
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
      clearSilence(l);
      lives.delete(callSid);
    },

    async hangup(entry) {
      const l = lives.get(entry.callSid);
      lives.delete(entry.callSid);
      if (l !== undefined) {
        dropCorrection(l);
        clearSilence(l);
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
