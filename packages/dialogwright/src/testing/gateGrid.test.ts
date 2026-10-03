import { describe, expect, it } from 'vitest';
import { isDeepStrictEqual } from 'node:util';
import type { GateDecision } from '../gate/types';
import { evaluateCall } from '../gate/policy';
import { testkitApp } from './testkit';
import {
  compareGateGrid, formatGateGridMismatches, gateGridCases, gateGridInput, gridUnexercised, gridVerdicts, legacyGateEvaluator,
  matrixProblems, nameOfLegacyId, namedDecision, runGateGrid, UNLISTED_TOOL, type GateEvaluate, type GateGridInput,
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
    // Every viewer report case that reached the role rule changed; nothing else did.
    const reachedRole = grid.points.filter((p) => p.case.tool === 'createReport' && p.case.principal === 'delegate:viewer' && p.decision.rules.some((r) => r.id === 'role'));
    expect(mismatches.length).toBe(reachedRole.length);
    const text = formatGateGridMismatches(mismatches, 2);
    expect(text).toContain(`${mismatches.length} case(s) decided otherwise`);
    expect(text).toContain('expected BLOCK reason=role identity+ role-');
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
      return namedDecision(evaluateCall(call, p, facts, lk, input.policy, input.subjectKind));
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
        { id: 'identity', description: 'Identity strong enough for this action', compared: 'identity.level 2 >= 2', pass: true },
        { id: 'scope', description: expect.any(String), compared: 'record owner ...1234 · caller may see ...1234 only', pass: true },
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

  it('needs a record for each subject only when a scope rule names a record', () => {
    const m = input.matrix;
    const { record: _record, ...ownWithout } = m.records.own;
    const bad: GateGridInput = { ...input, matrix: { ...m, records: { ...m.records, own: ownWithout } } };
    expect(matrixProblems(bad)).toEqual(['records.own.record is missing: the policy has a scope rule on a record (scope: { record }), so each of the four needs one']);
    const noRecordRule: GateGridInput = { ...bad, policy: { ...bad.policy, subjects: Object.fromEntries(Object.entries(bad.policy.subjects).filter(([, row]) => row.via !== 'record')) } };
    expect(matrixProblems(noRecordRule)).toEqual([]);
  });

  it('refuses a matrix whose delegates are not what identity.yaml declares: their kind, their roles', () => {
    const m = input.matrix;
    expect(input.identity?.delegateRoles).toEqual(['viewer', 'clerk']);
    const viewer = m.principals.delegates.viewer!;
    const bad: GateGridInput = {
      ...input,
      identity: { ...input.identity!, delegateRoles: ['viewer'] },
      matrix: { ...m, principals: { ...m.principals, roleless: { ...m.principals.roleless, kind: 'courier' }, delegates: { ...m.principals.delegates, viewer: { ...viewer, kind: 'courier' } } } },
    };
    expect(matrixProblems(bad).filter((p) => !p.startsWith('otherParty'))).toEqual([
      'delegates.viewer is a courier, not the delegate kind "agent" identity.yaml declares',
      'delegates.clerk has the role "clerk", which identity.yaml does not declare (viewer)',
      'roleless is a courier, not the delegate kind "agent"',
      // The lookups know a courier for no depot: the scope check finds it too.
      'delegates.viewer may not see records.inScope',
    ]);
  });
});

/**
 * The one id map between the legacy evaluator (R1..R7, R0) and the gate (the rules' names): the
 * reference's decisions are compared with the gate's after it, and nothing else of a decision moves.
 */
describe('the id map between the legacy evaluator and the gate', () => {
  it('maps each legacy id to the rule\'s name and leaves an app\'s own id alone', () => {
    expect(['R0', 'R1', 'R2', 'R3', 'R5', 'R6', 'R7'].map(nameOfLegacyId)).toEqual(['unlisted', 'identity', 'scope', 'confirmed', 'role', 'attempts', 'fields']);
    for (const id of ['R4', 'R8', 'known-branch', 'identity', 'dateInRange', 'constructor']) expect(nameOfLegacyId(id)).toBe(id);
  });

  it('changes only the rule lines\' ids (and the id a line that fails closed words), never a verdict, reason, level, call or compared line', () => {
    const input = gateGridInput(testkitApp);
    const legacy: GateEvaluate = (call, p, facts, lk) => evaluateCall(call, p, facts, lk, input.policy, input.subjectKind);
    const named = legacyGateEvaluator(input);
    let compared = 0;
    for (const { case: c } of runGateGrid(input).points) {
      const raw = legacy(c.call, c.p, c.facts, input.lookups);
      const mapped = named(c.call, c.p, c.facts, input.lookups);
      expect({ ...mapped, rules: mapped.rules.map((r) => ({ ...r, id: '' })) }, c.key).toEqual({ ...raw, rules: raw.rules.map((r) => ({ ...r, id: '' })) });
      expect(mapped.rules.map((r) => r.id), c.key).toEqual(raw.rules.map((r) => nameOfLegacyId(r.id)));
      compared += 1;
    }
    expect(compared).toBeGreaterThan(1000);
    // A line that fails closed words the rule's id; it follows the id.
    const line = { id: 'R2', description: 'A rule the gate could run', compared: 'rule R2 threw', pass: false };
    const d = namedDecision({ call: { tool: 't', params: {} }, rules: [line, { ...line, id: 'R8', compared: 'rule R2 threw' }], verdict: 'BLOCK', reason: 'rule-error' });
    expect(d.rules).toEqual([{ ...line, id: 'scope', compared: 'rule scope threw' }, { ...line, id: 'R8', compared: 'rule R2 threw' }]);
  });
});
