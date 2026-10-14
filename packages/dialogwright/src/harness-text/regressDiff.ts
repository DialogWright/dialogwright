import { gapOutcomes, type CorpusEntry, type KnownGap } from '../jev/corpus';
import { canonical, scenarioShowsGap } from './scenarioGap';

/**
 * The two fields that say how a decision was reached rather than what it was: which gate decided
 * and its verdict (sweepScore.ts counts them among its cosmetic fields). A scenario marked
 * `cosmeticDrift` may differ from the stub baseline on these alone under a real model.
 */
export const DRIFT_FIELDS: ReadonlySet<string> = new Set(['decidedGate', 'verdict']);

/** Ids whose DRIFT_FIELDS may differ without failing; every other key still diffs as usual. */
export type DriftAllowance = ReadonlySet<string>;

/**
 * Ids with a documented gap (CorpusEntry.knownGap, Scenario.knownGap), each with its reason and the outcome fields the
 * model is known to produce (or a few such outcomes). Such an id may differ from the baseline only by
 * exactly those fields: when its outcome equals the baseline's with one pinned outcome's fields
 * overlaid, each difference is allowed and says why; any other outcome fails as usual. Only a run against a real model's answers
 * is given any; a stub run is held to the baseline exactly.
 */
export type KnownGaps = ReadonlyMap<string, KnownGap>;

/**
 * The clients whose answers are a real decision model's (live, or a recording of it): the only runs
 * a known gap or a scenario's cosmetic drift applies to. The stubs (fixture and heuristic) answer
 * from labels and keywords, so a difference there is the run's own and is never excused.
 */
export const REAL_MODEL_KINDS: ReadonlySet<string> = new Set(['jev', 'record', 'recorded']);

/**
 * The known gaps a run of `kind` tolerates: every corpus entry's (or every scripted call's: each is an
 * id with an optional `knownGap`), against a real model; none otherwise.
 */
export function knownGapsFor(kind: string, tagged: readonly Pick<CorpusEntry, 'id' | 'knownGap'>[]): KnownGaps {
  if (!REAL_MODEL_KINDS.has(kind)) return new Map();
  return new Map(tagged.flatMap((e): [string, KnownGap][] => (e.knownGap === undefined ? [] : [[e.id, e.knownGap]])));
}

/**
 * How a gap is shown: `a` is the baseline `e` with one of the gap's pinned outcomes overlaid. A corpus
 * outcome is compared whole (showsGap); a scripted call's also carries its own expectation's verdict,
 * which the pin may explain (scenarioGap.ts scenarioShowsGap).
 */
export type GapTest = (e: object, a: object, gap: KnownGap) => boolean;

/**
 * The known-gap ids whose outcome now matches the baseline exactly: the model no longer shows the
 * gap, so the tag may be removable. An id that differs in any way (its pinned outcome or another)
 * is not among them.
 */
export function gapsNowMatching<T extends object>(expected: Record<string, T>, actual: Record<string, T>, gaps: KnownGaps): string[] {
  return [...gaps.keys()].filter((id) => expected[id] !== undefined && actual[id] !== undefined && canonical(expected[id]) === canonical(actual[id]));
}

/** True when `a` is the baseline outcome `e` with one of the gap's pinned outcomes overlaid, and nothing else. */
export function showsGap(e: object, a: object, gap: KnownGap): boolean {
  return gapOutcomes(gap).some((pinned) => canonical({ ...e, ...pinned }) === canonical(a));
}

/** What the gap's outcomes pin `key` to, each value once (`"b"`, or `"b" or "c"`); null when none pins it. */
function pinnedValues(gap: KnownGap, key: string): string | null {
  const values = [...new Set(gapOutcomes(gap).filter((o) => Object.hasOwn(o, key)).map((o) => JSON.stringify((o as Record<string, unknown>)[key])))];
  return values.length > 0 ? values.join(' or ') : null;
}

/** One diff line per differing key, so a changed outcome names exactly what moved. */
function diffOne<T extends object>(name: string, id: string, e: T | undefined, a: T | undefined, drift: boolean, gap: KnownGap | undefined, shows: GapTest): { lines: string[]; allowed: string[] } {
  if (!e) return { lines: [`+ ${name} ${id}: new`], allowed: [] };
  if (!a) return { lines: [`- ${name} ${id}: removed`], allowed: [] };
  const lines: string[] = [];
  const allowed: string[] = [];
  const known = gap !== undefined && shows(e, a, gap);
  for (const key of new Set([...Object.keys(e), ...Object.keys(a)])) {
    const ev = JSON.stringify((e as Record<string, unknown>)[key]);
    const av = JSON.stringify((a as Record<string, unknown>)[key]);
    if (ev === av) continue;
    const line = `~ ${name} ${id}.${key}: ${ev} -> ${av}`;
    if (known) allowed.push(`${line} (allowed: knownGap: ${gap.reason})`);
    else if (drift && DRIFT_FIELDS.has(key)) allowed.push(`${line} (allowed: cosmeticDrift)`);
    // A gap the model no longer shows as pinned: say what the pin expected, so the line explains itself.
    else {
      const pinned = gap === undefined ? null : pinnedValues(gap, key);
      lines.push(pinned === null ? line : `${line} (knownGap pins ${pinned})`);
    }
  }
  return { lines, allowed };
}

/**
 * Diff lines across every id on either side, plus the count of ids that matched exactly. A
 * difference `drift` or `gaps` allows is reported in `allowed`, not `lines`, and the id does not
 * count as matching: it is shown, and it does not fail the run. `gapped` names the ids in `gaps`
 * that showed their known outcome (an id in `gaps` that matched exactly is in neither; one that
 * differed some other way fails, in `lines`). `shows` says how a gap is shown: by default a scripted
 * call's way for the `scenario` diff (its expectation's verdict explained by the pin), a corpus line's
 * for any other.
 */
export function diff<T extends object>(
  name: string,
  expected: Record<string, T>,
  actual: Record<string, T>,
  drift: DriftAllowance = new Set(),
  gaps: KnownGaps = new Map(),
  shows: GapTest = name === 'scenario' ? scenarioShowsGap : showsGap,
): { lines: string[]; matching: number; allowed: string[]; gapped: string[] } {
  const lines: string[] = [];
  const allowed: string[] = [];
  const gapped: string[] = [];
  let matching = 0;
  for (const id of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const gap = gaps.get(id);
    const own = diffOne(name, id, expected[id], actual[id], drift.has(id), gap, shows);
    if (own.lines.length === 0 && own.allowed.length === 0) matching += 1;
    if (gap !== undefined && own.allowed.length > 0) gapped.push(id);
    lines.push(...own.lines);
    allowed.push(...own.allowed);
  }
  return { lines, matching, allowed, gapped };
}

/**
 * The ids whose differences are not allowed (they fail the run): what `diff` reports in `lines`, by
 * id rather than by field, so a summary can count what needs a decision.
 */
export function differingIds<T extends object>(
  name: string,
  expected: Record<string, T>,
  actual: Record<string, T>,
  drift: DriftAllowance = new Set(),
  gaps: KnownGaps = new Map(),
  shows: GapTest = name === 'scenario' ? scenarioShowsGap : showsGap,
): string[] {
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter((id) => diffOne(name, id, expected[id], actual[id], drift.has(id), gaps.get(id), shows).lines.length > 0);
}

/**
 * The scripted calls that fail their own expectation, by id: every one that does not pass, but one
 * whose run shows its known gap against the baseline (scenarioShowsGap), which is reported as allowed
 * instead. `gaps` is empty on a stub run, so there every call is held to its expectation.
 */
export function failingScenarios<T extends object & { pass: boolean }>(expected: Record<string, T>, actual: Record<string, T>, gaps: KnownGaps): string[] {
  return Object.entries(actual).filter(([id, a]) => {
    if (a.pass) return false;
    const gap = gaps.get(id);
    const e = expected[id];
    return gap === undefined || e === undefined || !scenarioShowsGap(e, a, gap);
  }).map(([id]) => id);
}
