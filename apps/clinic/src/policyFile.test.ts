import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { convertFolder, DEFAULT_MAX_ATTEMPTS, definePolicy } from 'dialogwright/policy';
import { compareGateGrid, formatGateGridMismatches, gateGridInput, legacyGateEvaluator } from 'dialogwright/testing';
import { FROZEN_CLINIC_POLICY } from './__fixtures__/frozen';
import { clinicApp, code } from './index';

/**
 * The clinic's policy.yaml is the old file converted (`dialogwright policy:convert`; the old file is
 * __fixtures__/legacy/policy.yaml, with the comments rewritten and an action's words added by
 * hand), and it compiles to exactly the tables the clinic ran before (__fixtures__/frozen.ts), so
 * the gate decides every case as it did. The clinic verifies no one, so it has no identity.yaml and
 * the attempts rule's number is the engine's default (no action runs the rule). What the old file
 * could not say, how each param that is no redacted slot is recorded (audit), is added by hand:
 * each as it is, as it was recorded before.
 */

/** How the clinic records the params no redacted slot covers: as they are, as before. */
const AUDIT = { name: 'keep', provider: 'keep', date: 'keep', time: 'keep' };

const POLICY = fileURLToPath(new URL('../policy.yaml', import.meta.url));
const LEGACY = fileURLToPath(new URL('./__fixtures__/legacy', import.meta.url));

describe('the clinic\'s policy.yaml', () => {
  it('compiles to the tables the old file gave', () => {
    const { audit, ...tables } = clinicApp.policy;
    expect(tables).toEqual(FROZEN_CLINIC_POLICY);
    expect(audit).toEqual(AUDIT);
    expect(clinicApp.policy.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
  });

  it('is what policy:convert makes of the old file, less the words an author adds (an action\'s say) and the comments: the same tables', () => {
    const converted = convertFolder(LEGACY);
    expect(converted.dropped).toEqual([]);
    expect(converted.unplaced).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'clinic-policy-'));
    try {
      writeFileSync(join(dir, 'policy.yaml'), `${converted.files['policy.yaml']!}audit:\n${Object.entries(AUDIT).map(([p, how]) => `  ${p}: ${how}\n`).join('')}`);
      expect(definePolicy(join(dir, 'policy.yaml'), { tools: code.tools, slots: clinicApp.slots })).toEqual(clinicApp.policy);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('definePolicy, from the path and checked against the clinic\'s code, gives the same', () => {
    expect(definePolicy(POLICY, { tools: code.tools, slots: clinicApp.slots })).toEqual(clinicApp.policy);
  });

  it('gate grid: the compiled tables decide every case as the frozen ones, whole decision for whole decision', () => {
    const input = { ...gateGridInput(clinicApp), policy: FROZEN_CLINIC_POLICY };
    const mismatches = compareGateGrid(input, legacyGateEvaluator({ policy: clinicApp.policy, subjectKind: input.subjectKind }));
    expect(mismatches.length === 0 ? [] : [formatGateGridMismatches(mismatches)]).toEqual([]);
  });
});
