import { describe, expect, it } from 'vitest';
import { loadScenarios, runScenario } from '../harness-text/runner';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { appOf } from '../core/app/registry';
import { spokenText } from '../prompts/render';
import { sayText } from '../channel/actions';
import { useTestkit } from '../testing/apps';
import { defaultCorpusFile, scenariosDir } from '../run/fixtures';

useTestkit();

/**
 * The chats build their reply from `spokenText(app, decision)` (chatTurn.ts), the defined source of
 * what was said. The channel model carries the same words as `say` actions. This is the fact a chat
 * consuming `say` actions starts from: on every turn of every chat scenario
 * (the testkit's depot staff chats and its customers' web chat), the two agree.
 *
 * A scenario id listed here is one where they do not, with a line on what differs. Neither function
 * is changed to hide a difference; the list is the work left to do.
 */
const KNOWN_DIFFERENCES: Record<string, string> = {};

const corpus = loadCorpus(defaultCorpusFile());
const chats = loadScenarios(scenariosDir()).filter((s) => s.as !== undefined);
const opts = {
  client: new FixtureStubClient(corpus, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: '2026-09-18' }) }),
  thresholds: { ...DEFAULT_THRESHOLDS },
  todayIso: '2026-09-18',
  now: () => 0,
};

describe('what the chats say', () => {
  it('covers the staff chat and the web chat scenarios', () => {
    expect(chats.length).toBeGreaterThan(0);
    expect(chats.some((s) => s.as === 'web')).toBe(true);
    expect(chats.some((s) => s.as !== 'web')).toBe(true);
  });

  for (const s of chats) {
    it(`${s.id}: every turn's say actions read the same as its decision's spoken text`, async () => {
      const run = await runScenario(s, opts);
      expect(run.runs.some((r) => sayText(r.result.actions) !== ''), 'a chat scenario that says nothing proves nothing').toBe(true);
      const differing = run.runs.flatMap((r, i) => {
        const fromActions = sayText(r.result.actions);
        const fromDecision = spokenText(appOf(r.result.session), r.result.decision);
        return fromActions === fromDecision ? [] : [`turn ${i}: actions say ${JSON.stringify(fromActions)}, decision says ${JSON.stringify(fromDecision)}`];
      });
      if (s.id in KNOWN_DIFFERENCES) expect(differing, `${s.id} is listed as different (${KNOWN_DIFFERENCES[s.id]}) but agrees: remove it`).not.toEqual([]);
      else expect(differing).toEqual([]);
    });
  }

  it('lists only scenarios that exist', () => {
    const ids = new Set(chats.map((s) => s.id));
    for (const id of Object.keys(KNOWN_DIFFERENCES)) expect(ids, id).toContain(id);
  });
});
