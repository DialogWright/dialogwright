import { maskId } from '../gate/principal';
import type { SlotState } from '../core/session';
import type { SlotSpec } from '../core/slots/types';
import type { App } from '../core/app/types';
import { defaultAppOrNull } from '../core/app/registry';
import { IDENTITY_UNVERIFIED, IDENTITY_VERIFIED } from '../core/decision';
import type { TraceRecord } from './types';

/**
 * The redacted slots as a trace record may carry them, by each slot's SlotSpec.redact
 * (e.g. the account ID, the date of birth, a free-text note). A record holds the session's
 * slots, the slots the model was shown, a pending readback and a handoff's collected slots; each
 * would otherwise carry the whole identifier and factor. Every function here is idempotent, so a
 * record the trace writer already redacted can go through the dashboard's redaction again.
 *
 * What this masks is the slot FIELDS, not the caller's words. The transcript (the speech or text event,
 * the turn state's text, the questions the model was asked) is kept as spoken, so an identifier or
 * birth date said aloud is in the trace as said: the trace is PHI-bearing and stays apart from the
 * audit log, which carries no identity value at all (core/audit.ts).
 *
 * The slots are the app's: each function takes it, and without one the default registered app's
 * (a record carries no app id). With no app at all, nothing is masked.
 *
 * A `length` slot is the caller's statement: 'length' keeps only its length (the trace file; the
 * statement itself lives in the app's system), 'keep' leaves it (the live console shows the words).
 */
export type StatementMode = 'length' | 'keep';

/** The app whose slots say what is masked. */
type Slots = Pick<App, 'slots'> | null;

function ruleOf(app: Slots, slot: string): SlotSpec['redact'] {
  return app !== null && Object.hasOwn(app.slots, slot) ? app.slots[slot]!.redact : undefined;
}

/** A `last4` slot: "55501234", "5550 1234" or "...1234" all become the last four digits, as the gate logs an id. */
export function maskLast4(v: string): string {
  return maskId(v.replace(/\D/g, ''));
}

/** A `mask` slot: "1985-04-12", "April 12th, 1985" or "••/••/1985" all become the year alone. */
export function maskToYear(v: string): string {
  const year = /(\d{4})(?!.*\d{4})/.exec(v)?.[1];
  return `••/••/${year ?? '••••'}`;
}

function maskStatement(v: string): string {
  return /^<\d+ chars>$/.test(v) ? v : `<${v.length} chars>`;
}

/** One value of `slot`, masked; null stays null and every other slot passes through. */
function maskValue(app: Slots, slot: string, v: string | null, mode: StatementMode): string | null {
  if (v === null) return null;
  const rule = ruleOf(app, slot);
  if (rule === 'last4') return maskLast4(v);
  if (rule === 'mask') return maskToYear(v);
  if (rule === 'length' && mode === 'length') return maskStatement(v);
  return v;
}

/** A statement's display is a stand-in, never the words, so only its value is masked. */
function isStatement(app: Slots, slot: string): boolean {
  return ruleOf(app, slot) === 'length';
}

/** A redacted slot's pending partial, its numeric parts zeroed and its shape kept. */
function maskPartial(w: NonNullable<SlotState['window']>): NonNullable<SlotState['window']> {
  const out: NonNullable<SlotState['window']> = { ...w };
  for (const [k, v] of Object.entries(w)) if (k !== 'kind' && typeof v === 'number') out[k] = 0;
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function redactSlotState(app: Slots, slot: string, st: SlotState, mode: StatementMode): SlotState {
  if (!isObject(st)) return st;
  // A statement displays as a stand-in ("your description"), so only its value is masked.
  const display = isStatement(app, slot) ? st.display : maskValue(app, slot, st.display, mode);
  // A redacted slot part-given (a date of birth's month and day): masked to zeroes, keeping the shape.
  const window = ruleOf(app, slot) !== undefined && st.window ? maskPartial(st.window) : st.window;
  return { ...st, value: maskValue(app, slot, st.value, mode), display, window };
}

export function redactSlots(slots: TraceRecord['slots'], mode: StatementMode, app: Slots = defaultAppOrNull()): TraceRecord['slots'] {
  if (!isObject(slots)) return slots;
  const out: Record<string, SlotState> = {};
  for (const [id, st] of Object.entries(slots)) out[id] = redactSlotState(app, id, st, mode);
  return out as TraceRecord['slots'];
}

/** The slots the model was shown (display values), and a pending readback it was told about. */
export function redactTurnState(ts: TraceRecord['turnState'], mode: StatementMode, app: Slots = defaultAppOrNull()): TraceRecord['turnState'] {
  if (!isObject(ts)) return ts;
  const out = { ...ts };
  if (isObject(ts.slots)) {
    const slots: Record<string, unknown> = {};
    for (const [id, st] of Object.entries(ts.slots)) {
      slots[id] = isObject(st) && typeof st.value === 'string' && !isStatement(app, id) ? { ...st, value: maskValue(app, id, st.value, mode) } : st;
    }
    out.slots = slots as typeof ts.slots;
  }
  // Digits keyed so far at a slot's question (the code never gets here: state.ts leaves it out).
  // At an identity factor's question they are part of one, so only their count is kept.
  if (isObject(ts.asr) && typeof ts.asr.dtmf === 'string') out.asr = { ...ts.asr, dtmf: ts.asr.dtmf.replace(/\d/g, '•') };
  const pc = ts.pendingConfirmation;
  if (isObject(pc) && typeof pc.value === 'string') out.pendingConfirmation = { ...pc, value: maskValue(app, pc.target, pc.value, mode) ?? pc.value };
  return out;
}

/**
 * A handoff's collected slots ("what the call collected, as the caller heard it"), masked. These
 * are displays, and a statement's display is its stand-in, "your description", so it stays.
 */
function redactCollected(app: Slots, slots: Record<string, string>, mode: StatementMode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, v] of Object.entries(slots)) {
    // A handoff hands a `verified` slot (a date of birth) over only as whether identity was verified; that stays.
    const verdict = app !== null && Object.hasOwn(app.slots, id) && app.slots[id]!.handoff === 'verified' && (v === IDENTITY_VERIFIED || v === IDENTITY_UNVERIFIED);
    out[id] = isStatement(app, id) || verdict ? v : maskValue(app, id, v, mode) ?? v;
  }
  return out;
}

/** A prompt's variables by slot name: a summary is handed every slot's display, spoken or not. */
function redactVars(app: Slots, vars: unknown, mode: StatementMode): unknown {
  return isObject(vars) ? redactCollected(app, vars as Record<string, string>, mode) : vars;
}

/** The decision's own copies: its variables, its acks' variables, and a handoff's collected slots. */
function redactDecision(app: Slots, d: TraceRecord['decision'], mode: StatementMode): TraceRecord['decision'] {
  if (!isObject(d)) return d;
  const out: Record<string, unknown> = { ...d };
  if ('vars' in d) out.vars = redactVars(app, d.vars, mode);
  if ('acks' in d && Array.isArray(d.acks)) out.acks = d.acks.map((a) => (isObject(a) ? { ...a, vars: redactVars(app, a.vars, mode) } : a));
  if ('slots' in d) out.slots = redactVars(app, d.slots, mode);
  return out as TraceRecord['decision'];
}

/** The `end` frame's handoff data carries the collected slots too, as a JSON string. */
export function redactHandoffData(data: string, mode: StatementMode, app: Slots = defaultAppOrNull()): string {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!isObject(parsed) || !isObject(parsed.slots)) return data;
    return JSON.stringify({ ...parsed, slots: redactCollected(app, parsed.slots as Record<string, string>, mode) });
  } catch {
    return data;
  }
}

/**
 * The runner's side effects: a downstream service's params may carry the caller's statement verbatim
 * (e.g. a depot call's `missingNote`), so each param is masked as the slot of the same name would be.
 */
function redactEffects(app: Slots, effects: TraceRecord['effects'], mode: StatementMode): TraceRecord['effects'] {
  if (!Array.isArray(effects)) return effects;
  return effects.map((e) => {
    if (!isObject(e) || !isObject(e.params)) return e;
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(e.params)) params[k] = typeof v === 'string' ? maskValue(app, k, v, mode) ?? v : v;
    return { ...e, params };
  });
}

/** Every place a record carries a redacted slot's value, masked; nothing else is changed. */
export function redactRecordSlots(record: TraceRecord, mode: StatementMode, app: Slots = defaultAppOrNull()): TraceRecord {
  const out: TraceRecord = { ...record, slots: redactSlots(record.slots, mode, app), turnState: redactTurnState(record.turnState, mode, app) };
  const pc = record.pendingConfirmation;
  if (pc && pc.target === 'slot') out.pendingConfirmation = { ...pc, value: maskValue(app, pc.slot, pc.value, mode) ?? pc.value, display: maskValue(app, pc.slot, pc.display, mode) ?? pc.display };
  out.decision = redactDecision(app, record.decision, mode);
  if (record.effects !== undefined) out.effects = redactEffects(app, record.effects, mode);
  // A transfer hands over what the call collected, identity slots included.
  if (Array.isArray(record.actions)) {
    out.actions = record.actions.map((a) => (isObject(a) && a.type === 'transfer' && isObject(a.slots) ? { ...a, slots: redactCollected(app, a.slots, mode) } : a));
  }
  return out;
}
