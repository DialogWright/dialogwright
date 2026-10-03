import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expectPolicyMatrix, policyInvariants, runRuleExamples } from 'dialogwright/testing';
import { clinicApp } from './index';

/**
 * The clinic's policy, tested against its file: the gate holds to every invariant of the policy on
 * the whole gate grid, and policy.matrix (the reviewed golden of what the gate decides, beside
 * policy.yaml) is what it decides today. A policy change fails here with a diff to review; write the
 * new matrix deliberately with `pnpm policy:matrix apps/clinic`.
 */
describe('the clinic\'s policy against its file', () => {
  it('holds to the policy\'s invariants on the gate grid', () => {
    const report = policyInvariants(clinicApp);
    expect(report.violations).toEqual([]);
    // Every caller is at level 0 or above it and the clinic has no scope, roles, fields or attempts:
    // what applies is the unlisted action, the confirmed writes, and the allowed calls.
    expect(Object.entries(report.applied).filter(([, n]) => n > 0).map(([name]) => name)).toEqual(['unlisted', 'confirmed', 'all-rules-passed', 'monotonic']);
  });

  it('has no custom rules to run examples for', () => {
    expect(runRuleExamples(clinicApp)).toEqual([]);
  });

  it('policy.matrix is what the gate decides', () => {
    expectPolicyMatrix(clinicApp, fileURLToPath(new URL('../policy.matrix', import.meta.url)), 'pnpm policy:matrix apps/clinic');
  });
});
