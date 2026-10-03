import type { AuditDraft } from '../audit/types';
import { maskId } from '../gate/principal';
import type { GateDecision, ToolCall } from '../gate/types';
import type { App, AuditMask } from './app/types';

/**
 * What is recorded of a call's params: the gate event, and so the trace, the console and the audit,
 * carry a copy of the call (redactCall) in which each param is masked as it is declared:
 *
 * - a param that is a slot with a redact setting, as the slot says (SlotSpec.redact: last4, mask, length);
 * - any other param, as policy.yaml's `audit:` declares it (PolicyTables.audit: last4, mask, length,
 *   secret, keep);
 * - anything else as it is. That is `check`'s to refuse, not the runtime's: every tool lists the
 *   params its calls carry (ToolDef.params), and check refuses one that is neither a redacted slot nor
 *   declared. A call that carries a param its tool does not list (a call put to the gate by hand, an
 *   extra field the confirmed rule refuses) keeps it, name and value, as the evidence of what was
 *   sent; the gate-event goldens (dialogwright/testing gateEventGolden's unlistedParams) show any such
 *   param an app's own calls carry.
 *
 * The same masks reach the free text the engine records beside the call: the rules' lines (an app's
 * own rule writes its compared line as it likes), the tool's summary and the record it names, and
 * the tool's own audit rows (ToolDef.audit). Wherever one of them repeats the raw value of a param
 * that is recorded masked or never, the value is replaced by what the call records for it ("•" for a
 * secret). That holds for the value as it is (in any case); a rule or a tool that reshapes a value
 * (reformats a date, spaces out digits, quotes a part of it) is not recognised, so code still writes
 * only what may be recorded. Over-masking is the failure it allows: a short masked value also
 * matches inside other words, which then read masked too.
 *
 * Only the call's own params are known here: a value the code reads from elsewhere (the session, its
 * systems) and writes into a line is the code's to mask.
 */

/** How a param may be recorded (policy.yaml `audit:`, AuditMask), in the order the docs list them. */
export const AUDIT_MASKS: readonly AuditMask[] = ['last4', 'mask', 'length', 'secret', 'keep'];

/** The app as recording reads it: its slots' redact settings and its policy's `audit:`. */
export type RecordingApp = Pick<App, 'slots'> & { readonly policy: Pick<App['policy'], 'audit'> };

/** How a param is recorded: its slot's redact, else its `audit:` declaration, else as it is. */
export function recordingOf(app: RecordingApp, param: string): AuditMask {
  const slot = Object.hasOwn(app.slots, param) ? app.slots[param]!.redact : undefined;
  if (slot !== undefined) return slot;
  const audit = app.policy.audit;
  if (audit !== undefined && Object.hasOwn(audit, param)) return audit[param]!;
  return 'keep';
}

/** A value as it is recorded under `how`; null for a secret, which is not recorded at all. An empty value stays empty (but its length). */
export function recordedValue(how: AuditMask, v: string): string | null {
  switch (how) {
    case 'last4': return v ? maskId(v) : v;
    case 'mask': return v ? '•' : v;
    case 'length': return `<${v.length} chars>`;
    case 'secret': return null;
    case 'keep': return v;
  }
}

/**
 * A call as it may be shown and recorded: each param masked as recordingOf says (e.g. the account ID
 * by its last four, the date of birth not at all, the caller's free-text note only by its length, a
 * record id as it is where `audit:` keeps it), and a secret one left out. The gate itself evaluates
 * the raw call; only this copy leaves callTool.
 */
export function redactCall(app: RecordingApp, call: ToolCall): ToolCall {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(call.params)) {
    const shown = recordedValue(recordingOf(app, k), v);
    if (shown !== null) params[k] = shown;
  }
  return { ...call, params };
}

/** Text with every raw value of a masked param replaced by what is recorded for it. */
export type Scrub = (text: string) => string;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The scrub for the free text recorded beside `call`: each non-empty raw value of a param that is
 * recorded masked or never, replaced (matched in any case, the longest first) by its recorded form,
 * "•" for a secret. Null when the call has no such value, so nothing need change.
 */
export function scrubberFor(app: RecordingApp, call: ToolCall): Scrub | null {
  const shownFor = new Map<string, string>();
  for (const [k, v] of Object.entries(call.params)) {
    const how = recordingOf(app, k);
    if (how === 'keep' || v === '') continue;
    const key = v.toLowerCase();
    // Two params with the same value: the first masked form is used for both.
    if (!shownFor.has(key)) shownFor.set(key, recordedValue(how, v) ?? '•');
  }
  if (shownFor.size === 0) return null;
  const pattern = new RegExp([...shownFor.keys()].sort((a, b) => b.length - a.length).map(escape).join('|'), 'gi');
  return (text) => text.replace(pattern, (m) => shownFor.get(m.toLowerCase()) ?? '•');
}

/** The scrub each recorded decision was made with (registered by the lifecycle), for the rows recorded after it. */
const SCRUBS = new WeakMap<GateDecision, Scrub>();

/** Registers the scrub for the free text recorded beside `decision` (the lifecycle does, as it records the decision). */
export function registerScrub(decision: GateDecision, scrub: Scrub): void {
  SCRUBS.set(decision, scrub);
}

/**
 * The scrub registered for a decision the lifecycle recorded in this process, or null (nothing of
 * its call was masked, or the decision was read back from a trace, where the raw values are gone).
 */
export function scrubberOf(decision: GateDecision): Scrub | null {
  return SCRUBS.get(decision) ?? null;
}

/** The decision's rule lines with the scrub applied to their description and compared text. */
export function scrubbedDecision(decision: GateDecision, scrub: Scrub | null): GateDecision {
  if (scrub === null) return decision;
  return { ...decision, rules: decision.rules.map((r) => ({ ...r, description: scrub(r.description), compared: scrub(r.compared) })) };
}

/**
 * An app's own audit rows (ToolDef.audit) with the scrub applied to every text in their detail
 * (each string, and each string of a list), so a row cannot carry the raw value of a masked param.
 */
export function scrubbedDrafts(drafts: readonly AuditDraft[], scrub: Scrub | null): AuditDraft[] {
  if (scrub === null) return [...drafts];
  return drafts.map((d) => {
    // A row that is not one is recorded as the hook returned it (the audit sink's own checks apply).
    if (typeof d !== 'object' || d === null || typeof d.detail !== 'object' || d.detail === null) return d;
    const detail: AuditDraft['detail'] = {};
    for (const [k, v] of Object.entries(d.detail)) {
      detail[k] = typeof v === 'string' ? scrub(v) : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? scrub(x) : x)) : v;
    }
    return { ...d, detail };
  });
}
