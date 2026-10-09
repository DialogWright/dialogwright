import type { App } from '../core/app/types';
import { transferHeaderNames, transferVariables, HEADER_NAME } from '../core/transfer';
import { envVariableOf } from '../core/app/envReference';
import { calledVariables } from '../core/routes';
import { writableValue } from '../channel/callData';
import { maskNumber } from '../channel/maskByName';
import { fitHeaders, isSipTarget, SIP_URI_MAX, type DialTarget } from './voice/dial';
import type { Env } from './config';

/**
 * The server's side of transfer targets (app.yaml's `transfer`, core/transfer.ts): the engine chooses
 * a target by its variable's name and the server dials the variable's value. Every variable the app's
 * transfer names is read as the server starts (transferTargetsFrom), and a start with one unset, or
 * holding neither an E.164 number nor a `sip:` URI, is refused with the fix. HANDOFF_NUMBER is the
 * server's own (config.ts), whatever names it. A call put through with no handoff decision (the relay
 * lost for good, a server stopping, a saved call it cannot read) goes to the default.
 */

/** An E.164 number: a plus and 8 to 15 digits, as HANDOFF_NUMBER is held to (config.ts). */
export const E164 = /^\+\d{8,15}$/;

/** A SIP URI a target may be: `sip:` and no space, quote or angle bracket. */
const SIP_URI = /^sip:[^\s"<>]+$/i;

/** The server's own variable, which config.ts reads and holds to E.164. */
export const HANDOFF_VARIABLE = 'HANDOFF_NUMBER';

/** The transfer as the server holds it: each variable's value, the default's variable, and the header names the app may send. */
export interface ServerTransfer {
  readonly numbers: ReadonlyMap<string, string>;
  readonly defaultVariable: string;
  /** Lower case, every rule's and the top-level's (core/transfer.ts transferHeaderNames). */
  readonly headerNames: ReadonlySet<string>;
}

/** What is wrong with a target's value, or null when it is an E.164 number or a `sip:` URI a carrier takes. */
export function targetValueProblem(value: string): string | null {
  if (E164.test(value)) return null;
  if (!SIP_URI.test(value)) return 'is neither an E.164 number (+15551234567) nor a sip: URI (sip:desk@pbx.example.com)';
  if (!writableValue(value)) return 'has a control character';
  if (value.split('?')[0]!.length > SIP_URI_MAX) return `is a SIP URI of more than ${SIP_URI_MAX} characters (the carrier takes one under 255)`;
  return null;
}

/**
 * Each variable the app's transfer names, read from the environment, HANDOFF_NUMBER from the config.
 * Throws, naming the variable, where it is named and the fix, when one is unset or blank or holds
 * neither an E.164 number nor a `sip:` URI. Null for an app without `transfer`: every call then goes to
 * HANDOFF_NUMBER, as before.
 */
export function transferTargetsFrom(app: Pick<App, 'transfer'> | undefined, env: Env, handoffNumber: string): ServerTransfer | null {
  const transfer = app?.transfer;
  if (transfer === undefined) return null;
  const numbers = new Map<string, string>();
  for (const variable of transferVariables(transfer)) {
    if (variable === HANDOFF_VARIABLE) {
      numbers.set(variable, handoffNumber);
      continue;
    }
    const value = env[variable]?.trim();
    if (value === undefined || value === '') throw new Error(`app.yaml's transfer names ${variable}, which is not set: set ${variable} in the app's .env to an E.164 number or a sip: URI, or take it out of transfer`);
    const problem = targetValueProblem(value);
    if (problem !== null) throw new Error(`${variable} (a transfer target in app.yaml) ${problem}: set it to an E.164 number like +15551234567 or a sip: URI like sip:desk@pbx.example.com`);
    numbers.set(variable, value);
  }
  return { numbers, defaultVariable: envVariableOf(transfer.default) ?? HANDOFF_VARIABLE, headerNames: transferHeaderNames(transfer) };
}

/**
 * The variables the app's `called` conditions name (routes.yaml, app.yaml's transfer targets: the number
 * a caller dialed is one of these), read as the server starts: one unset or blank, or that is not an
 * E.164 number, stops it with the fix, as a transfer target's does, since the condition would never
 * hold. The names, never the numbers, for the startup line. None for an app that names none.
 */
export function calledVariablesFrom(app: Pick<App, 'routes' | 'transfer'> | undefined, env: Env): string[] {
  const names = app === undefined ? [] : calledVariables(app);
  for (const variable of names) {
    const value = env[variable]?.trim();
    if (value === undefined || value === '') throw new Error(`a called condition (routes.yaml or app.yaml's transfer) reads ${variable}, which is not set: set ${variable} in the app's .env to the E.164 number callers dial, or take the condition out`);
    if (!E164.test(value)) throw new Error(`${variable} (read by a called condition) is not an E.164 number: set it to the number callers dial, like +15551234567`);
  }
  return names;
}

/** A handoff as the carrier posted it back (the end frame's handoff data, channel/relay/frames.ts endFrame). */
export interface PostedHandoff {
  readonly reasonCode: string;
  readonly target?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A handoff reason as the engine writes one: letters, digits, '-', '_' and '.', at most 64 characters. */
export const PLAIN_REASON = /^[A-Za-z0-9_.-]{1,64}$/;

/** The handoff data the carrier posted back, read: its reason, and for an app with transfer its target and headers (each a string, or left out). */
export function parseHandoff(raw: string): PostedHandoff {
  try {
    const v = JSON.parse(raw) as { reasonCode?: unknown; target?: unknown; headers?: unknown };
    // Written into the server's log line (`dial:<reason>`): a reason that is not a plain token is `unknown`,
    // so a value posted back can never forge a line. Every reason the engine writes is one.
    const reasonCode = typeof v.reasonCode === 'string' && PLAIN_REASON.test(v.reasonCode) ? v.reasonCode : 'unknown';
    const target = typeof v.target === 'string' ? v.target : undefined;
    const headers = typeof v.headers === 'object' && v.headers !== null && !Array.isArray(v.headers)
      ? Object.fromEntries(Object.entries(v.headers as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'))
      : undefined;
    return { reasonCode, ...(target !== undefined ? { target } : {}), ...(headers !== undefined && Object.keys(headers).length > 0 ? { headers } : {}) };
  } catch {
    return { reasonCode: 'unknown' };
  }
}

/**
 * Why a posted header was not sent: the target is a phone number, which carries none (`number`); it
 * would take the headers past the carrier's limit (`size`); the app's transfer does not send that name
 * (`unknown`); its value cannot be written into a dial document (`value`: a control character, a lone
 * surrogate); it is a name already sent in another case (`duplicate`).
 */
export type DropWhy = 'number' | 'size' | 'unknown' | 'value' | 'duplicate';

/** Where a handoff is put through, and what of its headers went and what did not. */
export interface DialPlan {
  readonly target: DialTarget;
  /** The variable dialed (HANDOFF_NUMBER for an app without transfer). */
  readonly variable: string;
  /** The headers sent, by name. */
  readonly sent: readonly string[];
  /** The headers left out, each with why: only names that are header names (HEADER_NAME), so a record never holds a forged one. */
  readonly dropped: readonly { readonly name: string; readonly why: DropWhy }[];
  /** How many posted names were no header name at all: counted, never written anywhere. */
  readonly notHeaders: number;
}

/**
 * Where a posted handoff is put through: its target's value when the target is one the app's transfer
 * names; the app's default when it names none (an end the engine made with no choice, such as a saved
 * call the server cannot read); HANDOFF_NUMBER for a target the app does not have, and for an app
 * without transfer. With the headers the app sends, as many as the target carries (server/voice/dial.ts
 * fitHeaders).
 */
export function dialPlan(transfer: ServerTransfer | null, handoffNumber: string, posted: PostedHandoff): DialPlan {
  const variable = transfer === null ? HANDOFF_VARIABLE
    : posted.target === undefined ? transfer.defaultVariable
    : transfer.numbers.has(posted.target) ? posted.target : HANDOFF_VARIABLE;
  const to = variable === HANDOFF_VARIABLE || transfer === null ? handoffNumber : (transfer.numbers.get(variable) ?? handoffNumber);
  const offered = transfer === null ? {} : (posted.headers ?? {});
  const named: Record<string, string> = {};
  const dropped: { name: string; why: DropWhy }[] = [];
  const lower = new Set<string>();
  let notHeaders = 0;
  for (const [name, value] of Object.entries(offered)) {
    if (!HEADER_NAME.test(name)) notHeaders += 1;
    else if (!transfer!.headerNames.has(name.toLowerCase())) dropped.push({ name, why: 'unknown' });
    else if (lower.has(name.toLowerCase())) dropped.push({ name, why: 'duplicate' });
    else if (!writableValue(value)) dropped.push({ name, why: 'value' });
    else {
      named[name] = value;
      lower.add(name.toLowerCase());
    }
  }
  const fit = fitHeaders(to, named);
  const sent = Object.keys(fit.kept);
  const target: DialTarget = sent.length > 0 ? { to, headers: fit.kept } : { to };
  return { target, variable, sent, dropped: [...fit.dropped.map((name) => ({ name, why: fit.why! })), ...dropped], notHeaders };
}

/** The most dropped header names a log line or the frame log lists; the rest are counted. */
export const DROPPED_SHOWN = 10;

const DROP_WORDS: Readonly<Record<DropWhy, string>> = {
  number: 'a phone number carries none',
  size: 'over the 1024 characters a transfer carries',
  unknown: 'not ones app.yaml sends',
  value: 'a value a dial document cannot carry',
  duplicate: 'a name already sent in another case',
};

/**
 * The headers a plan left out, for the server's log line: grouped by why, at most DROPPED_SHOWN names,
 * the rest and the names that are no header name counted. Empty when none was left out.
 */
export function describeDropped(plan: DialPlan): string {
  const parts: string[] = [];
  let shown = 0;
  let more = 0;
  for (const why of Object.keys(DROP_WORDS) as DropWhy[]) {
    const names = plan.dropped.filter((d) => d.why === why).map((d) => d.name);
    if (names.length === 0) continue;
    const listed = names.slice(0, Math.max(0, DROPPED_SHOWN - shown));
    shown += listed.length;
    more += names.length - listed.length;
    if (listed.length > 0) parts.push(`${listed.join(', ')}: ${DROP_WORDS[why]}`);
  }
  if (more > 0) parts.push(`and ${more} more`);
  if (plan.notHeaders > 0) parts.push(`and ${plan.notHeaders} more not header names`);
  return parts.join('; ');
}

/** The plan as the frame log writes it: the target, the names sent, at most DROPPED_SHOWN dropped with why, and counts of the rest. */
export function recordedPlan(plan: DialPlan): Record<string, unknown> {
  const dropped = plan.dropped.slice(0, DROPPED_SHOWN).map((d) => ({ name: d.name, why: d.why }));
  return {
    target: plan.variable,
    ...(plan.sent.length > 0 ? { sent: [...plan.sent] } : {}),
    ...(dropped.length > 0 ? { dropped } : {}),
    ...(plan.dropped.length > DROPPED_SHOWN ? { moreDropped: plan.dropped.length - DROPPED_SHOWN } : {}),
    ...(plan.notHeaders > 0 ? { notHeaders: plan.notHeaders } : {}),
  };
}

/** Where a call put through with no handoff decision goes: the app's default (HANDOFF_NUMBER without transfer), with no headers. */
export function defaultTarget(transfer: ServerTransfer | null, handoffNumber: string): DialTarget {
  if (transfer === null) return { to: handoffNumber };
  return { to: transfer.numbers.get(transfer.defaultVariable) ?? handoffNumber };
}

/** What a variable dials, for the console: its value, or HANDOFF_NUMBER's for one the app does not name. */
export function targetNumber(transfer: ServerTransfer | null, handoffNumber: string, variable: string | undefined): string {
  return transfer !== null && variable !== undefined && transfer.numbers.has(variable) ? transfer.numbers.get(variable)! : handoffNumber;
}

/** A target as the console shows it: a number by its last four, a SIP URI by its host alone (`sip:…@pbx.example.com`). */
export function maskTarget(to: string): string {
  if (!isSipTarget(to)) return maskNumber(to);
  const host = to.slice(4).split(/[?;]/)[0]!.split('@');
  return host.length > 1 ? `sip:…@${host.at(-1)}` : 'sip:…';
}
