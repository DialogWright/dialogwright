import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RenderCassette, loadRenderCassette, renderCassettePath } from './cassette';
import { FakeRenderClient } from './fake';
import { RENDER_INSTRUCTIONS, renderKey } from './prompt';
import { ModelRenderClient, renderLines, renderSettings, resolveRenderProvider } from './providers';
import { RenderClientError, type RenderRequest, type SpeechAct } from './types';

/**
 * The render providers (OpenRouter and Anthropic, with the author's own key from its own variable),
 * their settings, and the render cassette. No test reaches a model: each request goes to a fetch
 * written here, which checks what it was sent and answers as the provider documents.
 */

const KEY = 'sk-test-not-a-real-key';
const act: SpeechAct = {
  act: 'ask', goal: 'Ask for the caller\'s name.', fixed: 'And who is the message from?', asks: true, items: [],
  frustration: 'none', situations: ['first-ask'], channel: 'voice', language: 'en-US', style: { persona: 'a calm agent', words: 25, avoid: [] },
};
const req: RenderRequest = { promptId: 'ask_caller', act, key: renderKey('ask_caller', act) };
const signal = new AbortController().signal;

describe('resolveRenderProvider', () => {
  it('is null with RENDER_PROVIDER unset: no line is generated', () => {
    expect(resolveRenderProvider({})).toBeNull();
  });

  it('reads each provider\'s key from its own variable, with a current Claude Haiku by default', () => {
    expect(resolveRenderProvider({ RENDER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY })).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5', keyVar: 'ANTHROPIC_API_KEY', apiKey: KEY });
    expect(resolveRenderProvider({ RENDER_PROVIDER: 'openrouter', OPENROUTER_API_KEY: KEY, RENDER_MODEL: 'vendor/small' })).toMatchObject({ provider: 'openrouter', model: 'vendor/small', keyVar: 'OPENROUTER_API_KEY' });
  });

  it('names the variable a missing key is read from, never a key; a replay needs none', () => {
    expect(() => resolveRenderProvider({ RENDER_PROVIDER: 'anthropic' })).toThrow('missing required environment variable ANTHROPIC_API_KEY (RENDER_PROVIDER=anthropic)');
    expect(resolveRenderProvider({ RENDER_PROVIDER: 'anthropic' }, { needKey: false })!.apiKey).toBeNull();
    expect(() => resolveRenderProvider({ RENDER_PROVIDER: 'openai' })).toThrow('RENDER_PROVIDER must be openrouter or anthropic, got "openai"');
  });
});

describe('renderSettings', () => {
  it('defaults: every call generated, 700 ms on a call and 1500 in a chat, the default model\'s price', () => {
    expect(renderSettings({})).toEqual({ share: 100, timeoutMs: { voice: 700, chat: 1500 }, price: { input: 0.1, output: 0.5 } });
  });

  it('RENDER_SHARE, RENDER_TIMEOUT_MS (both channels) and the price, each checked', () => {
    expect(renderSettings({ RENDER_SHARE: '50', RENDER_TIMEOUT_MS: '900', RENDER_PRICE_INPUT_PER_MTOK: '1', RENDER_PRICE_OUTPUT_PER_MTOK: '5' })).toEqual({ share: 50, timeoutMs: { voice: 900, chat: 900 }, price: { input: 1, output: 5 } });
    expect(() => renderSettings({ RENDER_SHARE: '150' })).toThrow('RENDER_SHARE must be a whole number from 0 to 100, got "150"');
    expect(() => renderSettings({ RENDER_TIMEOUT_MS: 'fast' })).toThrow('RENDER_TIMEOUT_MS');
    expect(() => renderSettings({ RENDER_PRICE_INPUT_PER_MTOK: '-1' })).toThrow('RENDER_PRICE_INPUT_PER_MTOK');
  });
});

describe('ModelRenderClient', () => {
  const sent: { url: string; init: RequestInit }[] = [];
  const answering = (status: number, body: unknown): typeof fetch => (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init! });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;

  it('Anthropic: the Messages API, the key in x-api-key, the instructions as the system prompt and the act as JSON, thinking off', async () => {
    sent.length = 0;
    const p = resolveRenderProvider({ RENDER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY })!;
    const client = new ModelRenderClient(p, answering(200, { model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'And your name?' }], usage: { input_tokens: 300, output_tokens: 5 }, stop_reason: 'end_turn' }));
    const g = await client.generate(req, signal);
    expect(g).toMatchObject({ text: 'And your name?', model: 'claude-haiku-5-5', usage: { inputTokens: 300, outputTokens: 5 }, source: 'model' });
    expect(sent[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect((sent[0]!.init.headers as Record<string, string>)['x-api-key']).toBe(KEY);
    const body = JSON.parse(String(sent[0]!.init.body));
    expect(body).toMatchObject({ model: 'claude-haiku-5-5', system: RENDER_INSTRUCTIONS, thinking: { type: 'disabled' } });
    expect(JSON.parse(body.messages[0].content)).toEqual(JSON.parse(JSON.stringify(act)));
    // The prompt id is never sent.
    expect(String(sent[0]!.init.body)).not.toContain('ask_caller');
  });

  it('OpenRouter: chat completions, the key as a bearer token, the instructions as the system message', async () => {
    sent.length = 0;
    const p = resolveRenderProvider({ RENDER_PROVIDER: 'openrouter', OPENROUTER_API_KEY: KEY })!;
    const client = new ModelRenderClient(p, answering(200, { model: 'anthropic/claude-haiku-5.5', choices: [{ message: { content: 'Who is it from?' } }], usage: { prompt_tokens: 280, completion_tokens: 4 } }));
    expect(await client.generate(req, signal)).toMatchObject({ text: 'Who is it from?', usage: { inputTokens: 280, outputTokens: 4 } });
    expect(sent[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(sent[0]!.init.body)).messages[0]).toEqual({ role: 'system', content: RENDER_INSTRUCTIONS });
  });

  it('a failed request, a refusal or an answer with no line rejects with an error that names no key', async () => {
    const p = resolveRenderProvider({ RENDER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY })!;
    const fails = async (f: typeof fetch): Promise<string> => {
      const e = await new ModelRenderClient(p, f).generate(req, signal).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RenderClientError);
      expect(String((e as Error).message)).not.toContain(KEY);
      return (e as Error).message;
    };
    expect(await fails(answering(401, { error: 'bad key' }))).toBe('anthropic: HTTP 401');
    expect(await fails(answering(200, { content: [], stop_reason: 'refusal' }))).toBe('anthropic: the answer had no line');
    expect(await fails((async () => { throw new TypeError(`fetch failed with ${KEY}`); }) as typeof fetch)).toBe('anthropic: TypeError');
  });

  it('says which model, from where, never the key', () => {
    const p = resolveRenderProvider({ RENDER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY })!;
    expect(renderLines(p)).toEqual(['generated lines worded by claude-haiku-5-5 from anthropic']);
    expect(renderLines(p, { replayed: true }).join(' ')).not.toContain(KEY);
  });
});

describe('the render cassette', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-cassette-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('records what the inner client gave, by key, and replays it; a miss rejects as a cassette miss', async () => {
    const path = renderCassettePath(dir, 'vendor/small');
    expect(path).toBe(join(dir, 'render', 'vendor__small.jsonl'));
    const recording = new RenderCassette({ path, mode: 'record', model: 'vendor/small', inner: new FakeRenderClient({ say: { ask_caller: 'Who is it from?' } }), now: () => 0 });
    expect((await recording.generate(req, signal)).text).toBe('Who is it from?');
    const line = JSON.parse(readFileSync(path, 'utf8').trim());
    expect(line).toMatchObject({ v: 1, key: req.key, promptId: 'ask_caller', text: 'Who is it from?', recordedAt: '1970-01-01T00:00:00.000Z' });
    const replay = new RenderCassette({ path, mode: 'replay', model: 'vendor/small' });
    expect(await replay.generate(req, signal)).toMatchObject({ text: 'Who is it from?', source: 'recorded' });
    const other = { ...req, key: renderKey('ask_caller', { ...act, heard: 'hello' }) };
    const miss = await replay.generate(other, signal).catch((e: unknown) => e);
    expect(miss).toBeInstanceOf(RenderClientError);
    expect((miss as RenderClientError).kind).toBe('cassette-miss');
    expect(loadRenderCassette(path).size).toBe(1);
  });

  it('a line\'s key changes with anything in its act', () => {
    expect(renderKey('ask_caller', act)).not.toBe(renderKey('ask_caller', { ...act, frustration: 'some' }));
    expect(renderKey('ask_caller', act)).not.toBe(renderKey('ask_phone', act));
  });
});
