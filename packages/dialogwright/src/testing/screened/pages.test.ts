import { describe, it } from 'vitest';
import { join } from 'node:path';
import { registerApp, resetAppsForTest } from '../../core/app/registry';
import { expectAppMap, expectPolicyCard, expectPolicyMatrix, policyInvariants, runRuleExamples } from '../index';
import { SCREENED_DIR, screenedApp } from './app';

/**
 * The fixture's three read-back pages: a form's checks on the app map (each check beside the slots
 * it reads, with its outcomes), a check action on the policy card (what it is sent, and that nothing
 * runs) and in the matrix as an ordinary action. Written with `pnpm policy:matrix`, `policy:card` and
 * `app:diagram` on this folder; a test fails when one is stale.
 */

resetAppsForTest();
registerApp(screenedApp);

describe('the screened fixture\'s pages', () => {
  it('its rule examples hold in every action that names each rule', () => runRuleExamples(screenedApp));
  it('its policy keeps the invariants, with three check actions that have no tool', () => { policyInvariants(screenedApp); });
  it('policy.matrix', () => expectPolicyMatrix(screenedApp, join(SCREENED_DIR, 'policy.matrix')));
  it('POLICY.md', () => expectPolicyCard(screenedApp, join(SCREENED_DIR, 'POLICY.md')));
  it('APP-MAP.md', () => expectAppMap(screenedApp, join(SCREENED_DIR, 'APP-MAP.md')));
});
