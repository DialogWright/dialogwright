import { describe, expect, it } from 'vitest';
import type { App, PolicyTables } from '../core/app/types';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { gateOf } from '../core/app/lookup';
import { readBaseline, REGRESS_TODAY } from '../harness-text/baseline';
import { runAll } from '../harness-text/runAll';
import { loadScenarios } from '../harness-text/runner';
import { loadCorpus } from '../jev/corpus';
import { buildClient, buildThresholds } from '../run/client';
import { defaultCorpusFile, scenariosDir } from '../run/fixtures';
import { FROZEN_TESTKIT_POLICY } from '../define/__fixtures__/frozen/testkit';
import { useTestkit } from './apps';
import { compareGateGrid, formatGateGridMismatches, gateGridInput, legacyGateEvaluator, runGateGrid } from './gateGrid';
import {
  createGateShadowReport, formatGateShadowReport, gateEvaluator, gateShadowUnexercised, GateShadowMismatchError, legacyGateOf, shadowGate, withShadowGate,
  type GateShadowReport,
} from './shadowGate';
import { testkitApp } from './testkit';
import { TESTKIT_CUSTOM_RULES } from './testkit/domain/policy';

/**
 * The shadow gate on the testkit: its gate (the named rules of its policy.yaml) beside the legacy
 * evaluator over the tables the testkit wrote by hand before it had the file (frozen test data), on
 * every case of the gate grid and on every call of the whole stub regression (the testkit has no
 * recorded cassette). Not one decision may differ, the run's outputs are the committed baseline, and
 * every rule of every action is seen to pass and to fail on the grid. Then the harness's own test:
 * a reference that differs by one role is found, in throw and in report mode, and a candidate that
 * throws is a mismatch.
 */

useTestkit();

const FROZEN: PolicyTables = { ...FROZEN_TESTKIT_POLICY, customRules: TESTKIT_CUSTOM_RULES };

describe('the shadow gate on the testkit', () => {
  const input = { ...gateGridInput(testkitApp), policy: FROZEN };

  it('grid: the compiled gate decides every case as the legacy evaluator over the frozen tables, and every rule of every action passes and fails', () => {
    const mismatches = compareGateGrid(input, gateEvaluator(testkitApp));
    expect(mismatches.length === 0 ? [] : [formatGateGridMismatches(mismatches)]).toEqual([]);
    const report = createGateShadowReport();
    const grid = runGateGrid(input, shadowGate(gateEvaluator(testkitApp), legacyGateEvaluator(input), { mode: 'report', report }));
    expect(report.mismatches, formatGateShadowReport(report)).toEqual([]);
    expect(report.compared).toBe(grid.points.length);
    expect(report.compared).toBe(4 * 8 * 18 * (6 * 5 + 1 * 5 * 3 + 3 * 1));
    expect(gateShadowUnexercised(report, FROZEN.rulesFor, true)).toEqual([]);
    expect(Object.keys(report.rules).sort()).toEqual(['R8', 'attempts', 'confirmed', 'fields', 'identity', 'role', 'scope', 'unlisted']);
  });

  async function run(app: App, report: GateShadowReport) {
    resetAppsForTest();
    try {
      registerApp(withShadowGate(app, legacyGateOf(app, FROZEN), { mode: 'report', report }));
      const thresholds = buildThresholds([]);
      return await runAll(loadCorpus(defaultCorpusFile()), loadScenarios(scenariosDir()), {
        client: buildClient('stub', defaultCorpusFile(), thresholds, REGRESS_TODAY),
        thresholds,
        todayIso: REGRESS_TODAY,
        now: () => 0,
      });
    } finally {
      useTestkit();
    }
  }

  it('a whole stub run: every decision the same, and the run is the committed baseline', async () => {
    const report = createGateShadowReport();
    const actual = await run(testkitApp, report);
    const expected = readBaseline();
    expect(actual.scenarios).toEqual(expected.scenarios);
    expect(actual.corpus).toEqual(expected.corpus);
    expect(report.mismatches, formatGateShadowReport(report)).toEqual([]);
    expect(report.compared).toBeGreaterThan(100);
    // What a run reaches: every rule it runs passes somewhere; no call of a run fails the confirmed
    // or the fields rule (the grid fails both).
    expect(gateShadowUnexercised(report)).toEqual(['confirmed never fails', 'fields never fails']);
  }, 60_000);

  it('finds a reference that differs by one role, in throw mode and in report mode', () => {
    const roles = { ...FROZEN.roles, createReport: { ...FROZEN.roles!.createReport, viewer: 'allow' as const } };
    const altered = legacyGateEvaluator({ policy: { ...FROZEN, roles }, subjectKind: input.subjectKind });
    expect(() => runGateGrid(input, shadowGate(gateEvaluator(testkitApp), altered))).toThrow(GateShadowMismatchError);
    expect(() => runGateGrid(input, shadowGate(gateEvaluator(testkitApp), altered))).toThrow(/createReport by agent@2:viewer decided otherwise/);
    const report = createGateShadowReport();
    runGateGrid(input, shadowGate(gateEvaluator(testkitApp), altered, { mode: 'report', report }));
    expect(report.mismatches.length).toBe(compareGateGrid(input, gateEvaluator(testkitApp), altered).length);
    expect(report.mismatches.length).toBeGreaterThan(0);
    const text = formatGateShadowReport(report, 1);
    expect(text).toContain('role viewer may createReport: yes');
    expect(text).toContain('role viewer may createReport: no');
    expect(text).toContain(`... and ${report.mismatches.length - 1} more`);
  });

  it('a candidate that throws is a mismatch; the reference answers', () => {
    const report = createGateShadowReport();
    const evaluate = shadowGate(() => { throw new Error('not built yet'); }, legacyGateEvaluator(input), { mode: 'report', report });
    const call = { tool: 'getParcel', params: { parcel: '7101' } };
    const p = input.matrix.principals.subject2;
    const decided = evaluate(call, p, { attempts: 0, confirmedHash: null, todayIso: REGRESS_TODAY }, input.lookups);
    expect(decided.verdict).toBe('ALLOW');
    expect(report.mismatches.map((m) => m.actual)).toEqual(['threw: not built yet']);
    expect(() => shadowGate(gateEvaluator(testkitApp), legacyGateEvaluator(input), { mode: 'report' })).toThrow(/needs a report/);
  });

  it('puts itself in front of the app\'s calls, and leaves the app it was given as it was', () => {
    const shadowed = withShadowGate(testkitApp);
    expect(shadowed.gate).toBeDefined();
    expect(testkitApp.gate).toBeUndefined();
    expect(gateOf(shadowed)).toBe(shadowed.gate);
    expect(shadowed.gate!.source).toBe(gateOf(testkitApp).source);
  });
});
