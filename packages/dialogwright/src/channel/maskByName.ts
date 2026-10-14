import { SHORT_MASK } from '../gate/principal';
import type { RecordsConfig } from '../core/app/types';

/**
 * The masking by name that the frame log, the console and the server's log apply to everything they
 * write (server/dashboard/events.ts redactDeep), here so the call data's records can take it as a floor
 * (core/callData.ts, channel/callData.ts): a key's `redact` may record a value more strictly, never less.
 * It is about what is written down, never about what is delivered: what a transfer sends, what app code
 * reads and what the audit decides are never masked by it.
 *
 * What it does with a number is app.yaml's `records` (RecordsConfig, NumberRecords below): the caller's
 * number by its last four by default, the business's own numbers (the number called, transfer targets)
 * whole by default, the caller's name redacted by default.
 */

/** How the records write numbers and the caller's name: app.yaml's `records`, with its defaults filled in. */
export interface NumberRecords {
  readonly callerNumber: 'last4' | 'keep';
  readonly businessNumbers: 'keep' | 'last4';
  readonly callerName: 'redact' | 'keep';
}

/** The records' defaults: the caller's number by its last four, the business's numbers whole, the caller's name redacted. */
export const DEFAULT_RECORDS: NumberRecords = Object.freeze({ callerNumber: 'last4', businessNumbers: 'keep', callerName: 'redact' });

/** An app's records setting (app.yaml's `records`), with the defaults for what it leaves out; the defaults for no app. */
export function recordsOf(app: { readonly records?: RecordsConfig } | null | undefined): NumberRecords {
  const r = app?.records;
  if (r === undefined) return DEFAULT_RECORDS;
  return {
    callerNumber: r.callerNumber ?? DEFAULT_RECORDS.callerNumber,
    businessNumbers: r.businessNumbers ?? DEFAULT_RECORDS.businessNumbers,
    callerName: r.callerName ?? DEFAULT_RECORDS.callerName,
  };
}

/** Whether a records setting writes anything of the caller whole (`keep`): what needs a console behind sign-in. */
export function recordsKeepCaller(records: NumberRecords): boolean {
  return records.callerNumber === 'keep' || records.callerName === 'keep';
}

/** The last four digits only (one of four digits or fewer: SHORT_MASK). */
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

/** A number as a carrier writes it: digits, with a leading `+` and spacing, dashes, dots or brackets. */
const NUMBER_SHAPE = /^\+?[\d\s().-]+$/;

/** A value already masked, or a number: masked as a number (maskNumber); anything else is an address. */
function numberLike(value: string): boolean {
  const text = value.trim();
  return text === '' || NUMBER_SHAPE.test(text) || /^(?:\.\.\.|…)/.test(text) || text === SHORT_MASK;
}

/**
 * An address with each number in it masked to its last four (a run of five or more digits, with a `+`
 * before it or not: `+15555550142@sip.telnyx.com` is `…0142@sip.telnyx.com`); one with no such run
 * (`anonymous@anonymous.invalid`, an already masked one) as it is.
 */
export function maskAddress(value: string): string {
  return value.replace(/\+?\d{5,}/g, (run) => maskNumber(run));
}

/** The words a carrier writes for a withheld caller, which say nothing of who is calling. */
const WITHHELD_USER = /^(anonymous|restricted|unavailable|unknown|private|blocked|withheld)$/i;

/**
 * A caller's SIP or client address masked: each number in it to its last four (maskAddress), and a user
 * part that holds no number to its last four characters (`client:alice.smith` is `client:…mith`,
 * `sip:1001@pbx.example.com` is `sip:…@pbx.example.com`), the scheme and host kept. A withheld word
 * (`anonymous`) and an address already masked stay as they are.
 */
export function maskUri(value: string): string {
  const numbers = maskAddress(value);
  const m = /^((?:sips?|client|tel):)?([^@;>]*)(.*)$/i.exec(numbers);
  if (m === null) return numbers;
  const scheme = m[1] ?? '';
  const user = m[2] ?? '';
  const rest = m[3] ?? '';
  if (user === '' || user.startsWith('…') || WITHHELD_USER.test(user)) return numbers;
  return user.length <= 4 ? `${scheme}…${rest}` : `${scheme}…${user.slice(-4)}${rest}`;
}

/** What the records write of the caller's number or address under `records` (callerNumber: last4 or keep). */
export function maskCallerValue(value: string, records: NumberRecords = DEFAULT_RECORDS): string {
  if (records.callerNumber === 'keep') return value;
  return numberLike(value) ? maskNumber(value) : maskUri(value);
}

/** What the records write of one of the business's own numbers (the number called, a transfer target) under `records` (businessNumbers: keep or last4). */
export function maskBusinessValue(value: string, records: NumberRecords = DEFAULT_RECORDS): string {
  if (records.businessNumbers === 'keep') return value;
  return numberLike(value) ? maskNumber(value) : maskAddress(value);
}

/**
 * Caller identity travels under a handful of names that the carriers spell differently per surface --
 * `from` on the setup frame, `From`/`Caller` on the `/cr-action` form post, `callerNumber` on a session
 * start (SessionStart.callerNumber), `telnyx_call_from` among Telnyx's custom parameters
 * (server/voice/telnyx.ts), `forwardedFrom` -- and the dashboard route may be unauthenticated, so the
 * masking works by key name on any object rather than by frame type. Matched case-insensitively.
 */
export const CALLER_KEYS = new Set(['from', 'caller', 'forwardedfrom', 'callernumber', 'telnyx_call_from']);
/** The business's own number under the names the carriers give it: the number called (the DNIS). Kept whole unless `records.businessNumbers` is `last4`. */
export const BUSINESS_KEYS = new Set(['to', 'called', 'callednumber', 'telnyx_call_to']);
/** Every name a number travels under, the caller's and the business's. */
export const MASK_KEYS = new Set([...CALLER_KEYS, ...BUSINESS_KEYS]);
/**
 * Addresses that may carry the caller's number inside other text: Telnyx's TeXML webhooks name the
 * caller's ID (`CallerId`) and the caller's SIP address (`FromSipUri`), with the number whole on an
 * ordinary call (`+15555550142@sip.telnyx.com`) and a word on a withheld one (`anonymous`,
 * `anonymous@anonymous.invalid`). Masked by maskAddress: each number in them to its last four, the rest
 * kept, so a withheld call's marks stay readable. Matched case-insensitively.
 */
export const CALLER_ADDRESS_KEYS = new Set(['callerid', 'fromsipuri']);
/** The business's own SIP address (`ToSipUri`), kept whole unless `records.businessNumbers` is `last4`. */
export const BUSINESS_ADDRESS_KEYS = new Set(['tosipuri']);
/** Every address that may carry a number. */
export const ADDRESS_KEYS = new Set([...CALLER_ADDRESS_KEYS, ...BUSINESS_ADDRESS_KEYS]);

/**
 * Fields with every copy of `number` masked, whatever their names: a field whose digits hold the number's
 * last seven has each number in it masked to its last four (maskAddress), or the whole value when the
 * number is written with spaces or dashes between its digits. A defence beside the masking by name, for a
 * carrier that sends the number under a name no list knows. A number of fewer than seven digits, or none,
 * and records that keep the caller's number, leave the fields as they are.
 */
export function maskCopiesOf(fields: Readonly<Record<string, string>>, number: string | undefined, records: NumberRecords = DEFAULT_RECORDS): Record<string, string> {
  const digits = (number ?? '').replace(/\D/g, '');
  if (digits.length < 7 || records.callerNumber === 'keep') return { ...fields };
  const tail = digits.slice(-7);
  const holds = (v: string): boolean => v.replace(/\D/g, '').includes(tail);
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => {
    if (!holds(v)) return [k, v];
    const masked = maskAddress(v);
    return [k, holds(masked) ? maskNumber(v) : masked];
  }));
}

/** What may stand between two digits of a number a line says or a carrier echoes: spaces, a comma, a dot, a hyphen, a slash or a bracket, a few at most. */
const SPOKEN_DIGIT_GAP = '[\\s,.\\-/()]{0,3}';

/**
 * Free text (our own line as the frame log records it, a carrier's report of the line it played) with
 * every copy of the caller's `number` masked as `records` write it (maskCallerValue: by its last four,
 * "…0142"), however it is spaced or grouped: whole or from its last seven digits on (the national or the
 * local number), its digits run together, in groups ("555 555 0142", "(555) 555-0142"), or one by one as
 * the voice says them ("5 5 5, 5 5 5, 0 1 4 2"), never inside a longer run of digits. Null, nothing to
 * mask, for a number of fewer than seven digits, none, and records that keep the caller's number. For
 * the records only: never what is delivered.
 */
export function callerNumberScrub(number: string | undefined | null, records: NumberRecords = DEFAULT_RECORDS): ((text: string) => string) | null {
  const digits = (number ?? '').replace(/\D/g, '');
  if (digits.length < 7 || records.callerNumber === 'keep') return null;
  const shown = maskCallerValue(number!, records);
  const forms: string[] = [];
  for (let n = digits.length; n >= 7; n--) forms.push([...digits.slice(-n)].join(SPOKEN_DIGIT_GAP));
  const pattern = new RegExp(`(?<!\\p{N})\\+?\\(?(?:${forms.join('|')})(?!\\p{N})`, 'gu');
  return (text) => text.replace(pattern, shown);
}

/** The caller's name a carrier sends (CNAM: Twilio's `CallerName`, Telnyx's caller ID name), written `redacted` unless `records.callerName` is `keep`. */
export const NAME_KEYS = new Set(['callername', 'calleridname', 'caller_id_name']);
/** Dropped outright; the account id identifies the carrier's account, not the call. */
export const DROP_KEYS = new Set(['accountsid']);
/**
 * The geographic lookup Twilio attaches to its webhooks, by its exact names (lower case): `FromCity`,
 * `CallerState`, `ToZip`, `CalledCountry` and the rest. Left out of the records; a field of another name
 * that happens to end the same way (`callState`) is kept.
 */
export const GEO_KEYS = new Set(['from', 'caller', 'to', 'called'].flatMap((who) => ['city', 'state', 'zip', 'country'].map((what) => `${who}${what}`)));

/** Whether the records leave a field out by its name (its last dotted segment, any case): the account id and Twilio's geographic lookup. */
export function droppedByName(name: string): boolean {
  const k = name.toLowerCase().split('.').pop()!;
  return DROP_KEYS.has(k) || GEO_KEYS.has(k);
}

/**
 * What the records (the frame log, the console, the audit's call data) write of a value under `name`
 * by its name alone (redactDeep's rules): left out (null) for a dropped name, the caller's name
 * `redacted`, the caller's number by its last four, the business's number whole, each as `records`
 * says, as it is otherwise. A floor for the call data an app keeps: a key's `redact` may record a value
 * more strictly than this, never less. A value already recorded more strictly (`•`, `<n chars>`) stays.
 * Never applied to what is delivered (a transfer's headers or data).
 */
export function floorByName(name: string, value: string, records: NumberRecords = DEFAULT_RECORDS): string | null {
  const k = name.toLowerCase().split('.').pop()!;
  if (droppedByName(k)) return null;
  if (value === '•' || /^<\d+ chars>$/.test(value)) return value;
  if (NAME_KEYS.has(k)) return records.callerName === 'keep' ? value : 'redacted';
  // A number already shown by its last four (a key's `last4`) is as strict as the floor.
  const shown = value === SHORT_MASK || /^(?:\.\.\.|…).{4}$/.test(value);
  if (CALLER_KEYS.has(k)) return shown ? value : maskCallerValue(value, records);
  if (BUSINESS_KEYS.has(k)) return shown ? value : maskBusinessValue(value, records);
  if (CALLER_ADDRESS_KEYS.has(k)) return records.callerNumber === 'keep' ? value : maskAddress(value);
  if (BUSINESS_ADDRESS_KEYS.has(k)) return records.businessNumbers === 'keep' ? value : maskAddress(value);
  return value;
}

/** Whether the frame log keeps a setup field as the carrier sent it (redactDeep changes or drops it otherwise): what a replay reads of a `setup.` key. */
export function frameLogKeepsField(name: string, records: NumberRecords = DEFAULT_RECORDS): boolean {
  return floorByName(name, 'x0000', records) === 'x0000';
}
