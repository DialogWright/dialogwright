import { createPublicKey, type KeyObject } from 'node:crypto';

/**
 * The identity provider's published signing keys (a JWKS, at CHAT_JWKS_URL), by kid: fetched on
 * demand over https, cached for the provider's max-age, and refetched for a kid not yet seen (a
 * rotated key), but never more often than once every 30 seconds, so tokens with made-up kids cannot
 * make the server hammer the provider.
 */
export interface JwksOptions {
  url: string;
  /** Tests serve their own keys. */
  fetch?: typeof fetch;
  nowMs?: () => number;
  log?: (line: string) => void;
}

const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;
/** The fewest milliseconds between two fetches, whatever is asked. */
export const JWKS_MIN_REFETCH_MS = 30_000;
const FETCH_TIMEOUT_MS = 5_000;
/** A key set is a few kilobytes; anything near this is not one. */
const MAX_BODY_CHARS = 256 * 1024;

/** CHAT_JWKS_URL's rule, checked by the config and here alike: https, so the keys cannot be swapped on the way. */
export function checkJwksUrl(url: string): void {
  let parsed: URL | null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (parsed === null || parsed.protocol !== 'https:') throw new Error(`CHAT_JWKS_URL must be an https URL, got "${url}"`);
}

/** The signing keys a JWKS document lists, by kid; anything else (an encryption key, a key without a kid, one Node cannot read) is left out. */
function keysOf(body: unknown): Map<string, KeyObject> {
  const out = new Map<string, KeyObject>();
  const list = typeof body === 'object' && body !== null && Array.isArray((body as { keys?: unknown }).keys) ? (body as { keys: unknown[] }).keys : [];
  for (const jwk of list) {
    if (typeof jwk !== 'object' || jwk === null) continue;
    const k = jwk as Record<string, unknown>;
    if (typeof k.kid !== 'string' || k.kid === '' || (k.use !== undefined && k.use !== 'sig')) continue;
    // Only the public parts are read: a private member, should a provider publish one, is not.
    const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...pub } = k;
    try {
      out.set(k.kid, createPublicKey({ key: pub as never, format: 'jwk' }));
    } catch {
      // A key Node cannot read is one no token can be verified with.
    }
  }
  return out;
}

/** A lookup of the provider's keys by kid. */
export function jwksKeys(o: JwksOptions): (kid: string) => Promise<KeyObject | null> {
  checkJwksUrl(o.url);
  const doFetch = o.fetch ?? fetch;
  const now = o.nowMs ?? Date.now;
  let keys = new Map<string, KeyObject>();
  let expiresAt = -Infinity;
  let lastFetch = -Infinity;
  let inFlight: Promise<void> | null = null;
  let failing = false;

  const refresh = async (): Promise<void> => {
    lastFetch = now();
    try {
      const res = await doFetch(o.url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BODY_CHARS) throw new Error('the key set is too large');
      keys = keysOf(JSON.parse(text));
      const maxAge = /(?:^|[,\s])max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '');
      expiresAt = now() + Math.min(maxAge ? Number(maxAge[1]) * 1000 : DEFAULT_TTL_MS, MAX_TTL_MS);
      failing = false;
    } catch (e) {
      // The keys already fetched keep working; a provider that is down is said once, not on every sign-in.
      if (!failing) o.log?.(`chat sign-in: could not fetch ${o.url}: ${e instanceof Error ? e.message : String(e)} (keeping the keys already fetched)`);
      failing = true;
    }
  };

  return async (kid) => {
    if (inFlight !== null) await inFlight;
    else if ((now() >= expiresAt || !keys.has(kid)) && now() - lastFetch >= JWKS_MIN_REFETCH_MS) {
      inFlight = refresh().finally(() => {
        inFlight = null;
      });
      await inFlight;
    }
    return keys.get(kid) ?? null;
  };
}
