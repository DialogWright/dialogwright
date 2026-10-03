import { afterAll, describe, expect, it } from 'vitest';
import {
  buildClient, buildThresholds, defaultCorpusFile, loadCorpus, loadScenarios, readBaseline, registerApp, REGRESS_TODAY, resetAppsForTest, runAll, scenariosDir,
  type App,
} from 'dialogwright';
import {
  compareGateGrid, createGateShadowReport, formatGateGridMismatches, formatGateShadowReport, gateEvaluator, gateGridInput, gateShadowUnexercised,
  isCassetteMiss, legacyGateEvaluator, legacyGateOf, runGateGrid, shadowGate, withShadowGate, type GateShadowReport,
} from 'dialogwright/testing';
import { clinicApp, registerClinic } from './index';
import { FROZEN_CLINIC_POLICY } from './__fixtures__/frozen';

/**
 * The shadow gate on the clinic: its gate (the named rules of policy.yaml) beside the legacy
 * evaluator over the tables the clinic ran before its policy.yaml took the new shape (frozen test
 * data), on every case of the gate grid, on every call of the full stub regression and on every call
 * of the full replay of the recorded calls. Not one decision may differ; the stub run is the
 * committed baseline, and the replay is the unshadowed replay with no cassette miss.
 */
describe('the shadow gate on the clinic', () => {
  afterAll(() => {
    resetAppsForTest();
    registerClinic();
  });

  const input = { ...gateGridInput(clinicApp), policy: FROZEN_CLINIC_POLICY };

  it('grid: every case decided as the legacy evaluator over the frozen tables decides it', () => {
    const mismatches = compareGateGrid(input, gateEvaluator(clinicApp));
    expect(mismatches.length === 0 ? [] : [formatGateGridMismatches(mismatches)]).toEqual([]);
    const report = createGateShadowReport();
    runGateGrid(input, shadowGate(gateEvaluator(clinicApp), legacyGateEvaluator(input), { mode: 'report', report }));
    expect(report.mismatches, formatGateShadowReport(report)).toEqual([]);
    expect(report.compared).toBe(3 * 6 * 18 * 6);
    // No call can fail identity at level 0; every other rule of every action passes and fails.
    expect(gateShadowUnexercised(report, FROZEN_CLINIC_POLICY.rulesFor, true)).toEqual(Object.keys(FROZEN_CLINIC_POLICY.rulesFor).map((t) => `${t} identity never fails`));
  });

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

  const shadowed = (report: GateShadowReport): App => withShadowGate(clinicApp, legacyGateOf(clinicApp, FROZEN_CLINIC_POLICY), { mode: 'report', report });

  it('a full stub run: every decision the same, and the run is the committed baseline', async () => {
    const report = createGateShadowReport();
    const actual = await run('stub', shadowed(report));
    const expected = readBaseline();
    expect(actual.scenarios).toEqual(expected.scenarios);
    expect(actual.corpus).toEqual(expected.corpus);
    expect(report.mismatches, formatGateShadowReport(report)).toEqual([]);
    expect(report.compared).toBeGreaterThan(50);
    // No call of a run fails identity (every action is level 0) or confirmed (every write was read back and
    // confirmed); the grid fails confirmed.
    expect(gateShadowUnexercised(report)).toEqual(['identity never fails', 'confirmed never fails']);
  }, 60_000);

  it('a full replay of the recorded calls: every decision the same, no cassette miss, the replay as without the shadow', async () => {
    const plain = await run('recorded', clinicApp);
    const report = createGateShadowReport();
    const actual = await run('recorded', shadowed(report));
    expect(actual.records.filter((r) => isCassetteMiss(r))).toEqual([]);
    expect(actual.records.length).toBe(plain.records.length);
    expect(actual.scenarios).toEqual(plain.scenarios);
    expect(actual.corpus).toEqual(plain.corpus);
    expect(report.mismatches, formatGateShadowReport(report)).toEqual([]);
    expect(report.compared).toBeGreaterThan(50);
    expect(gateShadowUnexercised(report)).toEqual(['identity never fails', 'confirmed never fails']);
  }, 120_000);
});
