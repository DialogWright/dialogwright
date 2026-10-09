import { describe, expect, it } from 'vitest';
import { loggedRoutes, routeDivergence } from './replay';
import type { ReadFrameLogLine } from '../server/frameLog';

/**
 * A replay of a call whose routes (routes.yaml) took another branch than the call did says so (its
 * `skipped` lines), never silently: the frame log keeps the routes the call took, by point and rule,
 * and does not keep the number called, which a start route on `called` reads.
 */

const line = (msg: unknown, n: number): ReadFrameLogLine => ({ ts: '2026-10-12T14:00:00.000Z', dir: 'log', msg, line: n }) as ReadFrameLogLine;

describe('routes in a replay', () => {
  it('reads the routes the call took, in order; none for a log without them', () => {
    expect(loggedRoutes([line({ routes: [{ point: 'start', rule: 4 }] }, 1), line({ routes: [{ point: 'afterForm', form: 'report_problem', rule: 'else' }] }, 2)])).toEqual(['start rule 4', 'afterForm report_problem else']);
    expect(loggedRoutes([line({ callData: ['region'] }, 1)])).toBeNull();
  });

  it('says where the replay went another way, and nothing when it went the same', () => {
    expect(routeDivergence(['start rule 4'], ['start else'])).toMatch(/^routes: the call took start rule 4, the replay took start else \(a route on the number called/);
    expect(routeDivergence(['start rule 4'], ['start rule 4'])).toBeNull();
    expect(routeDivergence(null, ['start else'])).toBeNull();
  });
});
