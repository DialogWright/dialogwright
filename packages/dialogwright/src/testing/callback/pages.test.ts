import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { registerApp, resetAppsForTest } from '../../core/app/registry';
import { appMapText, expectAppMap, expectPolicyCard, expectPolicyMatrix, policyInvariants } from '../index';
import { CALLBACK_DIR, callbackApp } from './app';

/**
 * The fixture's three read-back pages, the app map drawing where a handoff goes (app.yaml's transfer:
 * each target in order, its conditions, the variable it dials and what goes with it, and the default).
 * Written with `pnpm policy:matrix`, `policy:card` and `app:diagram` on this folder; a test fails when
 * one is stale.
 */

resetAppsForTest();
registerApp(callbackApp);

describe('the callback fixture\'s pages', () => {
  it('its policy keeps the invariants', () => {
    expect(policyInvariants(callbackApp).violations).toEqual([]);
  });
  it('policy.matrix', () => expectPolicyMatrix(callbackApp, join(CALLBACK_DIR, 'policy.matrix')));
  it('POLICY.md', () => expectPolicyCard(callbackApp, join(CALLBACK_DIR, 'POLICY.md')));
  it('APP-MAP.md', () => expectAppMap(callbackApp, join(CALLBACK_DIR, 'APP-MAP.md')));
  it('the app map draws the transfer targets in order, the default last', () => {
    const map = appMapText(callbackApp);
    expect(map).toContain('## Where a handoff goes');
    const order = ['PRIORITY_LINE', 'CALLBACK_DESK', 'SECURITY_DESK', 'default HANDOFF_NUMBER'].map((t) => map.indexOf(t));
    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!))).toBe(true);
    expect(map).toContain('w_1{"the form is request_callback and the reason is max-attempts"}');
  });
});
