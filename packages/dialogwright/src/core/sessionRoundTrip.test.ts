import { describe, expect, it } from 'vitest';
import { useTestkit } from '../testing/apps';
import { sessionRoundTrip } from '../testing/sessionRoundTrip';
import { SESSION_SCHEMA } from './session';

useTestkit();

/**
 * A saved session resumes exactly: every corpus entry and scenario of the testkit, run once as it is
 * and once with the session put through JSON (what a store keeps) before every turn, gives the same
 * decision, actions, trace record and session at every turn. The same check runs over the clinic's and
 * the utility's own (each app's sessionRoundTrip.test.ts).
 */
describe('a session saved and loaded between any two turns', () => {
  it('has a schema version, kept beside the session in the store and never inside it', () => {
    expect(SESSION_SCHEMA).toBe(1);
  });

  it('runs every testkit corpus entry and scenario as the live session does, at every turn', async () => {
    const report = await sessionRoundTrip('stub');
    expect(report.mismatches).toEqual([]);
    expect(report.turns).toBeGreaterThan(100);
  }, 60_000);

  it('notices a session that does not survive the trip', async () => {
    // A store that loses the turn count: the next turn's record says another index.
    const report = await sessionRoundTrip('stub', {}, (s) => ({ ...s, turnIndex: s.turnIndex + 1 }));
    expect(report.mismatches.length).toBeGreaterThan(0);
    expect(report.mismatches[0]).toMatchObject({ turn: 0 });
  }, 60_000);
});
