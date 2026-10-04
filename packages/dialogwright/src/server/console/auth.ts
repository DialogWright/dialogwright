import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync, chmodSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, join } from 'node:path';
import type { AuditSink } from '../../run/turn';
import { isDirectLocalRequest, isLoopbackHost } from '../localOnly';
import type { ConsoleAuthSettings } from './settings';
import { signInPage, type SignInNote } from './pages';

/**
 * CONSOLE_AUTH=token: the operator console, from anywhere the tunnel reaches, for its one owner.
 *
 * Signing in. The server makes a one-time sign-in link when it starts, and again whenever
 * `pnpm console:link` asks (server/console/linkCli.ts): `<public base>/dashboard/login?code=<code>`, the
 * code 32 random bytes in hex, valid ten minutes, used once; a new link retires the one before it.
 * Opening the link shows a page whose button posts the code (so a link preview, which only fetches,
 * never uses it up). A code is kept as its SHA-256 and compared in constant time, and only a short hash
 * of it is ever logged. A valid code sets the session cookie and goes to the console.
 *
 * The session cookie. `dw_console=v1.<session id>.<expiry>.<HMAC-SHA256>`, signed with
 * CONSOLE_SESSION_KEY (so a session outlives a restart) or a key made when the process starts; HttpOnly,
 * SameSite=Strict, Path=/dashboard, Max-Age CONSOLE_SESSION_HOURS, and Secure except on a laptop
 * (PUBLIC_HOST a name for this machine) for a plain http request made on it. Signing out clears it and
 * refuses that session from then on.
 *
 * Without a session, the console's page answers 302 to the sign-in page and everything else under
 * /dashboard (the live feed, the traces, the boot id, the view module) answers 401. The sign-in page
 * carries nothing of the app's or of any call. Every answer under /dashboard carries a
 * Content-Security-Policy, X-Frame-Options DENY, Referrer-Policy no-referrer, Cache-Control no-store and
 * nosniff.
 *
 * Failed sign-ins are limited: ten in a quarter of an hour from one address (the tunnel's
 * cf-connecting-ip or x-forwarded-for, else the socket's), then a hundred in a quarter of an hour
 * through the tunnel for everyone; past either, an attempt is refused (429) before its code is looked
 * at. A request made on this machine is held only to its own address's limit, so an owner at the server
 * can always sign in.
 *
 * The link file. The current link is written to CONSOLE_LINK_FILE (mode 600, in a folder of mode 700),
 * with the port and a key made when the process starts. `pnpm console:link` reads the file and posts the
 * key to `/dashboard/link`, which mints a new link only for a request made directly on this machine
 * that carries the key and no Origin (no browser page): through the tunnel it is not there at all (404).
 * Being on the machine is not enough, as other accounts on it can reach its ports; reading a file only
 * the server's own account can read is what proves the owner.
 *
 * The access log. Each of these is appended to the audit chain as `console_access`, channel `console`:
 * a link made (`link_made`), a sign-in (`sign_in`) and a refusal (`sign_in_refused`, with why; once per
 * lock while rate-limited), a sign-out, the live feed's first open in a session (`live`), and every
 * replay of a stored call (`replay`, under that call's id). Each names the session by a short hash of
 * its id, never the cookie, and a code by a short hash, never the code. The entry is written before the
 * answer, so an access the audit could not record is not served.
 */

export const CONSOLE_COOKIE = 'dw_console';
export const LOGIN_PATH = '/dashboard/login';
export const LOGOUT_PATH = '/dashboard/logout';
/** The local-only endpoint `pnpm console:link` posts to; its key goes in this header. */
export const LINK_PATH = '/dashboard/link';
export const LINK_KEY_HEADER = 'x-console-key';
/** How long a sign-in link works. */
export const CODE_TTL_MS = 10 * 60 * 1000;
/** The window failed sign-ins are counted in, and how many from one address, and in all, it allows. */
export const FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const FAILURES_PER_ADDRESS = 10;
export const FAILURES_IN_ALL = 100;

const CODE = /^[0-9a-f]{64}$/;
const COOKIE_VALUE = /^v1\.([0-9a-f]{32})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;
const MAX_FORM = 4096;
/** The most addresses, retired codes and noted sessions kept in memory; the oldest go first. */
const MAX_TRACKED = 10_000;
const MAX_RETIRED = 16;

/** A signed-in browser: its session id, and a short hash of it for the audit. */
export interface ConsoleSession {
  id: string;
  hash: string;
  expiresAt: number;
}

export interface SignInLink {
  url: string;
  /** The code in the url: for the link file and a test, never a log. */
  code: string;
  expiresAt: number;
  /** A short hash of the code, which a log and the audit name it by. */
  codeHash: string;
}

/** What the console's routes ask of the sign-in (server/dashboard/routes.ts). */
export interface ConsoleGate {
  /** Sets the headers every console answer carries; with a nonce, the policy lets the page's own script and style run. */
  protect(res: ServerResponse, nonce?: string): void;
  /** Answers the sign-in's own paths (login, logout, link); false for any other. */
  handle(req: IncomingMessage, res: ServerResponse, path: string): boolean;
  sessionOf(req: IncomingMessage): ConsoleSession | null;
  /** Answers a request with no session: the page to the sign-in page (302), anything else 401. */
  refuse(req: IncomingMessage, res: ServerResponse, path: string): void;
  /** Records the live feed's first open in a session. */
  noteLive(session: ConsoleSession): void;
  /** Records a replay of a stored call. */
  noteReplay(session: ConsoleSession, callId: string): void;
}

export interface ConsoleAuthOptions {
  settings: ConsoleAuthSettings;
  publicHost: string;
  /** The server's audit chain, for the access log; absent, nothing is recorded (a test that does not care). */
  audit?: AuditSink | null;
  now?: () => number;
  log?: (line: string) => void;
}

/** The policy of a console answer: nothing from anywhere else, no framing, and inline code only by nonce. */
export function consoleCsp(nonce?: string): string {
  const own = nonce ? ` 'nonce-${nonce}'` : '';
  return [
    "default-src 'none'",
    `script-src 'self'${own}`,
    `style-src 'self'${own}`,
    // The console draws its bars and delays with style attributes; a style cannot run code.
    "style-src-attr 'unsafe-inline'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
/** A short hash, for a log or the audit: enough to tell two apart, nothing to sign in with. */
const shortHash = (s: string, length = 8): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, length);

/** Whether two strings are equal, compared in constant time (their hashes, so their lengths do not show). */
function sameSecret(given: string, expected: string): boolean {
  return timingSafeEqual(sha256(given), sha256(expected));
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** The address a request came from: the tunnel's word for it (Cloudflare's, else the first forwarded), else the socket's. */
function clientAddress(req: IncomingMessage): string {
  const raw = header(req, 'cf-connecting-ip') ?? header(req, 'x-forwarded-for')?.split(',')[0] ?? req.socket.remoteAddress ?? '';
  const a = raw.trim();
  // An address, not whatever a client put in a header: it reaches the audit and a map's keys.
  return /^[0-9A-Fa-f:.]{2,45}$/.test(a) ? a : 'unknown';
}

function cookieValues(req: IncomingMessage, name: string): string[] {
  const out: string[] = [];
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) out.push(part.slice(eq + 1).trim());
  }
  return out;
}

function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_FORM) {
        resolve(null);
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

/** A map that forgets its oldest entries past MAX_TRACKED, and entries whose time has passed. */
function prune<V>(map: Map<string, V>, expired: (v: V) => boolean): void {
  for (const [k, v] of map) if (expired(v)) map.delete(k);
  while (map.size > MAX_TRACKED) map.delete(map.keys().next().value!);
}

/**
 * Writes `content` to `file` readable by its owner alone: the folder made with mode 700 (the default
 * `.console-link` folder is the server's own, and put back to 700 if it is not), the file written
 * whole under a new name with mode 600 and renamed over the old. A folder of someone else's, or one
 * others may write in (who could replace the file), is refused.
 */
export function writeOwnerOnly(file: string, content: string, platform: NodeJS.Platform = process.platform): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') {
    const st = lstatSync(dir);
    if (!st.isDirectory()) throw new Error(`CONSOLE_LINK_FILE's folder ${dir} is not a folder`);
    if (process.getuid && st.uid !== process.getuid()) throw new Error(`CONSOLE_LINK_FILE's folder ${dir} belongs to another account: name a folder of the server's own`);
    if (st.mode & 0o077) {
      if (basename(dir) === '.console-link') chmodSync(dir, 0o700);
      else if (st.mode & 0o022) throw new Error(`CONSOLE_LINK_FILE's folder ${dir} can be written by others (mode ${(st.mode & 0o777).toString(8)}): chmod 700 ${dir}, or leave CONSOLE_LINK_FILE unset`);
    }
  }
  const temp = join(dir, `.link-${randomBytes(8).toString('hex')}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

/** What the link file holds: the current link (null once used), the server's port, and the key that mints a new one. */
export interface LinkFile {
  url: string | null;
  expiresAt: string | null;
  port: number;
  key: string;
  pid: number;
}

export class ConsoleAuth implements ConsoleGate {
  private readonly key: Buffer;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly audit: AuditSink | null;
  /** The key `pnpm console:link` reads from the link file and posts back. */
  private readonly linkKey = randomBytes(32).toString('hex');
  private port = 0;
  private pending: { digest: Buffer; expiresAt: number; hash: string } | null = null;
  private retired: Array<{ digest: Buffer; reason: 'used' | 'expired' | 'replaced' }> = [];
  /** Signed-out sessions, refused until they would have expired. */
  private readonly revoked = new Map<string, number>();
  /** Sessions whose first live feed has been recorded. */
  private readonly live = new Map<string, number>();
  private readonly failures = new Map<string, number[]>();
  private failuresInAll: number[] = [];
  /** When a lock (an address's, or `*` for all) was last recorded, so one lock is one audit entry. */
  private readonly locksNoted = new Map<string, number>();

  constructor(private readonly o: ConsoleAuthOptions) {
    this.key = o.settings.sessionKey ?? randomBytes(32);
    this.now = o.now ?? (() => Date.now());
    this.log = o.log ?? (() => {});
    this.audit = o.audit ?? null;
  }

  /** Where the link file is. */
  get linkFile(): string {
    return this.o.settings.linkFile;
  }

  /** Once the server listens: the port is known, so the first link is made and its file written. */
  start(port: number): SignInLink {
    this.port = port;
    return this.mint('start');
  }

  /** Removes the link file: its key dies with the process. */
  stop(): void {
    rmSync(this.linkFile, { force: true });
  }

  /** A new one-time link; one made before it that was not used stops working. The link file is rewritten. */
  mint(by: 'start' | 'console:link' = 'console:link'): SignInLink {
    const now = this.now();
    if (this.pending) this.retire(this.pending.digest, now > this.pending.expiresAt ? 'expired' : 'replaced');
    const code = randomBytes(32).toString('hex');
    const expiresAt = now + CODE_TTL_MS;
    const hash = shortHash(code);
    const url = `${this.base()}${LOGIN_PATH}?code=${code}`;
    this.note('console', { event: 'link_made', code: hash, by });
    this.pending = { digest: sha256(code), expiresAt, hash };
    this.writeLinkFile(url, expiresAt);
    this.log(`console: a sign-in link (code ${hash}…, until ${new Date(expiresAt).toISOString().slice(11, 16)} UTC, once) is in ${this.linkFile}; pnpm console:link prints a new one`);
    return { url, code, expiresAt, codeHash: hash };
  }

  protect(res: ServerResponse, nonce?: string): void {
    res.setHeader('content-security-policy', consoleCsp(nonce));
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
  }

  sessionOf(req: IncomingMessage): ConsoleSession | null {
    const now = this.now();
    for (const value of cookieValues(req, CONSOLE_COOKIE)) {
      const m = COOKIE_VALUE.exec(value);
      if (!m) continue;
      const [, id, exp, mac] = m as unknown as [string, string, string, string];
      const expected = this.sign(`v1.${id}.${exp}`);
      const given = Buffer.from(mac, 'base64url');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) continue;
      const expiresAt = Number(exp) * 1000;
      if (expiresAt <= now || this.revoked.has(id)) continue;
      return { id, hash: shortHash(`session:${id}`, 16), expiresAt };
    }
    return null;
  }

  refuse(req: IncomingMessage, res: ServerResponse, path: string): void {
    if ((path === '/dashboard' || path === '/dashboard/') && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(302, { location: LOGIN_PATH, 'content-length': 0 });
      res.end();
      return;
    }
    const body = `sign in first: ${LOGIN_PATH}\n`;
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  noteLive(session: ConsoleSession): void {
    if (this.live.has(session.id)) return;
    this.note('console', { event: 'live', session: session.hash });
    this.live.set(session.id, session.expiresAt);
    prune(this.live, (exp) => exp <= this.now());
  }

  noteReplay(session: ConsoleSession, callId: string): void {
    this.note(callId, { event: 'replay', session: session.hash });
  }

  handle(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    if (path !== LOGIN_PATH && path !== LOGOUT_PATH && path !== LINK_PATH) return false;
    const work = path === LOGIN_PATH ? this.login(req, res) : path === LOGOUT_PATH ? this.logout(req, res) : this.link(req, res);
    work.catch((e: unknown) => {
      this.log(`console: ${path} failed: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) this.text(res, 500, 'error');
      else res.end();
    });
    return true;
  }

  // ---------- the routes ----------

  private async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    if (method === 'GET' || method === 'HEAD') {
      if (this.sessionOf(req)) return this.redirect(res, '/dashboard');
      const url = new URL(req.url ?? LOGIN_PATH, 'http://console.invalid');
      const code = url.searchParams.get('code') ?? '';
      const note: SignInNote | undefined = url.searchParams.get('out') === '1' ? 'signed-out' : undefined;
      return this.page(req, res, 200, CODE.test(code) ? { code, ...(note ? { note } : {}) } : note ? { note } : {});
    }
    if (method !== 'POST') return this.text(res, 405, 'method not allowed', { allow: 'GET, HEAD, POST' });
    if (!this.originOk(req)) return this.text(res, 403, 'a sign-in must come from the sign-in page');
    if (!(header(req, 'content-type') ?? '').startsWith('application/x-www-form-urlencoded')) return this.text(res, 415, 'a sign-in is sent as a form');
    const from = clientAddress(req);
    const local = isDirectLocalRequest(req, this.o.publicHost);
    const via = local ? 'local' : 'tunnel';
    const lock = this.locked(from, local);
    if (lock !== null) {
      this.noteLock(lock, from, via);
      return this.page(req, res, 429, { note: 'limited' });
    }
    const form = await readForm(req);
    if (form === null) return this.text(res, 413, 'too large');
    const code = (form.get('code') ?? '').slice(0, 256);
    const verdict = this.redeem(code);
    if (verdict !== 'ok') {
      this.fail(from);
      this.note('console', { event: 'sign_in_refused', reason: verdict, code: shortHash(code), from, via });
      this.log(`console: sign-in refused (${verdict}, code ${shortHash(code)}…, from ${from})`);
      return this.page(req, res, 403, { note: 'refused' });
    }
    const hours = this.o.settings.sessionHours;
    const id = randomBytes(16).toString('hex');
    const expSec = Math.floor(this.now() / 1000) + hours * 3600;
    const payload = `v1.${id}.${expSec}`;
    const session = shortHash(`session:${id}`, 16);
    // Recorded before the cookie is set: a sign-in the audit could not record is not made.
    this.note('console', { event: 'sign_in', session, code: shortHash(code), from, via });
    this.log(`console: signed in (session ${session}, from ${from})`);
    this.writeLinkFile(null, null);
    res.setHeader('set-cookie', `${CONSOLE_COOKIE}=${payload}.${this.sign(payload).toString('base64url')}; ${this.cookieAttributes(req)}; Max-Age=${hours * 3600}`);
    this.redirect(res, '/dashboard');
  }

  private async logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return this.text(res, 405, 'method not allowed', { allow: 'POST' });
    if (!this.originOk(req)) return this.text(res, 403, 'a sign-out must come from the console');
    const session = this.sessionOf(req);
    if (session) {
      this.note('console', { event: 'sign_out', session: session.hash });
      this.revoked.set(session.id, session.expiresAt);
      prune(this.revoked, (exp) => exp <= this.now());
    }
    res.setHeader('set-cookie', `${CONSOLE_COOKIE}=; ${this.cookieAttributes(req)}; Max-Age=0`);
    this.redirect(res, `${LOGIN_PATH}?out=1`);
  }

  private async link(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Through the tunnel there is no such path.
    if (!isDirectLocalRequest(req, this.o.publicHost)) return this.text(res, 404, 'not found');
    if (req.method !== 'POST') return this.text(res, 405, 'method not allowed', { allow: 'POST' });
    // pnpm console:link sends no Origin; a browser's page always does.
    const given = header(req, LINK_KEY_HEADER);
    if (header(req, 'origin') !== undefined || given === undefined || !sameSecret(given, this.linkKey)) {
      this.note('console', { event: 'link_refused', from: clientAddress(req) });
      return this.text(res, 403, 'the link file\'s key is needed: run pnpm console:link');
    }
    const made = this.mint('console:link');
    const body = JSON.stringify({ url: made.url, expiresAt: new Date(made.expiresAt).toISOString() });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  // ---------- codes, sessions, limits ----------

  private base(): string {
    return isLoopbackHost(this.o.publicHost) ? `http://localhost:${this.port}` : `https://${this.o.publicHost}`;
  }

  private sign(payload: string): Buffer {
    return createHmac('sha256', this.key).update(payload, 'utf8').digest();
  }

  private retire(digest: Buffer, reason: 'used' | 'expired' | 'replaced'): void {
    this.retired.push({ digest, reason });
    if (this.retired.length > MAX_RETIRED) this.retired.shift();
  }

  /** Whether `code` signs in, using it up if it does; else why not. */
  private redeem(code: string): 'ok' | 'malformed' | 'used' | 'expired' | 'replaced' | 'unknown' {
    if (!CODE.test(code)) return 'malformed';
    const digest = sha256(code);
    const p = this.pending;
    if (p && timingSafeEqual(digest, p.digest)) {
      this.pending = null;
      if (this.now() > p.expiresAt) {
        this.retire(digest, 'expired');
        return 'expired';
      }
      this.retire(digest, 'used');
      return 'ok';
    }
    for (const r of this.retired) if (timingSafeEqual(digest, r.digest)) return r.reason;
    return 'unknown';
  }

  private recent(times: number[]): number[] {
    const since = this.now() - FAILURE_WINDOW_MS;
    return times.filter((t) => t > since);
  }

  /** Whether an attempt from `from` is refused unread: its address's limit, or (through the tunnel) everyone's. */
  private locked(from: string, local: boolean): string | null {
    const mine = this.recent(this.failures.get(from) ?? []);
    if (mine.length >= FAILURES_PER_ADDRESS) return from;
    this.failuresInAll = this.recent(this.failuresInAll);
    if (!local && this.failuresInAll.length >= FAILURES_IN_ALL) return '*';
    return null;
  }

  private fail(from: string): void {
    const now = this.now();
    const before = this.recent(this.failures.get(from) ?? []);
    // Deleted and set again, so the map's order is the order addresses last failed in (prune drops the oldest).
    this.failures.delete(from);
    this.failures.set(from, [...before, now]);
    prune(this.failures, (times) => this.recent(times).length === 0);
    this.failuresInAll.push(now);
  }

  private noteLock(lock: string, from: string, via: string): void {
    const at = this.locksNoted.get(lock);
    if (at !== undefined && this.now() - at < FAILURE_WINDOW_MS) return;
    this.locksNoted.set(lock, this.now());
    prune(this.locksNoted, (t) => this.now() - t >= FAILURE_WINDOW_MS);
    this.note('console', { event: 'sign_in_refused', reason: 'rate_limited', limit: lock === '*' ? 'all' : 'address', from, via });
    this.log(lock === '*'
      ? `console: ${FAILURES_IN_ALL} failed sign-ins in ${FAILURE_WINDOW_MS / 60_000} minutes: sign-in through the tunnel is refused for now`
      : `console: ${FAILURES_PER_ADDRESS} failed sign-ins from ${from}: refused for ${FAILURE_WINDOW_MS / 60_000} minutes`);
  }

  // ---------- answers ----------

  /** A form post comes from this console's own page: no Origin, `null` (a page under no-referrer), or this server's own. */
  private originOk(req: IncomingMessage): boolean {
    const origin = header(req, 'origin');
    if (origin === undefined || origin === 'null') return true;
    if (origin === `https://${this.o.publicHost}`) return true;
    return isDirectLocalRequest(req, this.o.publicHost) && origin === `http://${header(req, 'host') ?? ''}`;
  }

  private cookieAttributes(req: IncomingMessage): string {
    // A laptop's own plain http is the one place a Secure cookie would never be sent back.
    const plainLaptop = isLoopbackHost(this.o.publicHost) && isDirectLocalRequest(req, this.o.publicHost);
    return `Path=/dashboard; HttpOnly; SameSite=Strict${plainLaptop ? '' : '; Secure'}`;
  }

  private page(req: IncomingMessage, res: ServerResponse, status: number, o: { code?: string; note?: SignInNote }): void {
    const nonce = randomBytes(16).toString('base64');
    this.protect(res, nonce);
    const body = signInPage({ nonce, hours: this.o.settings.sessionHours, ...o });
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  private text(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
    const text = `${body}\n`;
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers });
    res.end(text);
  }

  private redirect(res: ServerResponse, location: string): void {
    res.writeHead(303, { location, 'content-length': 0 });
    res.end();
  }

  private note(callId: string, detail: Record<string, string | number | boolean | null>): void {
    this.audit?.append(callId, 'console', { type: 'console_access', detail });
  }

  private writeLinkFile(url: string | null, expiresAt: number | null): void {
    if (this.port === 0) return;
    const file: LinkFile = { url, expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(), port: this.port, key: this.linkKey, pid: process.pid };
    writeOwnerOnly(this.linkFile, `${JSON.stringify(file, null, 2)}\n`);
  }
}
