import { gapOutcomes, type CorpusEntry, type KnownGap } from '../jev/corpus';

/**
 * The two fields that say how a decision was reached rather than what it was: which gate decided
 * and its verdict (sweepScore.ts counts them among its cosmetic fields). A scenario marked
 * `cosmeticDrift` may differ from the stub baseline on these alone under a real model.
 */
export const DRIFT_FIELDS: ReadonlySet<string> = new Set(['decidedGate', 'verdict']);

/** Ids whose DRIFT_FIELDS may differ without failing; every other key still diffs as usual. */
export type DriftAllowance = ReadonlySet<string>;

/**
 * Ids with a documented gap (CorpusEntry.knownGap), each with its reason and the outcome fields the
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

/** The known gaps a run of `kind` tolerates: every corpus entry's, against a real model; none otherwise. */
export function knownGapsFor(kind: string, corpus: readonly CorpusEntry[]): KnownGaps {
  if (!REAL_MODEL_KINDS.has(kind)) return new Map();
  return new Map(corpus.flatMap((e): [string, KnownGap][] => (e.knownGap === undefined ? [] : [[e.id, e.knownGap]])));
}

/** JSON with object keys sorted, so two outcomes compare by value whatever order their keys were written in. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (typeof x === 'object' && x !== null && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : x));
}

/**
 * The known-gap ids whose outcome now matches the baseline exactly: the model no longer shows the
 * gap, so the tag may be removable. An id that differs in any way (its pinned outcome or another)
 * is not among them.
 */
export function gapsNowMatching<T extends object>(expected: Record<string, T>, actual: Record<string, T>, gaps: KnownGaps): string[] {
  return [...gaps.keys()].filter((id) => expected[id] !== undefined && actual[id] !== undefined && canonical(expected[id]) === canonical(actual[id]));
}

/** True when `a` is the baseline outcome `e` with one of the gap's pinned outcomes overlaid, and nothing else. */
function showsGap(e: object, a: object, gap: KnownGap): boolean {
  return gapOutcomes(gap).some((pinned) => canonical({ ...e, ...pinned }) === canonical(a));
}

/** What the gap's outcomes pin `key` to, each value once (`"b"`, or `"b" or "c"`); null when none pins it. */
function pinnedValues(gap: KnownGap, key: string): string | null {
  const values = [...new Set(gapOutcomes(gap).filter((o) => Object.hasOwn(o, key)).map((o) => JSON.stringify((o as Record<string, unknown>)[key])))];
  return values.length > 0 ? values.join(' or ') : null;
}

/** One diff line per differing key, so a changed outcome names exactly what moved. */
function diffOne<T extends object>(name: string, id: string, e: T | undefined, a: T | undefined, drift: boolean, gap: KnownGap | undefined): { lines: string[]; allowed: string[] } {
  if (!e) return { lines: [`+ ${name} ${id}: new`], allowed: [] };
  if (!a) return { lines: [`- ${name} ${id}: removed`], allowed: [] };
  const lines: string[] = [];
  const allowed: string[] = [];
  const known = gap !== undefined && showsGap(e, a, gap);
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
 * differed some other way fails, in `lines`).
 */
export function diff<T extends object>(
  name: string,
  expected: Record<string, T>,
  actual: Record<string, T>,
  drift: DriftAllowance = new Set(),
  gaps: KnownGaps = new Map(),
): { lines: string[]; matching: number; allowed: string[]; gapped: string[] } {
  const lines: string[] = [];
  const allowed: string[] = [];
  const gapped: string[] = [];
  let matching = 0;
  for (const id of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const gap = gaps.get(id);
    const own = diffOne(name, id, expected[id], actual[id], drift.has(id), gap);
    if (own.lines.length === 0 && own.allowed.length === 0) matching += 1;
    if (gap !== undefined && own.allowed.length > 0) gapped.push(id);
    lines.push(...own.lines);
    allowed.push(...own.allowed);
  }
  return { lines, matching, allowed, gapped };
}
