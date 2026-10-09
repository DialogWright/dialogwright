import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { registerApp, resetAppsForTest } from '../../core/app/registry';
import { appMapText, expectAppMap, expectPolicyCard, expectPolicyMatrix, policyInvariants } from '../index';
import { ROUTED_DIR, routedApp } from './app';

/**
 * The fixture's three read-back pages, the app map drawing the routes (each point's rules in order, the
 * else last, and the start hook with what it calls) and the internal form only a route reaches. Written
 * with `pnpm policy:matrix`, `policy:card` and `app:diagram` on this folder; a test fails when one is stale.
 */

resetAppsForTest();
registerApp(routedApp);

describe('the routed fixture\'s pages', () => {
  it('its policy keeps the invariants', () => {
    expect(policyInvariants(routedApp).violations).toEqual([]);
  });
  it('policy.matrix', () => expectPolicyMatrix(routedApp, join(ROUTED_DIR, 'policy.matrix')));
  it('POLICY.md', () => expectPolicyCard(routedApp, join(ROUTED_DIR, 'POLICY.md')));
  it('APP-MAP.md', () => expectAppMap(routedApp, join(ROUTED_DIR, 'APP-MAP.md')));
  it('the app map draws each point\'s rules in order, the else last, and what reaches the internal form', () => {
    const map = appMapText(routedApp);
    expect(map).toContain('## Routes');
    expect(map).toContain('The start hook runs first, as every call starts, and calls `lookupNotices`.');
    const order = ['the hours are closed', 'vip holds (in code)', 'fact outage is true', 'the number called is SPANISH_LINE', 'else<br/>continue: the greeting'].map((t) => map.indexOf(t));
    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!))).toBe(true);
    expect(map).toContain('After a route (afterIdentity): the internal form `payment_plan`');
    expect(map).toContain('w_after_report_problem_0{"slot severity is danger"}');
    expect(map).toContain('w_0{"the billing hours are closed"}');
  });
});
