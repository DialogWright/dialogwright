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

/** A failed request as an `error` event: the API's own words made safe (never the key); `filtered` where its content filter refused. */
export async function httpError(res: Response, key: string): Promise<ErrorEvent> {
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // not JSON: the status alone
  }
  const told = apiError(json, key);
  const detail = `HTTP ${res.status}${told.type ? ` ${told.type}` : ''}${told.message ? `: ${told.message}` : ''}`;
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
