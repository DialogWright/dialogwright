import type { DashboardEvent, DeliveryFact } from './events';
import type { FrameLogLine } from '../frameLog';
import type { PlaybackEvent } from '../voice/provider';
import { anyPlaybackEventOf } from '../voice/registry';
import { DELIVERY_NOTES } from './view.js';

/**
 * Delivery facts: what happened on the line to what the agent said (a line the carrier cut short and
 * said again, the carrier's interrupt, the caller's words joined to their last answer, a call's end held
 * until its goodbye played), for the console's delivery notes under each line (view.js DELIVERY_NOTES,
 * which says each kind in words and names the line it goes under).
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

/** What is known of the caller's voice on a call, at a carrier's interrupt (callerHeardAt). */
export interface CallerVoice {
  /** The carrier has reported its speakers on this call (reportsSpeakers). */
  reported: boolean;
  /** The carrier reports the caller speaking now. */
  speaking: boolean;
  /** When the carrier last reported the caller starting to speak, if it has. */
  lastStartMs: number | null;
}

/**
 * Whether a carrier's report says who is speaking (Telnyx's speaker events: the playback starting or
 * stopping, or the caller's voice), so that a caller never reported speaking was not heard. A report of
 * a line played (Telnyx's tokens-played, a `finished` naming its line) alone says nothing of the caller.
 */
export function reportsSpeakers(ev: PlaybackEvent): boolean {
  return ev.kind === 'caller' || (ev.state === 'started' || ev.text === undefined);
}

/**
 * Whether the caller was heard speaking over a line the carrier interrupted `afterMs` into it, at
 * `atMs`: speaking now, or begun since the line started; not heard, on a carrier that reports its
 * speakers; null (not known) on one that does not.
 */
export function callerHeardAt(voice: CallerVoice, atMs: number, afterMs: number): boolean | null {
  if (voice.speaking) return true;
  if (voice.lastStartMs !== null && voice.lastStartMs >= atMs - afterMs) return true;
  return voice.reported ? false : null;
}

/** The fact of the carrier's interrupt of the line, `afterMs` into it. */
export function interruptFact(afterMs: number, callerHeard: boolean | null): DeliveryFact {
  return { kind: 'interrupt', afterMs, callerHeard };
}

/**
 * The delivery facts of one call, read from its frame log in order, as the `delivery` events the adapter
 * published live: each `log` line that is one (deliveryFactOf), and each carrier `interrupt` with
 * whether the caller was heard, from the carrier's events logged before it (`{ carrierEvent }`), as the
 * adapter followed them (a reconnect or a socket close forgets the caller's speaking). Lines with no
 * readable time are passed over.
 */
export function deliveriesOf(frames: readonly FrameLogLine[], callSid: string): DeliveryEvent[] {
  const out: DeliveryEvent[] = [];
  const voice: CallerVoice = { reported: false, speaking: false, lastStartMs: null };
  for (const f of frames) {
    const at = Date.parse(f.ts);
    const msg = f.msg;
    if (!Number.isFinite(at) || !isRecord(msg)) continue;
    if (f.dir === 'in' && 'carrierEvent' in msg) {
      const ev = anyPlaybackEventOf(msg.carrierEvent);
      if (!ev) continue;
      if (reportsSpeakers(ev)) voice.reported = true;
      if (ev.kind === 'caller') {
        voice.speaking = ev.speaking;
        if (ev.speaking) voice.lastStartMs = at;
      }
    } else if (f.dir === 'in' && msg.type === 'interrupt') {
      const afterMs = msg.durationUntilInterruptMs;
      if (typeof afterMs !== 'number' || !Number.isFinite(afterMs)) continue;
      out.push({ type: 'delivery', callSid, at, fact: interruptFact(afterMs, callerHeardAt(voice, at, afterMs)) });
    } else if (f.dir === 'log') {
      if (msg.resumed === true || msg.socketClosed === true) {
        voice.speaking = false;
        voice.lastStartMs = null;
      }
      const fact = deliveryFactOf(msg);
      if (fact) out.push({ type: 'delivery', callSid, at, fact });
    }
  }
  return out;
}
