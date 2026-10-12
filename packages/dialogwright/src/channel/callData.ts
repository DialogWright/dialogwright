import type { AuditMask, CallDataKey } from '../core/app/types';
import { SHORT_MASK, maskId } from '../gate/principal';

/**
 * The data a call or chat came with, read by name (app.yaml's `callData`, App.callData). Carrier-neutral
 * by design: a key names a source by kind, never a carrier's own field.
 * - `param.<name>`: a custom parameter of the relay's setup (`customParameters`; Twilio `<Parameter>`,
 *   Telnyx custom parameters), which a start event's provider details carry as `param.<name>`
 *   (channel/relay/map.ts frameToEvent).
 * - `setup.<field>`: a field of the setup frame the wire keeps (SETUP_FIELDS).
 * - `webhook.<field>`: a field of the carrier's answer webhook. The server copies each named one into
 *   the start document as a custom parameter, `dw_<key>` (webhookParameters), so it comes back with
 *   the setup; nothing is held between the webhook and the socket.
 * - `chat.<key>`: a key of the web chat `start` message's optional `context` (channel/chat/protocol.ts).
 * Only the keys an app names are kept, each only when its source sent a value: a key whose source is
 * absent (or empty) is absent, never an empty string.
 */

/** The kinds of source a key may name. */
export const CALL_DATA_SOURCES = ['param', 'setup', 'webhook', 'chat'] as const;
export type CallDataSourceKind = (typeof CALL_DATA_SOURCES)[number];

/** A source as `from` names it: its kind, and the name within it. */
export interface CallDataSource {
  readonly kind: CallDataSourceKind;
  readonly name: string;
}

/**
 * The optional setup fields a carrier documents, which the relay wire keeps as they arrive
 * (channel/relay/wire.ts parseInbound): Twilio's, then the call ids Telnyx adds (callControlId,
 * callSessionId, callLegId). Anything else on a setup is dropped. Here, outside the relay, because
 * call data names them too (`setup.<field>`).
 */
export const SETUP_EXTRAS = [
  'accountSid', 'parentCallSid', 'forwardedFrom', 'callType', 'callerName', 'direction', 'callStatus',
  'callControlId', 'callSessionId', 'callLegId',
] as const;

/** The setup fields a key may read (`setup.<field>`): the call ids, and the optional fields the wire keeps (SETUP_EXTRAS). */
export const SETUP_FIELDS: readonly string[] = ['callSid', 'sessionId', ...SETUP_EXTRAS];

/** The prefix of the custom parameter the server echoes a webhook field as: `dw_<key>`. */
export const WEBHOOK_PARAMETER_PREFIX = 'dw_';

/**
 * The custom parameter a host's start document carries (several apps on one server, server/host.ts):
 * the app the number called reached at the answer webhook, so the setup, on whichever server it lands,
 * starts the call in the same app. Only under a host file; a server of one app sends none.
 */
export const HOST_APP_PARAMETER = 'dialogwright_app';

/** The most custom parameters a setup keeps, and the longest value (the wire's limits, channel/relay/wire.ts); a chat's context is held to the same. */
export const CALL_DATA_MAX_KEYS = 50;
export const CALL_DATA_VALUE_MAX = 500;

/**
 * The name within a source: a carrier's own names have hyphens and dots (Twilio's
 * `SipHeader_User-to-User`), so a token rather than an identifier; never a space, a quote or a bracket.
 */
export const SOURCE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** A key of a web chat start's `context` (channel/chat/protocol.ts): a source name of at most 64 characters, so a `chat.<key>` longer than that could never arrive. */
export const CONTEXT_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

/**
 * The most a start's `context` may take, as UTF-8 bytes of its JSON: the chat socket takes messages of
 * at most 16 KiB (server/chat/socket.ts CHAT_MAX_PAYLOAD), and a start may also carry a sign-in token
 * of up to 8 KiB (CHAT_TOKEN_MAX), so the context gets what is left with room to spare. Without the cap,
 * 50 values of 500 characters would close the socket with no error the page could read.
 */
export const CHAT_CONTEXT_MAX_BYTES = 6 * 1024;

/** The context's size as the cap counts it: the UTF-8 bytes of its JSON. */
export function contextBytes(context: Readonly<Record<string, unknown>>): number {
  return new TextEncoder().encode(JSON.stringify(context)).length;
}

/**
 * The carrier's copies of the numbers, as sources: the caller's and the called number are app.yaml's
 * `callerNumber` (callerOf, calledOf), kept and masked by its own rules, so call data never reads them.
 */
const NUMBER_SOURCES: Readonly<Record<string, readonly string[]>> = {
  setup: ['from', 'to'],
  param: ['telnyx_call_from', 'telnyx_call_to'],
  webhook: ['From', 'To', 'Caller', 'Called'],
};
const NUMBER_FIX = 'read the numbers with app.yaml\'s callerNumber (callerOf(s), and calledOf(s) with called: true)';

/**
 * Characters a value may not have: the C0 controls (tab and newline included: an XML attribute turns
 * them into spaces, so the value would not come back as sent), DEL, U+FFFE and U+FFFF, and a lone
 * surrogate. None can be written into a start document as it is, so a value with one is no value.
 */
const UNWRITABLE = /[\u0000-\u001F\u007F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Whether `v` can be written into a start document as it is (UNWRITABLE). */
export function writableValue(v: string): boolean {
  return !UNWRITABLE.test(v);
}

/** The custom parameter a key's webhook field is echoed as. */
export function webhookParameterName(key: string): string {
  return `${WEBHOOK_PARAMETER_PREFIX}${key}`;
}

/** The source `from` names, or null when it names none (no prefix, an unknown one, or an empty name). */
export function callDataSourceOf(from: string): CallDataSource | null {
  const dot = from.indexOf('.');
  if (dot <= 0) return null;
  const kind = from.slice(0, dot);
  const name = from.slice(dot + 1);
  if (!(CALL_DATA_SOURCES as readonly string[]).includes(kind) || name === '') return null;
  return { kind: kind as CallDataSourceKind, name };
}

/** What is wrong with a key's `from`, with its fix; null when it names a source the engine reads. Shared by the schema and validateApp. */
export function callDataSourceProblem(from: string): { message: string; fix: string } | null {
  const source = callDataSourceOf(from);
  const sources = CALL_DATA_SOURCES.map((k) => `${k}.<name>`).join(', ');
  if (source === null) {
    return {
      message: `"${from}" is not a source of call data: it must be one of ${sources}`,
      fix: 'write param.<name> for a custom parameter of the setup, setup.<field> for a field of the setup frame, webhook.<field> for a field of the answer webhook, or chat.<key> for a key of the web chat\'s context',
    };
  }
  if (!SOURCE_NAME.test(source.name)) {
    return { message: `"${source.name}" is not a name a ${source.kind} source has: it must use only letters, digits, underscores, hyphens and dots`, fix: 'write the name as the carrier (or the chat client) sends it' };
  }
  if (NUMBER_SOURCES[source.kind]?.includes(source.name)) {
    return { message: `"${from}" is the number the caller is calling from or the number called, which call data does not read`, fix: NUMBER_FIX };
  }
  if (source.kind === 'chat' && !CONTEXT_KEY.test(source.name)) {
    return { message: `"${source.name}" is longer than a web chat context's key may be (64 characters), so it could never arrive`, fix: 'name a shorter key, as the page sends it' };
  }
  if (source.kind === 'setup' && !SETUP_FIELDS.includes(source.name)) {
    return { message: `"${source.name}" is not a field of the setup frame the wire keeps (${SETUP_FIELDS.join(', ')})`, fix: 'name one of those, or read a custom parameter as param.<name>' };
  }
  if (source.kind === 'param' && source.name.startsWith(WEBHOOK_PARAMETER_PREFIX)) {
    return { message: `custom parameters named "${WEBHOOK_PARAMETER_PREFIX}..." are the server's echoes of webhook fields`, fix: 'read the webhook field as webhook.<field> instead' };
  }
  return null;
}

/** How a key is recorded: its `redact`, else `mask`. */
export function redactionOf(key: CallDataKey | undefined): AuditMask {
  return key?.redact ?? 'mask';
}

/**
 * A value fit to keep: a string with something in it, no longer than the wire takes, that a start
 * document can carry as it is (writableValue). Anything else is no value: its key is absent. Shared by
 * the channel's reading, the webhook's echoes and the core's keeping (core/callData.ts), so a chat's
 * context and a seeded value are held to the same.
 */
export function usableCallDataValue(v: unknown): v is string {
  return typeof v === 'string' && v !== '' && v.length <= CALL_DATA_VALUE_MAX && writableValue(v);
}
const usable = usableCallDataValue;

/**
 * The call data a session start carries, by the app's keys: each read from the start's provider
 * details (a setup's fields as they are, its custom parameters as `param.<name>`), or from a chat's
 * context. A key whose source sent nothing (or an empty value, or one longer than the wire takes) is
 * left out. Empty for an app without `callData`.
 */
export function callDataFrom(
  spec: Readonly<Record<string, CallDataKey>> | undefined,
  provider: Readonly<Record<string, string>>,
  context?: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (spec === undefined) return out;
  for (const [key, def] of Object.entries(spec)) {
    const source = callDataSourceOf(def.from);
    if (source === null) continue;
    const at = (o: Readonly<Record<string, string>> | undefined, k: string): string | undefined => (o !== undefined && Object.hasOwn(o, k) ? o[k] : undefined);
    const v = source.kind === 'param' ? at(provider, `param.${source.name}`)
      : source.kind === 'setup' ? (SETUP_FIELDS.includes(source.name) ? at(provider, source.name) : undefined)
      : source.kind === 'webhook' ? at(provider, `param.${webhookParameterName(key)}`)
      : at(context, source.name);
    if (usable(v)) out[key] = v;
  }
  return out;
}

/**
 * The custom parameters the server writes into a start document for the app's `webhook.` keys: each
 * field of the answer webhook a key names, as `dw_<key>`, when the webhook carried a usable value.
 * Empty for an app without such a key, so its documents are as they were.
 */
export function webhookParameters(spec: Readonly<Record<string, CallDataKey>> | undefined, raw: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  if (spec === undefined) return out;
  for (const [key, def] of Object.entries(spec)) {
    const source = callDataSourceOf(def.from);
    if (source?.kind !== 'webhook' || !Object.hasOwn(raw, source.name)) continue;
    const v = raw[source.name];
    if (usable(v)) out[webhookParameterName(key)] = v;
  }
  return out;
}

/**
 * The same echoes from the call data a session kept, for a reconnect's start document: the webhook is
 * not sent again, and the document then carries what the first one did.
 */
export function webhookParametersOfKept(spec: Readonly<Record<string, CallDataKey>> | undefined, kept: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (spec === undefined || kept === undefined) return out;
  for (const [key, def] of Object.entries(spec)) {
    if (callDataSourceOf(def.from)?.kind === 'webhook' && Object.hasOwn(kept, key) && usable(kept[key])) out[webhookParameterName(key)] = kept[key]!;
  }
  return out;
}

/** Already recorded by its length ("<12 chars>"). */
const BY_LENGTH = /^<\d+ chars>$/;
/** Already recorded by its last four ("...1234"), or as too short to show (SHORT_MASK). */
const BY_LAST4 = /^\.\.\..{4}$/;

/**
 * One value as it is recorded by `how` (policy.yaml's `audit:` masks, core/recording.ts recordedValue),
 * null for `secret` (left out). Idempotent, so a record redacted once (the trace file, the frame log)
 * can be redacted again on the console and come out the same.
 */
export function recordedCallData(how: AuditMask, v: string): string | null {
  switch (how) {
    case 'last4': return v === SHORT_MASK || BY_LAST4.test(v) ? v : maskId(v);
    case 'mask': return '•';
    case 'length': return BY_LENGTH.test(v) ? v : `<${v.length} chars>`;
    case 'secret': return null;
    case 'keep': return v;
  }
}

/** The call data as recorded, each key by its own redaction; a `secret` one left out, and a key the app does not name left out too. */
export function recordedCallDataMap(spec: Readonly<Record<string, CallDataKey>> | undefined, data: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(data)) {
    if (typeof v !== 'string') continue;
    const def = spec !== undefined && Object.hasOwn(spec, key) ? spec[key] : undefined;
    const shown = recordedCallData(def === undefined ? 'mask' : redactionOf(def), v);
    if (shown !== null) out[key] = shown;
  }
  return out;
}

/** What the frame log and the console write for a custom parameter no key of the app keeps. */
export const UNNAMED_PARAMETER = 'redacted';

/**
 * The custom parameters that feed the app's keys, by parameter name (a `param.` key's own name, a
 * `webhook.` key's echo `dw_<key>`), with the redaction of the key; a parameter two keys read takes the
 * stricter (any key that does not keep it).
 */
export function parameterRedactions(spec: Readonly<Record<string, CallDataKey>> | undefined): Map<string, AuditMask> {
  return namesRead(spec, (key, source) => (source.kind === 'param' ? source.name : source.kind === 'webhook' ? webhookParameterName(key) : null));
}

/** The setup fields the app's keys read (`setup.<field>`), with the stricter key's redaction. */
export function setupRedactions(spec: Readonly<Record<string, CallDataKey>> | undefined): Map<string, AuditMask> {
  return namesRead(spec, (_key, source) => (source.kind === 'setup' ? source.name : null));
}

/**
 * The custom parameters a record keeps by rules of their own, whatever the app reads: `locale` (a
 * language tag, the engine's), and the carrier's copies of the numbers (`telnyx_call_from`,
 * `telnyx_call_to`), which the caller's-number rules mask where the app keeps the number.
 */
export const OWN_RULE_PARAMETERS: readonly string[] = ['locale', 'telnyx_call_from', 'telnyx_call_to'];

/** The masks from the strictest (left out) to the least (as it is): a name two keys read is recorded by the stricter. */
const STRICTNESS: readonly AuditMask[] = ['secret', 'mask', 'length', 'last4', 'keep'];

/** Each name the app's keys read (as `nameOf` gives it for a key and its source; null for none), with the stricter key's redaction. */
function namesRead(spec: Readonly<Record<string, CallDataKey>> | undefined, nameOf: (key: string, source: CallDataSource) => string | null): Map<string, AuditMask> {
  const out = new Map<string, AuditMask>();
  for (const [key, def] of Object.entries(spec ?? {})) {
    const source = callDataSourceOf(def.from);
    const name = source === null ? null : nameOf(key, source);
    if (name === null) continue;
    const how = redactionOf(def);
    const had = out.get(name);
    out.set(name, had === undefined || STRICTNESS.indexOf(how) < STRICTNESS.indexOf(had) ? how : had);
  }
  return out;
}

/**
 * A setup's custom parameters as the frame log writes them: `locale` as sent (the engine's own, a
 * language tag); one that feeds a key of the app's as the key's redaction says (a `secret` one left
 * out); every other one as `unnamed` says, UNNAMED_PARAMETER unless the caller knows better (the
 * frame log masks a carrier's copy of the caller's number to its last four), since no one named it
 * as worth keeping. A value already redacted comes out the same.
 */
export function recordedCustomParameters(
  spec: Readonly<Record<string, CallDataKey>> | undefined,
  params: Readonly<Record<string, unknown>>,
  unnamed: (name: string, value: string) => string = () => UNNAMED_PARAMETER,
  floor?: (sourceName: string, recorded: string) => string | null,
): Record<string, unknown> {
  const named = parameterRedactions(spec);
  const sources = parameterSourceNames(spec);
  const out: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(params)) {
    if (name === 'locale' || typeof v !== 'string') {
      out[name] = v;
      continue;
    }
    const how = named.get(name);
    if (how === undefined) {
      out[name] = v === UNNAMED_PARAMETER ? v : unnamed(name, v);
      continue;
    }
    const shown = recordedCallData(how, v);
    // The caller's own masking by name is a floor a key's redact never goes under: a value a key keeps
    // whole is masked still where its name (or, for an echo, its webhook field's) is a number or a name.
    const floored = shown === null || floor === undefined || shown !== v ? shown : floor(sources.get(name) ?? name, shown);
    if (floored !== null) out[name] = floored;
  }
  return out;
}

/** By custom parameter name, the name the carrier gave it: a `param.` key's own, a `webhook.` key's echo `dw_<key>` its field. */
export function parameterSourceNames(spec: Readonly<Record<string, CallDataKey>> | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, def] of Object.entries(spec ?? {})) {
    const source = callDataSourceOf(def.from);
    if (source?.kind === 'param') out.set(source.name, source.name);
    else if (source?.kind === 'webhook') out.set(webhookParameterName(key), source.name);
  }
  return out;
}

/**
 * A web chat's `context` as the frame log writes it: a key a `chat.` key of the app's reads as that
 * key's redaction says (a `secret` one left out), every other one as UNNAMED_PARAMETER.
 */
export function recordedContext(spec: Readonly<Record<string, CallDataKey>> | undefined, context: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const named = namesRead(spec, (_key, source) => (source.kind === 'chat' ? source.name : null));
  const out: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(context)) {
    const how = named.get(name);
    if (typeof v !== 'string') continue;
    if (how === undefined) out[name] = UNNAMED_PARAMETER;
    else {
      const shown = recordedCallData(how, v);
      if (shown !== null) out[name] = shown;
    }
  }
  return out;
}

/**
 * A carrier's webhook fields as the frame log writes them: each field a `webhook.` key of the app's
 * reads as that key's redaction says (a `secret` one left out); every other field as it is, for the
 * frame log's own masking by name (server/dashboard/events.ts redactDeep) to do as it always has.
 */
export function recordedWebhookFields(spec: Readonly<Record<string, CallDataKey>> | undefined, raw: Readonly<Record<string, string>>): Record<string, string> {
  const named = namesRead(spec, (_key, source) => (source.kind === 'webhook' ? source.name : null));
  if (named.size === 0) return { ...raw };
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(raw)) {
    const how = named.get(name);
    if (how === undefined) out[name] = v;
    else {
      const shown = recordedCallData(how, v);
      if (shown !== null) out[name] = shown;
    }
  }
  return out;
}
