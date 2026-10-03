import { maskId } from './principal';
import type { GateLookups, RuleContext, RuleOutcome, ToolCall } from './types';

/**
 * The two built-in rules that hold a call's value to bounds: `dateInRange` (a date param on or after,
 * on or before, and within a window) and `limit` (a number param at least, at most), with the small
 * reference grammar their bounds are written in.
 *
 * A bound is a literal (a date, `today`, a number) or a reference to one of the app's lookups:
 *
 *   <lookup>(<param>)            the lookup called with the call's value of <param>
 *   <lookup>(<param>).<field>    the same, then one field of what it returned
 *
 * Every name is a plain word (a letter, then letters, digits and underscores). The grammar is read
 * when the policy is compiled; nothing in it is run. A lookup is a function the app's code declares
 * (AppCode.lookups, DefinePolicyOptions.lookups) on its GateLookups; `check` refuses a reference to
 * one it does not declare. No name may be one an object has from Object.prototype (`constructor`,
 * `toString`, ...) or `prototype`, a lookup may not be the gate's own (`ownerOf`, `scopeOf`), and a
 * field is read only as an own data property of a plain object the lookup returned (never a getter,
 * never an array's), so a reference reaches the one value it names and nothing else.
 *
 * A bound resolves only through the app's lookups (its code and systems), never through session
 * facts or the conversation; `today` is the session's date (GateFacts.todayIso), never the clock.
 *
 * Both rules fail closed. A value that is not a date (yyyy-mm-dd, a real calendar day) or not a
 * number (an optional minus, digits, an optional point and digits: no units, separators, exponents
 * or spaces) BLOCKs. A bound that cannot be resolved (the param the reference reads is missing, the
 * lookup is not a function, it returned something that is not a date, a number or a window) BLOCKs
 * with reason `bound-unknown`. A lookup that throws BLOCKs too (the gate's own rule-error). Every
 * bound is inclusive: `notBefore`, `notAfter`, `min`, `max` and the window's two ends all admit the
 * value equal to them.
 *
 * What the lines show: the field's name and the bounds (today's date, a literal, what a lookup
 * returned), with the param a lookup was called with masked to its last four (maskId). Never the
 * call's own value: it may be a slot the app redacts, and a compared line reaches the audit as is.
 */

/** A reference to one of the app's lookups: `<lookup>(<param>)` or `<lookup>(<param>).<field>`. */
export interface LookupRef {
  readonly lookup: string;
  readonly param: string;
  readonly field?: string;
}

/** A date bound: today's date, a date, or a lookup that gives one. */
export type DateBound =
  | { readonly kind: 'today' }
  | { readonly kind: 'date'; readonly date: string }
  | { readonly kind: 'lookup'; readonly ref: LookupRef };

/** A number bound: a number (as its decimal text), or a lookup that gives one. */
export type NumberBound =
  | { readonly kind: 'number'; readonly value: string }
  | { readonly kind: 'lookup'; readonly ref: LookupRef };

/** The verdict a range rule may give a value out of its bounds: refused, or handed to a person. */
export type RangeVerdict = 'BLOCK' | 'NEEDS_HUMAN';

/** The ways `dateInRange` fails that an action may give its own reason for. */
export interface DateInRangeReasons {
  /** The value is not a date. Default "not-a-date". Always BLOCK. */
  readonly invalid?: string;
  /** The value is before notBefore or after notAfter. Default "date-range". */
  readonly outOfRange?: string;
  /** The value is outside the window `within` gives, or the lookup has no window (null). Default "date-window". */
  readonly outsideWindow?: string;
}

/** The ways `limit` fails that an action may give its own reason for. */
export interface LimitReasons {
  /** The value is not a number. Default "not-a-number". Always BLOCK. */
  readonly invalid?: string;
  /** The value is below min or above max. Default "limit". */
  readonly outOfRange?: string;
}

/** The parameters of a `dateInRange` rule, read. */
export interface DateInRangeParams {
  readonly field: string;
  readonly notBefore?: DateBound;
  readonly notAfter?: DateBound;
  readonly within?: LookupRef;
  readonly reasons?: DateInRangeReasons;
  readonly verdicts?: { readonly outOfRange?: RangeVerdict; readonly outsideWindow?: RangeVerdict };
}

/** The parameters of a `limit` rule, read. */
export interface LimitParams {
  readonly field: string;
  readonly min?: NumberBound;
  readonly max?: NumberBound;
  readonly reasons?: LimitReasons;
  readonly verdicts?: { readonly outOfRange?: RangeVerdict };
}

/** The default reasons, by failure. */
export const DATE_IN_RANGE_REASONS = { invalid: 'not-a-date', outOfRange: 'date-range', outsideWindow: 'date-window' } as const;
export const LIMIT_REASONS = { invalid: 'not-a-number', outOfRange: 'limit' } as const;
/** The reason a bound that cannot be resolved BLOCKs for (either rule). */
export const BOUND_UNKNOWN = 'bound-unknown';

// ---------------------------------------------------------------------------------------------
// The grammar
// ---------------------------------------------------------------------------------------------

const WORD = /^[A-Za-z][A-Za-z0-9_]*$/;
const REF = /^([A-Za-z][A-Za-z0-9_]*)\(([A-Za-z][A-Za-z0-9_]*)\)(?:\.([A-Za-z][A-Za-z0-9_]*))?$/;
/** A reference longer than this is refused: three plain words do not need more. */
const MAX_REF_LENGTH = 200;

/** The gate's own lookups, which a reference may not call: they are not functions of a param's value. */
export const GATE_LOOKUPS: readonly string[] = ['ownerOf', 'scopeOf'];

/**
 * Whether `name` may be read off an object by a reference: a plain word that no object has from
 * Object.prototype (constructor, toString, hasOwnProperty, ...) and not `prototype`.
 */
export function isSafeName(name: string): boolean {
  return WORD.test(name) && name !== 'prototype' && !Object.hasOwn(Object.prototype, name);
}

/** Why a lookup name cannot be used, or null when it can. */
export function lookupNameProblem(name: string): string | null {
  if (!WORD.test(name)) return `"${name}" is not a plain word (a letter, then letters, digits and underscores)`;
  if (!isSafeName(name)) return `"${name}" is a name every object has (from Object.prototype), not one of the app's lookups`;
  if (GATE_LOOKUPS.includes(name)) return `"${name}" is one of the gate's own lookups, which take a record id or a caller, not a param's value`;
  return null;
}

/** A reference, read; or what is wrong with it. */
export function parseLookupRef(text: string): { ref: LookupRef } | { problem: string } {
  if (text.length > MAX_REF_LENGTH) return { problem: `the reference is longer than ${MAX_REF_LENGTH} characters` };
  const m = REF.exec(text);
  if (!m) return { problem: `"${text}" is not a reference: write <lookup>(<param>), or <lookup>(<param>).<field>, each a plain word with no spaces` };
  const [, lookup, param, field] = m as unknown as [string, string, string, string | undefined];
  const bad = lookupNameProblem(lookup);
  if (bad) return { problem: bad };
  if (field !== undefined && !isSafeName(field)) return { problem: `the field "${field}" is a name every object has (from Object.prototype), not a field a lookup returns` };
  return { ref: field === undefined ? { lookup, param } : { lookup, param, field } };
}

/** A reference as written. */
export function refText(ref: LookupRef): string {
  return `${ref.lookup}(${ref.param})${ref.field === undefined ? '' : `.${ref.field}`}`;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `value` is a date: yyyy-mm-dd, a day the calendar has (year 0001 to 9999). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  return d <= days;
}

/** A date bound as written, read; or what is wrong with it. */
export function parseDateBound(value: unknown): { bound: DateBound } | { problem: string } {
  if (typeof value !== 'string') return { problem: 'a date bound is "today", a date (yyyy-mm-dd) or a reference, <lookup>(<param>)' };
  if (value === 'today') return { bound: { kind: 'today' } };
  if (DATE.test(value)) return isIsoDate(value) ? { bound: { kind: 'date', date: value } } : { problem: `"${value}" is not a day the calendar has` };
  const ref = parseLookupRef(value);
  return 'ref' in ref ? { bound: { kind: 'lookup', ref: ref.ref } } : { problem: `${ref.problem}; a date bound is "today", a date (yyyy-mm-dd) or a reference` };
}

const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
/** A number's text longer than this is not a number the rule reads: it is refused, not rounded. */
const MAX_NUMBER_LENGTH = 40;

/** A number as the limit rule reads it: an exact decimal (digits scaled by a power of ten), or null. */
interface Decimal {
  readonly digits: bigint;
  readonly scale: number;
}

/**
 * A value as a number, strictly: a decimal text (an optional minus, digits with no leading zero, an
 * optional point and digits) or a finite JavaScript number whose text is one. Nothing else: no
 * spaces, signs other than a leading minus, thousands separators, units, currency, exponents.
 */
export function readDecimal(value: unknown): Decimal | null {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    text = String(value);
  } else if (typeof value === 'string') {
    text = value;
  } else {
    return null;
  }
  if (text.length > MAX_NUMBER_LENGTH || !DECIMAL.test(text)) return null;
  const negative = text.startsWith('-');
  const [whole, frac = ''] = (negative ? text.slice(1) : text).split('.') as [string, string?];
  const digits = BigInt(whole + frac);
  return { digits: negative ? -digits : digits, scale: frac.length };
}

/** a compared with b: negative, zero or positive. Exact. */
function compareDecimal(a: Decimal, b: Decimal): number {
  const scale = Math.max(a.scale, b.scale);
  const x = a.digits * 10n ** BigInt(scale - a.scale);
  const y = b.digits * 10n ** BigInt(scale - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A number bound as written, read; or what is wrong with it. */
export function parseNumberBound(value: unknown): { bound: NumberBound } | { problem: string } {
  if (typeof value === 'number' || (typeof value === 'string' && DECIMAL.test(value))) {
    return readDecimal(value) !== null ? { bound: { kind: 'number', value: String(value) } } : { problem: `${String(value)} is not a number the rule reads exactly (write it as plain digits, with a point if it has a fraction)` };
  }
  if (typeof value !== 'string') return { problem: 'a number bound is a number or a reference, <lookup>(<param>) or <lookup>(<param>).<field>' };
  const ref = parseLookupRef(value);
  return 'ref' in ref ? { bound: { kind: 'lookup', ref: ref.ref } } : { problem: `${ref.problem}; a number bound is a number or a reference` };
}

/** The two literal bounds of a rule in order, where both are literals: whether low <= high. Null where either is a reference or today. */
export function literalOrder(low: DateBound | NumberBound | undefined, high: DateBound | NumberBound | undefined): boolean | null {
  if (low?.kind === 'date' && high?.kind === 'date') return low.date <= high.date;
  if (low?.kind === 'number' && high?.kind === 'number') return compareDecimal(readDecimal(low.value)!, readDecimal(high.value)!) <= 0;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Resolving a reference
// ---------------------------------------------------------------------------------------------

/** A param of the call, own properties only. */
function paramOf(call: ToolCall, param: string): string | undefined {
  return Object.hasOwn(call.params, param) ? call.params[param] : undefined;
}

/** A reference as a line shows it: the lookup, the param's name and its value masked. */
function refShown(ref: LookupRef, call: ToolCall): string {
  const value = paramOf(call, ref.param);
  const arg = value === undefined || value === '' ? `${ref.param} missing` : `${ref.param} ${maskId(value)}`;
  return `${ref.lookup}(${arg})${ref.field === undefined ? '' : `.${ref.field}`}`;
}

/** One own data property of a plain object: not a getter, not an array's, not from a prototype. */
function ownData(obj: unknown, key: string): { value: unknown } | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj) || !isSafeName(key)) return null;
  const d = Object.getOwnPropertyDescriptor(obj, key);
  return d !== undefined && 'value' in d ? { value: d.value } : null;
}

type Resolved = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/**
 * What a reference gives for this call: the lookup called with the param's value, then its field if
 * it names one. Not ok (the bound is unknown) when the param is missing or empty, the name is not a
 * safe one, the lookup is not a function, or the field is not an own data property of a plain object.
 * The lookup is the app's code: if it throws, the gate BLOCKs the call (rule-error).
 */
function resolveRef(ref: LookupRef, call: ToolCall, lk: GateLookups): Resolved {
  const arg = paramOf(call, ref.param);
  if (arg === undefined || arg === '' || !isSafeName(ref.lookup) || GATE_LOOKUPS.includes(ref.lookup)) return { ok: false };
  const fn = (lk as unknown as Record<string, unknown>)[ref.lookup];
  if (typeof fn !== 'function') return { ok: false };
  const value: unknown = fn.call(lk, arg);
  if (ref.field === undefined) return { ok: true, value };
  const field = ownData(value, ref.field);
  return field ? { ok: true, value: field.value } : { ok: false };
}

// ---------------------------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------------------------

/** A bound resolved to what it compares with, and how the line shows it; null when unknown. */
interface Bound<T> {
  readonly value: T;
  readonly shown: string;
}

function dateBound(b: DateBound, c: RuleContext): Bound<string> | null {
  switch (b.kind) {
    case 'today':
      return isIsoDate(c.facts.todayIso) ? { value: c.facts.todayIso, shown: `today ${c.facts.todayIso}` } : null;
    case 'date':
      return isIsoDate(b.date) ? { value: b.date, shown: b.date } : null;
    case 'lookup': {
      const r = resolveRef(b.ref, c.call, c.lk);
      return r.ok && isIsoDate(r.value) ? { value: r.value, shown: `${refShown(b.ref, c.call)} ${r.value}` } : null;
    }
  }
}

function numberBound(b: NumberBound, c: RuleContext): Bound<Decimal> | null {
  if (b.kind === 'number') {
    const d = readDecimal(b.value);
    return d ? { value: d, shown: b.value } : null;
  }
  const r = resolveRef(b.ref, c.call, c.lk);
  if (!r.ok) return null;
  const d = readDecimal(r.value);
  return d ? { value: d, shown: `${refShown(b.ref, c.call)} ${String(r.value)}` } : null;
}

/** The window a `within` lookup gives: its start and its end (null: open-ended); null for no window; undefined when it is not one. */
function windowOf(value: unknown): { start: string; end: string | null } | null | undefined {
  if (value === null) return null;
  const start = ownData(value, 'start');
  const end = ownData(value, 'end');
  if (!start || !end || !isIsoDate(start.value) || (end.value !== null && !isIsoDate(end.value))) return undefined;
  return { start: start.value, end: end.value as string | null };
}

/** The id each range rule records itself under: its name (it has no legacy id). */
export const DATE_IN_RANGE_ID = 'dateInRange';
export const LIMIT_ID = 'limit';

/** dateInRange: the date in `field` is a date, within its bounds (each inclusive), and within the window a lookup gives. */
export function dateInRangeRule(params: DateInRangeParams): (c: RuleContext) => RuleOutcome {
  const { field } = params;
  const id = DATE_IN_RANGE_ID;
  const description = `The date in ${field} is within its bounds`;
  const reason = { ...DATE_IN_RANGE_REASONS, ...params.reasons };
  const verdict = { outOfRange: params.verdicts?.outOfRange ?? 'BLOCK', outsideWindow: params.verdicts?.outsideWindow ?? 'BLOCK' } as const;
  const failed = (compared: string, v: RangeVerdict, why: string): RuleOutcome => ({ result: { id, description, compared, pass: false }, fail: { verdict: v, reason: why } });
  return (c) => {
    const value = paramOf(c.call, field);
    if (!isIsoDate(value)) return failed(`${field} ${value === undefined || value === '' ? 'missing' : 'is not a date'}`, 'BLOCK', reason.invalid);
    const held: string[] = [];
    for (const [which, b] of [['notBefore', params.notBefore], ['notAfter', params.notAfter]] as const) {
      if (b === undefined) continue;
      const bound = dateBound(b, c);
      if (!bound) return failed(`${field}: ${which} ${b.kind === 'lookup' ? refShown(b.ref, c.call) : b.kind} gave no date`, 'BLOCK', BOUND_UNKNOWN);
      if (which === 'notBefore' && value < bound.value) return failed(`${field} before ${bound.shown}`, verdict.outOfRange, reason.outOfRange);
      if (which === 'notAfter' && value > bound.value) return failed(`${field} after ${bound.shown}`, verdict.outOfRange, reason.outOfRange);
      held.push(`${which === 'notBefore' ? 'on or after' : 'on or before'} ${bound.shown}`);
    }
    if (params.within) {
      const r = resolveRef(params.within, c.call, c.lk);
      const shown = refShown(params.within, c.call);
      const w = r.ok ? windowOf(r.value) : undefined;
      if (w === undefined) return failed(`${field}: within ${shown} gave no window`, 'BLOCK', BOUND_UNKNOWN);
      if (w === null) return failed(`${field}: ${shown} has no window`, verdict.outsideWindow, reason.outsideWindow);
      const span = `${shown} ${w.start}..${w.end ?? 'open'}`;
      if (value < w.start || (w.end !== null && value > w.end)) return failed(`${field} outside ${span}`, verdict.outsideWindow, reason.outsideWindow);
      held.push(`within ${span}`);
    }
    return { result: { id, description, compared: `${field} ${held.join(', ')}`, pass: true } };
  };
}

/** limit: the number in `field` is a number, at least `min` and at most `max` (each inclusive). */
export function limitRule(params: LimitParams): (c: RuleContext) => RuleOutcome {
  const { field } = params;
  const id = LIMIT_ID;
  const description = `The number in ${field} is within its limits`;
  const reason = { ...LIMIT_REASONS, ...params.reasons };
  const outOfRange = params.verdicts?.outOfRange ?? 'BLOCK';
  const failed = (compared: string, v: RangeVerdict, why: string): RuleOutcome => ({ result: { id, description, compared, pass: false }, fail: { verdict: v, reason: why } });
  return (c) => {
    const raw = paramOf(c.call, field);
    const value = readDecimal(raw);
    if (!value) return failed(`${field} ${raw === undefined || raw === '' ? 'missing' : 'is not a number'}`, 'BLOCK', reason.invalid);
    const held: string[] = [];
    for (const [which, b] of [['min', params.min], ['max', params.max]] as const) {
      if (b === undefined) continue;
      const bound = numberBound(b, c);
      if (!bound) return failed(`${field}: ${which} ${b.kind === 'lookup' ? refShown(b.ref, c.call) : b.value} gave no number`, 'BLOCK', BOUND_UNKNOWN);
      const cmp = compareDecimal(value, bound.value);
      if (which === 'min' && cmp < 0) return failed(`${field} below ${bound.shown}`, outOfRange, reason.outOfRange);
      if (which === 'max' && cmp > 0) return failed(`${field} above ${bound.shown}`, outOfRange, reason.outOfRange);
      held.push(`${which === 'min' ? 'at least' : 'at most'} ${bound.shown}`);
    }
    return { result: { id, description, compared: `${field} ${held.join(', ')}`, pass: true } };
  };
}
