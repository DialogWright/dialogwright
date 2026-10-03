import type { GateEvent } from '../core/lifecycle';
import { loadCorpus, type CorpusEntry } from '../jev/corpus';
import { isCassetteMiss } from '../jev/cassette';
import { buildClient, buildThresholds } from '../run/client';
import { defaultCorpusFile, scenariosDir } from '../run/fixtures';
import type { TurnRun } from '../run/turn';
import { REGRESS_TODAY } from '../harness-text/baseline';
import { loadScenarios, runCorpusEntry, runScenario, type RunOptions, type Scenario } from '../harness-text/runner';

/**
 * Gate-event goldens: every decision the action gate makes on an app's regression run, written out
 * line by line, so a change to the policy, the gate or the tables shows as a diff. The regression's
 * own outputs see only the last decision's tool and verdict; a golden sees every event of every turn
 * (probes and refusals included) with its redacted call, purpose, verdict, reason, the level a
 * step-up needs, and each rule's line.
 */

/** A gate event as the golden writes it: a heading line, then one line per rule the gate ran. */
export function gateEventLines(turn: number, event: GateEvent): string[] {
  const d = event.decision;
  const purpose = d.call.purpose === undefined ? '' : ` (${d.call.purpose})`;
  const reason = d.reason === undefined ? '' : ` reason=${d.reason}`;
  const need = d.needLevel === undefined ? '' : ` need=${d.needLevel}`;
  const head = `${turn} ${d.call.tool}${purpose} ${d.verdict}${reason}${need} ${JSON.stringify(d.call.params)}`;
  return [head, ...d.rules.map((r) => `    ${r.id} ${r.pass ? 'pass' : 'FAIL'}  ${r.description}  |  ${r.compared}`)];
}

/** What a golden run wrote and what it counted. */
export interface GateEventGolden {
  /** The golden: per corpus entry and scenario a `# corpus <id>` or `# scenario <id>` line, then its events by turn (0 is the greeting). */
  readonly text: string;
  readonly entries: number;
  readonly turns: number;
  readonly events: number;
  /** Turns a cassette had no answer for (a recorded run must have none). */
  readonly misses: number;
}

/** The clients a golden is taken with: the label stubs, and the app's recorded cassette replayed. */
export type GateGoldenClient = 'stub' | 'recorded';

export interface GateEventGoldenOptions {
  /** Default: the default app's corpus and scenarios (App.fixtures). */
  readonly corpus?: readonly CorpusEntry[];
  readonly scenarios?: readonly Scenario[];
}

/**
 * Runs the default app's corpus and scenarios exactly as `regress` does (its thresholds, its day,
 * its clock, the screen's default mode) with the stubs or the recorded cassette, and writes every
 * gate event of every turn.
 */
export async function gateEventGolden(kind: GateGoldenClient, options: GateEventGoldenOptions = {}): Promise<GateEventGolden> {
  const thresholds = buildThresholds([]);
  const opts: RunOptions = {
    client: buildClient(kind, defaultCorpusFile(), thresholds, REGRESS_TODAY),
    thresholds,
    todayIso: REGRESS_TODAY,
    now: () => 0,
  };
  const corpus = options.corpus ?? loadCorpus(defaultCorpusFile());
  const scenarios = options.scenarios ?? loadScenarios(scenariosDir());
  const lines: string[] = [];
  let turns = 0;
  let events = 0;
  let misses = 0;
  const write = (runs: readonly TurnRun[]): void => {
    runs.forEach((run, i) => {
      turns += 1;
      if (isCassetteMiss(run.record)) misses += 1;
      for (const event of run.result.gateEvents) {
        events += 1;
        lines.push(...gateEventLines(i, event));
      }
    });
  };
  for (const entry of corpus) {
    const r = await runCorpusEntry(entry, opts);
    lines.push(`# corpus ${entry.id}`);
    write([r.setup, r.run]);
  }
  for (const scenario of scenarios) {
    const r = await runScenario(scenario, opts);
    lines.push(`# scenario ${scenario.id}`);
    write(r.runs);
  }
  return { text: `${lines.join('\n')}\n`, entries: corpus.length + scenarios.length, turns, events, misses };
}
