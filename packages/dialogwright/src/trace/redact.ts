import { SHORT_MASK, maskId } from '../gate/principal';
import type { SlotState } from '../core/session';
import type { SlotSpec } from '../core/slots/types';
import type { App, AuditMask } from '../core/app/types';
import { recordedValue, spokenValuesScrubber, type Scrub } from '../core/recording';
import { defaultAppOrNull } from '../core/app/registry';
import { IDENTITY_UNVERIFIED, IDENTITY_VERIFIED } from '../core/decision';
import type { TraceRecord } from './types';
import { transferSources } from '../core/transfer';
import { OWN_RULE_PARAMETERS, parameterRedactions, recordedCallData, recordedCallDataMap, setupRedactions, UNNAMED_PARAMETER } from '../channel/callData';

/**
 * The redacted slots as a trace record may carry them, by each slot's SlotSpec.redact
 * (e.g. the account ID, the date of birth, a free-text note). A record holds the session's
 * slots, the slots the model was shown, a pending readback and a handoff's collected slots; each
 * would otherwise carry the whole identifier and factor. Every function here is idempotent, so a
 * record the trace writer already redacted can go through the dashboard's redaction again.
 *
 * What this masks is the slot FIELDS, and what our own lines said of them (the say actions' text, an
 * interruption's `heard`), not the caller's words. The transcript (the speech or text event,
 * the turn state's text, the questions the model was asked) is kept as spoken, so an identifier or
 * birth date said aloud is in the trace as said: the trace is PHI-bearing and stays apart from the
 * audit log, which carries no identity value at all (core/audit.ts).
 *
 * The slots are the app's: each function takes it, and without one the default registered app's
 * (a record carries no app id). With no app at all, nothing is masked.
 *
 * A `length` slot is the caller's statement: 'length' keeps only its length (the trace file; the
 * statement itself lives in the app's system), 'keep' leaves it (the live console shows the words).
 * A `length` slot that is a secret (SlotSpec.statement false: a PIN) is kept by its length in both.
 */
export type StatementMode = 'length' | 'keep';

/** The app whose slots (and, for a side effect's params, policy.yaml's `audit:`) say what is masked. */
type Slots = (Pick<App, 'slots'> & { readonly policy?: Pick<App['policy'], 'audit'>; readonly callerNumber?: App['callerNumber']; readonly callData?: App['callData']; readonly transfer?: App['transfer']; readonly generated?: App['generated'] }) | null;

function ruleOf(app: Slots, slot: string): SlotSpec['redact'] {
  return app !== null && Object.hasOwn(app.slots, slot) ? app.slots[slot]!.redact : undefined;
}

/**
 * A `last4` slot: "55501234", "5550 1234" or "...1234" all become the last four digits, as the gate
 * logs an id (maskId); one of four digits or fewer ("4821", "48 21") becomes SHORT_MASK, which stays.
 */
export function maskLast4(v: string): string {
  if (v === SHORT_MASK || /^\.\.\.\d{4}$/.test(v)) return v;
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
  if (rule === 'length' && (mode === 'length' || isSecretByLength(app, slot))) return maskStatement(v);
  return v;
}

/**
 * A statement's display is a stand-in, never the words, so only its value is masked. A slot by its
 * length that is no statement (SlotSpec.statement false, a short secret) shows its value as its display.
 */
function isStatement(app: Slots, slot: string): boolean {
  return ruleOf(app, slot) === 'length' && app!.slots[slot]!.statement !== false;
}

/** A slot by its length that is a secret, not the caller's words (SlotSpec.statement false): masked on the live console too. */
function isSecretByLength(app: Slots, slot: string): boolean {
  return ruleOf(app, slot) === 'length' && app!.slots[slot]!.statement === false;
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

/**
 * One collected slot's handoff value masked as the trace file masks it (redactCollected, a
 * statement by its length): what a transfer hands the channel for a slot it sends `masked`
 * (handoff/data.ts).
 */
export function maskCollectedSlot(app: Slots, slot: string, v: string): string {
  return redactCollected(app, { [slot]: v }, 'length')[slot]!;
}

/**
 * What a transfer sends (its SIP headers, or a chat's data, app.yaml's transfer.send), as a record keeps
 * it: a value sent from a slot is masked as the record masks that slot (redactCollected), whichever rule
 * sent it. A name the app sends from more than one slot is written `•`; one sent from a slot in one rule
 * and a constant in another is masked as the slot is, so a record is never less strict than the slot.
 * Every other value (the reason, the form, a constant, a call data key already sent as its redact
 * records it) is as sent.
 */
export function redactSent(app: Slots, part: 'headers' | 'chat', values: unknown, mode: StatementMode): unknown {
  if (!isObject(values) || app === null || app.transfer === undefined) return values;
  const sources = transferSources(app.transfer, part);
  const out: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(values)) {
    const slots = [...new Set((sources.get(part === 'headers' ? name.toLowerCase() : name) ?? []).flatMap((s) => (s.kind === 'slot' ? [s.slot] : [])))];
    if (typeof v !== 'string' || slots.length === 0) out[name] = v;
    else if (slots.length === 1) out[name] = redactCollected(app, { [slots[0]!]: v }, mode)[slots[0]!];
    else out[name] = '•';
  }
  return out;
}

/** A transfer choice's or action's headers and data (core/transfer.ts), as a record keeps them (redactSent). */
function redactTransferParts<T extends Record<string, unknown>>(app: Slots, o: T, mode: StatementMode): T {
  if (!('headers' in o) && !('data' in o)) return o;
  return { ...o, ...('headers' in o ? { headers: redactSent(app, 'headers', o.headers, mode) } : {}), ...('data' in o ? { data: redactSent(app, 'chat', o.data, mode) } : {}) };
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
  if ('transfer' in d && isObject(d.transfer)) out.transfer = redactTransferParts(app, d.transfer, mode);
  return out as TraceRecord['decision'];
}

/** The `end` frame's handoff data carries the collected slots too, as a JSON string. */
export function redactHandoffData(data: string, mode: StatementMode, app: Slots = defaultAppOrNull()): string {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!isObject(parsed) || (!isObject(parsed.slots) && !isObject(parsed.headers))) return data;
    return JSON.stringify({
      ...parsed,
      ...(isObject(parsed.slots) ? { slots: redactCollected(app, parsed.slots as Record<string, string>, mode) } : {}),
      ...(isObject(parsed.headers) ? { headers: redactSent(app, 'headers', parsed.headers, mode) } : {}),
    });
  } catch {
    return data;
  }
}

/** How policy.yaml's `audit:` records a param that is no redacted slot; undefined where it says nothing. */
function auditOf(app: Slots, param: string): AuditMask | undefined {
  const audit = app?.policy?.audit;
  return audit !== undefined && Object.hasOwn(audit, param) ? audit[param] : undefined;
}

/**
 * The runner's side effects: a downstream service's params may carry the caller's statement verbatim
 * (e.g. a depot call's `missingNote`), so each param is masked as the slot of the same name would be,
 * and a param that is no redacted slot as policy.yaml's `audit:` declares it, on the live console
 * too (a secret one left out): only a slot's statement keeps its words there.
 */
function redactEffects(app: Slots, effects: TraceRecord['effects'], mode: StatementMode): TraceRecord['effects'] {
  if (!Array.isArray(effects)) return effects;
  return effects.map((e) => {
    if (!isObject(e) || !isObject(e.params)) return e;
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(e.params)) {
      const declared = ruleOf(app, k) === undefined ? auditOf(app, k) : undefined;
      if (typeof v !== 'string' || declared === undefined) params[k] = typeof v === 'string' ? maskValue(app, k, v, mode) ?? v : v;
      else if (declared === 'length') params[k] = maskStatement(v);
      else {
        const shown = recordedValue(declared, v);
        if (shown !== null) params[k] = shown;
      }
    }
    return { ...e, params };
  });
}

/** A redacted slot's raw text and how it is shown, for the scrub of what was said (null: not one to look for). */
function spokenEntry(app: Slots, slot: string, raw: unknown, mode: StatementMode, display: boolean): { raw: string; shown: string; lastFour: boolean } | null {
  const rule = ruleOf(app, slot);
  if (rule === undefined || typeof raw !== 'string' || raw === '') return null;
  // A statement is shown in full on the live console, and its display is a stand-in ("your description"), never the words.
  if (rule === 'length' && !isSecretByLength(app, slot) && (mode === 'keep' || display)) return null;
  const shown = maskValue(app, slot, raw, mode) ?? raw;
  return { raw, shown, lastFour: rule !== 'last4' };
}

/**
 * The scrub of what a session's lines said aloud, built from the redacted slots it holds (each
 * slot's value and display, and a pending readback's): each raw value, its last-four form (for a
 * slot not shown by its last four) and its digits however spaced or grouped (core/recording.ts
 * spokenValuesScrubber), replaced by the slot's masked form. Null when there is nothing to look for.
 */
export function slotsScrubber(
  slots: Readonly<Record<string, { readonly value?: unknown; readonly display?: unknown } | null | undefined>> | null | undefined,
  pending: { readonly target: string; readonly slot?: string; readonly value?: unknown; readonly display?: unknown } | null | undefined,
  mode: StatementMode,
  app: Slots = defaultAppOrNull(),
  more: Iterable<readonly [slot: string, text: unknown]> = [],
  options: { readonly cutOff?: boolean } = {},
): Scrub | null {
  const entries: { raw: string; shown: string; lastFour: boolean }[] = [];
  const add = (slot: string, raw: unknown, display: boolean): void => {
    const e = spokenEntry(app, slot, raw, mode, display);
    if (e) entries.push(e);
  };
  if (isObject(slots)) {
    for (const [id, st] of Object.entries(slots)) {
      if (!isObject(st)) continue;
      add(id, st.value, false);
      add(id, st.display, true);
    }
  }
  if (isObject(pending) && pending.target === 'slot' && typeof pending.slot === 'string') {
    add(pending.slot, pending.value, false);
    add(pending.slot, pending.display, true);
  }
  for (const [slot, text] of more) add(slot, text, true);
  return spokenValuesScrubber(entries, options);
}

/** The raw texts a turn carries of its redacted slots beside its slots and readback: its decision's variables and a handoff's or a transfer's collected slots. */
function decisionTexts(decision: unknown, actions: unknown): [string, unknown][] {
  const out: [string, unknown][] = [];
  const vars = (v: unknown): void => {
    if (isObject(v)) for (const [k, x] of Object.entries(v)) out.push([k, x]);
  };
  if (isObject(decision)) {
    vars(decision.vars);
    vars(decision.slots);
    if (Array.isArray(decision.acks)) for (const a of decision.acks) if (isObject(a)) vars(a.vars);
  }
  if (Array.isArray(actions)) for (const a of actions) if (isObject(a) && a.type === 'transfer') vars(a.slots);
  return out;
}

/** The scrub of what a record's turn said aloud (slotsScrubber over the record's slots, readback and decision), or null. */
export function recordScrubber(record: TraceRecord, mode: StatementMode, app: Slots = defaultAppOrNull(), options: { readonly cutOff?: boolean } = {}): Scrub | null {
  return slotsScrubber(record.slots, record.pendingConfirmation ?? null, mode, app, [...decisionTexts(record.decision, record.actions), ...summaryTexts(record.render, app)], options);
}

/**
 * The slots marked to be summarized though masked in the records (SlotSpec.summarized: a `text`
 * slot's `redact: length-summarized`). Empty for every other app, whose records are as they were.
 */
function summarizedSlots(app: Slots): string[] {
  return app === null ? [] : Object.keys(app.slots).filter((id) => app.slots[id]!.summarized === true);
}

/** The slot a framed line's span is worded from (App.generated), or undefined. */
function spanFrom(app: Slots, promptId: string, span: string | undefined): string | undefined {
  return span === undefined ? undefined : app?.generated?.lines[promptId]?.spans?.[span]?.from;
}

/**
 * The words a model gave for a span worded from a slot marked to be summarized (said, or refused), each
 * as a text of that slot's: a summary of the words is masked as the words are, in the line said too.
 */
function summaryTexts(render: TraceRecord['render'], app: Slots): [string, unknown][] {
  const marked = summarizedSlots(app);
  if (render === undefined || marked.length === 0) return [];
  const out: [string, unknown][] = [];
  for (const l of render.lines) {
    const from = spanFrom(app, l.promptId, l.span);
    if (from === undefined || !marked.includes(from)) continue;
    if (l.said !== undefined) out.push([from, l.said]);
    if (l.refused !== undefined) out.push([from, l.refused]);
  }
  return out;
}

/**
 * Whether the frame log keeps a caller's words by their length alone: in an app with a slot marked to be
 * summarized though masked in the records (SlotSpec.summarized). The frame log is written as the words
 * arrive, before any turn has read them, and the words that give such a slot may come on any turn (in
 * one breath with the request, or as a correction at its read-back), so none is kept. The trace masks
 * exactly the words the slot was given (maskSummarizedWords), after the turn.
 */
export function framesMaskWords(app: Slots): boolean {
  return summarizedSlots(app).length > 0;
}

/**
 * The live console's `asked` event (what the model is asked, before the turn has read the words) in an
 * app with a slot marked to be summarized (framesMaskWords): as the frame log, it cannot know whether
 * these words give the slot, so the caller's words (asr.text), the spans of them the model is shown
 * (candidateSpans, a choice's criteria with no description) and the line just played (scrubbed of the
 * slots' words, as a say action is) are masked by their length; the turn's own event, after it, masks
 * exactly. Every other app's event is as it was.
 */
export function liveAskedForConsole<Q, T>(questions: Q, turnState: T, session: { readonly slots: TraceRecord['slots']; readonly pendingConfirmation: TraceRecord['pendingConfirmation'] } | null, app: Slots): { questions: Q; turnState: T } {
  if (!framesMaskWords(app)) return { questions, turnState };
  let ts: unknown = turnState;
  if (isObject(ts)) {
    const scrub = session === null ? null : slotsScrubber(session.slots, session.pendingConfirmation ?? null, 'keep', app);
    const out: Record<string, unknown> = { ...ts };
    if (isObject(ts.asr) && typeof ts.asr.text === 'string' && ts.asr.text !== '') out.asr = { ...ts.asr, text: byLength(ts.asr.text) };
    if (Array.isArray(ts.candidateSpans)) out.candidateSpans = ts.candidateSpans.map((c) => (typeof c === 'string' ? byLength(c) : c));
    if (scrub !== null && isObject(ts.node) && typeof ts.node.promptJustPlayed === 'string') out.node = { ...ts.node, promptJustPlayed: scrub(ts.node.promptJustPlayed) };
    ts = out;
  }
  let qs: unknown = questions;
  if (isObject(qs)) {
    qs = Object.fromEntries(Object.entries(qs).map(([id, q]) => {
      if (!isObject(q) || !isObject(q.criteria)) return [id, q];
      const criteria: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(q.criteria)) {
        let key = v === null ? byLength(k) : k;
        for (let n = 2; v === null && Object.hasOwn(criteria, key); n++) key = `${byLength(k)} #${n}`;
        criteria[key] = v;
      }
      return [id, { ...q, criteria }];
    }));
  }
  return { questions: qs as Q, turnState: ts as T };
}

/** A value's masked form, by its length (a statement's, `<n chars>`), unless it is one already. */
const byLength = (v: string): string => maskStatement(v);

/**
 * The caller's own words, where a slot marked to be summarized holds them: the record's transcript and
 * whatever was built from it (the event, the turn state the model saw, the questions and answers, the
 * screen, retrieval, a follow-up, joined fragments, an error), every string that holds the words (or is
 * three or more words of them) masked whole by its length. The words are what the slot was given, so
 * the turn that gave them is masked too; the trace keeps no copy of them, in any mode. Nothing is done
 * for an app with no such slot, nor for a record whose slots hold no such words.
 */
function maskSummarizedWords(record: TraceRecord, out: TraceRecord, app: Slots): TraceRecord {
  const marked = summarizedSlots(app);
  if (marked.length === 0) return out;
  const words = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v.trim() !== '' && !/^<\d+ chars>$/.test(v)) words.add(v.trim().toLowerCase());
  };
  for (const id of marked) {
    add(record.slots?.[id]?.value);
    add(record.slots?.[id]?.display);
    const shown = isObject(record.turnState) && isObject(record.turnState.slots) ? (record.turnState.slots as Record<string, unknown>)[id] : undefined;
    if (isObject(shown)) add(shown.value);
    const pc = record.pendingConfirmation;
    if (pc && pc.target === 'slot' && pc.slot === id) {
      add(pc.value);
      add(pc.display);
    }
  }
  if (words.size === 0) return out;
  const holds = (s: string): boolean => {
    const t = s.trim().toLowerCase();
    if (t === '') return false;
    for (const w of words) if (t.includes(w) || (w.includes(t) && t.split(/\s+/).length >= 3)) return true;
    return false;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return holds(v) ? byLength(v) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const masked: TraceRecord = { ...out, event: walk(out.event) as TraceRecord['event'], turnState: walk(out.turnState) as TraceRecord['turnState'], questions: walk(out.questions) as TraceRecord['questions'], answers: walk(out.answers) as TraceRecord['answers'], error: walk(out.error) as TraceRecord['error'] };
  // The turn that gave the words: the model was asked about parts of them (a name or a number among
  // them, each a span of the words: a choice's criteria with no description, or a pick's candidates),
  // each masked by its length too, in the question and in its answer alike.
  const transcript = [isObject(record.event) && typeof (record.event as { text?: unknown }).text === 'string' ? (record.event as { text: string }).text : '', ...(record.joined?.fragments ?? [])].filter((t) => holds(t));
  if (transcript.length > 0) {
    const heard = transcript.map((t) => ` ${t.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, ' ').trim()} `);
    const partOf = (v: string): boolean => {
      const w = v.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, ' ').trim();
      return w !== '' && heard.some((h) => h.includes(` ${w} `));
    };
    const questions = isObject(masked.questions) ? { ...(masked.questions as Record<string, unknown>) } : null;
    const answers = isObject(masked.answers) ? { ...(masked.answers as Record<string, unknown>) } : null;
    for (const [id, q] of Object.entries(questions ?? {})) {
      if (!isObject(q) || !isObject(q.criteria)) continue;
      const renamed = new Map<string, string>();
      const used = new Set<string>();
      const criteria: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(q.criteria)) {
        const span = v === null && partOf(k);
        let key = k;
        if (span) {
          key = byLength(k);
          for (let n = 2; used.has(key) || Object.hasOwn(q.criteria, key); n++) key = `${byLength(k)} #${n}`;
          renamed.set(k, key);
        }
        used.add(key);
        criteria[key] = typeof v === 'string' && partOf(v) ? byLength(v) : v;
      }
      questions![id] = { ...q, criteria };
      const a = answers?.[id];
      if (renamed.size > 0 && isObject(a)) {
        answers![id] = {
          ...a,
          ...(typeof a.choice === 'string' && renamed.has(a.choice) ? { choice: renamed.get(a.choice) } : {}),
          ...(isObject(a.probabilities) ? { probabilities: Object.fromEntries(Object.entries(a.probabilities).map(([k, p]) => [renamed.get(k) ?? k, p])) } : {}),
        };
      }
    }
    if (questions !== null) masked.questions = questions as TraceRecord['questions'];
    if (answers !== null) masked.answers = answers as TraceRecord['answers'];
    const ts = masked.turnState;
    if (isObject(ts) && Array.isArray(ts.candidateSpans)) masked.turnState = { ...ts, candidateSpans: ts.candidateSpans.map((c) => (typeof c === 'string' && partOf(c) ? byLength(c) : c)) };
  }
  for (const key of ['screen', 'retrieval', 'followUp', 'joined'] as const) {
    if (out[key] !== undefined) (masked as unknown as Record<string, unknown>)[key] = walk(out[key]);
  }
  // A span worded from such a slot: its words (said, or refused) by their length, as the content is.
  if (masked.render !== undefined) {
    masked.render = {
      ...masked.render,
      lines: masked.render.lines.map((l) => {
        const from = spanFrom(app, l.promptId, l.span);
        if (from === undefined || !marked.includes(from)) return l;
        return { ...l, fixed: byLength(l.fixed), ...(l.said !== undefined ? { said: byLength(l.said) } : {}), ...(l.refused !== undefined ? { refused: byLength(l.refused) } : {}) };
      }),
    };
  }
  return masked;
}

/** The scrub of what a turn said aloud, from the session after it and its decision (the frame log's: server/adapter.ts), or null. */
export function turnScrubber(session: { readonly slots: TraceRecord['slots']; readonly pendingConfirmation: TraceRecord['pendingConfirmation'] }, decision: unknown, mode: StatementMode, app: Slots = defaultAppOrNull(), render?: TraceRecord['render']): Scrub | null {
  return slotsScrubber(session.slots, session.pendingConfirmation ?? null, mode, app, [...decisionTexts(decision, []), ...summaryTexts(render, app)]);
}

/** A decision's variables and its acks' (each text), scrubbed: a variable not named for its slot may still hold its value. */
function scrubVars(d: TraceRecord['decision'], scrub: Scrub | null): TraceRecord['decision'] {
  if (scrub === null || !isObject(d)) return d;
  const vars = (v: unknown): unknown => (isObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' ? scrub(x) : x])) : v);
  const out: Record<string, unknown> = { ...d };
  if ('vars' in d) out.vars = vars(d.vars);
  if ('acks' in d && Array.isArray(d.acks)) out.acks = d.acks.map((a) => (isObject(a) ? { ...a, vars: vars(a.vars) } : a));
  return out as TraceRecord['decision'];
}

/** A say action's text parts, scrubbed. */
function scrubSay(action: unknown, scrub: Scrub): unknown {
  if (!isObject(action) || action.type !== 'say' || !Array.isArray(action.parts)) return action;
  return { ...action, parts: action.parts.map((p: unknown) => (isObject(p) && typeof p.text === 'string' ? { ...p, text: scrub(p.text) } : p)) };
}

/**
 * The line the turn before said (the model's node.promptJustPlayed), scrubbed as that turn's say
 * actions were: of each redacted slot's value and display, the slots and the readback both as the
 * model was shown them (a value read back, or proposed from the facts, that a no then emptied) and as
 * the turn left them (a value the yes filled).
 */
function scrubPromptJustPlayed(record: TraceRecord, ts: TraceRecord['turnState'], mode: StatementMode, app: Slots): TraceRecord['turnState'] {
  const raw = record.turnState;
  if (!isObject(raw) || !isObject(raw.node) || typeof raw.node.promptJustPlayed !== 'string' || raw.node.promptJustPlayed === '' || !isObject(ts) || !isObject(ts.node)) return ts;
  const shown: [string, unknown][] = [];
  if (isObject(raw.slots)) for (const [id, st] of Object.entries(raw.slots)) if (isObject(st)) shown.push([id, st.value]);
  const pc = raw.pendingConfirmation;
  if (isObject(pc) && typeof pc.target === 'string') shown.push([pc.target, pc.value]);
  const scrub = slotsScrubber(record.slots, record.pendingConfirmation ?? null, mode, app, shown);
  if (scrub === null) return ts;
  const said = scrub(raw.node.promptJustPlayed);
  return said === ts.node.promptJustPlayed ? ts : { ...ts, node: { ...ts.node, promptJustPlayed: said } };
}

/** A slot that offers the caller's number (SlotSpec.callerNumber) and is redacted, whose rule masks the number; null when none is. */
function callerNumberRule(app: Slots): string | null {
  if (app === null) return null;
  return Object.keys(app.slots).find((id) => app.slots[id]!.callerNumber !== undefined && app.slots[id]!.redact !== undefined) ?? null;
}

/**
 * Every place a record carries a redacted slot's value, masked; nothing else is changed. That
 * includes what the turn said aloud: the say actions' text, and the part of our line a caller's
 * interruption heard (the event's `heard`, our words, never the caller's), scrubbed of each
 * redacted slot's raw value, display and digits however spaced (recordScrubber).
 */
export function redactRecordSlots(record: TraceRecord, mode: StatementMode, app: Slots = defaultAppOrNull()): TraceRecord {
  const scrub = recordScrubber(record, mode, app);
  const out: TraceRecord = { ...record, slots: redactSlots(record.slots, mode, app), turnState: scrubPromptJustPlayed(record, redactTurnState(record.turnState, mode, app), mode, app) };
  // What an interruption heard of our line was cut off as it was said: a value's first digits are masked too.
  const cut = isObject(record.event) && record.event.type === 'user.interrupt' && typeof record.event.heard === 'string' ? recordScrubber(record, mode, app, { cutOff: true }) : null;
  if (cut !== null && record.event.type === 'user.interrupt') out.event = { ...record.event, heard: cut(record.event.heard) };
  // The number the caller is calling from, on the session start (SessionStart.callerNumber): masked as
  // the slot that offers it masks its value. A number the session kept is the slot's value to be, so
  // the setup's own copies of it in the event's provider details (Twilio's `from`, Telnyx's
  // `param.telnyx_call_from`) are masked the same. One not kept (withheld, or not one the slot can
  // use) is no value of the slot's, and the provider details keep it as sent, as on every app. An
  // app that keeps the number for its code (app.yaml's callerNumber: { use: hint }) and has no such
  // slot masks it, and the number called (SessionStart.calledNumber), to the last four digits, with
  // the setup's own copies of the number called (Twilio's `to`, Telnyx's `param.telnyx_call_to`).
  const offering = callerNumberRule(app);
  const hinted = app?.callerNumber?.use === 'hint';
  if (isObject(record.event) && record.event.type === 'session.start' && (offering !== null || hinted)) {
    const start = record.event;
    const raw = typeof start.callerNumber === 'string' ? start.callerNumber : null;
    const called = typeof start.calledNumber === 'string' ? start.calledNumber : null;
    const mask = (v: string): string => (offering !== null ? maskValue(app, offering, v, mode) ?? v : maskLast4(v));
    const kept = raw !== null && record.callerNumber === 'kept';
    const provider = (kept || called !== null) && isObject(start.provider)
      ? Object.fromEntries(Object.entries(start.provider).map(([k, v]) => [k, kept && v === raw ? mask(v) : called !== null && v === called ? maskLast4(v) : v]))
      : start.provider;
    const masked = { ...start, provider, ...(raw !== null ? { callerNumber: mask(raw) } : {}), ...(typeof start.calledNumber === 'string' ? { calledNumber: maskLast4(start.calledNumber) } : {}) };
    if (raw !== null || typeof start.calledNumber === 'string') out.event = masked;
  }
  // The custom parameters and the call data of a session start, in the trace file and on the console
  // alike. The call data the app names (SessionStart.callData), each key as its redact says, and the
  // setup's own copies of what a key reads: a custom parameter (`param.<name>`, a webhook field's echo
  // `param.dw_<key>`) and a setup field (`<field>`) the same. Every other custom parameter is written
  // `redacted`, for every app: no one named it as worth keeping (an app's startParameters among them);
  // `locale` and the carrier's copies of the numbers keep rules of their own (OWN_RULE_PARAMETERS).
  if (isObject(out.event) && out.event.type === 'session.start') {
    const start = out.event;
    const spec = app?.callData;
    const params = parameterRedactions(spec);
    const fields = setupRedactions(spec);
    const provider = isObject(start.provider)
      ? Object.fromEntries(Object.entries(start.provider).flatMap(([k, v]) => {
        if (typeof v !== 'string') return [[k, v]];
        const param = k.startsWith('param.') ? k.slice('param.'.length) : null;
        if (param !== null && OWN_RULE_PARAMETERS.includes(param)) return [[k, v]];
        const how = param !== null ? params.get(param) : fields.get(k);
        if (how === undefined) return [[k, param !== null ? UNNAMED_PARAMETER : v]];
        const shown = recordedCallData(how, v);
        return shown === null ? [] : [[k, shown]];
      }))
      : start.provider;
    out.event = { ...start, provider, ...(spec !== undefined && isObject(start.callData) ? { callData: recordedCallDataMap(spec, start.callData) } : {}) };
  }
  const pc = record.pendingConfirmation;
  if (pc && pc.target === 'slot') out.pendingConfirmation = { ...pc, value: maskValue(app, pc.slot, pc.value, mode) ?? pc.value, display: maskValue(app, pc.slot, pc.display, mode) ?? pc.display };
  out.decision = scrubVars(redactDecision(app, record.decision, mode), scrub);
  if (record.effects !== undefined) out.effects = redactEffects(app, record.effects, mode);
  // A transfer hands over what the call collected, identity slots included.
  if (Array.isArray(record.actions)) {
    out.actions = record.actions.map((a) => {
      if (isObject(a) && a.type === 'transfer' && isObject(a.slots)) return redactTransferParts(app, { ...a, slots: redactCollected(app, a.slots, mode) }, mode);
      return scrub === null ? a : (scrubSay(a, scrub) as typeof a);
    });
  }
  // Generated wording: each line's fixed text, the wording said and any wording refused, scrubbed as the say actions are.
  if (record.render !== undefined && scrub !== null) {
    out.render = {
      ...record.render,
      lines: record.render.lines.map((l) => ({
        ...l,
        fixed: scrub(l.fixed),
        ...(l.said !== undefined ? { said: scrub(l.said) } : {}),
        ...(l.refused !== undefined ? { refused: scrub(l.refused) } : {}),
        ...(l.error?.message !== undefined ? { error: { ...l.error, message: scrub(l.error.message) } } : {}),
      })),
    };
  }
  return maskSummarizedWords(record, out, app);
}

/**
 * A knowledge record (TurnOut.kb, KbSource) as the unauthenticated console shows it: whom the
 * passage answered (`applies`, the caller's facts read from their record) only as policy.yaml's
 * `audit:` declares each fact (a fact it does not declare, or declares secret, is left out), as a
 * tool's params are recorded. Everything else of the record (the passage, its version and hashes)
 * is the knowledge base's, and stays.
 */
export function consoleKbSource<K extends { readonly applies?: Readonly<Record<string, string>> }>(kb: K, app: Slots = defaultAppOrNull()): K {
  if (!isObject(kb) || !isObject(kb.applies)) return kb;
  const applies: Record<string, string> = {};
  for (const [fact, v] of Object.entries(kb.applies)) {
    const declared = typeof v === 'string' ? auditOf(app, fact) : undefined;
    const shown = declared === undefined ? null : recordedValue(declared, v as string);
    if (shown !== null) applies[fact] = shown;
  }
  return { ...kb, applies };
}

