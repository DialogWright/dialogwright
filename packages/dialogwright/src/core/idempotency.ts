import { createHash } from 'node:crypto';
import { canonicalJson } from '../jev/cassette';
import type { ToolCall } from '../gate/types';
import type { Effect } from './lifecycle';
import type { Session } from './session';

/**
 * Keys that let a system tell a write it has already done from a new one, so a write repeated after a
 * crash is never done twice. A tool that writes declares `idempotent: true` (ToolDef.idempotent) and is
 * given its call's key as it runs; a downstream service is given its request's key with the request
 * (ServiceResolveOptions.idempotencyKey), and may send it on as an `Idempotency-Key` header. The engine
 * only makes and passes the key: the system written to must honour it (keep the keys it has seen, and
 * answer a repeat with what it did the first time).
 *
 * Each is the first 32 hex characters of a SHA-256 over a JSON array, stable across processes and
 * versions; changing what goes in would make a retry look new, so it is documented and tested.
 */

const KEY_HEX = 32;

function digest(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex').slice(0, KEY_HEX);
}

/**
 * A tool call's key: over `["tool", call id, form, confirmed, tool]`, where confirmed is the hash of
 * the values the caller confirmed at the summary (Session.confirmedHash), or, for a call made with
 * nothing confirmed, the SHA-256 of the call's params as canonical JSON. So the same confirmed write on
 * the same call has the same key however often it is retried (a call resumed after a crash, the caller
 * saying yes to the same summary again), and any value changed makes another.
 */
export function idempotencyKey(s: Pick<Session, 'sessionId' | 'form' | 'confirmedHash'>, call: Pick<ToolCall, 'tool' | 'params'>): string {
  const confirmed = s.confirmedHash ?? createHash('sha256').update(canonicalJson(call.params), 'utf8').digest('hex');
  return digest(['tool', s.sessionId, s.form ?? '', confirmed, call.tool]);
}

/**
 * A service request's key: over `["service", call id, turn, service, params]` (the params as canonical
 * JSON), the turn being the one that left the request (Session.turnIndex after it). Recorded with the
 * request before it is sent (StoredCall.pending), so a call resumed after a restart that finds it
 * unanswered sends it again with this same key.
 */
export function serviceIdempotencyKey(s: Pick<Session, 'sessionId' | 'turnIndex'>, effect: Pick<Effect, 'service' | 'params'>): string {
  return digest(['service', s.sessionId, s.turnIndex, effect.service, canonicalJson(effect.params)]);
}
