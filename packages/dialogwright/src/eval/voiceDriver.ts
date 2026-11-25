import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import type { CallerFn, SimCall, SimTurn, TurnEnds } from './chatDriver';
import type { Persona } from './personas';

/**
 * The simulated callers on the voice path (pnpm eval --channel voice): one call driven as Twilio's
 * ConversationRelay would carry it, in text. The driver plays the carrier over the wire, a black box to the
 * server as the chat driver is: `POST /voice/twilio` answers the call, the start document names the relay's
 * socket and its token, and the socket's setup carries the number the persona calls from (or a 555 number of
 * the harness's own). The caller's words go as final prompts; the line's reply comes as text frames.
 *
 * - Playing. A reply's frames are "played" at SPEAKING_WORDS_PER_S from the first frame: each frame starts once
 *   it has arrived and the one before it has played. The caller is asked for its next words once the reply's
 *   final frame has played (and the server's turn has ended, where it tells them: `turnEnds`). The bridge (a
 *   frame the caller cannot interrupt) plays as any other, and is never cut in on.
 * - Cutting in (the persona's `voice.interrupts`). On a reply of more than CUT_IN_OVER_WORDS words, the caller
 *   cuts in when CUT_IN_AT of its words have played: an `interrupt` frame whose `utteranceUntilInterrupt` is the
 *   words played, then its next words as a final prompt. The caller is shown only the words played, and the
 *   call's line turn holds only them, marked `cut` (the judge is shown the mark), with the words not heard kept
 *   as `unheard` for the author. A reply still streaming is never cut in on: the cut waits for its final frame, and
 *   where that came after the 40% point, the caller cuts in at the words played by then.
 * - Fragments (the persona's `voice.fragments`). A caller turn of more than FRAGMENT_OVER_WORDS words is sent as
 *   two final prompts split at its middle word, FRAGMENT_GAP_MS apart, as a recognizer that ended the turn early.
 * - Timing. `firstWordMs` is from the caller's (last) final prompt to the first text frame heard (the bridge
 *   included), `replyFirstMs` to the reply's own first frame (the bridge left out), and `bridged` counts the turns
 *   whose reply began with the bridge. `timeScale`
 *   scales every wait the driver makes of its own (playback, the gap between fragments): 1 on a run, so the line
 *   meets real time as on a call; a test runs it faster.
 * - The end. The line's `end` frame ends the call (its handoff data posted back as the carrier's action callback
 *   would); a caller who hangs up closes the socket, and the carrier's callback says the call completed.
 */

/** The pace a reply is played at, in words per second. */
export const SPEAKING_WORDS_PER_S = 2.7;
/** A reply of more than this many words is one an interrupting caller cuts in on. */
export const CUT_IN_OVER_WORDS = 30;
/** The share of such a reply's words played when the caller cuts in. */
export const CUT_IN_AT = 0.4;
/** A caller turn of more than this many words reaches a fragmenting caller's line in two parts. */
export const FRAGMENT_OVER_WORDS = 8;
/** The time between the two parts. */
export const FRAGMENT_GAP_MS = 600;
/** The number a persona with no `callingFrom` calls from, and the number called: the harness's own, in the 555 range. */
export const VOICE_FROM = '+15555550188';
export const VOICE_TO = '+15555550101';

/** A message from the line, as it arrived; `turnEnd` is the driver's own mark that the server's n-th turn ended. */
interface Wire {
  type: string;
  token?: string;
  last?: boolean;
  interruptible?: boolean;
  handoffData?: string;
  turnEnd?: number;
  /** When it arrived (ms since the epoch). */
  at: number;
}

/** A frame of the line's reply as the caller hears it: its words, whether it is the bridge, and when it arrived. */
export interface PlayedFrame {
  words: readonly string[];
  bridge: boolean;
  at: number;
}

const wordsOf = (t: string): string[] => t.trim().split(/\s+/).filter((w) => w !== '');

/** When each frame plays: from its arrival, or once the frame before it has played, whichever is later. */
export function schedule(frames: readonly PlayedFrame[], msPerWord: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let end = -Infinity;
  for (const f of frames) {
    const start = Math.max(f.at, end);
    end = start + f.words.length * msPerWord;
    out.push({ start, end });
  }
  return out;
}

/** The words of each frame played by time `t`. */
export function playedBy(frames: readonly PlayedFrame[], t: number, msPerWord: number): number[] {
  return schedule(frames, msPerWord).map((s, i) => {
    const n = frames[i]!.words.length;
    if (t >= s.end) return n;
    if (t <= s.start || msPerWord <= 0) return 0;
    return Math.min(n, Math.floor((t - s.start) / msPerWord));
  });
}

/** The time by which `k` of the reply's words the caller may interrupt (the bridge's left out) have played. */
export function timeOfWord(frames: readonly PlayedFrame[], k: number, msPerWord: number): number {
  const s = schedule(frames, msPerWord);
  let left = k;
  for (const [i, f] of frames.entries()) {
    if (f.bridge) continue;
    if (left <= f.words.length) return s[i]!.start + left * msPerWord;
    left -= f.words.length;
  }
  return s.at(-1)?.end ?? 0;
}

const form = (params: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(params).toString(),
});

/** What became of a reply: when its first frame came, whether the call is over, what the caller heard, and a cut-in's words. */
interface Reply {
  first: number | null;
  /** When its own first frame came, the bridge left out. */
  replyFirst: number | null;
  /** It began with the bridge (the model slow to begin). */
  bridged: boolean;
  over: boolean;
  /** The interrupt's utteranceUntilInterrupt (the words played that the caller may interrupt), where the caller cut in. */
  cut: string | null;
}

/**
 * Drives one call over the voice path, as Twilio would carry it: answered, the greeting played, then the caller's
 * words and the line's replies, until the caller hangs up, the line ends or transfers the call, or `maxTurns`
 * caller turns were said.
 *
 * Where the server tells its turns' ends (`turnEnds`, the voice runtime's onTurnEnd, by the call's CallSid), a
 * reply is every frame the server sends until its turn has ended, played out: on each end the driver pings the
 * socket and takes the end once the pong is in, so every frame the turn sent has arrived. A turn that has not
 * ended within `timeoutMs` of the last message is ended there. With no `turnEnds`, a reply ends once its final
 * frame (`last: true`, one the caller may interrupt) has played and `settleMs` has passed with nothing more.
 */
export async function driveVoice(o: {
  /** The server's socket address (ws://host:port), which the start document's relay path is opened on. */
  url: string;
  /** The server's http address, where the carrier's webhooks are posted. */
  serverHttp: string;
  persona: Persona;
  caller: CallerFn;
  maxTurns: number;
  timeoutMs: number;
  /** The server's turn ends (eval/server.ts EvalServer.turnEnds); absent: a reply ends by settling. */
  turnEnds?: TurnEnds;
  /** Scales the driver's own waits (playback, the gap between fragments); default 1, real time. */
  timeScale?: number;
  settleMs?: number;
}): Promise<SimCall> {
  const scale = o.timeScale ?? 1;
  const msPerWord = (1000 / SPEAKING_WORDS_PER_S) * scale;
  const settleMs = o.settleMs ?? 2000;
  const started = Date.now();
  const callSid = `CA${randomBytes(16).toString('hex')}`;
  const from = o.persona.callingFrom ?? VOICE_FROM;
  const interrupts = o.persona.voice?.interrupts === true;
  const fragmenting = o.persona.voice?.fragments === true;
  const call: SimCall = { persona: o.persona.id, turns: [], ended: 'turns', firstWordMs: [], callId: callSid, channel: 'voice', cutIns: 0, fragments: 0, replyFirstMs: [], bridged: 0 };
  const callback = (params: Record<string, string>): Promise<unknown> =>
    fetch(`${o.serverHttp}/cr-action/twilio`, form({ CallSid: callSid, ...params })).then((r) => r.text()).catch(() => undefined);

  const answer = await fetch(`${o.serverHttp}/voice/twilio`, form({ CallSid: callSid, From: from, To: VOICE_TO, CallStatus: 'ringing', Direction: 'inbound' }));
  const doc = await answer.text();
  const named = /url="wss?:\/\/[^/"]+(\/[^"]*)"/.exec(doc);
  if (!answer.ok || named === null) throw new Error(`the line did not answer with a relay (http ${answer.status})`);
  const socket = new WebSocket(`${o.url}${named[1]!.replace(/&amp;/g, '&')}`);
  const queue: Wire[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  socket.on('message', (d) => {
    queue.push({ ...(JSON.parse(d.toString()) as Omit<Wire, 'at'>), at: Date.now() });
    wake?.();
  });
  const shut = (): void => {
    closed = true;
    wake?.();
  };
  socket.on('close', shut);
  socket.on('error', shut);
  // Each pong answers the ping sent on a turn's end, in order, after every frame the turn sent.
  let pongs = 0;
  socket.on('pong', () => {
    queue.push({ type: 'turn_end', turnEnd: ++pongs, at: Date.now() });
    wake?.();
  });
  /** The next message by `deadline` (ms since the epoch), or null (silence, or the socket closed). */
  const next = async (deadline: number): Promise<Wire | null> => {
    for (;;) {
      const m = queue.shift();
      if (m !== undefined) return m;
      const left = deadline - Date.now();
      if (closed || left <= 0) return null;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      wake = null;
    }
  };
  /** The highest of the server's turns whose end has arrived. */
  let ended = 0;
  /** Frames of turns up to this one are not heard: the caller cut in on it, and the carrier stopped playing. */
  let unheardUntil = 0;
  /** The line's end frame, once it came. */
  let lineEnd: Wire | null = null;
  let unwatch: (() => void) | null = null;

  /** The line's reply to the server's turn `turn`, played; `sentAt`: when the caller's (last) words went. */
  const reply = async (turn: number, sentAt: number): Promise<Reply> => {
    const frames: PlayedFrame[] = [];
    let first: number | null = null;
    let replyFirst: number | null = null;
    let finalAt: number | null = null;
    let turnEnded = false;
    let over = false;
    let lastAt = Date.now();
    let cut: { words: number } | null = null;
    for (;;) {
      const now = Date.now();
      const playEnd = schedule(frames, msPerWord).at(-1)?.end ?? now;
      // The caller cuts in on a long reply once its final frame is in: at CUT_IN_AT of its words, or at once if they have played already.
      let cutAt: number | null = null;
      if (interrupts && finalAt !== null && !over) {
        const n = frames.filter((f) => !f.bridge).reduce((s, f) => s + f.words.length, 0);
        if (n > CUT_IN_OVER_WORDS) {
          const target = Math.ceil(CUT_IN_AT * n);
          cutAt = timeOfWord(frames, target, msPerWord);
          if (now >= cutAt) {
            const late = finalAt > cutAt;
            const playedThen = playedBy(frames, finalAt, msPerWord).reduce((s, k, i) => s + (frames[i]!.bridge ? 0 : k), 0);
            cut = { words: late ? Math.max(target, playedThen) : target };
            break;
          }
        }
      }
      if (over) break;
      // Its turn has ended (or, with no turn ends, its final frame has settled); or nothing came for timeoutMs, a lost end: the reply taken as it is.
      const done = (o.turnEnds !== undefined ? turnEnded : finalAt !== null && now - lastAt >= settleMs) || now - lastAt >= o.timeoutMs;
      if (done && now >= playEnd) break;
      const waits = done ? [playEnd] : [lastAt + o.timeoutMs, ...(o.turnEnds === undefined && finalAt !== null ? [lastAt + settleMs] : [])];
      if (cutAt !== null) waits.push(cutAt);
      const m = await next(Math.min(...waits));
      if (m === null) {
        if (closed) over = true;
        continue;
      }
      if (m.turnEnd !== undefined) {
        ended = Math.max(ended, m.turnEnd);
        if (m.turnEnd >= turn) turnEnded = true;
        continue;
      }
      lastAt = m.at;
      if (m.type === 'text' && typeof m.token === 'string') {
        if (ended < unheardUntil) continue;
        const words = wordsOf(m.token);
        if (words.length === 0) continue;
        const bridge = m.interruptible === false;
        frames.push({ words, bridge, at: m.at });
        first ??= m.at - sentAt;
        if (!bridge) replyFirst ??= m.at - sentAt;
        if (m.last === true && !bridge) finalAt = m.at;
      } else if (m.type === 'end') {
        lineEnd = m;
        over = true;
      }
    }
    // What the caller heard: every frame, or on a cut-in the bridge and the words played before it.
    let heard: string[];
    let utterance: string | null = null;
    let unheard: string[] = [];
    if (cut !== null) {
      const words = frames.filter((f) => !f.bridge).flatMap((f) => f.words);
      const spoken = words.slice(0, cut.words);
      unheard = words.slice(cut.words);
      const bridgeBefore = frames.slice(0, frames.findIndex((f) => !f.bridge)).flatMap((f) => f.words);
      utterance = spoken.join(' ');
      heard = [...bridgeBefore, ...spoken];
    } else heard = frames.flatMap((f) => f.words);
    // A turn cut in on is marked, with the words the caller did not hear kept for the author (never shown to the caller or the judge).
    if (heard.length > 0) call.turns.push({ who: 'line', text: heard.join(' '), atMs: sentAt - started + Math.max(0, first ?? 0), ...(cut !== null ? { cut: true as const, ...(unheard.length > 0 ? { unheard: unheard.join(' ') } : {}) } : {}) });
    else over = true;
    return { first, replyFirst, bridged: frames.some((f) => f.bridge), over, cut: utterance };
  };

  /**
   * After a cut-in on `turn`: its end waited for (where the server tells it) and whatever else of it arrives passed
   * over, unheard; those words are added to the cut turn's `unheard`.
   */
  const passOver = async (turn: number): Promise<void> => {
    unheardUntil = turn;
    const deadline = Date.now() + o.timeoutMs;
    const dropped: string[] = [];
    for (;;) {
      if (o.turnEnds !== undefined ? ended >= turn : queue.length === 0) break;
      const m = await next(o.turnEnds !== undefined ? deadline : Date.now());
      if (m === null) break;
      if (m.turnEnd !== undefined) ended = Math.max(ended, m.turnEnd);
      else if (m.type === 'end') lineEnd = m;
      else if (m.type === 'text' && typeof m.token === 'string' && m.interruptible !== false) dropped.push(...wordsOf(m.token));
    }
    const cutTurn = call.turns.at(-1);
    if (dropped.length > 0 && cutTurn?.cut === true) cutTurn.unheard = [cutTurn.unheard, dropped.join(' ')].filter((w) => w !== undefined && w !== '').join(' ');
  };

  /** The call as the caller knows it: each turn's words as heard, never the words they did not hear nor the mark. */
  const heardSoFar = (): SimTurn[] => call.turns.map((t) => ({ who: t.who, text: t.text, atMs: t.atMs }));
  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms * scale));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', (e) => reject(e));
    });
    if (o.turnEnds !== undefined) {
      unwatch = o.turnEnds.watch(callSid, () => {
        try {
          if (socket.readyState === WebSocket.OPEN) socket.ping();
        } catch {
          // The socket closed as the turn ended (the line ended the call): its close ends the reply.
        }
      });
    }
    socket.send(JSON.stringify({ type: 'setup', sessionId: `VX${callSid.slice(2)}`, callSid, from, to: VOICE_TO, direction: 'inbound', customParameters: {} }));
    let turn = 1;
    let r = await reply(turn, Date.now());
    for (let said = 0; ; said++) {
      if (r.over) {
        call.ended = 'line';
        break;
      }
      if (said >= o.maxTurns) {
        call.ended = 'turns';
        break;
      }
      let line: Awaited<ReturnType<CallerFn>>;
      if (r.cut !== null) {
        // The caller speaks over the line: the carrier's interrupt at once, their words once they have said them.
        socket.send(JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: r.cut, durationUntilInterruptMs: Math.round((wordsOf(r.cut).length / SPEAKING_WORDS_PER_S) * 1000) }));
        call.cutIns! += 1;
        [line] = await Promise.all([o.caller(o.persona, heardSoFar()), passOver(turn)]);
        // The line ended the call (or its socket closed) while the caller spoke over it: their words reach no one.
        if (lineEnd !== null || closed) {
          call.ended = 'line';
          break;
        }
      } else line = await o.caller(o.persona, heardSoFar());
      if (line === null || typeof line !== 'string') {
        call.ended = 'caller';
        call.callerEnded = line ?? { how: 'hang_up' };
        // The caller hangs up: the carrier closes the relay, then tells the server the call completed.
        socket.close();
        await callback({ CallStatus: 'completed', SessionStatus: 'ended' });
        break;
      }
      call.turns.push({ who: 'caller', text: line, atMs: Date.now() - started });
      const words = wordsOf(line);
      let sentAt: number;
      if (fragmenting && words.length > FRAGMENT_OVER_WORDS) {
        // The recognizer ends the turn early: its first half, then the rest.
        const half = Math.floor(words.length / 2);
        socket.send(JSON.stringify({ type: 'prompt', voicePrompt: words.slice(0, half).join(' '), lang: 'en-US', last: true }));
        turn += 1;
        await pause(FRAGMENT_GAP_MS);
        sentAt = Date.now();
        socket.send(JSON.stringify({ type: 'prompt', voicePrompt: words.slice(half).join(' '), lang: 'en-US', last: true }));
        call.fragments! += 1;
      } else {
        sentAt = Date.now();
        socket.send(JSON.stringify({ type: 'prompt', voicePrompt: line.slice(0, 500), lang: 'en-US', last: true }));
      }
      turn += 1;
      r = await reply(turn, sentAt);
      // The first frame heard (the bridge included), and the reply's own first frame (the bridge left out).
      call.firstWordMs.push(r.first === null ? o.timeoutMs : Math.max(0, r.first));
      call.replyFirstMs!.push(r.replyFirst === null ? o.timeoutMs : Math.max(0, r.replyFirst));
      if (r.bridged) call.bridged! += 1;
    }
    if (call.ended === 'line' && lineEnd !== null) {
      // The line ended the call: the carrier's action callback, with the end's handoff data.
      const end: Wire = lineEnd;
      await callback({ CallStatus: 'in-progress', SessionStatus: 'ended', ...(typeof end.handoffData === 'string' ? { HandoffData: end.handoffData } : {}) });
    }
    return call;
  } finally {
    unwatch?.();
    socket.close();
  }
}
