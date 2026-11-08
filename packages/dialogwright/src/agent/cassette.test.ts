import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AGENT_CASSETTE_MISS, agentKey, cassetteAgent, loadAgentCassette } from './cassette';
import { fakeAgent } from './fake';
import type { AgentAnswer, AgentContext } from './types';

/** The agent cassette (recorded with a fake here: no test asks a model) and the fake agent. */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agent-cassette-'));
  dirs.push(d);
  return join(d, 'recorded', 'fake.jsonl');
};

const ctx: AgentContext = {
  facts: { name: 'Example Service Desk', voice: 'Warm and brief.', says: [], background: [], fixed: {} },
  examples: [],
  form: { name: 'request' },
  fields: [{ name: 'day', type: 'date', value: null, required: true }],
  actions: [{ name: 'submit', about: 'Read back what is collected.' }],
  conversation: [{ who: 'caller', text: 'Thursday please.' }],
  caller: { account: null },
  channel: 'voice',
  overLine: false,
  seen: [],
  locale: 'en-US',
  today: '2026-11-09',
};
const answer: AgentAnswer = { reply: 'Thursday it is.', values: [{ field: 'day', value: '2026-11-12', words: 'Thursday' }], action: 'none', fromFacts: false };

describe('cassetteAgent', () => {
  it('a replay of an empty cassette is a miss, an error', async () => {
    expect(await cassetteAgent(scratch()).answer(ctx, 1000)).toEqual({ ok: false, reason: 'error', detail: AGENT_CASSETTE_MISS, ms: 0 });
  });

  it('records what it lacks, then replays it by the messages\' hash, its time and tokens kept', async () => {
    const path = scratch();
    let n = 0;
    const live = fakeAgent(() => (n += 1, answer), { ms: 640, usage: { inputTokens: 1500, outputTokens: 90 } });
    const recording = cassetteAgent(path, { record: live });
    expect(await recording.answer(ctx, 1000)).toMatchObject({ ok: true, answer, ms: 640 });
    expect(await recording.answer(ctx, 1000)).toMatchObject({ ok: true, answer });
    expect(n).toBe(2);
    const lines = loadAgentCassette(path).get(agentKey(ctx))!;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ v: 1, model: 'fake-agent', ms: 640, usage: { inputTokens: 1500, outputTokens: 90 }, raw: JSON.stringify(answer) });
    const replay = cassetteAgent(path);
    expect(await replay.answer(ctx, 1000)).toEqual({ ok: true, answer, ms: 640, raw: JSON.stringify(answer), usage: { inputTokens: 1500, outputTokens: 90 } });
    // Asked more often than recorded, a replay says the last line again.
    await replay.answer(ctx, 1000);
    expect(await replay.answer(ctx, 1000)).toMatchObject({ ok: true });
  });

  it('a text that is not the shape replays as invalid, parsed again for the turn', async () => {
    const path = scratch();
    const recording = cassetteAgent(path, { record: { model: 'raw', answer: async () => ({ ok: false, reason: 'invalid', detail: 'x', ms: 300, raw: 'Sure, Thursday!' }) } });
    await recording.answer(ctx, 1000);
    expect(await cassetteAgent(path).answer(ctx, 1000)).toMatchObject({ ok: false, reason: 'invalid', raw: 'Sure, Thursday!', ms: 300 });
  });

  it('records a timeout, which was measured, and never a failed request, which is asked again', async () => {
    const path = scratch();
    await cassetteAgent(path, { record: fakeAgent(() => ({ fail: 'error', detail: 'HTTP 500' })) }).answer(ctx, 1000);
    expect(loadAgentCassette(path).size).toBe(0);
    await cassetteAgent(path, { record: fakeAgent(() => ({ fail: 'timeout' }), { ms: 1000 }) }).answer(ctx, 1000);
    expect(await cassetteAgent(path).answer(ctx, 1000)).toMatchObject({ ok: false, reason: 'timeout', ms: 1000 });
    expect(readFileSync(path, 'utf8')).not.toContain('Thursday please');
  });

  it('a different turn is a different key', () => {
    expect(agentKey(ctx)).not.toBe(agentKey({ ...ctx, conversation: [{ who: 'caller', text: 'Friday please.' }] }));
    expect(agentKey(ctx)).not.toBe(agentKey({ ...ctx, examples: ['Happy to help.'] }));
  });
});

describe('fakeAgent', () => {
  it('answers from its script, reporting the time it is told to, or fails as scripted', async () => {
    expect(await fakeAgent(() => answer, { ms: (c) => c.conversation.length * 100 }).answer(ctx, 1000)).toMatchObject({ ok: true, answer, ms: 100 });
    expect(await fakeAgent(() => ({ fail: 'invalid' })).answer(ctx, 1000)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('a delay past the budget is a timeout', async () => {
    expect(await fakeAgent(() => answer, { delayMs: 30 }).answer(ctx, 10)).toMatchObject({ ok: false, reason: 'timeout', ms: 10 });
  });
});
