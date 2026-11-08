import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AGENT_CASSETTE_MISS, agentKey, cassetteAgent, loadAgentCassette } from './cassette';
import { fakeAgent } from './fake';
import { inceptionAgent, inceptionRequest, openRouterRequest } from './provider';
import type { AgentAnswer, AgentClient, AgentContext } from './types';

/** The agent cassette (recorded with a fake, or the real provider class over a fake fetch: no test asks a model) and the fake agent. */

const KEY = 'sk-test-not-a-real-key';
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

  it('records what it lacks, then replays it, its time and tokens kept; asked past what was recorded, a miss unless repeatLast', async () => {
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
    expect(await replay.answer(ctx, 1000)).toMatchObject({ ok: true });
    expect(await replay.answer(ctx, 1000)).toMatchObject({ ok: false, reason: 'error', detail: AGENT_CASSETTE_MISS });
    const lenient = cassetteAgent(path, { repeatLast: true });
    for (let i = 0; i < 3; i += 1) expect(await lenient.answer(ctx, 1000)).toMatchObject({ ok: true });
  });

  it('a regression\'s cassette (oneAnswer) answers every asking of a request as first recorded, and records only a request with none', async () => {
    const path = scratch();
    let n = 0;
    const live = fakeAgent(() => (n += 1, { ...answer, reply: `answer ${n}` }), { ms: 300 });
    const recording = cassetteAgent(path, { record: live, oneAnswer: true });
    expect(await recording.answer(ctx, 1000)).toMatchObject({ ok: true, answer: { reply: 'answer 1' } });
    // Asked again (another call repeating the same turn, an adversarial variant of the call): the first answer, no new asking.
    expect(await recording.answer(ctx, 1000)).toMatchObject({ ok: true, answer: { reply: 'answer 1' } });
    expect(n).toBe(1);
    expect(loadAgentCassette(path).get(agentKey(ctx))).toHaveLength(1);
    // A cassette recorded in turn (the bake-off's --repeat) replays its first answer to every asking.
    const repeated = scratch();
    const inTurn = cassetteAgent(repeated, { record: live });
    await inTurn.answer(ctx, 1000);
    await inTurn.answer(ctx, 1000);
    const replay = cassetteAgent(repeated, { oneAnswer: true });
    for (let i = 0; i < 3; i += 1) expect(await replay.answer(ctx, 1000)).toMatchObject({ ok: true, answer: { reply: 'answer 2' } });
    expect((await cassetteAgent(repeated).answer(ctx, 1000))).toMatchObject({ ok: true, answer: { reply: 'answer 2' } });
  });

  it('a recorded answer slower than the budget replays as a timeout', async () => {
    const path = scratch();
    await cassetteAgent(path, { record: fakeAgent(() => answer, { ms: 1200 }) }).answer(ctx, 5000);
    expect(await cassetteAgent(path).answer(ctx, 5000)).toMatchObject({ ok: true, ms: 1200 });
    expect(await cassetteAgent(path).answer(ctx, 1000)).toMatchObject({ ok: false, reason: 'timeout', ms: 1000 });
  });

  it('a text that is not the shape replays as invalid, parsed again for the turn', async () => {
    const path = scratch();
    const recording = cassetteAgent(path, { record: { model: 'raw', answer: async () => ({ ok: false, reason: 'invalid', detail: 'x', ms: 300, raw: 'Sure, Thursday!' }) } });
    await recording.answer(ctx, 1000);
    expect(await cassetteAgent(path).answer(ctx, 1000)).toMatchObject({ ok: false, reason: 'invalid', raw: 'Sure, Thursday!', ms: 300 });
  });

  it('records a timeout and a failed request; a failed request replays as it failed until an answer is recorded after it, and is asked again when recording', async () => {
    const path = scratch();
    await cassetteAgent(path, { record: fakeAgent(() => ({ fail: 'error', detail: 'inception: HTTP 500' }), { ms: 80 }) }).answer(ctx, 1000);
    expect(await cassetteAgent(path).answer(ctx, 1000)).toMatchObject({ ok: false, reason: 'error', detail: 'inception: HTTP 500', ms: 80 });
    let asked = 0;
    expect(await cassetteAgent(path, { record: fakeAgent(() => (asked += 1, answer)) }).answer(ctx, 1000)).toMatchObject({ ok: true });
    expect(asked).toBe(1);
    expect(await cassetteAgent(path).answer(ctx, 1000)).toMatchObject({ ok: true, answer });
    const timed = scratch();
    await cassetteAgent(timed, { record: fakeAgent(() => ({ fail: 'timeout' }), { ms: 1000 }) }).answer(ctx, 1000);
    expect(await cassetteAgent(timed).answer(ctx, 1000)).toMatchObject({ ok: false, reason: 'timeout', ms: 1000 });
    expect(readFileSync(timed, 'utf8')).not.toContain('Thursday please');
  });

  it('keys a turn by everything its request sends but the key', () => {
    const instant = inceptionRequest({ model: 'mercury-3', effort: 'instant', realtime: true });
    expect(agentKey(ctx, instant)).toBe(agentKey(ctx, inceptionRequest({ model: 'mercury-3', effort: 'instant', realtime: true })));
    expect(agentKey(ctx, instant)).not.toBe(agentKey(ctx, inceptionRequest({ model: 'mercury-3', effort: 'low', realtime: true })));
    expect(agentKey(ctx, instant)).not.toBe(agentKey(ctx, inceptionRequest({ model: 'mercury-3', effort: 'instant', realtime: false })));
    expect(agentKey(ctx, instant)).not.toBe(agentKey(ctx, openRouterRequest({ model: 'mercury-3' })));
    expect(agentKey(ctx, instant)).not.toBe(agentKey({ ...ctx, actions: [] }, instant));
    expect(agentKey(ctx)).not.toBe(agentKey({ ...ctx, conversation: [{ who: 'caller', text: 'Friday please.' }] }));
    expect(agentKey(ctx)).not.toBe(agentKey({ ...ctx, examples: ['Happy to help.'] }));
  });

  it('recorded through the provider over a fake fetch, a replay keyed by the request alone finds it, and the key is nowhere in the file', async () => {
    const path = scratch();
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ error: { message: `bad key ${KEY}` } }), { status: 401 });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 40 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const live: AgentClient = inceptionAgent({ model: 'mercury-3', apiKey: KEY, effort: 'instant', realtime: true }, fetchFn);
    const other = { ...ctx, conversation: [{ who: 'caller' as const, text: 'Friday please.' }] };
    const recording = cassetteAgent(path, { record: live });
    expect(await recording.answer(ctx, 5000)).toMatchObject({ ok: false, reason: 'error' });
    expect(await recording.answer(other, 5000)).toMatchObject({ ok: true });
    expect(readFileSync(path, 'utf8')).not.toContain(KEY);
    const replay = cassetteAgent(path, { request: inceptionRequest({ model: 'mercury-3', effort: 'instant', realtime: true }) });
    expect(await replay.answer(other, 5000)).toMatchObject({ ok: true, answer });
    expect(await replay.answer(ctx, 5000)).toMatchObject({ ok: false, reason: 'error' });
    // A replay keyed by another request finds nothing.
    expect(await cassetteAgent(path, { request: inceptionRequest({ model: 'mercury-3', effort: 'low', realtime: true }) }).answer(other, 5000)).toMatchObject({ detail: AGENT_CASSETTE_MISS });
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
