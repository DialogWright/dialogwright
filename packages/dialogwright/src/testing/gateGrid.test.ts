import { describe, expect, it } from 'vitest';
import { isDeepStrictEqual } from 'node:util';
import type { GateDecision } from '../gate/types';
import { evaluateCall } from '../gate/policy';
import { testkitApp } from './testkit';
import {
  compareGateGrid, formatGateGridMismatches, gateGridCases, gateGridInput, gridUnexercised, gridVerdicts, legacyGateEvaluator,
  matrixProblems, runGateGrid, UNLISTED_TOOL, type GateGridInput,
} from './gateGrid';

/**
 * The gate grid on the testkit, and the grid's own self-test: run against itself it is stable and
 * finds nothing, and a deliberately altered table shows up, as differences in exactly the cases it
 * should touch.
 */
describe('the gate grid', () => {
  const input = gateGridInput(testkitApp);
  const grid = runGateGrid(input);

  it('crosses every tool, probe and purpose with every principal, subject and fact', () => {
    const cases = grid.points.map((p) => p.case);
    expect(new Set(cases.map((c) => c.key)).size).toBe(cases.length);
    expect(new Set(cases.map((c) => c.tool))).toEqual(new Set([...Object.keys(testkitApp.policy.rulesFor), UNLISTED_TOOL]));
    expect(new Set(cases.map((c) => c.purpose))).toEqual(new Set([null, 'entry-check', 'retry-check', 'report_missing']));
    expect(new Set(cases.map((c) => c.principal))).toEqual(new Set([
      'anonymous', 'subject@1', 'subject@2', 'delegate:viewer', 'delegate:clerk', 'unlisted-role', 'roleless', 'other-party',
    ]));
    expect(new Set(cases.map((c) => c.subject))).toEqual(new Set(['own', 'inScope', 'outOfScope', 'unknown', 'empty', '-']));
    expect(new Set(cases.map((c) => c.attempts))).toEqual(new Set([0, 3]));
    // 9 tools and the unlisted one, 4 purposes, 8 principals; 7 tools name a subject (5 ways), createReport 3 param sets; 3 field variants, 2 attempts, 3 confirmations.
    expect(cases.length).toBe(4 * 8 * 18 * (6 * 5 + 1 * 5 * 3 + 3 * 1));
    expect(gridVerdicts(grid)).toEqual({ ALLOW: expect.any(Number), BLOCK: expect.any(Number), STEP_UP: expect.any(Number), NEEDS_HUMAN: expect.any(Number) });
  });

  it('sees every rule of every tool both pass and fail', () => {
    expect(gridUnexercised(input, grid)).toEqual([]);
  });

  it('is stable: run again, and against itself, it finds nothing', () => {
    expect(isDeepStrictEqual(runGateGrid(gateGridInput(testkitApp)), grid)).toBe(true);
    expect(compareGateGrid(input, legacyGateEvaluator(input))).toEqual([]);
  });

  it('shows a role flipped from refuse to allow, in exactly the viewer\'s report cases it changes', () => {
    const roles = { ...input.policy.roles, createReport: { ...input.policy.roles!.createReport, viewer: 'allow' as const } };
    const altered = legacyGateEvaluator({ ...input, policy: { ...input.policy, roles } });
    const mismatches = compareGateGrid(input, altered);
    expect(mismatches.length).toBeGreaterThan(0);
    for (const m of mismatches) expect(m.key).toMatch(/^createReport \S+ delegate:viewer /);
    // Every viewer report case that reached R5 changed; nothing else did.
    const reachedRole = grid.points.filter((p) => p.case.tool === 'createReport' && p.case.principal === 'delegate:viewer' && p.decision.rules.some((r) => r.id === 'R5'));
    expect(mismatches.length).toBe(reachedRole.length);
    const text = formatGateGridMismatches(mismatches, 2);
    expect(text).toContain(`${mismatches.length} case(s) decided otherwise`);
    expect(text).toContain('expected BLOCK reason=role R1+ R5-');
    expect(text).toContain('role viewer may createReport: no');
    expect(text).toContain('role viewer may createReport: yes');
    expect(text).toContain(`... and ${mismatches.length - 2} more`);
  });

  it('shows a level lowered, and a candidate that throws', () => {
    const lowered = legacyGateEvaluator({ ...input, policy: { ...input.policy, toolLevel: { ...input.policy.toolLevel, listParcels: 1 } } });
    const changed = compareGateGrid(input, lowered);
    expect(changed.length).toBeGreaterThan(0);
    expect(new Set(changed.map((m) => m.key.split(' ')[0]))).toEqual(new Set(['listParcels']));
    const throws = compareGateGrid(input, (call, p, facts, lk) => {
      if (call.tool === 'getParcel') throw new Error('not built yet');
      return evaluateCall(call, p, facts, lk, input.policy, input.subjectKind);
    });
    expect(throws.length).toBe(grid.points.filter((p) => p.case.tool === 'getParcel').length);
    expect(formatGateGridMismatches(throws, 1)).toContain('actual   threw: not built yet');
  });

  it('returns whole decisions, raw calls included, for a candidate to be held to', () => {
    const point = grid.points.find((p) => p.case.key === 'getParcel - subject@2 own base exact a0 none')!;
    expect(point.decision).toEqual<GateDecision>({
      call: { tool: 'getParcel', params: { parcel: '7101' } },
      verdict: 'ALLOW',
      rules: [
        { id: 'R1', description: 'Identity strong enough for this action', compared: 'identity.level 2 >= 2', pass: true },
        { id: 'R2', description: expect.any(String), compared: 'record owner ...1234 · caller may see ...1234 only', pass: true },
      ],
    });
  });

  it('refuses a matrix that does not hold the principals and records it says it does', () => {
    const m = input.matrix;
    const bad: GateGridInput = {
      ...input,
      matrix: {
        ...m,
        principals: { ...m.principals, subject1: m.principals.subject2, unlistedRole: m.principals.delegates.viewer!, roleless: m.principals.delegates.clerk! },
        records: { ...m.records, unknown: m.records.own },
      },
    };
    expect(matrixProblems(bad)).toEqual([
      'subject1 is at level 2, not 1',
      'unlistedRole\'s role viewer is not one the tables leave out',
      'roleless has role clerk',
      'records.unknown.record has an owner',
      'the subject may see records.unknown',
      'delegates.viewer may see records.outOfScope or records.unknown',
      'delegates.clerk may see records.outOfScope or records.unknown',
    ]);
    expect(() => gateGridCases(bad)).toThrow(/does not hold together/);
    expect(matrixProblems(input)).toEqual([]);
  });
});
