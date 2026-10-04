import { describe, expect, it } from 'vitest';
import { sessionRoundTrip } from 'dialogwright/testing';

/**
 * A saved session resumes exactly (a restart with SESSION_STORE=file): every corpus entry and scenario
 * of this app, run once as it is and once with the session put through JSON before every turn, gives
 * the same decision, actions, trace record and session at every turn.
 */
describe('a session saved and loaded between any two turns', () => {
  it('runs every corpus entry and scenario as the live session does, at every turn (stubs)', async () => {
    const report = await sessionRoundTrip('stub');
    expect(report.mismatches).toEqual([]);
    expect(report.turns).toBeGreaterThan(0);
  }, 60_000);

  it('and as the recorded cassette replays them, with no miss', async () => {
    const report = await sessionRoundTrip('recorded');
    expect(report.misses).toBe(0);
    expect(report.mismatches).toEqual([]);
  }, 60_000);
});
