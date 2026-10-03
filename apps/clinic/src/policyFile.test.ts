import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_ATTEMPTS, definePolicy } from 'dialogwright/policy';
import { compareGateGrid, formatGateGridMismatches, gateGridInput, legacyGateEvaluator } from 'dialogwright/testing';
import { clinicApp, code } from './index';

/**
 * The clinic's policy.yaml in the new shape (__fixtures__/converted/policy.yaml) compiles to exactly
 * the tables the clinic runs today from its old-shape file, and the gate grid decides every case the
 * same over both. The clinic verifies no one, so it has no identity.yaml and the attempts rule's
 * number is the engine's default (no action runs the rule).
 */

const CONVERTED = fileURLToPath(new URL('./__fixtures__/converted/policy.yaml', import.meta.url));

describe('compile equality: the clinic', () => {
  const policy = definePolicy(CONVERTED);

  it('policy.yaml in the new shape compiles to the tables the old one gives', () => {
    expect(policy).toEqual(clinicApp.policy);
    expect(policy.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
  });

  it('definePolicy, from the path and checked against the clinic\'s code, gives the same', () => {
    expect(definePolicy(CONVERTED, { tools: code.tools, slots: clinicApp.slots })).toEqual(clinicApp.policy);
  });

  it('gate grid: no case decided otherwise', () => {
    const input = gateGridInput(clinicApp);
    const mismatches = compareGateGrid(input, legacyGateEvaluator({ policy, subjectKind: input.subjectKind }));
    expect(mismatches.length === 0 ? [] : [formatGateGridMismatches(mismatches)]).toEqual([]);
  });
});
