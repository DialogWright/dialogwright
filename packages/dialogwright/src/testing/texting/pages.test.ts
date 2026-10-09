import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { registerApp, resetAppsForTest } from '../../core/app/registry';
import { expectAppMap, expectPolicyCard, expectPolicyMatrix, policyInvariants } from '../index';
import { TEXTING_DIR, textingApp } from './app';

/**
 * The fixture's three read-back pages: the callerNumber rule on the policy card (in words, with its
 * reasons), in the matrix (split by whether the call came from the matrix's caller number), and on the
 * app map. Written with `pnpm policy:matrix`, `policy:card` and `app:diagram` on this folder; a test
 * fails when one is stale.
 */

resetAppsForTest();
registerApp(textingApp);

describe('the texting fixture\'s pages', () => {
  it('its policy keeps the invariants, the callerNumber rule\'s among them (one-of)', () => {
    const report = policyInvariants(textingApp);
    expect(report.applied['one-of']).toBeGreaterThan(0);
  });
  it('policy.matrix', () => expectPolicyMatrix(textingApp, join(TEXTING_DIR, 'policy.matrix')));
  it('POLICY.md', () => expectPolicyCard(textingApp, join(TEXTING_DIR, 'POLICY.md')));
  it('APP-MAP.md', () => expectAppMap(textingApp, join(TEXTING_DIR, 'APP-MAP.md')));
});
