import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * A Google service account's sign-in, by code of our own over `fetch` (no SDK, as the S3 traces' SigV4 is):
 * the account's key file read, a JWT signed RS256 with its private key (node:crypto), exchanged at its token
 * URI for an access token (grant type jwt-bearer), and the token kept until a minute before it expires.
 *
 * Nothing here logs, and no error carries the key file's path or anything in it: the path comes from the
 * app's settings and the file holds a private key. An error names only what went wrong (GoogleCalendarError).
 */

/** The scope the line asks for: the calendar's events, read and written; nothing else of the account. */
export const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
/** The token URI a key file that names none signs in at (Google's own). */
export const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
/** How long before its expiry a token is no longer used: a minute. */
export const TOKEN_MARGIN_MS = 60_000;
/** How long an assertion is valid: an hour, the most Google takes. */
const ASSERTION_S = 3600;

/** Why a request to Google failed, as the runtime records it; the message is what the model is told. */
export type GoogleFailure = 'key-file' | 'sign-in' | 'timeout' | 'unreachable' | 'unavailable' | 'not-found' | 'refused';

/** A calendar request that failed: its message is said to the model as the action's failure, and names no path, key or token. */
export class GoogleCalendarError extends Error {
  constructor(readonly failure: GoogleFailure, message: string) {
    super(message);
    this.name = 'GoogleCalendarError';
  }
}

/** What the line takes from a service account's key file. */
export interface ServiceAccountKey {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

const notSetUp = (why: string): GoogleCalendarError => new GoogleCalendarError('key-file', `the calendar's sign-in is not set up (${why}), so it cannot be read or booked now`);

/** A service account's key from its file's text; throws GoogleCalendarError, saying nothing of the text. */
export function parseServiceAccountKey(text: string): ServiceAccountKey {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw notSetUp('its key file is not a service account\'s key');
  }
  const o = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof o[k] === 'string' && (o[k] as string).trim() !== '' ? (o[k] as string) : undefined);
  const clientEmail = str('client_email');
  const privateKey = str('private_key');
  if (clientEmail === undefined || privateKey === undefined || !privateKey.includes('PRIVATE KEY')) throw notSetUp('its key file is not a service account\'s key');
  return { clientEmail, privateKey, tokenUri: str('token_uri') ?? GOOGLE_TOKEN_URI };
}

/** The key file at `path`, read; throws GoogleCalendarError, never naming the path. */
export async function readServiceAccountKey(path: string): Promise<ServiceAccountKey> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw notSetUp('its key file cannot be read');
  }
  return parseServiceAccountKey(text);
}

const base64Url = (b: Buffer | string): string => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** The signed assertion (a JWT, RS256) a service account exchanges for an access token, issued at `nowMs`. */
export function signedAssertion(key: ServiceAccountKey, scope: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const head = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({ iss: key.clientEmail, scope, aud: key.tokenUri, iat, exp: iat + ASSERTION_S }));
  let signature: string;
  try {
    signature = base64Url(createSign('RSA-SHA256').update(`${head}.${claims}`).sign(key.privateKey));
  } catch {
    throw notSetUp('its key file\'s private key cannot sign');
  }
  return `${head}.${claims}.${signature}`;
}

/**
 * A request to Google within `timeoutMs`: its answer, or a GoogleCalendarError (the time ran out, or Google
 * could not be reached). The request is aborted at the time; an answer that comes after is not waited for.
 */
export async function requestWithin(fetcher: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new GoogleCalendarError('timeout', `the calendar did not answer in time (${timeoutMs} ms), so nothing is known from it now`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetcher(url, { ...init, signal: abort.signal }), late]);
  } catch (e) {
    if (e instanceof GoogleCalendarError) throw e;
    throw new GoogleCalendarError('unreachable', 'the calendar could not be reached, so nothing is known from it now');
  } finally {
    clearTimeout(timer);
  }
}

export interface ServiceAccountTokens {
  /** An access token: the one kept while it has more than a minute to run, else a new one (one request for callers at once). */
  token(): Promise<string>;
  /** The token kept is dropped (Google refused it): the next request signs in again. */
  forget(): void;
}

/** A service account's access tokens, from the key file at `keyFile` (read at the first sign-in, and again after a failed one). */
export function serviceAccountTokens(o: { keyFile: string; scope: string; fetch: typeof fetch; now: () => Date; timeoutMs: number }): ServiceAccountTokens {
  let kept: { token: string; expiresMs: number } | null = null;
  let pending: Promise<string> | null = null;
  const signIn = async (): Promise<string> => {
    const key = await readServiceAccountKey(o.keyFile);
    const nowMs = o.now().getTime();
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedAssertion(key, o.scope, nowMs) }).toString();
    const res = await requestWithin(o.fetch, key.tokenUri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }, o.timeoutMs);
    if (res.status >= 500 || res.status === 429) throw new GoogleCalendarError('unavailable', `the calendar is not answering (${res.status}), so nothing is known from it now`);
    const json = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
    if (!res.ok || typeof json.access_token !== 'string') throw new GoogleCalendarError('sign-in', `the calendar refused the line's sign-in (${res.status}), so it cannot be read or booked now`);
    const lifetimeS = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 3600;
    kept = { token: json.access_token, expiresMs: nowMs + lifetimeS * 1000 };
    return json.access_token;
  };
  return {
    async token() {
      if (kept !== null && o.now().getTime() < kept.expiresMs - TOKEN_MARGIN_MS) return kept.token;
      pending ??= signIn().finally(() => {
        pending = null;
      });
      return pending;
    },
    forget() {
      kept = null;
    },
  };
}
