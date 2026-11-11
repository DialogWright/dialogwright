import { describe, expect, it } from 'vitest';
import { anthropicModel } from './anthropic';
import { collect, sse, sseResponse, stubFetch } from './testStream';
import type { ModelRequest } from './types';

const KEY = 'sk-ant-test-key-1234567890abcdef';
const req: ModelRequest = {
  system: 'You take bookings.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Friday please' }] },
    { role: 'assistant', content: [{ type: 'tool_call', id: 't0', name: 'look', args: {} }] },
    { role: 'user', content: [{ type: 'tool_result', id: 't0', content: 'free', isError: false }] },
  ],
  tools: [{ name: 'book', description: 'Book a day', parameters: { type: 'object', properties: { day: { type: 'string' } } } }],
  maxTokens: 300,
};
const ctl = () => new AbortController().signal;

const stream = () =>
  sseResponse([
    sse({ type: 'message_start', message: { usage: { input_tokens: 40, output_tokens: 1 } } }, 'message_start'),
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Booking ' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'that.' } }),
    sse({ type: 'content_block_stop', index: 0 }),
    sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'book', input: {} } }),
    sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"day":' } }),
    sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"2026-11-13"}' } }),
    sse({ type: 'content_block_stop', index: 1 }),
    sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 22 } }),
    sse({ type: 'message_stop' }),
  ]);

describe('anthropicModel', () => {
  it('streams text then a tool call then done', async () => {
    const f = stubFetch(stream);
    const events = await collect(anthropicModel({ model: 'claude-haiku-5-5', apiKey: KEY, fetch: f.fetch }).stream(req, ctl()));
    expect(events).toEqual([
      { type: 'text', delta: 'Booking ' },
      { type: 'text', delta: 'that.' },
      { type: 'tool_call', id: 'tu_1', name: 'book', args: { day: '2026-11-13' } },
      { type: 'done', stop: 'tool', usage: { inputTokens: 40, outputTokens: 22 } },
    ]);
  });
  it('sends stream, the key and version headers, tools as input_schema and tool results as blocks', async () => {
    const f = stubFetch(stream);
    await collect(anthropicModel({ model: 'claude-haiku-5-5', apiKey: KEY, fetch: f.fetch }).stream(req, ctl()));
    const { url, init } = f.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const h = init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe(KEY);
    expect(h['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(String(init.body));
    expect(body.stream).toBe(true);
    expect(body.temperature).toBeUndefined();
    expect(body.tools).toEqual([{ name: 'book', description: 'Book a day', input_schema: req.tools[0]!.parameters }]);
    expect(body.messages[1].content[0]).toEqual({ type: 'tool_use', id: 't0', name: 'look', input: {} });
    expect(body.messages[2].content[0]).toEqual({ type: 'tool_result', tool_use_id: 't0', content: 'free' });
    expect(String(init.body)).not.toContain(KEY);
  });
  it('maps a content-filter 400 to filtered, other failures to http, never with the key', async () => {
    const f = stubFetch(() => new Response(JSON.stringify({ error: { type: 'content_filter', message: `blocked ${KEY}` } }), { status: 400 }));
    const events = await collect(anthropicModel({ model: 'm', apiKey: KEY, fetch: f.fetch }).stream(req, ctl()));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', kind: 'filtered' });
    expect(JSON.stringify(events)).not.toContain(KEY);
    const g = stubFetch(() => new Response('nope', { status: 500 }));
    expect(await collect(anthropicModel({ model: 'm', apiKey: KEY, fetch: g.fetch }).stream(req, ctl()))).toEqual([{ type: 'error', kind: 'http', detail: 'HTTP 500' }]);
  });
  it('maps an abort to timeout', async () => {
    const ac = new AbortController();
    const fetchImpl = (async (_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    const p = collect(anthropicModel({ model: 'm', apiKey: KEY, fetch: fetchImpl }).stream(req, ac.signal));
    ac.abort();
    expect(await p).toEqual([{ type: 'error', kind: 'timeout', detail: 'the request was aborted' }]);
  });
  it('reports a stream that ends early as invalid', async () => {
    const f = stubFetch(() => sseResponse([sse({ type: 'message_start', message: { usage: { input_tokens: 1 } } })]));
    expect(await collect(anthropicModel({ model: 'm', apiKey: KEY, fetch: f.fetch }).stream(req, ctl()))).toMatchObject([{ type: 'error', kind: 'invalid' }]);
  });

  it('sends the effort as output_config.effort (minimal, which the Messages API does not have, as low), and none where the request names none', async () => {
    const f = stubFetch(stream);
    await collect(anthropicModel({ model: 'claude-haiku-5-5', apiKey: KEY, fetch: f.fetch }).stream({ ...req, effort: 'minimal' }, ctl()));
    await collect(anthropicModel({ model: 'claude-haiku-5-5', apiKey: KEY, fetch: f.fetch }).stream({ ...req, effort: 'medium' }, ctl()));
    await collect(anthropicModel({ model: 'claude-haiku-5-5', apiKey: KEY, fetch: f.fetch }).stream(req, ctl()));
    const bodies = f.calls.map((c) => JSON.parse(String(c.init.body)) as Record<string, unknown>);
    expect(bodies.map((b) => b.output_config)).toEqual([{ effort: 'low' }, { effort: 'medium' }, undefined]);
    expect(String(f.calls[0]!.init.body)).not.toContain('reasoning');
  });
});
