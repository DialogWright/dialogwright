import { afterAll, describe, expect, it } from 'vitest';
import {
  buildClient, buildThresholds, defaultCorpusFile, loadCorpus, loadScenarios, readBaseline, registerApp, REGRESS_TODAY,
  resetAppsForTest, runAll, scenariosDir, type App, type SlotSpec,
} from 'dialogwright';
import { createShadowReport, formatShadowReport, isCassetteMiss, withShadowSlots, type ShadowReport } from 'dialogwright/testing';
import { clinicApp, registerClinic } from './index';
import { CLINIC_SHADOW_PAIRS } from './testing/shadowPairs';

/**
 * The shadow harness over whole runs of the clinic: every clinic slot shadowed by a copy of itself
 * (the same behavior, so any mismatch is the harness's own), through the full stub regression and
 * the full replay of the recorded calls. Nothing may change: the stub run is the committed
 * baseline, the replay is the unshadowed replay with no cassette miss, and the report is empty
 * though every slot was compared on every turn it was asked.
 */
describe('the shadow harness on the clinic', () => {
  afterAll(() => {
    resetAppsForTest();
    registerClinic();
  });

  const selves: SlotSpec[] = Object.values(clinicApp.slots).map((spec) => ({ ...spec }));

  async function run(kind: 'stub' | 'recorded', app: App) {
    resetAppsForTest();
    registerApp(app);
    const thresholds = buildThresholds([]);
    return runAll(loadCorpus(defaultCorpusFile()), loadScenarios(scenariosDir()), {
      client: buildClient(kind, defaultCorpusFile(), thresholds, REGRESS_TODAY),
      thresholds,
      todayIso: REGRESS_TODAY,
      now: () => 0,
    });
  }

  function expectExercised(report: ShadowReport): void {
    expect(report.mismatches, formatShadowReport(report, selves.map((s) => s.id))).toEqual([]);
    for (const spec of selves) {
      expect(report.calls[`${spec.id}.questions`] ?? 0, `${spec.id}.questions`).toBeGreaterThan(0);
      expect(report.calls[`${spec.id}.fill`] ?? 0, `${spec.id}.fill`).toBeGreaterThan(0);
    }
  }

  it('has no shadow pairs yet: a regression run with DIALOGWRIGHT_SHADOW on registers the clinic as it is', () => {
    expect(CLINIC_SHADOW_PAIRS).toEqual([]);
  });

  it('changes nothing in a full stub regression run, every slot shadowed by itself', async () => {
    const report = createShadowReport();
    const actual = await run('stub', withShadowSlots(clinicApp, selves, { mode: 'report', report }));
    const expected = readBaseline();
    expect(actual.scenarios).toEqual(expected.scenarios);
    expect(actual.corpus).toEqual(expected.corpus);
    expectExercised(report);
  });

  it('changes nothing in a full replay of the recorded calls, with no cassette miss, every slot shadowed by itself', async () => {
    const plain = await run('recorded', clinicApp);
    const report = createShadowReport();
    const shadowed = await run('recorded', withShadowSlots(clinicApp, selves, { mode: 'report', report }));
    expect(shadowed.records.filter((r) => isCassetteMiss(r))).toEqual([]);
    expect(shadowed.records.length).toBe(plain.records.length);
    expect(shadowed.scenarios).toEqual(plain.scenarios);
    expect(shadowed.corpus).toEqual(plain.corpus);
    expectExercised(report);
  });
});
