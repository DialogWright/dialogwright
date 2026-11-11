import { describe, expect, it } from 'vitest';
import { AGENT_CASSETTE_MISS } from '../agent/cassette';
import { agentCassetteMissed } from './agentScript';
import type { TurnRun } from '../run/turn';

/** A regression's agent cassette miss, on any asking of a turn: the call fails on it rather than pass on a fallback nobody recorded. */
describe('agentCassetteMissed', () => {
  const run = (agent: Record<string, unknown> | undefined) => ({ record: { agent } }) as unknown as Pick<TurnRun, 'record'>;

  it('is a miss on the first asking, the asking again after an answer not in its shape, and a second shown a tool\'s result', () => {
    expect(agentCassetteMissed(run({ use: 'failed', fallback: 'error', detail: AGENT_CASSETTE_MISS }))).toBe(true);
    expect(agentCassetteMissed(run({ use: 'failed', fallback: 'invalid', detail: 'x', retried: { invalid: 'x', ms: 0, fallback: 'error', detail: AGENT_CASSETTE_MISS } }))).toBe(true);
    expect(agentCassetteMissed(run({ use: 'used', again: { tools: ['t'], ms: 0, fallback: 'error', detail: AGENT_CASSETTE_MISS } }))).toBe(true);
  });

  it('is none where every asking was answered, or failed for another reason', () => {
    expect(agentCassetteMissed(run({ use: 'used', retried: { invalid: 'x', ms: 400 } }))).toBe(false);
    expect(agentCassetteMissed(run({ use: 'failed', fallback: 'invalid', detail: 'x', retried: { invalid: 'x', ms: 400, fallback: 'invalid', detail: 'y' } }))).toBe(false);
    expect(agentCassetteMissed(run(undefined))).toBe(false);
  });
});
