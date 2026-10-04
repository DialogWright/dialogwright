import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { KbPlace } from 'dialogwright';
import { acceptTopic, approve, approvedSectionText, draftReviewProblems, editAndApprove, mergeTopic, reject, reviewerProblem, reviewState, type ActionResult, type Edits, type Reviewer } from './actions';
import { draftPage, indexPage, notFoundPage, passagePage, topicPage, type PageContext } from './pages';

/**
 * kb:review's server: the review page, on this machine only, for the person who started it.
 *
 * - It listens on 127.0.0.1 alone, on a free port the system picks (or --port), and answers only a
 *   request from a loopback address whose Host is that address and port (so a web page elsewhere
 *   cannot reach it through a name that resolves to 127.0.0.1).
 * - It makes a random token when it starts (32 bytes) and prints its URL with it. Every request,
 *   reading or writing, must carry the token (the `token` query parameter, the form field of a
 *   POST, or an `x-review-token` header), compared in constant time; without it the answer is 403.
 *   A POST must also come from the page itself when the browser says where it comes from (Origin).
 * - Its pages load nothing from anywhere else (a Content-Security-Policy says so), are not cached and
 *   send no Referer.
 * - The operator console is not where it lives: the console has no access control until Phase 8,
 *   and a page that approves what callers are told should not be reachable through the console's
 *   tunnel. It stops with Ctrl-C.
 */

export interface ReviewServerOptions {
  place: KbPlace;
  /** Today, as an ISO date: the day an approval or a rejection is recorded on. */
  today: () => string;
  /** The port; default 0, a free one. */
  port?: number;
  /** The token (a test's); default a new random one. */
  token?: string;
}

export interface ReviewServer {
  /** The page's URL, with the token. */
  url: string;
  /** Where it listens, without the token. */
  origin: string;
  token: string;
  port: number;
  close(): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1']);
const MAX_BODY = 64 * 1024;

/** Whether two strings are equal, compared in constant time (their hashes, so their lengths do not show). */
export function sameToken(given: string, token: string): boolean {
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(token, 'utf8').digest();
  return timingSafeEqual(a, b) && given.length === token.length;
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** The edits a form gives: the answer, an excerpt when there is one, each fact's ticked values, the dates. */
function editsOf(form: URLSearchParams, facts: readonly string[]): Edits {
  const applies: Record<string, string[]> = {};
  for (const fact of facts) {
    const values = form.getAll(`applies.${fact}`).filter((v) => v !== '');
    if (values.length > 0) applies[fact] = values;
  }
  const to = (form.get('to') ?? '').trim();
  return {
    answer: form.get('answer') ?? '',
    ...(form.has('excerpt') ? { excerpt: form.get('excerpt') ?? '' } : {}),
    applies,
    effective: { from: (form.get('from') ?? '').trim(), ...(to !== '' ? { to } : {}) },
  };
}

export async function startReviewServer(options: ReviewServerOptions): Promise<ReviewServer> {
  const { place } = options;
  const token = options.token ?? randomBytes(32).toString('base64url');
  let reviewer: Reviewer | null = null;
  let flash: ActionResult | null = null;
  let port = 0;

  const send = (res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', nonce?: string): void => {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce ?? 'none'}'; script-src 'nonce-${nonce ?? 'none'}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    });
    res.end(body);
  };
  const refuse = (res: ServerResponse, status: number, why: string): void => send(res, status, `${why}\n`, 'text/plain; charset=utf-8');
  const redirect = (res: ServerResponse, path: string): void => {
    res.writeHead(303, { location: `${path}?token=${encodeURIComponent(token)}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end();
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // This machine only: a loopback peer, addressed by this server's own host and port.
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return refuse(res, 403, 'the review page answers only this machine');
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return refuse(res, 421, 'the review page answers only at the address it printed');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const method = req.method ?? 'GET';
    let form: URLSearchParams | null = null;
    if (method === 'POST') {
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return refuse(res, 403, 'a change must come from the review page itself');
      if (!(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) return refuse(res, 415, 'a change is sent as a form');
      const body = await readBody(req);
      if (body === null) return refuse(res, 413, 'too large');
      form = new URLSearchParams(body);
    } else if (method !== 'GET' && method !== 'HEAD') return refuse(res, 405, 'only GET and POST');
    const header = req.headers['x-review-token'];
    const given = form?.get('token') ?? url.searchParams.get('token') ?? (typeof header === 'string' ? header : null);
    if (given === null || !sameToken(given, token)) return refuse(res, 403, 'the review page needs the token it printed when it started: open the URL it printed');

    const nonce = randomBytes(16).toString('base64');
    const ctx = (path: string): PageContext => {
      const c: PageContext = { token, nonce, label: place.label, reviewer, flash, path };
      flash = null;
      return c;
    };
    const parts = url.pathname.split('/').filter((p) => p !== '').map(decodeURIComponent);
    const today = options.today();

    if (method === 'POST' && form) {
      const [kind, id, action] = parts;
      const done = (result: ActionResult, back: string): void => {
        flash = result;
        redirect(res, back);
      };
      if (kind === 'reviewer' && parts.length === 1) {
        const candidate = { by: (form.get('by') ?? '').trim(), owner: (form.get('owner') ?? '').trim() };
        const problem = reviewerProblem(candidate);
        if (problem === null) reviewer = candidate;
        const back = form.get('back') ?? '/';
        return done(problem === null ? { ok: true, message: `reviewing as ${candidate.by} for ${candidate.owner}` } : { ok: false, message: problem, problems: [] }, back.startsWith('/') && !back.startsWith('//') ? back : '/');
      }
      if (id === undefined || action === undefined || parts.length !== 3) return refuse(res, 404, 'no such action');
      const facts = Object.keys(reviewState(place).kb?.settings.applies ?? {});
      if (kind === 'draft' || kind === 'passage') {
        if (action === 'approve') {
          const result = approve(place, id, reviewer, today);
          return done(result, result.ok ? '/' : `/${kind}/${encodeURIComponent(id)}`);
        }
        if (action === 'edit') {
          const result = editAndApprove(place, id, editsOf(form, facts), reviewer, today);
          return done(result, result.ok ? '/' : `/${kind}/${encodeURIComponent(id)}`);
        }
        if (action === 'reject' && kind === 'draft') {
          const result = reject(place, id, form.get('reason') ?? '', reviewer, today);
          return done(result, result.ok ? '/' : `/draft/${encodeURIComponent(id)}`);
        }
      }
      if (kind === 'topic') {
        if (action === 'accept') {
          const result = acceptTopic(place, id, reviewer, form.get('as') ?? undefined);
          return done(result, result.ok ? '/' : `/topic/${encodeURIComponent(id)}`);
        }
        if (action === 'merge') {
          const result = mergeTopic(place, id, form.get('into') ?? '', reviewer);
          return done(result, result.ok ? '/' : `/topic/${encodeURIComponent(id)}`);
        }
      }
      return refuse(res, 404, 'no such action');
    }

    const state = reviewState(place);
    const problemsOf = (d: (typeof state.drafts)[number]): string[] => draftReviewProblems(place, state, d);
    if (parts.length === 0) return send(res, 200, indexPage(ctx('/'), state, problemsOf), undefined, nonce);
    const [kind, id] = parts;
    if (parts.length === 2 && kind === 'draft') {
      const d = state.drafts.find((x) => x.id === id);
      if (d) return send(res, 200, draftPage(ctx(url.pathname), state.kb, d, problemsOf(d), state.proposed.find((t) => t.id === d.draft?.topic)), undefined, nonce);
    }
    if (parts.length === 2 && kind === 'passage' && state.kb) {
      const w = state.withheld.find((x) => x.passage.id === id);
      if (w) return send(res, 200, passagePage(ctx(url.pathname), state.kb, w, approvedSectionText(place, w.passage)), undefined, nonce);
    }
    if (parts.length === 2 && kind === 'topic' && state.kb) {
      const t = state.proposed.find((x) => x.id === id);
      if (t) return send(res, 200, topicPage(ctx(url.pathname), state.kb, t, state.drafts.filter((d) => d.draft?.topic === t.id)), undefined, nonce);
    }
    return send(res, 404, notFoundPage(ctx(url.pathname), `${url.pathname} is not waiting for review (it may have been approved or rejected already).`), undefined, nonce);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) refuse(res, 500, `the review page failed: ${error instanceof Error ? error.message : String(error)}`);
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    url: `${origin}/?token=${encodeURIComponent(token)}`,
    origin,
    token,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
