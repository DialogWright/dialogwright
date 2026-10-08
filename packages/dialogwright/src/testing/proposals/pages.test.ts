import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { registerApp, resetAppsForTest } from '../../core/app/registry';
import { expectAppMap, expectPolicyCard, expectPolicyMatrix, policyInvariants } from '../index';
import { PROPOSALS_DIR, proposalsApp } from './app';

/**
 * The fixture's three read-back pages: the call-start lookup held to the number calling, the
 * status behind level 1 whatever was proposed, and the report a confirmed write. Written with
 * `pnpm policy:matrix`, `policy:card` and `app:diagram` on this folder; a test fails when one is stale.
 */

resetAppsForTest();
registerApp(proposalsApp);

describe('the proposals fixture\'s pages', () => {
  it('its policy keeps the invariants, the callerNumber rule\'s among them (one-of)', () => {
    const report = policyInvariants(proposalsApp);
    expect(report.violations).toEqual([]);
    expect(report.applied['one-of']).toBeGreaterThan(0);
  });
  it('policy.matrix', () => expectPolicyMatrix(proposalsApp, join(PROPOSALS_DIR, 'policy.matrix')));
  it('POLICY.md', () => expectPolicyCard(proposalsApp, join(PROPOSALS_DIR, 'POLICY.md')));
  it('APP-MAP.md', () => expectAppMap(proposalsApp, join(PROPOSALS_DIR, 'APP-MAP.md')));
});
