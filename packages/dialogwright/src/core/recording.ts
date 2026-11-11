import type { AuditDraft } from '../audit/types';
import type { GateDecision } from '../gate/types';
import { SCRUB_MIN_LENGTH, bothScrubs, lastFourForm, maskedIdScrub, scrubberOfValues, type Scrub } from '../audit/recording';

// The pure parameter masking and scrub construction moved to audit/recording.ts (shared with src/converse); re-exported so nothing else changes.
export * from '../audit/recording';

/**
 * The scrub each recorded thing was made with (registered by the lifecycle, and carried by the
 * runner and the server from a side effect to the answer it brings): a decision, for the rows
 * recorded after it; a side effect, for its params as recorded; a service's answer, for its row.
 *
 * They live in this process only, keyed by the object, and are never part of a session. A decision's
 * is made and used within its turn, from the turn's own call and result, so a turn run on a session a
 * store saved and loaded records exactly what the live turn would (testing/sessionRoundTrip.ts holds
 * the trace records of every scenario to that). A side effect's is carried to its answer, the next
 * turn: a call saved while it waits for that answer keeps the scrub as data (scrubParts, in
 * StoredCall.pending), and a server that sends the request again after a restart makes the scrub
 * again from it (scrubFromParts), so the answer is recorded masked as it would have been.
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

/** What may stand between two digits of a number said or shown in groups: spaces, a comma, a dot, a hyphen or a slash, a few at most. */
const DIGIT_GAP = '[\\s,.\\-/]{0,3}';

/**
 * The scrub of values a line says aloud (what a trace's or a frame log's spoken text may repeat of a
 * redacted slot): each raw value as scrubberOfValues finds it (whole tokens, any case,
 * SCRUB_MIN_LENGTH characters or more), its last-four form where `lastFour` (a value recorded hidden,
 * by length or never, would otherwise say four of its characters), and its digits as one run however
 * the line spaces or groups them ("5555 1234", "5 5 5 5, 1 2 3 4" as a voice line spells it out,
 * "5555-1234"; not inside a longer run of digits), each replaced by its shown form. With `cutOff`,
 * for a line cut off as it was said, a last run of digits that begins one of the values (at least
 * SCRUB_MIN_LENGTH of them) is replaced too. Null when there is nothing to look for.
 */
export function spokenValuesScrubber(values: Iterable<{ readonly raw: string; readonly shown: string; readonly lastFour?: boolean }>, options: { readonly cutOff?: boolean } = {}): Scrub | null {
  const pairs: [string, string][] = [];
  const lastFour: [string, string][] = [];
  const runs = new Map<string, string>();
  for (const { raw, shown, lastFour: hidden } of values) {
    if (raw === shown) continue;
    pairs.push([raw, shown]);
    if (hidden && raw.length >= SCRUB_MIN_LENGTH) lastFour.push([lastFourForm(raw), shown]);
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= SCRUB_MIN_LENGTH && !runs.has(digits)) runs.set(digits, shown);
  }
  let runScrub: Scrub | null = null;
  if (runs.size > 0) {
    const alternatives = [...runs.keys()].sort((a, b) => b.length - a.length).map((d) => [...d].join(DIGIT_GAP)).join('|');
    const pattern = new RegExp(`(?<!\\p{N})(?:${alternatives})(?!\\p{N})`, 'gu');
    runScrub = (text) => text.replace(pattern, (m) => runs.get(m.replace(/\D/g, '')) ?? '•');
    if (options.cutOff) {
      // A line cut off as it was said (an interruption): its last run of digits may be the start of a value.
      const whole = runScrub;
      const tail = new RegExp(`(?<!\\p{N})\\p{N}(?:${DIGIT_GAP}\\p{N})*$`, 'u');
      runScrub = (text) => {
        const done = whole(text);
        const m = tail.exec(done);
        const digits = m?.[0].replace(/\D/g, '') ?? '';
        if (m === null || digits.length < SCRUB_MIN_LENGTH) return done;
        const of = [...runs.keys()].find((d) => d.length > digits.length && d.startsWith(digits));
        return of === undefined ? done : done.slice(0, m.index) + runs.get(of)!;
      };
    }
  }
  return bothScrubs(bothScrubs(scrubberOfValues(pairs), lastFour.length === 0 ? null : maskedIdScrub(lastFour)), runScrub);
}
