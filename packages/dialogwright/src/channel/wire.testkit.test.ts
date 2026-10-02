import { describe, expect, it } from 'vitest';
import { loadScenarios, runScenario } from '../harness-text/runner';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { recordableClips } from '../prompts/clips';
import type { RenderContext } from '../prompts/render';
import { useTestkit } from '../testing/apps';
import { testkitApp } from '../testing/testkit';
import { serializeOutbound } from './relay/wire';
import { actionsToFrames } from './relay/map';

/**
 * Every byte the voice adapter would put on the wire for every testkit scenario, text-only and with
 * every clip recorded: the engine's own golden. Each line is "<turn> <frame JSON>";
 * turn 0 is the setup turn (the greeting). A change in these files is a change in what a channel sends.
 */
useTestkit();

const FIXTURES = 'src/testing/testkit/fixtures';
const corpus = loadCorpus(`${FIXTURES}/corpus.jsonl`);
const scenarios = loadScenarios(`${FIXTURES}/scenarios`);
const base = {
  client: new FixtureStubClient(corpus, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: '2026-09-18' }) }),
  thresholds: { ...DEFAULT_THRESHOLDS },
  todayIso: '2026-09-18',
  now: () => 0,
};
const allClips: RenderContext = {
  clips: new Map(recordableClips(testkitApp).map((c) => [c.id, `${c.id}.mp3`])),
  audioBase: 'https://example.test/audio/',
};

async function wire(render: RenderContext | null): Promise<string> {
  const lines: string[] = [];
  for (const s of scenarios) {
    const r = await runScenario(s, { ...base, render });
    lines.push(`# ${s.id}`);
    r.runs.forEach((run, i) => {
      for (const f of actionsToFrames(run.result.actions)) lines.push(`${i} ${serializeOutbound(f)}`);
    });
  }
  return `${lines.join('\n')}\n`;
}

describe('wire golden, on the testkit', () => {
  it('text only', async () => {
    await expect(await wire(null)).toMatchFileSnapshot('./__snapshots__/wire-testkit.txt');
  });
  it('with every clip recorded', async () => {
    await expect(await wire(allClips)).toMatchFileSnapshot('./__snapshots__/wire-testkit-clips.txt');
  });
});
