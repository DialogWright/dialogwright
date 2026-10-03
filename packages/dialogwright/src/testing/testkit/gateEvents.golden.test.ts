import { describe, expect, it } from 'vitest';
import { gateEventGolden } from '../gateEvents';

/**
 * Every gate decision of the testkit's regression run, as the stubs drive it: every event of every
 * turn of every corpus entry and scenario, with its redacted call, purpose, verdict, reason, the level
 * a step-up needs, and each rule's line. A change to the policy, the gate or the tables shows here as
 * a diff to explain; this file must not change with it unless the change is meant. (The testkit has
 * no recorded cassette.)
 */
describe('gate-event golden', () => {
  it('stub', async () => {
    const golden = await gateEventGolden('stub');
    expect(golden.misses).toBe(0);
    expect(golden.events).toBeGreaterThan(0);
    await expect(golden.text).toMatchFileSnapshot('./__snapshots__/gate-events.stub.txt');
  }, 60_000);
});
