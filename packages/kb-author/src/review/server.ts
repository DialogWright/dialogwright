import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import type { KbPlace } from 'dialogwright';
import { acceptTopic, approve, approvedSectionText, draftReviewProblems, editAndApprove, KB_FILE_ID, mergeTopic, reject, reviewerProblem, reviewState, seenOf, type ActionResult, type Edits, type Reviewer } from './actions';
import { TOPIC_ID } from '../draft/validate';
import { reportFromFiles, NO_NEAR_TOPIC } from '../gaps/report';
import { gapGroupPage, gapsPage, kbTopicPage, type GapsView } from './gapPages';
import { draftPage, esc, indexPage, notFoundPage, page, passagePage, topicPage, type PageContext } from './pages';

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
 * - Who is reviewing is kept per browser: once a request has shown the token, the page sets a session
 *   cookie (random, signed with a key made when it starts, HttpOnly, SameSite=Strict, named for its
 *   port), and the reviewer's name and team, and the outcome of their last change, belong to that
 *   session alone. Another browser with the token is asked who it is.
 * - Every form that changes a draft, a passage or a topic carries a hash of what the page showed when
 *   it was opened (actions.ts seenOf: the file as it is on disk, with its source section's text), and
 *   the change is refused when it no longer matches ("changed since you opened it: reload").
 * - Its pages load nothing from anywhere else (a Content-Security-Policy says so), are not cached and
 *   send no Referer.
 * - The Gaps tab (what callers asked that the knowledge base did not answer, from the traces) is read
 *   through the same token, and shows the callers' words as the traces recorded them.
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
  /**
   * Where the Gaps tab reads traces from: trace files, folders of them or globs (kb:gaps' `--traces`),
   * read again each time the tab is opened. Default: none (the tab says where to point it).
   */
  traces?: readonly string[];
  /** Where relative `traces` are from. Default: the process's working directory. */
  cwd?: string;
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
/** The most sessions kept; the oldest is dropped past it. */
const MAX_SESSIONS = 256;

/** One browser's review: who is reviewing, and the outcome of its last change, to show once. */
interface Session {
  reviewer: Reviewer | null;
  flash: ActionResult | null;
}

/** A request's cookies, by name. */
function cookiesOf(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return out;
}

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

/**
 * Where the reviewer form comes back to: a path of this page's own, else the list. It starts with one
 * slash and has only path characters after it: no second slash or backslash at its start (which a
 * browser reads as another host), no backslash anywhere, no query and no scheme.
 */
export function backTo(back: string | null): string {
  return back !== null && /^\/(?![/\\])[A-Za-z0-9_.~%/-]*$/.test(back) ? back : '/';
}

export async function startReviewServer(options: ReviewServerOptions): Promise<ReviewServer> {
  const { place } = options;
  const token = options.token ?? randomBytes(32).toString('base64url');
  const key = randomBytes(32);
  const sessions = new Map<string, Session>();
  let port = 0;
  const sign = (id: string): string => createHmac('sha256', key).update(id).digest('base64url');

  /** The request's session, from its signed cookie; a new one (and its cookie set) when it has none that holds. */
  const sessionFor = (req: IncomingMessage, res: ServerResponse): Session => {
    const name = `dw-review-${port}`;
    const [id, mac] = (cookiesOf(req).get(name) ?? '').split('.');
    if (id && mac && sameToken(mac, sign(id))) {
      const known = sessions.get(id);
      if (known) return known;
    }
    const fresh = randomBytes(24).toString('base64url');
    const session: Session = { reviewer: null, flash: null };
    sessions.set(fresh, session);
    if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
    res.setHeader('set-cookie', `${name}=${fresh}.${sign(fresh)}; Path=/; HttpOnly; SameSite=Strict`);
    return session;
  };

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

    const session = sessionFor(req, res);
    const nonce = randomBytes(16).toString('base64');
    const ctx = (path: string, seen?: string | null): PageContext => {
      const c: PageContext = { token, nonce, label: place.label, reviewer: session.reviewer, flash: session.flash, path, ...(seen ? { seen } : {}) };
      session.flash = null;
      return c;
    };
    let parts: string[];
    try {
      parts = url.pathname.split('/').filter((p) => p !== '').map(decodeURIComponent);
    } catch {
      return refuse(res, 404, 'no such page');
    }
    // An id from the URL names a draft, a passage or a topic, never a path: one that is not an id is not there.
    const [kindOf, idOf] = parts;
    if (idOf !== undefined && (((kindOf === 'draft' || kindOf === 'passage') && !KB_FILE_ID.test(idOf)) || (kindOf === 'topic' && !TOPIC_ID.test(idOf)))) {
      return method === 'POST' ? refuse(res, 404, 'no such action') : send(res, 404, notFoundPage(ctx(url.pathname), `${url.pathname} is not waiting for review.`), undefined, nonce);
    }
    const today = options.today();

    if (method === 'POST' && form) {
      const [kind, id, action] = parts;
      const done = (result: ActionResult, back: string): void => {
        session.flash = result;
        redirect(res, back);
      };
      const reviewer = session.reviewer;
      // What the reviewer saw when they opened the page: a form without it is out of date.
      const seen = form.get('seen') ?? '';
      if (kind === 'reviewer' && parts.length === 1) {
        const candidate = { by: (form.get('by') ?? '').trim(), owner: (form.get('owner') ?? '').trim() };
        const problem = reviewerProblem(candidate);
        if (problem === null) session.reviewer = candidate;
        return done(problem === null ? { ok: true, message: `reviewing as ${candidate.by} for ${candidate.owner}` } : { ok: false, message: problem, problems: [] }, backTo(form.get('back')));
      }
      if (id === undefined || action === undefined || parts.length !== 3) return refuse(res, 404, 'no such action');
      const facts = Object.keys(reviewState(place).kb?.settings.applies ?? {});
      if (kind === 'draft' || kind === 'passage') {
        if (action === 'approve') {
          const result = approve(place, id, reviewer, today, seen);
          return done(result, result.ok ? '/' : `/${kind}/${encodeURIComponent(id)}`);
        }
        if (action === 'edit') {
          const result = editAndApprove(place, id, editsOf(form, facts), reviewer, today, seen);
          return done(result, result.ok ? '/' : `/${kind}/${encodeURIComponent(id)}`);
        }
        if (action === 'reject' && kind === 'draft') {
          const result = reject(place, id, form.get('reason') ?? '', reviewer, today, seen);
          return done(result, result.ok ? '/' : `/draft/${encodeURIComponent(id)}`);
        }
      }
      if (kind === 'topic') {
        if (action === 'accept') {
          const as = form.get('as');
          const title = form.get('title');
          const result = acceptTopic(place, id, reviewer, { ...(as !== null ? { as } : {}), ...(title !== null ? { title } : {}), seen });
          return done(result, result.ok ? '/' : `/topic/${encodeURIComponent(id)}`);
        }
        if (action === 'merge') {
          const result = mergeTopic(place, id, form.get('into') ?? '', reviewer, seen);
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
      if (d) return send(res, 200, draftPage(ctx(url.pathname, seenOf(place, state, 'draft', d.id)), state.kb, d, problemsOf(d), state.proposed.find((t) => t.id === d.draft?.topic)), undefined, nonce);
    }
    if (parts.length === 2 && kind === 'passage' && state.kb) {
      const w = state.withheld.find((x) => x.passage.id === id);
      if (w) return send(res, 200, passagePage(ctx(url.pathname, seenOf(place, state, 'passage', w.passage.id)), state.kb, w, approvedSectionText(place, w.passage)), undefined, nonce);
    }
    if (parts.length === 2 && kind === 'topic' && state.kb) {
      const t = state.proposed.find((x) => x.id === id);
      if (t) return send(res, 200, topicPage(ctx(url.pathname, seenOf(place, state, 'topic', t.id)), state.kb, t, state.drafts.filter((d) => d.draft?.topic === t.id)), undefined, nonce);
      if (typeof id === 'string' && Object.hasOwn(state.kb.topics, id)) return send(res, 200, kbTopicPage(ctx(url.pathname), state.kb, id, state.withheld, state.drafts.filter((d) => d.draft?.topic === id)), undefined, nonce);
    }
    if (kind === 'gaps' && (parts.length === 1 || parts.length === 2)) {
      const c = ctx(url.pathname);
      if (!state.kb) return send(res, 200, page(c, 'Gaps', `<h1>Gaps</h1><section class="card" role="alert"><h2>The knowledge base does not load</h2><ul class="problems">${state.problems.map((p) => `<li class="mono">${esc(p)}</li>`).join('')}</ul></section>`), undefined, nonce);
      const cwd = options.cwd ?? process.cwd();
      const specs = options.traces ?? [];
      const view = (samples: number): GapsView => ({
        report: reportFromFiles({ kb: state.kb!, place, label: place.label, traces: specs, cwd, samples }).report,
        kb: state.kb!,
        withheld: new Set(state.withheld.map((w) => w.passage.id)),
        proposed: new Set(state.proposed.map((t) => t.id)),
        searched: specs.map((s) => resolve(cwd, s)),
      });
      if (parts.length === 1) return send(res, 200, gapsPage(c, view(3)), undefined, nonce);
      const v = view(25);
      const g = v.report.groups.find((x) => x.key === id);
      if (g) return send(res, 200, gapGroupPage(c, v, g), undefined, nonce);
      return send(res, 404, notFoundPage(c, id === NO_NEAR_TOPIC ? 'No gaps are near no topic now.' : `No gaps are listed for ${id ?? ''} now.`), undefined, nonce);
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
