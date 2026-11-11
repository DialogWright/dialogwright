import { apiError, safeErrorText } from '../../render/endpoints';
import type { ModelEvent } from './types';

/** Whether a failure is the provider's content filter refusing the turn (a finish reason, an error type, or a 403 with moderation reasons). */
export function filteredBy(status: number, json: unknown, told: { type?: string }, finish?: unknown): boolean {
  if (finish === 'content_filter') return true;
  if (told.type !== undefined && /content[_ -]?filter/i.test(told.type)) return true;
  const metadata = (json as { error?: { metadata?: { reasons?: unknown } } } | null)?.error?.metadata;
  return status === 403 && Array.isArray(metadata?.reasons);
}

type ErrorEvent = Extract<ModelEvent, { type: 'error' }>;

/**
 * How long a response asks to be left before the next request, in ms: its `retry-after-ms` header, else its
 * `Retry-After` (seconds, or an HTTP date from `nowMs`); undefined where it says neither, or nothing readable.
 */
export function retryAfterMsOf(headers: Headers, nowMs: number = Date.now()): number | undefined {
  const ms = headers.get('retry-after-ms');
  if (ms !== null && ms.trim() !== '' && Number.isFinite(Number(ms)) && Number(ms) >= 0) return Math.round(Number(ms));
  const after = headers.get('retry-after');
  if (after === null || after.trim() === '') return undefined;
  if (Number.isFinite(Number(after))) return Number(after) >= 0 ? Math.round(Number(after) * 1000) : undefined;
  const at = Date.parse(after);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

/**
 * A failed request as an `error` event: the API's own words made safe (never the key); `filtered` where its
 * content filter refused; `rate_limited` for an HTTP 429, with the wait its Retry-After asks for where it gives one.
 */
export async function httpError(res: Response, key: string): Promise<ErrorEvent> {
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // not JSON: the status alone
  }
  const told = apiError(json, key);
  const detail = `HTTP ${res.status}${told.type ? ` ${told.type}` : ''}${told.message ? `: ${told.message}` : ''}`;
  if (res.status === 429) {
    const retryAfterMs = retryAfterMsOf(res.headers);
    return { type: 'error', kind: 'rate_limited', detail, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  return { type: 'error', kind: filteredBy(res.status, json, told) ? 'filtered' : 'http', detail };
}

/** A thrown failure as an `error` event: `timeout` when the caller's signal aborted, else `http` with safe text. */
export function thrownError(e: unknown, signal: AbortSignal, key: string): ErrorEvent {
  if (signal.aborted) return { type: 'error', kind: 'timeout', detail: 'the request was aborted' };
  return { type: 'error', kind: 'http', detail: safeErrorText(e instanceof Error ? e.message : String(e), key) };
}

/** The JSON of one SSE payload, or null. */
export function jsonOf(payload: string): Record<string, any> | null {
  try {
    const v = JSON.parse(payload);
    return v !== null && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}
