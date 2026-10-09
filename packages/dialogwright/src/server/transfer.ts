import type { App } from '../core/app/types';
import { transferHeaderNames, transferVariables, HEADER_NAME } from '../core/transfer';
import { envVariableOf } from '../core/app/envReference';
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

/** A handoff as the carrier posted it back (the end frame's handoff data, channel/relay/frames.ts endFrame). */
export interface PostedHandoff {
  readonly reasonCode: string;
  readonly target?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** The handoff data the carrier posted back, read: its reason, and for an app with transfer its target and headers (each a string, or left out). */
export function parseHandoff(raw: string): PostedHandoff {
  try {
    const v = JSON.parse(raw) as { reasonCode?: unknown; target?: unknown; headers?: unknown };
    const reasonCode = typeof v.reasonCode === 'string' ? v.reasonCode : 'unknown';
    const target = typeof v.target === 'string' ? v.target : undefined;
    const headers = typeof v.headers === 'object' && v.headers !== null && !Array.isArray(v.headers)
      ? Object.fromEntries(Object.entries(v.headers as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'))
      : undefined;
    return { reasonCode, ...(target !== undefined ? { target } : {}), ...(headers !== undefined && Object.keys(headers).length > 0 ? { headers } : {}) };
  } catch {
    return { reasonCode: 'unknown' };
  }
}

/** Where a handoff is put through, and what of its headers went and what did not. */
export interface DialPlan {
  readonly target: DialTarget;
  /** The variable dialed (HANDOFF_NUMBER for an app without transfer). */
  readonly variable: string;
  /** The headers sent, by name. */
  readonly sent: readonly string[];
  /** The headers left out, by name: every one for a phone number (`number`), those over the limit (`size`), or those the app does not send (`unknown`). */
  readonly dropped: readonly string[];
  readonly why?: 'number' | 'size' | 'unknown';
}

/**
 * Where a posted handoff is put through: its target's value when the target is one the app's transfer
 * names, else HANDOFF_NUMBER (a target the app does not name, or an app without transfer); with the
 * headers the app sends, as many as the target carries (server/voice/dial.ts fitHeaders).
 */
export function dialPlan(transfer: ServerTransfer | null, handoffNumber: string, posted: PostedHandoff): DialPlan {
  const variable = transfer !== null && posted.target !== undefined && transfer.numbers.has(posted.target) ? posted.target : HANDOFF_VARIABLE;
  const to = variable === HANDOFF_VARIABLE ? handoffNumber : transfer!.numbers.get(variable)!;
  const offered = transfer === null ? {} : (posted.headers ?? {});
  const named: Record<string, string> = {};
  const unknown: string[] = [];
  for (const [name, value] of Object.entries(offered)) {
    if (HEADER_NAME.test(name) && transfer!.headerNames.has(name.toLowerCase()) && writableValue(value)) named[name] = value;
    else unknown.push(name);
  }
  const fit = fitHeaders(to, named);
  const sent = Object.keys(fit.kept);
  const target: DialTarget = sent.length > 0 ? { to, headers: fit.kept } : { to };
  if (fit.dropped.length > 0) return { target, variable, sent, dropped: [...fit.dropped, ...unknown], why: fit.why! };
  if (unknown.length > 0) return { target, variable, sent, dropped: unknown, why: 'unknown' };
  return { target, variable, sent, dropped: [] };
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
