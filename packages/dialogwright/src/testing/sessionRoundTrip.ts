import type { Session } from '../core/session';
import { loadCorpus } from '../jev/corpus';
import { isCassetteMiss } from '../jev/cassette';
import { buildClient, buildThresholds } from '../run/client';
import { defaultCorpusFile, scenariosDir } from '../run/fixtures';
import { runTurn, type TurnRun } from '../run/turn';
import { REGRESS_TODAY } from '../harness-text/baseline';
import { loadScenarios, runCorpusEntry, runScenario, type ScenarioRunOptions, type TurnRunner } from '../harness-text/runner';
import type { GoldenClient, GoldenRunOptions } from './goldenRuns';

/**
 * Whether a saved session resumes exactly: the default app's corpus and scenarios, run as `regress`
 * runs them, once as they are and once with the session put through `trip` before every turn (by
 * default a JSON round trip, which is what a session store keeps: server/stores/types.ts). At every
 * turn the two runs must agree on the decision, the actions, the trace record (but its timing) and
 * the session after the turn. One that does not is a field a store would lose (a value JSON cannot
 * hold: a Date, a Map, a class instance, an undefined that means something) or a turn that reads
 * something outside the session, and a call resumed after a restart would not go on as it was.
 *
 * Each run has its own client and its own book of business (the app's systems), so what one run
 * files the other files too, in the same order.
 */

/** One turn where the two runs disagree: which part, and each run's value of it, as JSON. */
export interface RoundTripMismatch {
  /** `corpus <id>` or `scenario <id>`. */
  readonly section: string;
  /** The turn's index in the section (0 is the greeting). */
  readonly turn: number;
  readonly part: 'turns' | 'decision' | 'actions' | 'record' | 'session';
  readonly live: string;
  readonly resumed: string;
}

export interface RoundTripReport {
  readonly sections: number;
  readonly turns: number;
  /** Turns a cassette had no answer for, in the live run (a recorded run must have none). */
  readonly misses: number;
  readonly mismatches: readonly RoundTripMismatch[];
}

/** What a store hands back: the session as JSON keeps it. */
export function jsonTrip(s: Session): Session {
  return JSON.parse(JSON.stringify(s)) as Session;
}

/** The trace record but its timing, which is the clock's and differs on every run. */
function recordOf(run: TurnRun): unknown {
  const { timing: _timing, ...rest } = run.record;
  return rest;
}

const PARTS: readonly { part: RoundTripMismatch['part']; of(run: TurnRun): unknown }[] = [
  { part: 'decision', of: (r) => r.result.decision },
  { part: 'actions', of: (r) => r.result.actions },
  { part: 'record', of: recordOf },
  { part: 'session', of: (r) => r.result.session },
];

function compare(section: string, live: readonly TurnRun[], resumed: readonly TurnRun[], out: RoundTripMismatch[]): void {
  if (live.length !== resumed.length) {
    out.push({ section, turn: Math.min(live.length, resumed.length), part: 'turns', live: String(live.length), resumed: String(resumed.length) });
  }
  for (let i = 0; i < Math.min(live.length, resumed.length); i++) {
    for (const { part, of } of PARTS) {
      const a = JSON.stringify(of(live[i]!));
      const b = JSON.stringify(of(resumed[i]!));
      if (a !== b) {
        out.push({ section, turn: i, part, live: a, resumed: b });
        return;
      }
    }
  }
}

/**
 * Runs the default app's corpus and scenarios (or `options`') twice, as described above, and reports
 * every section's first turn where the runs disagree. `trip` is what is done to the session between
 * turns in the second run (default jsonTrip); a test of this check passes one that loses something.
 */
export async function sessionRoundTrip(kind: GoldenClient = 'stub', options: GoldenRunOptions = {}, trip: (s: Session) => Session = jsonTrip): Promise<RoundTripReport> {
  const thresholds = buildThresholds([]);
  const optsOf = (turn?: TurnRunner): ScenarioRunOptions => ({
    client: buildClient(kind, defaultCorpusFile(), thresholds, REGRESS_TODAY),
    thresholds,
    todayIso: REGRESS_TODAY,
    now: () => 0,
    ...(turn ? { turn } : {}),
  });
  const tripped: TurnRunner = (session, event, opts, arrival) => runTurn(trip(session), event, opts, arrival);
  const corpus = options.corpus ?? loadCorpus(defaultCorpusFile());
  const scenarios = options.scenarios ?? loadScenarios(scenariosDir());
  const mismatches: RoundTripMismatch[] = [];
  let turns = 0;
  let misses = 0;
  const count = (runs: readonly TurnRun[]): void => {
    turns += runs.length;
    misses += runs.filter((r) => isCassetteMiss(r.record)).length;
  };
  const live = optsOf();
  const resumed = optsOf(tripped);
  for (const entry of corpus) {
    const a = await runCorpusEntry(entry, live);
    const b = await runCorpusEntry(entry, resumed);
    count([a.setup, a.run]);
    compare(`corpus ${entry.id}`, [a.setup, a.run], [b.setup, b.run], mismatches);
  }
  for (const scenario of scenarios) {
    const a = await runScenario(scenario, live);
    const b = await runScenario(scenario, resumed);
    count(a.runs);
    compare(`scenario ${scenario.id}`, a.runs, b.runs, mismatches);
  }
  return { sections: corpus.length + scenarios.length, turns, misses, mismatches };
}
