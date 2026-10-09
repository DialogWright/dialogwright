import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { registerApp, resetAppsForTest } from '../../core/app/registry';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { loadCorpus } from '../../jev/corpus';
import { FixtureStubClient } from '../../jev/fixtureStub';
import { HeuristicStubClient } from '../../jev/heuristicStub';
import { scripted } from '../../testing/scripted';
import { ROUTED_DIR, routedApp } from '../../testing/routed/app';
import { configure, reduce } from './view.js';
import { consoleMetaOf } from './meta';
import type { DashboardEvent } from './events';

/**
 * The console on a call a route decided (routes.yaml): the NOW panel says the route taken on the
 * latest turn, its point, its rule and what followed, from the turn's `route` audit drafts, and the
 * audit tail has the row, the subjects it read and never their values.
 */

resetAppsForTest();
registerApp(routedApp);
configure(consoleMetaOf(routedApp));
const client = new FixtureStubClient(loadCorpus(join(ROUTED_DIR, 'fixtures', 'corpus.jsonl'), routedApp), { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient() });

describe('a call a route decided', () => {
  it('closed: the NOW panel names the route that ended it', async () => {
    const { events } = await scripted([], { client, startMs: Date.parse('2026-10-12T19:00:00-04:00') });
    const v = reduce(events as DashboardEvent[], { fromTrace: true });
    expect(v.now).toMatchObject({ routed: 'route: start rule 1, end' });
    expect(v.auditTail.map((a) => a.type)).toContain('route');
  });

  it('after a form: the route on the turn it was taken, and none on a turn that took none', async () => {
    const open = Date.parse('2026-10-12T10:00:00-04:00');
    const { events } = await scripted(["I'd like to report a problem", 'nothing is working at all', 'yes, someone could get hurt', 'yes, file it'], { client, startMs: open });
    expect(reduce(events as DashboardEvent[]).now).toMatchObject({ state: 'handoff', routed: 'route: afterForm report_problem rule 1, handoff' });
    const { events: before } = await scripted(["I'd like to report a problem"], { client, startMs: open });
    expect(reduce(before as DashboardEvent[]).now).not.toHaveProperty('routed');
  });
});
