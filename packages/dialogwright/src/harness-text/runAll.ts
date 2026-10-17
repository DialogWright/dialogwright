import type { CorpusEntry } from '../jev/corpus';
import type { TraceRecord } from '../trace/types';
import type { ScenarioOutcome } from './baseline';
import { defaultAppOrNull } from '../core/app/registry';
import { runCorpusEntry, runScenario, type Outcome, type RunOptions, type Scenario } from './runner';

export interface RunAllResult {
  corpus: Record<string, Outcome>;
  scenarios: Record<string, ScenarioOutcome>;
  /** every turn's record per scenario, setup included */
  scenarioRecords: Record<string, TraceRecord[]>;
  /** all of the above in run order */
  records: TraceRecord[];
}

export interface RunAllHooks {
  onCorpus?(done: number, total: number, entry: CorpusEntry, record: TraceRecord): void;
  onScenario?(done: number, total: number, scenario: Scenario, records: TraceRecord[]): void;
}

export function emptyRunAll(): RunAllResult {
  return { corpus: {}, scenarios: {}, scenarioRecords: {}, records: [] };
}

/**
 * Corpus entries in file order, then scenarios in file order, exactly as the regression
 * runner and the cassette expect. Results accumulate into `into` as they arrive so a hook
 * that throws (a live-run abort) leaves the caller holding everything that ran.
 *
 * Returns `into` itself. Reusing an accumulator across calls appends to `records` and
 * overwrites keys; pass a fresh one per run.
 */
export async function runAll(corpus: CorpusEntry[], scenarios: Scenario[], opts: RunOptions, hooks: RunAllHooks = {}, into: RunAllResult = emptyRunAll()): Promise<RunAllResult> {
  await warmKnowledge();
  for (const [i, entry] of corpus.entries()) {
    const r = await runCorpusEntry(entry, opts);
    into.corpus[entry.id] = r.outcome;
    into.records.push(r.run.record);
    hooks.onCorpus?.(i + 1, corpus.length, entry, r.run.record);
  }
  for (const [i, scenario] of scenarios.entries()) {
    const r = await runScenario(scenario, opts);
    const records = r.runs.map((run) => run.record);
    into.scenarios[scenario.id] = { ...r.outcome, pass: r.pass, mismatches: r.mismatches };
    into.scenarioRecords[scenario.id] = records;
    into.records.push(...records);
    hooks.onScenario?.(i + 1, scenarios.length, scenario, records);
  }
  return into;
}

/**
 * Loads what the app's retrievers load on first use (the sections' own embedding model, kb.yaml
 * documents.embedder) before any turn runs, as a server does when it starts: retrieval has a budget,
 * and a model still loading on a run's first turns would nominate nothing there and something later,
 * so the same words would make two requests. One that cannot be loaded leaves the keywords, every turn.
 */
export async function warmKnowledge(): Promise<void> {
  await defaultAppOrNull()?.knowledge?.sections?.warm?.().catch(() => false);
}
