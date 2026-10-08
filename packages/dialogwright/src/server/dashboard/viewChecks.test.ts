import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { registerApp, resetAppsForTest } from '../../core/app/registry';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { loadCorpus } from '../../jev/corpus';
import { FixtureStubClient } from '../../jev/fixtureStub';
import { HeuristicStubClient } from '../../jev/heuristicStub';
import { scripted } from '../../testing/scripted';
import { SCREENED_DIR, screenedApp } from '../../testing/screened/app';
import { configure, reduce } from './view.js';
import { consoleMetaOf } from './meta';
import type { DashboardEvent } from './events';

/**
 * The console on a call whose form a check ended (core/checks.ts): the check's gate event shows as
 * any call's does, and the NOW panel says which check stopped the form and why, from the turn's
 * `form_stopped` audit draft.
 */

resetAppsForTest();
registerApp(screenedApp);
configure(consoleMetaOf(screenedApp));
const client = new FixtureStubClient(loadCorpus(join(SCREENED_DIR, 'fixtures', 'corpus.jsonl')), { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient() });

describe('a form a check ended', () => {
  it('shows the check on the gate card and "stopped" on the form in the NOW panel', async () => {
    const { events } = await scripted(["there's water in my basement", 'I rent it'], { client });
    const v = reduce(events as DashboardEvent[]);
    expect(v.gate).toMatchObject({ display: 'checkOwner(ownership=rent)', verdict: 'BLOCK', reason: 'not-owner' });
    expect(v.now).toMatchObject({ state: 'task', label: 'Book a visit', stopped: 'stopped: checkOwner, not-owner' });
  });

  it('says nothing of a stop on a turn whose checks passed', async () => {
    const { events } = await scripted(["there's water in my basement", 'yes, I own it'], { client });
    const v = reduce(events as DashboardEvent[]);
    expect(v.gate).toMatchObject({ display: 'checkOwner(ownership=own)', verdict: 'ALLOW' });
    expect(v.now).not.toHaveProperty('stopped');
  });

  it('keeps the stop beside the handoff when the check handed the call over', async () => {
    const { events } = await scripted(["there's water in my basement", 'yes, I own it', 'Cedar Falls', 'it needs someone right away'], { client });
    expect(reduce(events as DashboardEvent[]).now).toMatchObject({ state: 'handoff', stopped: 'stopped: checkUrgency, urgent' });
  });
});

describe('a handoff with values the caller never confirmed (handoff.data.unconfirmed: mark)', () => {
  it('marks each such value in the packet, the corrected urgency among them', async () => {
    const { events } = await scripted(["there's water in my basement", 'yes, I own it', 'Cedar Falls', "it's getting worse", 'Monday', 'the morning', 'wait, water is coming through the wall right now'], { client });
    const v = reduce(events as DashboardEvent[]);
    expect(v.handoff).toMatchObject({ reason: 'urgent' });
    expect(v.handoff!.packet).toEqual([
      'problem: a leak (not confirmed)',
      'ownership: you own it (not confirmed)',
      'town: Cedar Falls (not confirmed)',
      'howUrgent: right away (not confirmed)',
      'visitDay: Monday (not confirmed)',
      'timeOfDay: the morning (not confirmed)',
    ]);
  });
});
