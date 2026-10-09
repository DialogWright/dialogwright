import { SHORT_MASK } from '../gate/principal';

/**
 * The masking by name that the frame log and the console apply to everything they write
 * (server/dashboard/events.ts redactDeep), here so the call data's records can take it as a floor
 * (core/callData.ts, channel/callData.ts): a key's `redact` may record a value more strictly, never less.
 */

/** The last four digits only; the page never shows a whole caller number (one of four digits or fewer: SHORT_MASK). */
export function maskNumber(n: string | undefined | null): string {
  if (!n) return 'unknown';
  // Already masked (the trace's `...0142`, or SHORT_MASK): kept, in the page's own spelling.
  if (n === SHORT_MASK) return n;
  const masked = /^(?:\.\.\.|…)(\d{4})$/.exec(n);
  if (masked) return `…${masked[1]}`;
  const digits = n.replace(/\D/g, '');
  if (digits.length > 0 && digits.length <= 4) return SHORT_MASK;
  return `…${digits.slice(-4)}`;
}

/**
 * Caller identity travels under a handful of names that Twilio spells differently per surface --
 * `from`/`to` on the setup frame, `From`/`To`/`Caller`/`Called` on the `/cr-action` form post --
 * and the dashboard route is unauthenticated, so redaction works by key name on any object rather
 * than by frame type. These are matched case-insensitively. `callerNumber` is a session start's
 * (SessionStart.callerNumber), for an app with a slot that offers the caller's number or that keeps
 * it for its code, and `calledNumber` the number called (SessionStart.calledNumber), for an app that keeps it. Telnyx's setup
 * has `from` and `to` null and carries the numbers as custom parameters, `telnyx_call_from` and
 * `telnyx_call_to` (server/voice/telnyx.ts): masked by those names, in the setup frame the frame log
 * writes and in a start event's provider details (`param.telnyx_call_from`).
 */
export const MASK_KEYS = new Set(['from', 'to', 'caller', 'called', 'forwardedfrom', 'callernumber', 'callednumber', 'telnyx_call_from', 'telnyx_call_to']);
/** Masked to a fixed string rather than to digits: a name has nothing worth keeping. */
export const NAME_KEYS = new Set(['callername']);
/** Dropped outright; the account id identifies the Twilio account, not the call. */
export const DROP_KEYS = new Set(['accountsid']);
/** `FromCity`, `CallerState`, `ToZip`, `CalledCountry`, ... -- the geo lookup Twilio attaches. */
export const DROP_SUFFIXES = ['city', 'state', 'zip', 'country'];
/**
 * What the frame log and the console write of a value under `name` by its name alone (redactDeep's
 * rules): left out (null) for a dropped name, `redacted` for a name, the last four for a number,
 * as it is otherwise. A floor for the call data an app keeps: a key's `redact` may record a value more
 * strictly than this, never less. A value already recorded more strictly (`•`, `<n chars>`) stays.
 */
export function floorByName(name: string, value: string): string | null {
  const k = name.toLowerCase().split('.').pop()!;
  if (DROP_KEYS.has(k) || DROP_SUFFIXES.some((s) => k.endsWith(s))) return null;
  if (value === '•' || /^<\d+ chars>$/.test(value)) return value;
  if (NAME_KEYS.has(k)) return 'redacted';
  // A number already shown by its last four (a key's `last4`) is as strict as the floor.
  if (MASK_KEYS.has(k)) return value === SHORT_MASK || /^(?:\.\.\.|…).{4}$/.test(value) ? value : maskNumber(value);
  return value;
}

/** Whether the frame log keeps a setup field as the carrier sent it (redactDeep changes or drops it otherwise): what a replay reads of a `setup.` key. */
export function frameLogKeepsField(name: string): boolean {
  return floorByName(name, 'x0000') === 'x0000';
}

