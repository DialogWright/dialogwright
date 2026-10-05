import type { DashboardEvent, DeliveryFact } from './events';
import type { FrameLogLine } from '../frameLog';
import { DELIVERY_NOTES } from './view.js';

/**
 * Delivery facts: what happened on the line to what the agent said (a line the carrier cut short and
 * said again, the carrier's interrupt and whether it was the caller's, a reply held for a caller not
 * finished, the caller's words joined to their last answer, a call's end held until its goodbye
 * played), for the console's delivery notes under each line (view.js DELIVERY_NOTES, which says each
 * kind in words and names the line it goes under).
 *
 * The frame log is where they are kept: each is a `log` line the adapter writes under its kind's key
 * (`{ resaid: { heardMs, expectedMs } }`), or the carrier's `interrupt` frame. The adapter publishes the
 * fact as it writes the line (server/adapter.ts logDelivery), and the console's reload of a past call
 * reads the same facts back from the frame log (deliveriesOf, through `/dashboard/traces/<sid>`), so a
 * note is in the live view and in every replay of the call alike. Nothing is added to the trace.
 *
 * A fact holds only numbers, booleans, nulls and short codes (CODE): never a caller's words or our own
 * lines, so the unauthenticated console shows nothing through it that the turn does not already show.
 */
export type DeliveryEvent = Extract<DashboardEvent, { type: 'delivery' }>;

/** A short code a fact may carry as it is (`played`, `spurious-interrupt`): one word, never a sentence. */
const CODE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

type Field = number | boolean | string | null;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isField(v: unknown): v is Field {
  return v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && CODE.test(v));
}

/**
 * The delivery fact a frame-log `log` line stands for, or null when it is none: a line whose key is a
 * kind in DELIVERY_NOTES, with that key's fields flattened into the fact (a bare value as `value`) and
 * the line's other fields beside them. Any field that is not a number, a boolean, a null or a short
 * code is left out.
 */
export function deliveryFactOf(msg: unknown): DeliveryFact | null {
  if (!isRecord(msg)) return null;
  const kind = Object.keys(msg).find((k) => Object.hasOwn(DELIVERY_NOTES, k));
  if (kind === undefined) return null;
  const fact: DeliveryFact = { kind };
  const body = msg[kind];
  if (isRecord(body)) {
    for (const [k, v] of Object.entries(body)) if (k !== 'kind' && isField(v)) fact[k] = v;
  } else if (isField(body)) {
    fact.value = body;
  }
  for (const [k, v] of Object.entries(msg)) if (k !== kind && k !== 'kind' && isField(v)) fact[k] = v;
  return fact;
}

/**
 * The fact of the carrier's interrupt of the line, `afterMs` into it. Whether it was the caller's is the
 * adapter's decision, which comes after it as a fact of its own when it was not (`spuriousInterrupt`, then
 * `resaid` with `reason: 'spurious-interrupt'` when the line is said again), and replaces its note.
 */
export function interruptFact(afterMs: number): DeliveryFact {
  return { kind: 'interrupt', afterMs };
}

/**
 * The delivery facts of one call, read from its frame log in order, as the `delivery` events the adapter
 * published live: each `log` line that is one (deliveryFactOf), and each carrier `interrupt`. Lines with
 * no readable time are passed over.
 */
export function deliveriesOf(frames: readonly FrameLogLine[], callSid: string): DeliveryEvent[] {
  const out: DeliveryEvent[] = [];
  for (const f of frames) {
    const at = Date.parse(f.ts);
    const msg = f.msg;
    if (!Number.isFinite(at) || !isRecord(msg)) continue;
    let fact: DeliveryFact | null = null;
    if (f.dir === 'in' && msg.type === 'interrupt') {
      const afterMs = msg.durationUntilInterruptMs;
      if (typeof afterMs === 'number' && Number.isFinite(afterMs)) fact = interruptFact(afterMs);
    } else if (f.dir === 'log') {
      fact = deliveryFactOf(msg);
    }
    if (fact) out.push({ type: 'delivery', callSid, at, fact });
  }
  return out;
}
