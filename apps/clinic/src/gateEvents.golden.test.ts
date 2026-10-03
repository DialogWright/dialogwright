import { describe, expect, it } from 'vitest';
import { clinicApp } from './index';
import { compareGateGrid, gateEventGolden, gateGridInput, gridUnexercised, legacyGateEvaluator, runGateGrid } from 'dialogwright/testing';

/**
 * Every gate decision of the clinic's regression run: every event of every turn of every corpus
 * entry and scenario, with its redacted call, purpose, verdict, reason, the level a step-up needs and
 * each rule's line, once as the stubs drive it and once as the recorded cassette replays it (with no
 * miss). A change to the policy, the gate or the tables shows here as a diff to explain; these files
 * must not change with it unless the change is meant.
 */
describe('gate-event golden', () => {
  it('stub', async () => {
    const golden = await gateEventGolden('stub');
    expect(golden.misses).toBe(0);
    // Every param the clinic's own calls carry is one its tool lists, so check holds it to policy.yaml's audit.
    expect(golden.unlistedParams).toEqual([]);
    await expect(golden.text).toMatchFileSnapshot('./__snapshots__/gate-events.stub.txt');
  }, 60_000);

  it('recorded', async () => {
    const golden = await gateEventGolden('recorded');
    expect(golden.misses).toBe(0);
    expect(golden.unlistedParams).toEqual([]);
    await expect(golden.text).toMatchFileSnapshot('./__snapshots__/gate-events.recorded.txt');
  }, 60_000);
});

describe('gate grid', () => {
  it('is stable, and sees every rule pass and fail but identity, which no call can fail at level 0', () => {
    const input = gateGridInput(clinicApp);
    const grid = runGateGrid(input);
    // 5 tools and the unlisted one; no purposes beside the two probes; 6 principals; one param set each; 18 facts.
    expect(grid.points.length).toBe(3 * 6 * 18 * 6);
    expect(compareGateGrid(input, legacyGateEvaluator(input))).toEqual([]);
    expect(gridUnexercised(input, grid)).toEqual(Object.keys(clinicApp.policy.rulesFor).map((t) => `${t} identity never fails`));
  });
});
