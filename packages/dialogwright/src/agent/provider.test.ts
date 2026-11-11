import { describe, expect, it } from 'vitest';
import { resolveRenderProvider } from '../render/providers';
import { agentKeyVar, appAgentClient, INCEPTION_URL, inceptionAgent, openRouterAgent, resolveInceptionAgent, AGENT_MAX_TOKENS } from './provider';
import type { AgentContext } from './types';

/**
 * The agent model's providers: OpenRouter, and Inception's own OpenAI-compatible API. No test reaches
 * a model: each request goes to a fetch written here, which checks what it was sent and answers as an
 * OpenAI-compatible API does.
 */

const KEY = 'sk-test-not-a-real-key';

const ctx: AgentContext = {
  facts: { name: 'Example Service Desk', voice: 'Warm and brief.', says: ['The desk answers requests.'], background: [], fixed: {} },
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

const answer = { reply: 'Thursday works. Morning or afternoon?', values: [{ field: 'day', value: '2026-11-12', words: 'Thursday' }], action: 'none', fromFacts: false };

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

/** A fetch that records what it was sent and answers with `content` as the assistant's message. */
function fakeFetch(content: unknown, opts: { status?: number; error?: unknown; usage?: Record<string, unknown> } = {}): { fetchFn: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    if (opts.status !== undefined && opts.status !== 200) return new Response(JSON.stringify({ error: opts.error ?? { message: 'bad' } }), { status: opts.status });
    return new Response(JSON.stringify({ model: 'mercury-3', choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1200, completion_tokens: 80, ...opts.usage } }), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, sent };
}

const openRouter = () => resolveRenderProvider({ RENDER_PROVIDER: 'openrouter', RENDER_MODEL: 'inception/mercury-3', OPENROUTER_API_KEY: KEY })!;

describe('openRouterAgent', () => {
  it('a valid body is ok, with its usage and its text', async () => {
    const { fetchFn } = fakeFetch(answer, { usage: { cost: 0.00042 } });
    const r = await openRouterAgent(openRouter(), fetchFn).answer(ctx, 5000);
    expect(r).toMatchObject({ ok: true, answer, usage: { inputTokens: 1200, outputTokens: 80 }, costUsd: 0.00042, raw: JSON.stringify(answer) });
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it('a body that is not the schema is invalid', async () => {
    const { fetchFn } = fakeFetch({ ...answer, action: 'book' });
    const r = await openRouterAgent(openRouter(), fetchFn).answer(ctx, 5000);
    expect(r).toMatchObject({ ok: false, reason: 'invalid' });
    const prose = await openRouterAgent(openRouter(), fakeFeed('Sure, Thursday works!')).answer(ctx, 5000);
    expect(prose).toMatchObject({ ok: false, reason: 'invalid', raw: 'Sure, Thursday works!' });
  });

  it('an abort at the budget is timeout', async () => {
    const hanging = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })) as unknown as typeof fetch;
    const r = await openRouterAgent(openRouter(), hanging).answer(ctx, 20);
    expect(r).toMatchObject({ ok: false, reason: 'timeout' });
    expect(r.ms).toBeGreaterThanOrEqual(15);
  });

  it('an API error is error, its message kept without the key', async () => {
    const { fetchFn } = fakeFetch(null, { status: 401, error: { code: 401, message: `invalid key ${KEY}` } });
    const r = await openRouterAgent(openRouter(), fetchFn).answer(ctx, 5000);
    expect(r).toMatchObject({ ok: false, reason: 'error' });
    expect(!r.ok && r.detail).toContain('HTTP 401');
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('the request names json_schema strict, temperature 0.6 and the model', async () => {
    const { fetchFn, sent } = fakeFetch(answer);
    await openRouterAgent(openRouter(), fetchFn).answer(ctx, 5000);
    const [req] = sent;
    expect(req!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(req!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req!.body).toMatchObject({ model: 'inception/mercury-3', temperature: 0.6, provider: { require_parameters: true }, usage: { include: true }, response_format: { type: 'json_schema', json_schema: { name: 'agent_answer', strict: true } } });
    const schema = (req!.body.response_format as { json_schema: { schema: { properties: { action: { enum: string[] } } } } }).json_schema.schema;
    expect(schema.properties.action.enum).toEqual(['submit', 'none']);
    const messages = req!.body.messages as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[1]!.content).toContain('Thursday please.');
  });

  it('sends no reasoning setting where none is given, and the one given where it is', async () => {
    const plain = fakeFetch(answer);
    await openRouterAgent(openRouter(), plain.fetchFn).answer(ctx, 5000);
    expect(plain.sent[0]!.body).not.toHaveProperty('reasoning');
    const low = fakeFetch(answer);
    const p = resolveRenderProvider({ RENDER_PROVIDER: 'openrouter', RENDER_MODEL: 'vendor/always-reasons', RENDER_EFFORT: 'low', OPENROUTER_API_KEY: KEY })!;
    await openRouterAgent(p, low.fetchFn).answer(ctx, 5000);
    expect(low.sent[0]!.body).toMatchObject({ reasoning: { effort: 'low', exclude: true }, max_tokens: 4000 });
  });

  it('a timeout while the body is read is timeout', async () => {
    const slowBody = ((_url: string, init?: RequestInit) => Promise.resolve({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    })) as unknown as typeof fetch;
    expect(await openRouterAgent(openRouter(), slowBody).answer(ctx, 20)).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('an answer cut off at the token limit is invalid, whatever it parses to', async () => {
    const cut = (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 1000 } }), { status: 200 })) as unknown as typeof fetch;
    const r = await openRouterAgent(openRouter(), cut).answer(ctx, 5000);
    expect(r).toMatchObject({ ok: false, reason: 'invalid', usage: { outputTokens: 1000 }, cutOff: true });
    expect(!r.ok && r.detail).toContain('cut off');
  });

  it('a network failure is error, naming its kind and never the request', async () => {
    const down = (async () => {
      throw Object.assign(new Error(`connect ECONNREFUSED with Bearer ${KEY}`), { name: 'TypeError' });
    }) as unknown as typeof fetch;
    const r = await openRouterAgent(openRouter(), down).answer(ctx, 5000);
    expect(r).toMatchObject({ ok: false, reason: 'error', detail: 'openrouter: TypeError' });
  });

  it('a gateway timeout (HTTP 504) is timeout', async () => {
    const { fetchFn } = fakeFetch(null, { status: 504, error: { message: 'upstream timed out' } });
    expect(await openRouterAgent(openRouter(), fetchFn).answer(ctx, 5000)).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('a turn that cannot be put into a request is error, never a throw', async () => {
    const { fetchFn, sent } = fakeFetch(answer);
    const r = await openRouterAgent(openRouter(), fetchFn).answer({ ...ctx, seen: [{ tool: 'lookup', result: { n: 1n } }] }, 5000);
    expect(r).toMatchObject({ ok: false, reason: 'error' });
    expect(sent).toHaveLength(0);
  });

  it('never makes a client without its key', () => {
    const p = resolveRenderProvider({ RENDER_PROVIDER: 'openrouter', RENDER_MODEL: 'inception/mercury-3' }, { needKey: false })!;
    expect(() => openRouterAgent(p)).toThrow('OPENROUTER_API_KEY');
  });
});

/** A fetch whose assistant message is `text` as it is. */
function fakeFeed(text: string): typeof fetch {
  return fakeFetch(text).fetchFn;
}

describe('inceptionAgent', () => {
  it('inceptionAgent sends reasoning_effort and realtime, and reads INCEPTION_API_KEY', async () => {
    const { fetchFn, sent } = fakeFetch(answer);
    const client = resolveInceptionAgent({ INCEPTION_API_KEY: KEY }, { model: 'mercury-3', effort: 'instant', realtime: true }, fetchFn);
    const r = await client.answer(ctx, 5000);
    expect(r).toMatchObject({ ok: true, answer });
    const [req] = sent;
    expect(req!.url).toBe(INCEPTION_URL);
    expect(INCEPTION_URL).toBe('https://api.inceptionlabs.ai/v1/chat/completions');
    expect(req!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req!.body).toMatchObject({ model: 'mercury-3', reasoning_effort: 'instant', realtime: true, temperature: 0.6, response_format: { type: 'json_schema', json_schema: { name: 'agent_answer', strict: true } } });
    // The answer is capped (call 38): sized from the largest valid answer recorded (302 tokens), a third more.
    expect(req!.body).toMatchObject({ max_tokens: AGENT_MAX_TOKENS });
    expect(AGENT_MAX_TOKENS).toBe(400);
    expect(req!.body).not.toHaveProperty('reasoning');
  });

  it('leaves out what is not asked for: no effort, no realtime', async () => {
    const { fetchFn, sent } = fakeFetch(answer);
    await inceptionAgent({ model: 'mercury-3', apiKey: KEY, realtime: false }, fetchFn).answer(ctx, 5000);
    expect(sent[0]!.body).not.toHaveProperty('reasoning_effort');
    expect(sent[0]!.body).not.toHaveProperty('realtime');
  });

  it('names the variable a missing key is read from, never a key', () => {
    expect(() => resolveInceptionAgent({}, { model: 'mercury-3', realtime: false })).toThrow('missing required environment variable INCEPTION_API_KEY');
    expect(() => inceptionAgent({ model: 'mercury-3', apiKey: null, realtime: false })).toThrow('INCEPTION_API_KEY');
  });
});

describe('an app\'s agent client (style.yaml\'s agent)', () => {
  it('on Inception: its model and effort, realtime, its key from INCEPTION_API_KEY', async () => {
    const { fetchFn, sent } = fakeFetch(answer);
    await appAgentClient({ INCEPTION_API_KEY: KEY }, { provider: 'inception', model: 'mercury-3', effort: 'instant' }, fetchFn).answer(ctx, 5000);
    expect(sent[0]!.url).toBe(INCEPTION_URL);
    expect(sent[0]!.body).toMatchObject({ model: 'mercury-3', reasoning_effort: 'instant', realtime: true });
    expect(agentKeyVar({ provider: 'inception' })).toBe('INCEPTION_API_KEY');
  });

  it('on OpenRouter: its model, no reasoning setting at instant, its key from OPENROUTER_API_KEY', async () => {
    const { fetchFn, sent } = fakeFetch(answer);
    await appAgentClient({ OPENROUTER_API_KEY: KEY }, { provider: 'openrouter', model: 'vendor/model', effort: 'instant' }, fetchFn).answer(ctx, 5000);
    expect(sent[0]!.body).toMatchObject({ model: 'vendor/model' });
    expect(sent[0]!.body).not.toHaveProperty('reasoning');
    expect(agentKeyVar({ provider: 'openrouter' })).toBe('OPENROUTER_API_KEY');
    expect(() => appAgentClient({}, { provider: 'openrouter', model: 'vendor/model', effort: 'low' })).toThrow('OPENROUTER_API_KEY');
  });
});
