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
 * secret), and where it is recorded hidden, by length or never, its last-four form (`...1234`, as
 * the scope rule names a subject) too. That holds for the value as it is (in any case, as a whole
 * token: not inside a longer run of letters or digits) and for values of SCRUB_MIN_LENGTH characters
 * or more; a rule or a tool that reshapes a value (reformats a date, spaces out digits, quotes a part
 * of it) is not recognised, so code still writes only what may be recorded. The side effects a tool
 * queues while it runs are recorded with the same scrub, and with what its result withheld
 * (recordedEffect: what is sent to the service is the effect itself), and a downstream service's
 * audit row for the answer to one with that effect's (carryScrub).
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
 * The fewest characters a value has for the scrub to look for it in free text. A shorter value (a
 * one-letter answer, a two-digit number) cannot be told from the line's own words and numbers
 * ("level 1", "a caller"), so it is not looked for: the call as recorded still masks it, and the
 * gate's own lines never print a param's raw value.
 */
export const SCRUB_MIN_LENGTH = 3;

/**
 * The scrub that replaces each raw value (matched in any case, as a whole token: not inside a longer
 * run of letters or digits, the longest first) by its shown form. Values shorter than
 * SCRUB_MIN_LENGTH are not looked for. Null when there is nothing to look for.
 */
export function scrubberOfValues(pairs: Iterable<readonly [raw: string, shown: string]>): Scrub | null {
  const shownFor = new Map<string, string>();
  for (const [raw, shown] of pairs) {
    if (raw.length < SCRUB_MIN_LENGTH) continue;
    const key = raw.toLowerCase();
    // Two values the same: the first shown form is used for both.
    if (!shownFor.has(key)) shownFor.set(key, shown);
  }
  if (shownFor.size === 0) return null;
  const alternatives = [...shownFor.keys()].sort((a, b) => b.length - a.length).map(escape).join('|');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, 'giu');
  return (text) => text.replace(pattern, (m) => shownFor.get(m.toLowerCase()) ?? '•');
}

/** Two scrubs as one (the first, then the second); either may be null. */
export function bothScrubs(a: Scrub | null, b: Scrub | null): Scrub | null {
  if (a === null) return b;
  if (b === null) return a;
  return (text) => b(a(text));
}

/**
 * The scrub for the free text recorded beside `call`: each raw value of a param that is recorded
 * masked or never, replaced by its recorded form, "•" for a secret (scrubberOfValues: whole tokens,
 * any case, SCRUB_MIN_LENGTH characters or more). A value recorded by its last four has its masked
 * form looked for too where it is recorded hidden, by length or never (`...1234` would say four of
 * its characters). Null when the call has no such value, so nothing need change.
 */
export function scrubberFor(app: RecordingApp, call: ToolCall): Scrub | null {
  const pairs: [string, string][] = [];
  const lastFour: [string, string][] = [];
  for (const [k, v] of Object.entries(call.params)) {
    const how = recordingOf(app, k);
    if (how === 'keep' || v === '') continue;
    const shown = recordedValue(how, v) ?? '•';
    pairs.push([v, shown]);
    // A line that names the value by its last four (the scope rule's subject, say) says them only where the value is recorded so.
    if (how !== 'last4' && v.length >= SCRUB_MIN_LENGTH) lastFour.push([maskId(v), shown]);
  }
  const masked = lastFour.length === 0 ? null : maskedIdScrub(lastFour);
  return bothScrubs(scrubberOfValues(pairs), masked);
}

/** The scrub of a value's last-four form (`...1234`) in a line, for a value recorded hidden, by length or never. */
function maskedIdScrub(pairs: readonly (readonly [string, string])[]): Scrub {
  const shownFor = new Map<string, string>();
  // Two values with the same last four: the first's shown form is used for both.
  for (const [masked, shown] of pairs) if (!shownFor.has(masked)) shownFor.set(masked, shown);
  const pattern = new RegExp(`(?:${[...shownFor.keys()].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'gu');
  return (text) => text.replace(pattern, (m) => shownFor.get(m) ?? '•');
}

/** The scrub of a result's withheld values (core/resultRedaction.ts): each text a withheld field held, "•" wherever the summary or the record named repeats it. */
export function withheldScrubber(values: readonly string[]): Scrub | null {
  return scrubberOfValues(values.map((v) => [v, '•'] as const));
}

/**
 * The scrub each recorded thing was made with (registered by the lifecycle, and carried by the
 * runner and the server from a side effect to the answer it brings): a decision, for the rows
 * recorded after it; a side effect, for its params as recorded; a service's answer, for its row.
 */
const SCRUBS = new WeakMap<object, Scrub>();

/** Registers the scrub for the free text recorded beside `target` (a decision, a side effect, a service's answer). */
export function registerScrub(target: object, scrub: Scrub): void {
  SCRUBS.set(target, scrub);
}

/**
 * The scrub registered for something the lifecycle recorded in this process, or null (nothing of its
 * call was masked, or it was read back from a trace or a log, where the raw values are gone).
 */
export function scrubberOf(target: object): Scrub | null {
  return SCRUBS.get(target) ?? null;
}

/** Carries the scrub of `from` (a side effect) to `to` (the service's answer to it), where it has one. */
export function carryScrub(from: object, to: object): void {
  const scrub = scrubberOf(from);
  if (scrub !== null) registerScrub(to, scrub);
}

/**
 * A side effect as recorded (the trace, the console): each of its text params with the scrub its
 * call registered (the call's masked params, and what its result withheld) applied. What is sent to
 * the service is the effect itself, unchanged.
 */
export function recordedEffect<E extends { readonly params: Readonly<Record<string, string>> }>(effect: E): E {
  const scrub = scrubberOf(effect);
  if (scrub === null) return effect;
  return { ...effect, params: Object.fromEntries(Object.entries(effect.params).map(([k, v]) => [k, typeof v === 'string' ? scrub(v) : v])) };
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
