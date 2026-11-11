import { createHash } from 'node:crypto';
import { E164 } from '../core/numberLocales';
import type { ActionSpec, ParamSpec } from './business/schema';

/**
 * The arguments of an action the model calls, checked by each param's type before the gate sees them
 * (docs/designs/2026-11-11-agent-runtime.md, "Tools, the gate and confirmation"): a date is a real day,
 * a choice one of its options, a slot one the named lookup returned on this call, a phone a number. A
 * failure goes back to the model as the tool's result, so its reason says what to do instead; it holds
 * no value but the one the model sent.
 */

/** What each lookup returned on this call, by the lookup's name, and when (ms since the epoch). */
export interface Seen {
  [lookup: string]: { results: unknown[]; atMs: number };
}

export type CheckedArgs = { ok: true; params: Record<string, string> } | { ok: false; reason: string };

/** The id of a lookup's result: a bare string, or an object's string `id`. */
export function resultId(result: unknown): string | undefined {
  if (typeof result === 'string') return result;
  if (typeof result === 'object' && result !== null && typeof (result as { id?: unknown }).id === 'string') return (result as { id: string }).id;
  return undefined;
}

/** Whether `iso` is a real day written YYYY-MM-DD. */
function isRealDay(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === iso;
}

/**
 * A phone number as E.164, or null: written with a + and its country code (8 to 15 digits), or as a
 * national number of ten digits (or eleven starting with 1), read as North American (+1).
 */
function asE164(written: string): string | null {
  const t = written.trim();
  if (!/^\+?[\d\s().-]+$/.test(t)) return null;
  const digits = t.replace(/\D/g, '');
  const n = t.startsWith('+') ? `+${digits}` : digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith('1') ? `+${digits}` : null;
  return n !== null && E164.test(n) ? n : null;
}

/** One param's value checked by its type: the value as it is sent on, or the reason it is refused. */
function checkOne(name: string, spec: ParamSpec, raw: string | number, seen: Seen, todayIso: string): { value: string } | { reason: string } {
  const text = String(raw).trim();
  switch (spec.type) {
    case 'date':
      return isRealDay(text) ? { value: text } : { reason: `${name} must be a real date written YYYY-MM-DD (today is ${todayIso}); "${text}" is not one` };
    case 'choice': {
      const options = spec.options ?? [];
      const match = options.find((o) => o.toLowerCase() === text.toLowerCase());
      return match !== undefined ? { value: match } : { reason: `${name} must be one of: ${options.join(', ')}; "${text}" is not one of them` };
    }
    case 'slot': {
      const from = spec.from ?? '';
      const returned = seen[from]?.results.map(resultId) ?? [];
      if (returned.includes(text)) return { value: text };
      return { reason: seen[from] ? `${name} "${text}" is not one ${from} returned on this call: pick a time from ${from}'s results` : `${from} has not been called on this call: call it, then pick a time from ${from}'s results` };
    }
    case 'number':
      return text !== '' && Number.isFinite(Number(text)) ? { value: String(Number(text)) } : { reason: `${name} must be a number; "${text}" is not one` };
    case 'phone': {
      const n = asE164(text);
      return n !== null ? { value: n } : { reason: `${name} must be a phone number with its area code (ten digits, or + and the country code); "${text}" is not one` };
    }
    case 'text':
      return { value: text };
  }
}

/**
 * The call's arguments checked against the action's params: no param it does not take, every required
 * one given, each value checked by its type. An optional param left out (or given as empty or null) is
 * sent as '', so the call carries every param and the confirmation covers each (./policy.ts). The params
 * come back as strings, as the gate and the tools take them. `todayIso` is the call's today, which a
 * refused date's reason names so the model can work out the day it meant.
 */
export function checkArgs(spec: ActionSpec, args: Record<string, unknown>, seen: Seen, todayIso: string): CheckedArgs {
  const names = Object.keys(spec.params);
  const extra = Object.keys(args).filter((k) => !Object.hasOwn(spec.params, k));
  if (extra.length > 0) return { ok: false, reason: `${extra.join(', ')} ${extra.length === 1 ? 'is no param' : 'are no params'} of this action; it takes: ${names.join(', ') || 'none'}` };
  const params: Record<string, string> = {};
  for (const name of names) {
    const p = spec.params[name]!;
    const raw = args[name];
    const absent = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
    if (absent) {
      if (p.optional === true) {
        params[name] = '';
        continue;
      }
      return { ok: false, reason: `${name} is missing: ${p.about}` };
    }
    if (typeof raw !== 'string' && typeof raw !== 'number') return { ok: false, reason: `${name} must be given as text, not ${Array.isArray(raw) ? 'a list' : typeof raw}` };
    const checked = checkOne(name, p, raw, seen, todayIso);
    if ('reason' in checked) return { ok: false, reason: checked.reason };
    params[name] = checked.value;
  }
  return { ok: true, params };
}

/**
 * The key a write is made under (passed to the system it writes to), so a write repeated after a
 * restart is not done twice: the sha256, in hex, of the call, the action and its params in the order of
 * their names. What goes into it is a promise kept across versions.
 */
export function idempotencyKey(callId: string, action: string, params: Record<string, string>): string {
  const sorted = Object.keys(params).sort().map((k) => [k, params[k]!]);
  return createHash('sha256').update(JSON.stringify([callId, action, sorted]), 'utf8').digest('hex');
}
