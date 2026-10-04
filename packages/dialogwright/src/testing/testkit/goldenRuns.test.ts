import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../../jev/corpus';
import { defaultCorpusFile, scenariosDir } from '../../run/fixtures';
import { loadScenarios } from '../../harness-text/runner';
import { goldenRuns } from '../goldenRuns';
import { gateEventGolden } from '../gateEvents';

/**
 * The runs every golden is written from, on the testkit: one section per corpus entry and scenario
 * in the regression's order, each turn kept whole, so a golden of another part of a turn sees the
 * same calls the gate-event golden does.
 */
describe('goldenRuns', () => {
  it('runs every corpus entry, then every scenario, each turn whole', async () => {
    const corpus = loadCorpus(defaultCorpusFile());
    const scenarios = loadScenarios(scenariosDir());
    const runs = await goldenRuns('stub');
    expect(runs.sections.map((s) => s.heading)).toEqual([...corpus.map((e) => `corpus ${e.id}`), ...scenarios.map((s) => `scenario ${s.id}`)]);
    for (const section of runs.sections.slice(0, corpus.length)) expect(section.runs.length).toBe(2);
    expect(runs.turns).toBe(runs.sections.reduce((n, s) => n + s.runs.length, 0));
    expect(runs.misses).toBe(0);
    const turns = runs.sections.flatMap((s) => s.runs);
    // Each turn's trace record carries its audit drafts and its knowledge source (null when it read none).
    expect(turns.some((run) => (run.record.audit?.length ?? 0) > 0)).toBe(true);
    expect(turns.every((run) => run.record.kb === run.result.kb)).toBe(true);

    const golden = await gateEventGolden('stub');
    expect(golden.entries).toBe(runs.sections.length);
    expect(golden.turns).toBe(runs.turns);
    expect(golden.events).toBe(turns.reduce((n, run) => n + run.result.gateEvents.length, 0));
  }, 60_000);

  it('runs only the corpus entries and scenarios it is given', async () => {
    const corpus = loadCorpus(defaultCorpusFile()).slice(0, 2);
    const runs = await goldenRuns('stub', { corpus, scenarios: [] });
    expect(runs.sections.map((s) => s.heading)).toEqual(corpus.map((e) => `corpus ${e.id}`));
    expect(runs.turns).toBe(4);
  });
});
