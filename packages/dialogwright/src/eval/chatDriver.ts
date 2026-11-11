import WebSocket from 'ws';
import type { Persona } from './personas';

export interface SimTurn {
  who: 'caller' | 'line';
  text: string;
  atMs: number;
}

export interface SimCall {
  persona: string;
  turns: SimTurn[];
  /** Who ended it: the line (an end or a transfer, or it fell silent), the caller (hung up) or the turn limit. */
  ended: 'line' | 'caller' | 'turns';
  /** For each caller turn, ms from sending it to the line's first sentence (its first say_delta, else its say). */
  firstWordMs: number[];
  /**
   * How the caller ended the call, where it did (`ended: 'caller'`): `hang_up`, with the goodbye it said (not sent to
   * the line), or `empty`, its model giving no reply twice: a fault of the simulation, not of the line. Absent from a
   * record made before it was kept.
   */
  callerEnded?: CallerEnd;
  /** The chat session, which is the call's id in the audit and the trace. */
  callId?: string;
}

/** How a simulated caller ended a call: it hung up (with the goodbye it said, if any), or its model gave no reply twice. */
export interface CallerEnd {
  how: 'hang_up' | 'empty';
  goodbye?: string;
}

/** What the simulated caller says next, given the call so far; an end (or null, a hang-up with no goodbye): the call ends. */
export type CallerFn = (persona: Persona, turns: readonly SimTurn[]) => Promise<string | CallerEnd | null>;

interface Wire {
  type: string;
  text?: string;
  session?: string;
  /** The driver's own mark that the server's n-th turn of this chat has ended, put after that turn's messages; never on the wire. */
  turnEnd?: number;
}

/**
 * The ends of a server's chat turns, by the chat's id: what the chat runtime's `onTurnEnd` tells (server/chat
 * runtime.ts) given to the driver of a call on that server, since the chat wire has no end-of-turn message.
 */
export interface TurnEnds {
  /** `fn` called once for each turn of the chat that has ended, those that ended before the watch included; the call returned stops it. */
  watch(chatId: string, fn: () => void): () => void;
}

/** A server's turn ends: `ended` is the chat runtime's onTurnEnd, `watch` the driver's. A chat's count is kept until its watch stops. */
export function turnEndSignal(): TurnEnds & { ended(chatId: string): void } {
  const chats = new Map<string, { ended: number; fns: Set<() => void> }>();
  const of = (id: string): { ended: number; fns: Set<() => void> } => {
    let c = chats.get(id);
    if (c === undefined) {
      c = { ended: 0, fns: new Set() };
      chats.set(id, c);
    }
    return c;
  };
  return {
    ended(id) {
      const c = of(id);
      c.ended += 1;
      for (const fn of c.fns) fn();
    },
    watch(id, fn) {
      const c = of(id);
      c.fns.add(fn);
      for (let i = 0; i < c.ended; i++) fn();
      return () => {
        c.fns.delete(fn);
        if (c.fns.size === 0) chats.delete(id);
      };
    },
  };
}

/**
 * Drives one call over the chat wire, as any client would: start, then the caller's lines and the line's
 * replies, until the caller hangs up, the line ends or transfers, or `maxTurns` caller turns were said.
 *
 * Where the server tells its turns' ends (`turnEnds`, the chat runtime's onTurnEnd), a reply is every line the
 * server says until its turn has ended: a reply and the correction the check after speaking sends after it,
 * however late, are one reply. On each end the driver pings the socket and takes the end once the pong is in,
 * so every message the turn sent, which went before the pong, has arrived. A turn that has not ended within
 * `timeoutMs` of the last message is ended there, so a lost end cannot hang a call.
 *
 * With no `turnEnds`, a reply is every line the server says until `settleMs` passes with none (a filler, then
 * the answer); a reply whose sentences are streaming (say_delta) is waited for until its say.
 */
export async function driveChat(o: {
  url: string;
  persona: Persona;
  caller: CallerFn;
  maxTurns: number;
  timeoutMs: number;
  origin?: string;
  settleMs?: number;
  /** The server's turn ends (eval/server.ts EvalServer.turnEnds); absent: a reply ends by settling. */
  turnEnds?: TurnEnds;
}): Promise<SimCall> {
  const settleMs = o.settleMs ?? 2000;
  const started = Date.now();
  const socket = new WebSocket(o.url, o.origin !== undefined ? { origin: o.origin } : {});
  const queue: Wire[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  socket.on('message', (d) => {
    queue.push(JSON.parse(d.toString()) as Wire);
    wake?.();
  });
  socket.on('close', () => {
    closed = true;
    wake?.();
  });
  socket.on('error', () => {
    closed = true;
    wake?.();
  });
  // Each pong answers the ping sent on a turn's end, in order, after every message the turn sent.
  let pongs = 0;
  socket.on('pong', () => {
    queue.push({ type: 'turn_end', turnEnd: ++pongs });
    wake?.();
  });
  /** How many of the server's turns of this chat the replies have taken (the greeting's is the first). */
  let taken = 0;
  let unwatch: (() => void) | null = null;
  /** The next message within `ms`, or null (silence, or the socket closed). */
  const next = async (ms: number): Promise<Wire | null> => {
    const deadline = Date.now() + ms;
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
  const call: SimCall = { persona: o.persona.id, turns: [], ended: 'turns', firstWordMs: [] };
  /** The line's reply: its lines until a pause; false when the line ended the chat. Returns the ms to its first word, or null for silence. */
  const reply = async (sentAt: number): Promise<{ firstWordMs: number | null; over: boolean }> => {
    const lines: string[] = [];
    let first: number | null = null;
    let over = false;
    // Sentences streamed (say_delta) and not yet followed by their reply's say: the reply is still coming.
    let streaming = false;
    // This reply's turn: the one after the last a reply took, whether or not that one's end came in time.
    const turn = ++taken;
    for (;;) {
      const m = await next(unwatch !== null || lines.length === 0 || streaming ? o.timeoutMs : settleMs);
      if (m === null) {
        if (closed) over = true;
        break;
      }
      if (m.turnEnd !== undefined) {
        // An earlier turn's end, come after its reply was ended at the ceiling: passed over.
        if (m.turnEnd < turn) continue;
        break;
      }
      if (m.type === 'say_delta' && typeof m.text === 'string') {
        // The first sentence sent: what a caller would hear first. The reply's text is its say.
        if (first === null) first = Date.now() - sentAt;
        streaming = true;
      } else if (m.type === 'say' && typeof m.text === 'string') {
        if (first === null) first = Date.now() - sentAt;
        streaming = false;
        lines.push(m.text);
      } else if (m.type === 'transfer' || m.type === 'end') {
        over = true;
        if (m.type === 'end') break;
      } else if (m.type === 'error') {
        over = true;
        break;
      }
    }
    if (lines.length > 0) call.turns.push({ who: 'line', text: lines.join(' '), atMs: sentAt - started + (first ?? 0) });
    else over = true;
    return { firstWordMs: first, over };
  };
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', (e) => reject(e));
    });
    // The reply streamed (each sentence as say_delta as soon as it is ready), so the first sentence is timed; and
    // the number the persona calls from, where it has one: the start's context, as a test page's would name it.
    socket.send(JSON.stringify({ type: 'start', v: 1, stream: true, ...(o.persona.callingFrom !== undefined ? { context: { callerNumber: o.persona.callingFrom } } : {}) }));
    const ready = await next(o.timeoutMs);
    if (ready === null || ready.type !== 'ready') throw new Error(`the chat did not start (${ready?.type ?? 'silence'})`);
    call.callId = ready.session;
    if (o.turnEnds !== undefined && typeof ready.session === 'string') {
      unwatch = o.turnEnds.watch(ready.session, () => {
        try {
          if (socket.readyState === WebSocket.OPEN) socket.ping();
        } catch {
          // The socket closed as the turn ended (the line ended the call): its close ends the reply.
        }
      });
    }
    const greeting = await reply(Date.now());
    if (greeting.over) {
      call.ended = 'line';
      return call;
    }
    for (let said = 0; ; said++) {
      if (said >= o.maxTurns) {
        call.ended = 'turns';
        break;
      }
      const line = await o.caller(o.persona, call.turns);
      if (line === null || typeof line !== 'string') {
        call.ended = 'caller';
        call.callerEnded = line ?? { how: 'hang_up' };
        socket.send(JSON.stringify({ type: 'end' }));
        break;
      }
      const sentAt = Date.now();
      call.turns.push({ who: 'caller', text: line, atMs: sentAt - started });
      socket.send(JSON.stringify({ type: 'text', text: line.slice(0, 500) }));
      const r = await reply(sentAt);
      call.firstWordMs.push(r.firstWordMs ?? o.timeoutMs);
      if (r.over) {
        call.ended = 'line';
        break;
      }
    }
    return call;
  } finally {
    unwatch?.();
    socket.close();
  }
}
