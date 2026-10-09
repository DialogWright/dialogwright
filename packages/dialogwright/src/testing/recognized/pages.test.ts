import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { registerApp, resetAppsForTest } from '../../core/app/registry';
import { expectAppMap, expectPolicyCard, expectPolicyMatrix, policyInvariants } from '../index';
import { RECOGNIZED_DIR, recognizedApp } from './app';

/**
 * The fixture's three read-back pages: the call-start lookup held to the number calling, the
 * status behind level 1 however the caller is verified, and the report a confirmed write. Written with
 * `pnpm policy:matrix`, `policy:card` and `app:diagram` on this folder; a test fails when one is stale.
 */

resetAppsForTest();
registerApp(recognizedApp);

describe('the recognized fixture\'s pages', () => {
  it('its policy keeps the invariants, the callerNumber rule\'s among them (one-of)', () => {
    const report = policyInvariants(recognizedApp);
    expect(report.violations).toEqual([]);
    expect(report.applied['one-of']).toBeGreaterThan(0);
  });
  it('policy.matrix', () => expectPolicyMatrix(recognizedApp, join(RECOGNIZED_DIR, 'policy.matrix')));
  it('POLICY.md', () => expectPolicyCard(recognizedApp, join(RECOGNIZED_DIR, 'POLICY.md')));
  it('APP-MAP.md', () => expectAppMap(recognizedApp, join(RECOGNIZED_DIR, 'APP-MAP.md')));
});
