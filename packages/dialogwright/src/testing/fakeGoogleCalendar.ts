import { verify, type KeyObject } from 'node:crypto';

/**
 * Google's token endpoint and the two Calendar API v3 endpoints the converse runtime's Google calendar uses
 * (converse/sources/googleCalendar.ts), served from memory as a `fetch`, for the engine's tests: nothing
 * leaves the process and no real Google account is reached. Internal, never exported to apps.
 *
 * - `POST <token uri>`: a service account's signed assertion (grant type jwt-bearer) checked against the
 *   public key of the pair the test made, its issuer, audience, scope and times; an access token in return,
 *   which lives `tokenLifetimeS` on the fake's clock.
 * - `GET /calendar/v3/calendars/<id>/events`: the events overlapping `timeMin` to `timeMax`, cancelled ones
 *   left out, in pages of `pageSize`.
 * - `GET /calendar/v3/calendars/<id>/events/<event id>`: one event, a cancelled (deleted) one too.
 * - `POST /calendar/v3/calendars/<id>/events`: an event inserted with the id it brings (base32hex, 5 to 1024
 *   characters); an id already used is 409, as Google answers.
 *
 * A test can make the next requests fail with a status (`failNext`), or answer slowly (`delayMs`, and `writeDelayMs` for an insert alone), or send a body that stalls after its headers (`stallBodyMs`), or leave a standing event out of a listing (`unlisted`): a slow
 * answer is made first and sent late, as a server that wrote and replied after the caller gave up.
 */

export interface FakeGoogleTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface FakeGoogleEvent {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  transparency?: 'opaque' | 'transparent';
  summary?: string;
  description?: string;
  start: FakeGoogleTime;
  end: FakeGoogleTime;
  extendedProperties?: { private?: Record<string, string> };
}

export interface FakeGoogleCalendarOptions {
  /** The public key of the service account's key pair (the test's own, made with node:crypto). */
  publicKey: KeyObject | string;
  clientEmail: string;
  /** The calendars that exist, by id; any other is 404. */
  calendars: string[];
  tokenUri?: string;
  /** The fake's clock, in ms: when a token expires. Default Date.now. */
  now?: () => number;
  /** The most events one page of a listing holds (Google's default 250). */
  pageSize?: number;
}

export const FAKE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const API_PREFIX = '/calendar/v3/calendars/';
const EVENT_ID = /^[a-v0-9]{5,1024}$/;

const fromBase64Url = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** The span of an event's time, in ms; an all-day date is read as UTC midnight (the tests' business zone is UTC where they use one). */
function msOf(t: FakeGoogleTime): number {
  if (t.dateTime !== undefined) return Date.parse(t.dateTime);
  return Date.parse(`${t.date ?? ''}T00:00:00Z`);
}

export class FakeGoogleCalendar {
  readonly events = new Map<string, FakeGoogleEvent[]>();
  /** Every request answered: its method, its path (no query) and its status. */
  readonly requests: { method: string; path: string; status: number }[] = [];
  /** How many access tokens were issued. */
  tokensIssued = 0;
  /** Every response waits this long before it is sent (after the work is done). */
  delayMs = 0;
  /** An event inserted waits this long more before its answer is sent (written, and answered late). */
  writeDelayMs = 0;
  /** Every response's headers are sent at once and its body this long after (a body that stalls). */
  stallBodyMs = 0;
  /** Events a listing leaves out though they stand (one not listed yet), by id. */
  readonly unlisted = new Set<string>();
  /** How long an issued token lives, in seconds (Google's is 3600). */
  tokenLifetimeS = 3600;
  readonly tokenUri: string;
  readonly now: () => number;
  private readonly tokens = new Map<string, number>();
  private failing = 0;
  private failStatus = 503;

  constructor(private readonly o: FakeGoogleCalendarOptions) {
    this.tokenUri = o.tokenUri ?? FAKE_TOKEN_URI;
    this.now = o.now ?? Date.now;
    for (const id of o.calendars) this.events.set(id, []);
  }

  /** The next `n` requests are answered with `status` (a 5xx by default), nothing done. */
  failNext(n: number, status = 503): void {
    this.failing = n;
    this.failStatus = status;
  }

  /** Every token issued so far stops working, as one revoked would. */
  revokeTokens(): void {
    this.tokens.clear();
  }

  /** An event put in a calendar directly (one the business's owner made by hand). */
  add(calendarId: string, e: FakeGoogleEvent): void {
    this.events.get(calendarId)!.push(e);
  }

  /** The fake as a `fetch`. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
    const answer = this.handle(url, method, init);
    this.requests.push({ method, path: url.pathname, status: answer.status });
    const delay = this.delayMs + (method === 'POST' && url.pathname.startsWith(API_PREFIX) ? this.writeDelayMs : 0);
    if (delay > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delay);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
    }
    const text = JSON.stringify(answer.body);
    if (this.stallBodyMs <= 0) return new Response(text, { status: answer.status, headers: { 'content-type': 'application/json' } });
    const stall = this.stallBodyMs;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const t = setTimeout(() => {
          c.enqueue(new TextEncoder().encode(text));
          c.close();
        }, stall);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          c.error(signal.reason ?? new DOMException('aborted', 'AbortError'));
        }, { once: true });
      },
    });
    return new Response(body, { status: answer.status, headers: { 'content-type': 'application/json' } });
  };

  private handle(url: URL, method: string, init: RequestInit | undefined): { status: number; body: unknown } {
    if (this.failing > 0) {
      this.failing -= 1;
      return { status: this.failStatus, body: { error: { code: this.failStatus, message: 'Backend Error' } } };
    }
    if (`${url.origin}${url.pathname}` === this.tokenUri) return method === 'POST' ? this.token(String(init?.body ?? '')) : { status: 405, body: {} };
    if (url.origin !== 'https://www.googleapis.com' || !url.pathname.startsWith(API_PREFIX)) return { status: 404, body: { error: { code: 404, message: 'Not Found' } } };
    const rest = url.pathname.slice(API_PREFIX.length).split('/');
    if ((rest.length !== 2 && rest.length !== 3) || rest[1] !== 'events') return { status: 404, body: { error: { code: 404, message: 'Not Found' } } };
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const expires = this.tokens.get(auth.replace(/^Bearer /, ''));
    if (!auth.startsWith('Bearer ') || expires === undefined || expires <= this.now()) return { status: 401, body: { error: { code: 401, message: 'Invalid Credentials' } } };
    const calendar = this.events.get(decodeURIComponent(rest[0]!));
    if (calendar === undefined) return { status: 404, body: { error: { code: 404, message: 'Not Found' } } };
    if (rest.length === 3) {
      // One event by its id, a cancelled one too, as Google gives a deleted event.
      const found = method === 'GET' ? calendar.find((e) => e.id === decodeURIComponent(rest[2]!)) : undefined;
      return found === undefined ? { status: 404, body: { error: { code: 404, message: 'Not Found' } } } : { status: 200, body: found };
    }
    if (method === 'GET') return this.list(calendar, url.searchParams);
    if (method === 'POST') return this.insert(calendar, String(init?.body ?? ''));
    return { status: 405, body: {} };
  }

  private token(body: string): { status: number; body: unknown } {
    const form = new URLSearchParams(body);
    const bad = { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } };
    if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') return { status: 400, body: { error: 'unsupported_grant_type' } };
    const parts = (form.get('assertion') ?? '').split('.');
    if (parts.length !== 3) return bad;
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: string; typ?: string };
    let claims: { iss?: string; scope?: string; aud?: string; iat?: number; exp?: number };
    try {
      header = JSON.parse(fromBase64Url(h).toString('utf8')) as typeof header;
      claims = JSON.parse(fromBase64Url(p).toString('utf8')) as typeof claims;
    } catch {
      return bad;
    }
    if (header.alg !== 'RS256' || !verify('RSA-SHA256', Buffer.from(`${h}.${p}`), this.o.publicKey, fromBase64Url(s))) return bad;
    const nowS = Math.floor(this.now() / 1000);
    if (claims.iss !== this.o.clientEmail || claims.aud !== this.tokenUri || !(claims.scope ?? '').split(' ').includes('https://www.googleapis.com/auth/calendar.events')) return bad;
    if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number' || claims.iat > nowS + 60 || claims.exp <= nowS || claims.exp - claims.iat > 3600) return bad;
    this.tokensIssued += 1;
    const token = `fake-access-${this.tokensIssued}`;
    this.tokens.set(token, this.now() + this.tokenLifetimeS * 1000);
    return { status: 200, body: { access_token: token, expires_in: this.tokenLifetimeS, token_type: 'Bearer' } };
  }

  private list(calendar: FakeGoogleEvent[], q: URLSearchParams): { status: number; body: unknown } {
    const from = Date.parse(q.get('timeMin') ?? '');
    const to = Date.parse(q.get('timeMax') ?? '');
    if (Number.isNaN(from) || Number.isNaN(to)) return { status: 400, body: { error: { code: 400, message: 'Bad Request' } } };
    if (q.get('singleEvents') !== 'true') return { status: 400, body: { error: { code: 400, message: 'singleEvents expected' } } };
    const found = calendar.filter((e) => e.status !== 'cancelled' && !this.unlisted.has(e.id) && msOf(e.start) < to && msOf(e.end) > from);
    const size = this.o.pageSize ?? 250;
    const at = Number(q.get('pageToken') ?? '0');
    const items = found.slice(at, at + size);
    return { status: 200, body: { kind: 'calendar#events', items, ...(at + size < found.length ? { nextPageToken: String(at + size) } : {}) } };
  }

  private insert(calendar: FakeGoogleEvent[], body: string): { status: number; body: unknown } {
    let e: FakeGoogleEvent;
    try {
      e = JSON.parse(body) as FakeGoogleEvent;
    } catch {
      return { status: 400, body: { error: { code: 400, message: 'Parse Error' } } };
    }
    if (typeof e.id !== 'string' || !EVENT_ID.test(e.id)) return { status: 400, body: { error: { code: 400, message: 'Invalid resource id value.' } } };
    if (calendar.some((x) => x.id === e.id)) return { status: 409, body: { error: { code: 409, message: 'The requested identifier already exists.' } } };
    const stored = { ...e, status: e.status ?? 'confirmed' } as FakeGoogleEvent;
    calendar.push(stored);
    return { status: 200, body: stored };
  }
}
