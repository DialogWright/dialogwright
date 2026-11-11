import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { ServerMessage } from '../../channel/chat/protocol';
import type { ModelEvent } from '../../converse/model/types';
import type { JevClient } from '../../jev/types';

/**
 * What the engine's tests of the converse fixture over the chat wire share (server/converse*.e2e.test.ts):
 * a chat client, a decision model that reads a yes, the model's side of a booking, and the audit's rows.
 */

/** The page's origin the tests' servers allow. */
export const CHAT_ORIGIN = 'https://www.example.com';
/** The number a chat names in its context. */
export const CALLER = '+15555550123';
/** A day the fixture's calendar is open, far enough ahead. */
export const DAY = '2030-01-15';
export const SLOT = `${DAY}:morning`;

/** A decision model that reads a yes where the caller's words say "yes", and keeps what it was asked. */
export function yesJev(): JevClient & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    async ask(req) {
      asked.push(req.state);
      const said = String((req.state as { said?: unknown }).said ?? '').toLowerCase();
      const yes = /\byes\b/.test(said);
      return {
        answers: { confirmsYes: { type: 'noul', noul: yes ? 0.95 : 0.05 }, confirmsNo: { type: 'noul', noul: yes ? 0.05 : 0.9 } },
        model: 'fake', usage: { inputTokens: 0, outputTokens: 0, estimated: true }, latencyMs: 1, source: 'jev',
      };
    },
  };
}

export const text = (delta: string): ModelEvent => ({ type: 'text', delta });
export const call = (id: string, name: string, args: Record<string, unknown>): ModelEvent => ({ type: 'tool_call', id, name, args });
export const done = (stop: 'end' | 'tool' = 'end'): ModelEvent => ({ type: 'done', stop, usage: { inputTokens: 120, outputTokens: 12 } });

/** The model's side of a booking: a lookup, a question, the booking read back, its confirmation, and the end. */
export const BOOKING: ModelEvent[][] = [
  [text('Let me look. '), call('c1', 'availability', { day: DAY }), done('tool')],
  [text('We have the morning, 9 to 12, '), text('or the afternoon. Which would suit you?'), done()],
  [call('c2', 'book', { window: SLOT, name: 'Sam Example', phone: 'caller' }), done('tool')],
  [text('You are booked for Tuesday morning.'), done()],
  [call('c3', 'end_call', {}), done('tool')],
];

/** A chat client as a site's page is one: its origin, the chat wire, and what has arrived. */
export class Chat {
  readonly received: ServerMessage[] = [];
  readonly closed: Promise<number>;
  private waiters: (() => void)[] = [];
  private constructor(private readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
    ws.on('message', (data) => {
      this.received.push(JSON.parse(data.toString()) as ServerMessage);
      for (const w of this.waiters.splice(0)) w();
    });
  }

  /** A chat on `base`'s `path`, kept in `open` for the test to close. */
  static open(base: string, open: Chat[], path = '/chat'): Promise<Chat> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}${path}`, { origin: CHAT_ORIGIN });
      ws.once('open', () => {
        const c = new Chat(ws);
        open.push(c);
        resolve(c);
      });
      ws.once('error', reject);
    });
  }

  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }

  async until(pred: (r: ServerMessage[]) => boolean, ms = 4000): Promise<ServerMessage[]> {
    const deadline = Date.now() + ms;
    while (!pred(this.received)) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out; received ${JSON.stringify(this.received)}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => (clearTimeout(t), resolve()));
      });
    }
    return this.received;
  }

  /** Sends `words` and waits for the line's next `say`; returns every message that came after the send. */
  async say(words: string): Promise<ServerMessage[]> {
    const before = this.received.length;
    this.send({ type: 'text', text: words });
    await this.until((r) => r.slice(before).some((m) => m.type === 'say'));
    return this.received.slice(before);
  }

  close(): void {
    this.ws.close();
  }
}

/** The words of each `say` among `ms`. */
export const says = (ms: readonly ServerMessage[]): string[] => ms.flatMap((m) => (m.type === 'say' ? [m.text] : []));

/** The audit rows in the folder `dir`, in its day files' order. */
export function auditRowsIn(dir: string): { type: string; callId: string; detail: Record<string, unknown> }[] {
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as { type: string; callId: string; detail: Record<string, unknown> }));
}
