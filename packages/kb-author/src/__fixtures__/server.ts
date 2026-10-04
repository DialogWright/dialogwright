import { createServer, type Server } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The tests' website: a static server on 127.0.0.1 (a free port) over ./site, with /files/* served
 * from ./folder (the patron guide PDF, the volunteer handbook DOCX), /partner redirecting off the host,
 * and every request it receives recorded. Nothing in the tests reaches the network.
 */

export const FIXTURES = fileURLToPath(new URL('.', import.meta.url));
export const SITE = join(FIXTURES, 'site');
export const FOLDER = join(FIXTURES, 'folder');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.csv': 'text/csv',
  '.png': 'image/png',
};

export interface FixtureSite {
  /** The site's origin, `http://127.0.0.1:<port>`. */
  origin: string;
  /** The paths requested, in order, with the User-Agent each came with. */
  requests: { path: string; userAgent: string | undefined; cookie: string | undefined }[];
  close(): Promise<void>;
}

/** Serves the fixture site until closed. `routes` answer a path first (status, headers, body). */
export async function serveSite(routes: Record<string, { status: number; headers?: Record<string, string>; body?: string }> = {}): Promise<FixtureSite> {
  const requests: FixtureSite['requests'] = [];
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fixture').pathname;
    requests.push({ path: req.url ?? '/', userAgent: req.headers['user-agent'], cookie: req.headers.cookie });
    const route = routes[path];
    if (route) {
      res.writeHead(route.status, route.headers ?? {});
      res.end(route.body ?? '');
      return;
    }
    if (path === '/partner') {
      res.writeHead(302, { location: 'http://offsite.invalid/partner.html' });
      res.end();
      return;
    }
    const base = path.startsWith('/files/') ? FOLDER : SITE;
    const rel = normalize(decodeURIComponent(path.startsWith('/files/') ? path.slice('/files'.length) : path));
    let file = join(base, rel);
    if (!file.startsWith(base)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
      const body = readFileSync(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'set-cookie': 'session=fixture' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the fixture server has no port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A fake clock: `sleep` moves it on at once, and every wait is recorded. */
export function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; waits: number[] } {
  let t = 0;
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      waits.push(ms);
      t += ms;
    },
    waits,
  };
}

/** A fetch that records each URL asked for and refuses any host but the fixture's, before passing it on. */
export function guardedFetch(origin: string): { fetch: typeof globalThis.fetch; asked: string[] } {
  const asked: string[] = [];
  const host = new URL(origin).host;
  const guarded: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    asked.push(url);
    if (new URL(url).host !== host) throw new Error(`the crawler asked for ${url}, off the fixture's host`);
    return globalThis.fetch(input, init);
  };
  return { fetch: guarded, asked };
}
