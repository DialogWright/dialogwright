/** HTTP plumbing shared by the apps' web chats (their AppRoutes). */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Chat request bodies are a login or one message: anything near this is not one. */
export const MAX_BODY = 8 * 1024;
/** The longest message a person may send in one turn; a longer one is refused with 413, not cut. */
export const CHAT_TEXT_MAX = 500;
/** A chat session nobody has written to for this long is dropped, and audited as abandoned. */
export const CHAT_IDLE_MS = 30 * 60 * 1000;

export function reply(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  reply(res, status, 'application/json', JSON.stringify(body));
}

/** The body, or null once a 413 has been sent for one over MAX_BODY. */
export function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        json(res, 413, { error: 'body too large' });
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (!tooLarge) reject(err);
    });
  });
}

export function parseObject(body: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(body);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
