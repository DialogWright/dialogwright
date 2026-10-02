import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { loadCorpus } from '../jev/corpus';
import { buildClient, buildThresholds, cassettePath, CLIENT_KINDS, isClientKind } from '../run/client';
import { defaultCorpusFile, expectedDir, scenariosDir } from '../run/fixtures';
import { isCassetteMiss } from '../jev/cassette';
import { diff, gapsNowMatching, knownGapsFor, REAL_MODEL_KINDS } from './regressDiff';
import { formatRegressSummary } from './regressSummary';
import type { TraceRecord } from '../trace/types';
import { loadScenarios, type RunOptions } from './runner';
import { readBaseline, REGRESS_TODAY, writeExpected } from './baseline';
import { emptyRunAll, runAll } from './runAll';
import { parseScreenMode } from '../core/screen';

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
  if (kind === 'record' || kind === 'recorded') {
    const path = cassettePath();
    console.log(`cassette ${path}${existsSync(path) ? '' : ' (not found; every turn will miss until recorded)'}  screen ${screen}`);
  }
  const opts: RunOptions = {
    client: buildClient(kind, defaultCorpusFile(), thresholds, REGRESS_TODAY),
    thresholds,
    todayIso: REGRESS_TODAY,
    now: () => 0,
    screen,
  };
  // A run that reaches a model is slow and can abort part way; it reports progress on stderr
  // (stdout is the diff artifact) and still gets a summary of what it paid for, from the finally.
  const live = kind === 'record' || kind === 'jev';

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

/** The process entry point, run by an app's launcher after it has registered the app. */
export async function main(): Promise<void> {
  await run().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
