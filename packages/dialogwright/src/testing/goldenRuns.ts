import { loadCorpus, type CorpusEntry } from '../jev/corpus';
import { isCassetteMiss } from '../jev/cassette';
import { buildClient, buildThresholds } from '../run/client';
import { defaultCorpusFile, scenariosDir } from '../run/fixtures';
import type { TurnRun } from '../run/turn';
import { REGRESS_TODAY } from '../harness-text/baseline';
import { loadScenarios, runCorpusEntry, runScenario, type RunOptions, type Scenario } from '../harness-text/runner';

/**
 * The runs a golden is written from: the default app's corpus and scenarios, run exactly as
 * `regress` runs them (its thresholds, its day, its clock, the screen's default mode) with the stubs
 * or the recorded cassette, each turn kept whole (its result, its trace record with the turn's audit
 * drafts). The gate-event golden writes their gate events (gateEvents.ts); an app's own goldens may
 * write any other part of the same turns (the knowledge an answer was read from, say), so every
 * golden sees one run of the same calls.
 */

/** The clients a golden is taken with: the label stubs, and the app's recorded cassette replayed. */
export type GoldenClient = 'stub' | 'recorded';

export interface GoldenRunOptions {
  /** Default: the default app's corpus and scenarios (App.fixtures). */
  readonly corpus?: readonly CorpusEntry[];
  readonly scenarios?: readonly Scenario[];
}

/** One corpus entry or scenario, and its turns in order. */
export interface GoldenSection {
  /** `corpus <id>` or `scenario <id>`: the golden's heading line, after a `# `. */
  readonly heading: string;
  /** A corpus entry's are its greeting (0) and its one utterance (1); a scenario's are every turn it ran, the greeting first. */
  readonly runs: readonly TurnRun[];
}

export interface GoldenRuns {
  /** The corpus entries first, in file order, then the scenarios. */
  readonly sections: readonly GoldenSection[];
  readonly turns: number;
  /** Turns a cassette had no answer for (a recorded run must have none). */
  readonly misses: number;
}

export async function goldenRuns(kind: GoldenClient, options: GoldenRunOptions = {}): Promise<GoldenRuns> {
  const thresholds = buildThresholds([]);
  const opts: RunOptions = {
    client: buildClient(kind, defaultCorpusFile(), thresholds, REGRESS_TODAY),
    thresholds,
    todayIso: REGRESS_TODAY,
    now: () => 0,
  };
  const corpus = options.corpus ?? loadCorpus(defaultCorpusFile());
  const scenarios = options.scenarios ?? loadScenarios(scenariosDir());
  const sections: GoldenSection[] = [];
  for (const entry of corpus) {
    const r = await runCorpusEntry(entry, opts);
    sections.push({ heading: `corpus ${entry.id}`, runs: [r.setup, r.run] });
  }
  for (const scenario of scenarios) {
    const r = await runScenario(scenario, opts);
    sections.push({ heading: `scenario ${scenario.id}`, runs: r.runs });
  }
  const runs = sections.flatMap((s) => s.runs);
  return { sections, turns: runs.length, misses: runs.filter((run) => isCassetteMiss(run.record)).length };
}
