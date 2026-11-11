import { describe, expect, it } from 'vitest';
import { openAiCompatModel } from './openaiCompat';
import { collect, sse, sseResponse, stubFetch } from './testStream';
import type { ModelRequest } from './types';

const KEY = 'inc_test_key_value_1234567890';
const req: ModelRequest = {
  system: 'sys',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_call', id: 'c0', name: 'look', args: { a: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', id: 'c0', content: 'free' }] },
  ],
  tools: [{ name: 'book', description: 'Book', parameters: { type: 'object' } }],
  maxTokens: 200,
};
const ctl = () => new AbortController().signal;
const chunk = (delta: unknown, finish: string | null = null, extra: object = {}) => sse({ choices: [{ delta, finish_reason: finish }], ...extra });

const toolStream = () =>
  sseResponse([
    chunk({ content: 'One ' }),
    chunk({ content: 'moment.' }),
    chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'book', arguments: '{"day":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"2026-11-13"}' } }] }),
    chunk({}, 'tool_calls'),
    sse({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 12 } }),
    sse('[DONE]'),
  ]);

describe('openAiCompatModel', () => {
  it('joins tool-call argument fragments into one tool_call and maps tool_calls to stop tool', async () => {
    const f = stubFetch(toolStream);
    const m = openAiCompatModel({ provider: 'inception', model: 'mercury-3', apiKey: KEY, fetch: f.fetch });
    expect(m.id).toBe('inception:mercury-3');
    expect(await collect(m.stream(req, ctl()))).toEqual([
      { type: 'text', delta: 'One ' },
      { type: 'text', delta: 'moment.' },
      { type: 'tool_call', id: 'call_1', name: 'book', args: { day: '2026-11-13' } },
      { type: 'done', stop: 'tool', usage: { inputTokens: 30, outputTokens: 12 } },
    ]);
  });
  it('sends a bearer key, tools as functions, tool results as tool messages, and temperature only when set', async () => {
    const f = stubFetch(toolStream);
    const m = openAiCompatModel({ provider: 'openrouter', model: 'vendor/model', apiKey: KEY, fetch: f.fetch });
    await collect(m.stream(req, ctl()));
    await collect(m.stream({ ...req, temperature: 0.6 }, ctl()));
    expect(f.calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const a = JSON.parse(String(f.calls[0]!.init.body));
    const b = JSON.parse(String(f.calls[1]!.init.body));
    expect(a.stream).toBe(true);
    expect(a.temperature).toBeUndefined();
    expect(b.temperature).toBe(0.6);
    expect(a.tools[0]).toEqual({ type: 'function', function: { name: 'book', description: 'Book', parameters: { type: 'object' } } });
    expect(a.messages[2]).toEqual({ role: 'assistant', content: 'checking', tool_calls: [{ id: 'c0', type: 'function', function: { name: 'look', arguments: '{"a":1}' } }] });
    expect(a.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c0', content: 'free' });
    expect(String(f.calls[0]!.init.body)).not.toContain(KEY);
  });
  it('sends the reasoning effort in each provider\'s form: Inception\'s reasoning_effort (minimal is its instant), OpenRouter\'s reasoning.effort; none where the request names none', async () => {
    const f = stubFetch(toolStream);
    await collect(openAiCompatModel({ provider: 'inception', model: 'mercury-3', apiKey: KEY, fetch: f.fetch }).stream({ ...req, effort: 'minimal' }, ctl()));
    await collect(openAiCompatModel({ provider: 'inception', model: 'mercury-3', apiKey: KEY, fetch: f.fetch }).stream({ ...req, effort: 'low' }, ctl()));
    await collect(openAiCompatModel({ provider: 'openrouter', model: 'vendor/model', apiKey: KEY, fetch: f.fetch }).stream({ ...req, effort: 'minimal' }, ctl()));
    await collect(openAiCompatModel({ provider: 'inception', model: 'mercury-3', apiKey: KEY, fetch: f.fetch }).stream(req, ctl()));
    const bodies = f.calls.map((c) => JSON.parse(String(c.init.body)) as Record<string, unknown>);
    expect(bodies.map((b) => [b.reasoning_effort, b.reasoning])).toEqual([['instant', undefined], ['low', undefined], [undefined, { effort: 'minimal' }], [undefined, undefined]]);
  });
  it('maps a plain stop to end and length to length', async () => {
    const run = async (finish: string) => collect(openAiCompatModel({ provider: 'inception', model: 'm', apiKey: KEY, fetch: stubFetch(() => sseResponse([chunk({ content: 'x' }, finish), sse('[DONE]')])).fetch }).stream(req, ctl()));
    expect((await run('stop')).at(-1)).toMatchObject({ type: 'done', stop: 'end' });
    expect((await run('length')).at(-1)).toMatchObject({ type: 'done', stop: 'length' });
  });
  it('maps content_filter, and Inception\'s content_filter_error, to filtered', async () => {
    const a = await collect(openAiCompatModel({ provider: 'inception', model: 'm', apiKey: KEY, fetch: stubFetch(() => sseResponse([chunk({ content: 'x' }, 'content_filter'), sse('[DONE]')])).fetch }).stream(req, ctl()));
    expect(a.at(-1)).toMatchObject({ type: 'error', kind: 'filtered' });
    const b = await collect(openAiCompatModel({ provider: 'inception', model: 'm', apiKey: KEY, fetch: stubFetch(() => new Response(JSON.stringify({ error: { type: 'content_filter_error', message: `no ${KEY}` } }), { status: 400 })).fetch }).stream(req, ctl()));
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ type: 'error', kind: 'filtered' });
    expect(JSON.stringify(b)).not.toContain(KEY);
  });
  it('gives invalid for unparseable tool arguments', async () => {
    const f = stubFetch(() => sseResponse([chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'book', arguments: '{"day":' } }] }, 'tool_calls'), sse('[DONE]')]));
    expect(await collect(openAiCompatModel({ provider: 'inception', model: 'm', apiKey: KEY, fetch: f.fetch }).stream(req, ctl()))).toMatchObject([{ type: 'error', kind: 'invalid' }]);
  });
  it('maps an abort to timeout', async () => {
    const ac = new AbortController();
    const fetchImpl = (async (_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    const p = collect(openAiCompatModel({ provider: 'inception', model: 'm', apiKey: KEY, fetch: fetchImpl }).stream(req, ac.signal));
    ac.abort();
    expect(await p).toMatchObject([{ type: 'error', kind: 'timeout' }]);
  });
  it('reports stop tool when tool calls were emitted, whatever the finish reason, and gives an id-less call one', async () => {
    const f = stubFetch(() => sseResponse([chunk({ tool_calls: [{ index: 0, function: { name: 'book', arguments: '{}' } }] }, 'stop'), sse('[DONE]')]));
    expect(await collect(openAiCompatModel({ provider: 'inception', model: 'm', apiKey: KEY, fetch: f.fetch }).stream(req, ctl()))).toMatchObject([
      { type: 'tool_call', id: 'call_1', name: 'book', args: {} },
      { type: 'done', stop: 'tool' },
    ]);
  });
});
