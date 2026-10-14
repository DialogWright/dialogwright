import { assertKnownGap, gapOutcomes, type KnownGap, type PinnedOutcome } from '../jev/corpus';
import type { ScenarioExpectation } from './runner';

/**
 * A scripted call's known gap (Scenario.knownGap), as a corpus line's (CorpusEntry.knownGap): a reason,
 * and the end outcome a real decision model is known to give instead of the stub's, in the same shape
 * (PinnedOutcome, one `outcome` or a few `outcomes`). Only a run against a real model's answers is given
 * one (regressDiff.ts knownGapsFor); a stub run holds the call to its expectation and the baseline exactly.
 *
 * Kept apart from the runner so `dialogwright check` (define/check.ts) reads a call's tag without the
 * runner's imports.
 */

/** The fields a pinned outcome and a call's expectation both have, which a pin may restate. */
const EXPECTED_FIELDS = ['decision', 'promptId', 'reason', 'form', 'slots', 'principalLevel', 'gate'] as const satisfies readonly (keyof PinnedOutcome & keyof ScenarioExpectation)[];

/** JSON with object keys sorted, so two values compare by value whatever order their keys were written in. */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (typeof x === 'object' && x !== null && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : x));
}

/**
 * True when every field the pin names is one the call's expectation names, with the same value: the
 * pin is the expectation itself, so it tolerates nothing a call that reaches its expectation needs.
 */
export function restatesExpectation(pinned: PinnedOutcome, expect: ScenarioExpectation): boolean {
  return Object.keys(pinned).every((key) => (EXPECTED_FIELDS as readonly string[]).includes(key)
    && Object.hasOwn(expect, key)
    && canonical((pinned as Record<string, unknown>)[key]) === canonical((expect as unknown as Record<string, unknown>)[key]));
}

/** A problem with a scripted call's known gap: its shape (`shape`), or a pin that is the call's own expectation (`restates`). */
export interface ScenarioGapProblem {
  kind: 'shape' | 'restates';
  message: string;
}

/**
 * What is wrong with a scripted call's known gap, one problem each (empty when nothing is, or the call
 * has none): its shape, as a corpus line's is checked (jev/corpus.ts assertKnownGap), then each pinned
 * outcome that only restates the call's own expectation.
 */
export function scenarioGapProblems(scenario: { id: string; expect?: ScenarioExpectation; knownGap?: unknown }): ScenarioGapProblem[] {
  if (scenario.knownGap === undefined) return [];
  const owner = `scenario ${scenario.id}`;
  try {
    assertKnownGap(owner, scenario.knownGap);
  } catch (e) {
    return [{ kind: 'shape', message: e instanceof Error ? e.message : String(e) }];
  }
  const gap = scenario.knownGap;
  const expect = scenario.expect;
  if (expect === undefined) return [];
  return gapOutcomes(gap).flatMap((pinned, i) => (restatesExpectation(pinned, expect)
    ? [{ kind: 'restates' as const, message: `${owner}: knownGap.${gap.outcomes === undefined ? 'outcome' : `outcomes[${i}]`} ${canonical(pinned)} is the call's own expectation, so it allows nothing: a known gap pins the end the model gives instead` }]
    : []));
}

/**
 * The outcome field a line of the call's own expectation check names (runner.ts checkExpectation:
 * `decision: expected ...`, `slot <id>: ...`, `text: ...`, `transfer target: ...`), or null for a line it
 * does not write.
 */
export function mismatchField(line: string): 'decision' | 'promptId' | 'reason' | 'form' | 'slots' | 'principalLevel' | 'gate' | 'text' | 'transfer' | null {
  const head = /^(decision|promptId|reason|form|principalLevel|gate|text):/.exec(line)?.[1];
  if (head !== undefined) return head as 'decision';
  if (/^slot \S+:/.test(line)) return 'slots';
  if (/^transfer (target|headers|data):/.test(line)) return 'transfer';
  return null;
}

/** The fields whose change alters what the last turn says or where it transfers: its `text` and `transfer` follow from them. */
const SAID_BY: ReadonlySet<string> = new Set(['decision', 'promptId', 'acks', 'reason']);

/**
 * True when a scripted call's run `a` is the baseline `e` with one of the gap's pinned outcomes overlaid
 * on its end outcome, and every line of the call's own expectation check it misses is one that pin
 * explains: a field the pin changes from the baseline, or the last turn's words or transfer when the pin
 * changes what that turn does (its decision, prompt, acknowledgements or reason), or a line the baseline
 * itself has. Anything else the run does still fails.
 */
export function scenarioShowsGap(
  e: object & { pass?: boolean; mismatches?: readonly string[] },
  a: object & { pass?: boolean; mismatches?: readonly string[] },
  gap: KnownGap,
): boolean {
  const { pass: _ep, mismatches: had = [], ...before } = e;
  const { pass: _ap, mismatches: missed = [], ...after } = a;
  return gapOutcomes(gap).some((pinned) => {
    if (canonical({ ...before, ...pinned }) !== canonical(after)) return false;
    const changed = new Set(Object.keys(pinned).filter((key) => canonical((pinned as Record<string, unknown>)[key]) !== canonical((before as Record<string, unknown>)[key])));
    const said = [...changed].some((key) => SAID_BY.has(key));
    return missed.every((line) => {
      if (had.includes(line)) return true;
      const field = mismatchField(line);
      if (field === 'text' || field === 'transfer') return said;
      return field !== null && changed.has(field);
    });
  });
}
