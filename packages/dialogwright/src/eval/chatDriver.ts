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
  /** For each caller turn, ms from sending it to the line's first word. */
  firstWordMs: number[];
  /** The chat session, which is the call's id in the audit and the trace. */
  callId?: string;
}

/** What the simulated caller says next, given the call so far; null: the caller hangs up. */
export type CallerFn = (persona: Persona, turns: readonly SimTurn[]) => Promise<string | null>;

interface Wire {
  type: string;
  text?: string;
  session?: string;
}

/**
 * Drives one call over the chat wire, as any client would: start, then the caller's lines and the line's
 * replies, until the caller hangs up, the line ends or transfers, or `maxTurns` caller turns were said. A
 * reply is every line the server says until `settleMs` passes with none (a filler, then the answer).
 */
export async function driveChat(o: {
  url: string;
  persona: Persona;
  caller: CallerFn;
  maxTurns: number;
  timeoutMs: number;
  origin?: string;
  settleMs?: number;
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
    for (;;) {
      const m = await next(lines.length === 0 ? o.timeoutMs : settleMs);
      if (m === null) {
        if (closed) over = true;
        break;
      }
      if (m.type === 'say' && typeof m.text === 'string') {
        if (first === null) first = Date.now() - sentAt;
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
    socket.send(JSON.stringify({ type: 'start', v: 1 }));
    const ready = await next(o.timeoutMs);
    if (ready === null || ready.type !== 'ready') throw new Error(`the chat did not start (${ready?.type ?? 'silence'})`);
    call.callId = ready.session;
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
      if (line === null) {
        call.ended = 'caller';
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
    socket.close();
  }
}
