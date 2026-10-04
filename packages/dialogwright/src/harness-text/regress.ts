import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { loadCorpus } from '../jev/corpus';
import { buildClient, buildThresholds, cassettePath, CLIENT_KINDS, isClientKind, modelHeader, providerFor } from '../run/client';
import { defaultCorpusFile, expectedDir, scenariosDir } from '../run/fixtures';
import { isCassetteMiss } from '../jev/cassette';
import { diff, gapsNowMatching, knownGapsFor, REAL_MODEL_KINDS } from './regressDiff';
import { formatRegressSummary } from './regressSummary';
import type { TraceRecord } from '../trace/types';
import { loadScenarios, runCorpusEntry, runScenario, unanswerableSteps, type RunOptions, type Scenario } from './runner';
import type { CorpusEntry } from '../jev/corpus';
import { closest } from '../define/problems';
import { corpusTranscript, scenarioTranscript } from './transcript';
import type { ScenarioOutcome } from './baseline';
import { readBaseline, REGRESS_TODAY, writeExpected } from './baseline';
import { emptyRunAll, runAll } from './runAll';
import { parseScreenMode } from '../core/screen';

/**
 * Whether a run on this client refuses a spoken step whose words no corpus line has: only the
 * stubs, which answer without a model (the fixture stub from the corpus, and the heuristic one).
 */
export function refusesUnanswerableSteps(kind: string): boolean {
  return kind === 'stub' || kind === 'heuristic';
}

/** Corpus entries between progress lines on a run that talks to a model. */
const PROGRESS_EVERY = 25;

async function run(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      update: { type: 'boolean', default: false },
      threshold: { type: 'string', multiple: true, default: [] },
      client: { type: 'string', default: 'stub' },
      // Where the injection screen is asked (core/screen.ts ScreenMode): inline (default) or separate.
      // A cassette replays only in the mode it was recorded in.
      screen: { type: 'string' },
      // A transcript of one scripted call or one corpus line, turn by turn, instead of the whole
      // run's diff (transcript.ts). Repeatable; the two may be given together.
      scenario: { type: 'string', multiple: true, default: [] },
      corpus: { type: 'string', multiple: true, default: [] },
    },
  });
  const kind = args.client ?? 'stub';
  if (!isClientKind(kind)) throw new Error(`--client must be one of ${CLIENT_KINDS.join(', ')}`);
  if (args.update && kind !== 'stub') {
    console.error(`--update is stub-only: ${expectedDir()} is the label-derived baseline and is re-recorded from the stub`);
    process.exitCode = 1;
    return;
  }
  const thresholds = buildThresholds(args.threshold ?? []);
  const screen = parseScreenMode(args.screen, '--screen');
  const corpus = loadCorpus(defaultCorpusFile());
  const scenarioDefs = loadScenarios(scenariosDir());
  // Refused on the stubs, as a duplicate corpus text is: a spoken step the corpus has no line for
  // is a turn the stub cannot answer, and the call would pass or fail on a miss nobody wrote. A
  // model (live, recording or replayed) answers any words, so a run against one is not held to it.
  const unanswerable = refusesUnanswerableSteps(kind) ? unanswerableSteps(corpus, scenarioDefs) : [];
  if (unanswerable.length > 0) {
    throw new Error([
      `${unanswerable.length} spoken ${unanswerable.length === 1 ? 'step is' : 'steps are'} not a corpus line's text, so the stub cannot answer ${unanswerable.length === 1 ? 'it' : 'them'}:`,
      ...unanswerable.map((u) => `  ${u}`),
      'add a line with those words to the corpus, labelled with what they mean, or change the step to the words of a line it has',
    ].join('\n'));
  }
  const picked = { scenarios: args.scenario ?? [], corpus: args.corpus ?? [] };
  if (args.update && picked.scenarios.length + picked.corpus.length > 0) {
    console.error('--update records the whole baseline; it cannot be given with --scenario or --corpus');
    process.exitCode = 1;
    return;
  }
  // Resolved once, so the header names the model the client asks (jev/provider.ts).
  const provider = providerFor(kind);
  for (const line of modelHeader(kind, provider)) console.log(line);
  if (provider && (kind === 'record' || kind === 'recorded')) {
    const path = cassettePath(provider.model);
    console.log(`cassette ${path}${existsSync(path) ? '' : ' (not found; every turn will miss until recorded)'}  screen ${screen}`);
  }
  const opts: RunOptions = {
    client: buildClient(kind, defaultCorpusFile(), thresholds, REGRESS_TODAY, provider ?? undefined),
    thresholds,
    todayIso: REGRESS_TODAY,
    now: () => 0,
    screen,
  };
  // A run that reaches a model is slow and can abort part way; it reports progress on stderr
  // (stdout is the diff artifact) and still gets a summary of what it paid for, from the finally.
  const live = kind === 'record' || kind === 'jev';
  if (picked.scenarios.length + picked.corpus.length > 0) {
    process.exitCode = await transcripts(picked, corpus, scenarioDefs, opts, readBaseline(), kind);
    return;
  }

  // Aborts a live run after 3 consecutive client-level failures (timeouts, auth) rather than
  // burning through the whole corpus one turn at a time; a cassette miss doesn't count; a
  // non-live kind never talks to a model, so it never trips this.
  let consecutiveClientErrors = 0;
  let firstClientErrorMessage = '';
  function checkClientError(record: TraceRecord): void {
    if (!live) return;
    const isClientError = record.source === 'error' && record.error !== null && !isCassetteMiss(record);
    if (!isClientError) {
      consecutiveClientErrors = 0;
      return;
    }
    if (consecutiveClientErrors === 0) firstClientErrorMessage = record.error!.message;
    consecutiveClientErrors += 1;
    if (consecutiveClientErrors >= 3) {
      throw new Error(`aborting after 3 consecutive client errors; first: ${firstClientErrorMessage}`);
    }
  }

  // Hoisted above the try so a corrupt expected-outcomes file fails before any run state
  // exists, rather than inside the finally where it would mask a real run failure.
  const expected = readBaseline();
  // The stubs are held to the baseline exactly; a real model may reach a marked scenario's decision
  // through a different gate (runner.ts, Scenario.cosmeticDrift).
  const drift = new Set(REAL_MODEL_KINDS.has(kind) ? scenarioDefs.filter((s) => s.cosmeticDrift === true).map((s) => s.id) : []);
  // Likewise a corpus entry's documented gap (CorpusEntry.knownGap): its known outcome, and only
  // that, is tolerated under a real model; the stubs still have to match the baseline exactly.
  const gaps = knownGapsFor(kind, corpus);

  const actual = emptyRunAll();
  try {
    await runAll(corpus, scenarioDefs, opts, {
      onCorpus: (done, total, _entry, record) => {
        checkClientError(record);
        if (live && done % PROGRESS_EVERY === 0) console.error(`  corpus ${done}/${total}`);
      },
      onScenario: (done, total, scenario, records) => {
        for (const record of records) checkClientError(record);
        if (live) console.error(`  scenario ${done}/${total} ${scenario.id}`);
      },
    }, actual);

    if (args.update) {
      writeExpected({ corpus: actual.corpus, scenarios: actual.scenarios });
      console.log(`recorded ${Object.keys(actual.corpus).length} corpus outcomes and ${Object.keys(actual.scenarios).length} scenario outcomes`);
      return;
    }

    const scenarioDiff = diff('scenario', expected.scenarios, actual.scenarios, drift);
    const corpusDiff = diff('corpus', expected.corpus, actual.corpus, new Set(), gaps);
    const lines = [...corpusDiff.lines, ...scenarioDiff.lines];
    const failing = Object.values(actual.scenarios).filter((s) => !s.pass);
    for (const s of failing) console.log(`FAIL scenario ${s.id}: ${s.mismatches.join('; ')}`);
    for (const l of lines) console.log(l);
    for (const l of corpusDiff.allowed) console.log(l);
    for (const l of scenarioDiff.allowed) console.log(l);
    // A gap the model no longer shows is worth a look (the tag may be removable), never a failure.
    for (const id of gapsNowMatching(expected.corpus, actual.corpus, gaps)) console.log(`knownGap now matches: ${id}`);
    const allowedKind = corpusDiff.allowed.length > 0 ? 'drift' : scenarioDiff.allowed.length > 0 ? 'cosmetic drift' : null;
    if (lines.length === 0 && failing.length === 0) console.log(allowedKind ? `no changes beyond the allowed ${allowedKind} above` : 'no changes');
    else process.exitCode = 1;
  } finally {
    // Diffed here rather than reused from above so an aborted run still reports what it ran:
    // ids it never reached simply read as removed. Wrapped so a failure in here (e.g. a
    // formatting bug) surfaces on stderr instead of replacing the real exception from the run.
    try {
      if (!args.update && actual.records.length > 0) {
        const ran = Object.values(actual.scenarios);
        console.log('');
        console.log(formatRegressSummary({
          corpusTotal: corpus.length,
          corpusMatching: diff('corpus', expected.corpus, actual.corpus, new Set(), gaps).matching,
          knownGaps: { total: gaps.size, drifted: diff('corpus', expected.corpus, actual.corpus, new Set(), gaps).gapped.length },
          scenarioTotal: scenarioDefs.length,
          scenarioPassing: ran.filter((s) => s.pass).length,
          scenarioMatching: diff('scenario', expected.scenarios, actual.scenarios, drift).matching,
          records: actual.records,
        }));
      }
    } catch (e) {
      console.error(`summary unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** The ids asked for, or the problem with one that is not there (with the nearest id). */
function pick<T extends { id: string }>(what: string, ids: readonly string[], all: readonly T[]): T[] {
  return ids.map((id) => {
    const found = all.find((x) => x.id === id);
    if (found) return found;
    const near = closest(id, all.map((x) => x.id));
    throw new Error(`no ${what} "${id}"${near ? `; did you mean "${near}"?` : ''}`);
  });
}

/**
 * `--scenario <id>` and `--corpus <id>`: each one's transcript, then whether its outcome is the
 * baseline's. Exit 1 when a scripted call misses what it expects, or an outcome is not the baseline's.
 */
async function transcripts(
  picked: { scenarios: readonly string[]; corpus: readonly string[] },
  corpus: CorpusEntry[],
  scenarios: Scenario[],
  opts: RunOptions,
  expected: ReturnType<typeof readBaseline>,
  kind: string,
): Promise<number> {
  const entries = pick('corpus line', picked.corpus, corpus);
  const calls = pick('scenario', picked.scenarios, scenarios);
  const gaps = knownGapsFor(kind, corpus);
  let failed = false;
  /** The outcome against the baseline: its differences (a failure), the allowed ones, or none. */
  const against = (what: string, had: boolean, d: { lines: string[]; allowed: string[] }): void => {
    if (!had) {
      console.log(`  baseline: none for this ${what} yet`);
      return;
    }
    for (const l of [...d.lines, ...d.allowed]) console.log(`  ${l}`);
    if (d.lines.length > 0) failed = true;
    else console.log(d.allowed.length > 0 ? '  baseline: no changes beyond the allowed ones above' : '  baseline: no changes');
  };
  for (const entry of entries) {
    const r = await runCorpusEntry(entry, opts);
    for (const l of corpusTranscript(entry, r)) console.log(l);
    const had = expected.corpus[entry.id];
    against('line', had !== undefined, had ? diff('corpus', { [entry.id]: had }, { [entry.id]: r.outcome }, new Set(), gaps) : { lines: [], allowed: [] });
    console.log('');
  }
  for (const scenario of calls) {
    const r = await runScenario(scenario, opts);
    for (const l of scenarioTranscript(scenario, r)) console.log(l);
    if (!r.pass) failed = true;
    const drift = new Set(REAL_MODEL_KINDS.has(kind) && scenario.cosmeticDrift === true ? [scenario.id] : []);
    const actual: ScenarioOutcome = { ...r.outcome, pass: r.pass, mismatches: r.mismatches };
    const had = expected.scenarios[scenario.id];
    against('call', had !== undefined, had ? diff('scenario', { [scenario.id]: had }, { [scenario.id]: actual }, drift) : { lines: [], allowed: [] });
    console.log('');
  }
  return failed ? 1 : 0;
}

/** The process entry point, run by an app's launcher after it has registered the app. */
export async function main(): Promise<void> {
  await run().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
