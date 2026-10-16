import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RenderCassette, loadRenderCassette, renderCassettePath } from './cassette';
import { FakeRenderClient } from './fake';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../jev/cassette';
import { instructionsOf, RENDER_INSTRUCTIONS, RENDER_INSTRUCTIONS_NO_ACKNOWLEDGEMENT, renderKey, SPAN_INSTRUCTIONS, spanKey } from './prompt';
import { appModelKeyMissing, ModelRenderClient, renderCassetteModel, renderEnvOf, renderLines, renderModelSource, renderSettings, resolveAppRenderProvider, resolveRenderProvider } from './providers';
import { RenderClientError, type RenderRequest, type SpanAct, type SpeechAct } from './types';

/** A span's sentence, as a call sends one (SpanAct.sentence): the frame's own words, the span a gap. */
const SENTENCE = "I'll make sure {recipient} gets your message from {caller}: ____. Shall I pass it on?";

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

describe('the model an app names (style.yaml\'s model, live findings item 27)', () => {
  const GEMINI = { provider: 'openrouter' as const, id: 'google/gemini-3.1-flash-lite-preview' };

  it('is the default under the environment: unset, the app\'s; the environment over it', () => {
    // No model named: the environment alone, as before.
    const env = { RENDER_PROVIDER: 'anthropic' };
    expect(renderEnvOf(env, undefined)).toBe(env);
    expect(resolveAppRenderProvider({}, undefined)).toBeNull();
    // Named, with nothing set: the app's provider and model, the key from the environment.
    expect(resolveAppRenderProvider({ OPENROUTER_API_KEY: 'or-test' }, GEMINI)).toMatchObject({ provider: 'openrouter', model: GEMINI.id, keyVar: 'OPENROUTER_API_KEY' });
    // The provider's default model where the app names none.
    expect(resolveAppRenderProvider({ ANTHROPIC_API_KEY: 'k' }, { provider: 'anthropic' })).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5' });
    // RENDER_MODEL names the model only with RENDER_PROVIDER: the app's provider keeps the app's id
    // unless RENDER_MODEL is set beside it.
    expect(resolveAppRenderProvider({ OPENROUTER_API_KEY: 'k', RENDER_PROVIDER: 'openrouter', RENDER_MODEL: 'vendor/other' }, GEMINI)!.model).toBe('vendor/other');
    expect(resolveAppRenderProvider({ OPENROUTER_API_KEY: 'k', RENDER_PROVIDER: 'openrouter' }, GEMINI)!.model).toBe(GEMINI.id);
    // A stray RENDER_MODEL, left from another provider with no RENDER_PROVIDER, never reaches the app's provider.
    expect(resolveAppRenderProvider({ OPENROUTER_API_KEY: 'k', RENDER_MODEL: 'claude-sonnet-5-5' }, GEMINI)!.model).toBe(GEMINI.id);
    expect(resolveAppRenderProvider({ ANTHROPIC_API_KEY: 'k', RENDER_MODEL: 'vendor/other' }, { provider: 'anthropic' })!.model).toBe('claude-haiku-5-5');
    // RENDER_PROVIDER naming another provider takes it, with its own default model: the app's id is not that provider's.
    expect(resolveAppRenderProvider({ ANTHROPIC_API_KEY: 'k', RENDER_PROVIDER: 'anthropic' }, GEMINI)).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5' });
    expect(renderEnvOf({ RENDER_PROVIDER: 'anthropic' }, GEMINI)).toEqual({ RENDER_PROVIDER: 'anthropic' });
    // ... and RENDER_MODEL with it names that provider's model.
    expect(resolveAppRenderProvider({ ANTHROPIC_API_KEY: 'k', RENDER_PROVIDER: 'anthropic', RENDER_MODEL: 'claude-sonnet-5-5' }, GEMINI)).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
  });

  it('says where the model came from: style.yaml, or the environment over it or alone', () => {
    expect(renderModelSource({}, GEMINI)).toBe('style.yaml');
    expect(renderModelSource({ RENDER_MODEL: 'vendor/stray' }, GEMINI)).toBe('style.yaml');
    expect(renderModelSource({ RENDER_PROVIDER: 'openrouter' }, GEMINI)).toBe('style.yaml');
    expect(renderModelSource({ RENDER_PROVIDER: 'openrouter', RENDER_MODEL: 'vendor/other' }, GEMINI)).toBe('environment');
    expect(renderModelSource({ RENDER_PROVIDER: 'anthropic' }, GEMINI)).toBe('environment');
    expect(renderModelSource({ RENDER_PROVIDER: 'anthropic' }, undefined)).toBe('environment');
    expect(renderModelSource({}, undefined)).toBeNull();
  });

  it('a key only from the environment: missing, it is named with style.yaml, never a RENDER_PROVIDER that was not set', () => {
    expect(appModelKeyMissing({}, GEMINI)).toBe('OPENROUTER_API_KEY');
    expect(appModelKeyMissing({ OPENROUTER_API_KEY: 'k' }, GEMINI)).toBeNull();
    // The environment chose (RENDER_PROVIDER set, the app's provider or another): a missing key refuses, as it always has.
    expect(appModelKeyMissing({ RENDER_PROVIDER: 'anthropic' }, GEMINI)).toBeNull();
    expect(appModelKeyMissing({ RENDER_PROVIDER: 'openrouter' }, GEMINI)).toBeNull();
    expect(() => resolveAppRenderProvider({ RENDER_PROVIDER: 'openrouter' }, GEMINI)).toThrow('missing required environment variable OPENROUTER_API_KEY (RENDER_PROVIDER=openrouter)');
    expect(() => resolveAppRenderProvider({ RENDER_PROVIDER: 'anthropic' }, GEMINI)).toThrow('missing required environment variable ANTHROPIC_API_KEY (RENDER_PROVIDER=anthropic)');
    expect(appModelKeyMissing({}, undefined)).toBeNull();
    expect(() => resolveAppRenderProvider({}, GEMINI)).toThrow("missing required environment variable OPENROUTER_API_KEY (style.yaml's model, openrouter google/gemini-3.1-flash-lite-preview)");
    // A replay needs none.
    expect(resolveAppRenderProvider({}, GEMINI, { needKey: false })).toMatchObject({ model: GEMINI.id, apiKey: null });
  });
});

describe('renderSettings', () => {
  it('defaults: every call generated, 900 ms on a call and 1500 in a chat, the default model\'s price', () => {
    expect(renderSettings({})).toEqual({ share: 100, timeoutMs: { voice: 900, chat: 1500 }, checkTimeoutMs: { voice: 500, chat: 1000 }, answerTimeoutMs: { voice: 4000, chat: 6000 }, price: { input: 0.1, output: 0.5 } });
  });

  it('RENDER_SHARE, RENDER_TIMEOUT_MS (both channels) and the price, each checked', () => {
    expect(renderSettings({ RENDER_SHARE: '50', RENDER_TIMEOUT_MS: '900', RENDER_CHECK_TIMEOUT_MS: '300', RENDER_PRICE_INPUT_PER_MTOK: '1', RENDER_PRICE_OUTPUT_PER_MTOK: '5' })).toEqual({ share: 50, timeoutMs: { voice: 900, chat: 900 }, checkTimeoutMs: { voice: 300, chat: 300 }, answerTimeoutMs: { voice: 4000, chat: 6000 }, price: { input: 1, output: 5 } });
    expect(() => renderSettings({ RENDER_SHARE: '150' })).toThrow('RENDER_SHARE must be a whole number from 0 to 100, got "150"');
    expect(() => renderSettings({ RENDER_TIMEOUT_MS: 'fast' })).toThrow('RENDER_TIMEOUT_MS');
    expect(() => renderSettings({ RENDER_PRICE_INPUT_PER_MTOK: '-1' })).toThrow('RENDER_PRICE_INPUT_PER_MTOK');
  });

  it('each channel set on its own: changing one never changes the other, and a channel\'s own setting wins over the one for both (the maintainer, 2026-10-14)', () => {
    expect(renderSettings({ RENDER_TIMEOUT_VOICE_MS: '1200' }).timeoutMs).toEqual({ voice: 1200, chat: 1500 });
    expect(renderSettings({ RENDER_TIMEOUT_CHAT_MS: '2000' }).timeoutMs).toEqual({ voice: 900, chat: 2000 });
    // A knowledge answer's limit, each channel on its own, both at once, and refused out of bounds.
    expect(renderSettings({ RENDER_ANSWER_TIMEOUT_VOICE_MS: '5000' }).answerTimeoutMs).toEqual({ voice: 5000, chat: 6000 });
    expect(renderSettings({ RENDER_ANSWER_TIMEOUT_MS: '3000', RENDER_ANSWER_TIMEOUT_CHAT_MS: '8000' }).answerTimeoutMs).toEqual({ voice: 3000, chat: 8000 });
    expect(() => renderSettings({ RENDER_ANSWER_TIMEOUT_MS: 'slow' })).toThrow('RENDER_ANSWER_TIMEOUT_MS');
    expect(renderSettings({ RENDER_TIMEOUT_MS: '15000', RENDER_TIMEOUT_VOICE_MS: '900' }).timeoutMs).toEqual({ voice: 900, chat: 15000 });
    expect(renderSettings({ RENDER_CHECK_TIMEOUT_VOICE_MS: '700' }).checkTimeoutMs).toEqual({ voice: 700, chat: 1000 });
    expect(renderSettings({ RENDER_CHECK_TIMEOUT_MS: '300', RENDER_CHECK_TIMEOUT_CHAT_MS: '800' }).checkTimeoutMs).toEqual({ voice: 300, chat: 800 });
    expect(() => renderSettings({ RENDER_TIMEOUT_VOICE_MS: '10' })).toThrow('RENDER_TIMEOUT_VOICE_MS must be a whole number from 50 to 30000, got "10"');
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
    // Reasoning off, in OpenRouter's documented form.
    expect(JSON.parse(String(sent[0]!.init.body)).reasoning).toEqual({ effort: 'none' });
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
    expect(await fails(answering(200, { content: [], stop_reason: 'refusal' }))).toBe('anthropic: the answer had no line (refusal)');
    expect(await fails(answering(200, { content: [{ type: 'text', text: 'And who is the mess' }], stop_reason: 'max_tokens' }))).toBe('anthropic: the answer had no line (max_tokens)');
    expect(await fails(answering(200, { nothing: true }))).toBe('anthropic: the answer had no line');
    const or = resolveRenderProvider({ RENDER_PROVIDER: 'openrouter', OPENROUTER_API_KEY: KEY })!;
    const cut = await new ModelRenderClient(or, answering(200, { choices: [{ message: { content: 'Who is it' }, finish_reason: 'length' }] })).generate(req, signal).catch((x: unknown) => x);
    expect((cut as Error).message).toBe('openrouter: the answer had no line (length)');
    expect(await fails((async () => { throw new TypeError(`fetch failed with ${KEY}`); }) as typeof fetch)).toBe('anthropic: TypeError');
  });

  it('a request the API refuses says why: the status and the API\'s error type, and its message apart, never the key or the request', async () => {
    const p = resolveRenderProvider({ RENDER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY })!;
    const e = await new ModelRenderClient(p, answering(400, { type: 'error', error: { type: 'invalid_request_error', message: `thinking.type: "disabled" is not supported for this model;\n  key ${KEY} was sent` } })).generate(req, signal).catch((x: unknown) => x) as RenderClientError;
    expect(e).toBeInstanceOf(RenderClientError);
    expect(e.message).toBe('anthropic: HTTP 400 invalid_request_error');
    expect(e.detail).toBe('thinking.type: "disabled" is not supported for this model; key • was sent');
    expect(JSON.stringify([e.message, e.detail])).not.toContain('And who is the message from?');
    const or = resolveRenderProvider({ RENDER_PROVIDER: 'openrouter', OPENROUTER_API_KEY: KEY })!;
    // OpenRouter's code may be the HTTP status again (a number): the status alone; a name is taken as the type. To confirm live.
    const o = await new ModelRenderClient(or, answering(429, { error: { code: 429, message: 'Slow down' } })).generate(req, signal).catch((x: unknown) => x) as RenderClientError;
    expect([o.message, o.detail]).toEqual(['openrouter: HTTP 429', 'Slow down']);
    const named = await new ModelRenderClient(or, answering(400, { error: { code: 'bad_request', message: 'No' } })).generate(req, signal).catch((x: unknown) => x) as RenderClientError;
    expect(named.message).toBe('openrouter: HTTP 400 bad_request');
    // The upstream provider's own error, which OpenRouter passes on in metadata: what says why, made safe the same way.
    // Only the provider's name, its type and code, and its own message when short: never the rest of its payload.
    const upstream = await new ModelRenderClient(or, answering(400, { error: { code: 400, message: 'Provider returned error', metadata: { provider_name: 'Example', raw: `{"error":{"message":"Reasoning is mandatory for this endpoint and cannot be disabled.","key":"${KEY}"}}` } } })).generate(req, signal).catch((x: unknown) => x) as RenderClientError;
    expect(upstream.message).toBe('openrouter: HTTP 400');
    expect(upstream.detail).toBe('Provider returned error (Example: Reasoning is mandatory for this endpoint and cannot be disabled.)');
    const rawOnly = await new ModelRenderClient(or, answering(400, { error: { code: 400, metadata: { raw: 'model not found' } } })).generate(req, signal).catch((x: unknown) => x) as RenderClientError;
    expect(rawOnly.detail).toBe('model not found');
    // A long payload (a decline quoting the caller's words), a moderation's flagged input, another provider's key: none kept.
    const quoted = `The request was declined because it contains: ${'tell her the boiler inspection moved to next Tuesday morning '.repeat(4)}`;
    const declined = await new ModelRenderClient(or, answering(403, { error: { code: 403, message: 'Provider returned error', metadata: { provider_name: 'Example', error_type: 'content_filter', provider_code: 'SAFETY', raw: JSON.stringify({ error: { message: quoted } }), flagged_input: 'tell her the boiler inspection', reasons: ['x'] } } })).generate(req, signal).catch((x: unknown) => x) as RenderClientError;
    expect(declined.detail).toBe('Provider returned error (Example: content_filter: SAFETY)');
    const keyed = await new ModelRenderClient(or, answering(401, { error: { code: 401, message: 'Invalid key AIzaSyA1234567890abcdefghijklmnopqrstuv for the upstream' } })).generate(req, signal).catch((x: unknown) => x) as RenderClientError;
    expect(keyed.detail).toBe('Invalid key • for the upstream');
    // A body that is not JSON: the status alone.
    const bare = await new ModelRenderClient(p, (async () => new Response('Bad gateway', { status: 502 })) as typeof fetch).generate(req, signal).catch((x: unknown) => x) as RenderClientError;
    expect([bare.message, bare.detail]).toEqual(['anthropic: HTTP 502', undefined]);
  });

  it('a framed line\'s span: its own instructions and its span act alone, the frame sent only as its sentence (its own words, the span a gap, no value)', async () => {
    sent.length = 0;
    const span: SpanAct = { kind: 'span', sentence: SENTENCE, goal: 'Summarize the message.', content: [{ name: 'message', value: 'call me about the invoice' }], channel: 'voice', language: 'en-US', style: { persona: 'a calm agent', words: 25, avoid: [] } };
    const spanReq: RenderRequest = { promptId: 'confirm_take_message', span: 'summary', act: span, key: spanKey('confirm_take_message', 'summary', span) };
    for (const [provider, keyVar, answer] of [['anthropic', 'ANTHROPIC_API_KEY', { content: [{ type: 'text', text: 'a call about the invoice' }], stop_reason: 'end_turn' }], ['openrouter', 'OPENROUTER_API_KEY', { choices: [{ message: { content: 'a call about the invoice' } }] }]] as const) {
      const p = resolveRenderProvider({ RENDER_PROVIDER: provider, [keyVar]: KEY })!;
      expect((await new ModelRenderClient(p, answering(200, answer)).generate(spanReq, signal)).text).toBe('a call about the invoice');
    }
    const [a, o] = sent.map((x) => JSON.parse(String(x.init.body)));
    expect(a.system).toBe(SPAN_INSTRUCTIONS);
    expect(o.messages[0]).toEqual({ role: 'system', content: SPAN_INSTRUCTIONS });
    expect(JSON.parse(a.messages[0].content)).toEqual(JSON.parse(JSON.stringify(span)));
    expect(String(sent[0]!.init.body)).not.toContain('confirm_take_message');
    // A span's key is its own: never a line's, and it changes with its span and its act.
    expect(spanKey('confirm_take_message', 'summary', span)).not.toBe(spanKey('confirm_take_message', 'gist', span));
    expect(spanKey('confirm_take_message', 'summary', span)).not.toBe(spanKey('confirm_take_message', 'summary', { ...span, goal: 'Sum it up.' }));
    expect(spanKey('confirm_take_message', 'summary', span)).not.toBe(spanKey('confirm_take_message', 'summary', { ...span, sentence: 'Here is your message: ____.' }));
  });

  it('a line is told what an acknowledgement may do: show the caller was heard, never what the agent will do, never a name the caller gave as someone else\'s', async () => {
    // The first recording with a real model (live findings, item 18): every fallback was an
    // acknowledgement that promised ("I can take a message for ...") or called the caller by the name
    // they had given as the recipient's. The sentence is sent with every whole line, both providers.
    const sentence = 'An acknowledgement only shows the caller was heard: it never says what the agent can or will do ("I can...", "I\'ll...", "happy to help with..."), and it calls the caller by a name only when "heard" gives that name as their own: a name the caller mentions (who something is for, say) is not theirs.';
    expect(RENDER_INSTRUCTIONS).toContain(sentence);
    // Right after the line's permission to acknowledge, which it bounds.
    expect(RENDER_INSTRUCTIONS).toContain(`be warmer or plainer when they are frustrated ("frustration"). ${sentence} Say every value in "items"`);
    sent.length = 0;
    for (const [provider, keyVar, answer] of [['anthropic', 'ANTHROPIC_API_KEY', { content: [{ type: 'text', text: 'And who is the message from?' }], stop_reason: 'end_turn' }], ['openrouter', 'OPENROUTER_API_KEY', { choices: [{ message: { content: 'And who is the message from?' } }] }]] as const) {
      const p = resolveRenderProvider({ RENDER_PROVIDER: provider, [keyVar]: KEY })!;
      await new ModelRenderClient(p, answering(200, answer)).generate(req, signal);
    }
    const [a, o] = sent.map((x) => JSON.parse(String(x.init.body)));
    expect(a.system).toContain(sentence);
    expect(o.messages[0].content).toContain(sentence);
    // A span acknowledges nothing: item 18 left its instructions as they were. Its key has changed once
    // since, by design: its act carries the sentence it is put into, and its instructions say what to do
    // with it (live findings item 24), so every recorded span re-keys; this pins the key as it now is.
    expect(SPAN_INSTRUCTIONS).not.toContain('An acknowledgement');
    const span: SpanAct = { kind: 'span', sentence: SENTENCE, goal: 'Summarize the message.', content: [{ name: 'message', value: 'call me about the invoice' }], channel: 'voice', language: 'en-US', style: { persona: 'a calm agent', words: 25, avoid: [] } };
    expect(spanKey('confirm_take_message', 'summary', span)).toBe('bf0db369a65a555972f800956425a1a5f201e16620822e0ab4a3cddf0c098603');
  });

  it('says which model, from where, how it thinks, never the key', () => {
    const p = resolveRenderProvider({ RENDER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY })!;
    expect(renderLines(p)).toEqual(['generated lines worded by claude-haiku-5-5 from anthropic (thinking disabled)']);
    expect(renderLines(resolveRenderProvider({ RENDER_PROVIDER: 'openrouter', OPENROUTER_API_KEY: KEY })!)).toEqual(['generated lines worded by anthropic/claude-haiku-5.5 from openrouter']);
    expect(renderLines(p, { replayed: true }).join(' ')).not.toContain(KEY);
  });
});

describe('how an Anthropic model thinks while it words a line', () => {
  const sent: Record<string, unknown>[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'And who is the message from?' }], usage: { input_tokens: 600, output_tokens: 90 }, stop_reason: 'end_turn' }), { status: 200 });
  }) as typeof fetch;
  const bodyFor = async (env: Record<string, string>): Promise<Record<string, unknown>> => {
    sent.length = 0;
    const p = resolveRenderProvider({ RENDER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY, ...env })!;
    const g = await new ModelRenderClient(p, fetchFn).generate(req, signal);
    // The line is the text block alone; the thinking block is never read, its tokens counted in the output.
    expect(g).toMatchObject({ text: 'And who is the message from?', usage: { inputTokens: 600, outputTokens: 90 } });
    const { system: _s, messages: _m, ...rest } = sent[0]!;
    return rest;
  };

  it('each model its own least thinking by default, the table\'s; a model it does not name as before', async () => {
    expect(await bodyFor({})).toEqual({ model: 'claude-haiku-5-5', max_tokens: 200, thinking: { type: 'disabled' } });
    expect(await bodyFor({ RENDER_MODEL: 'claude-sonnet-5-5' })).toEqual({ model: 'claude-sonnet-5-5', max_tokens: 200, thinking: { type: 'between_tools' } });
    // Opus 5.5 cannot stop thinking: no thinking field, the least effort, and room for its thinking.
    expect(await bodyFor({ RENDER_MODEL: 'claude-opus-5-5' })).toEqual({ model: 'claude-opus-5-5', max_tokens: 4000, output_config: { effort: 'low' } });
    expect(await bodyFor({ RENDER_MODEL: 'claude-fable-5-1' })).toEqual({ model: 'claude-fable-5-1', max_tokens: 4000 });
    expect(await bodyFor({ RENDER_MODEL: 'claude-haiku-4-5' })).toEqual({ model: 'claude-haiku-4-5', max_tokens: 200, thinking: { type: 'disabled' } });
  });

  it('RENDER_THINKING and RENDER_EFFORT override it: thinking on for a model that can turn it off, to compare', async () => {
    expect(await bodyFor({ RENDER_THINKING: 'adaptive', RENDER_EFFORT: 'low' })).toEqual({ model: 'claude-haiku-5-5', max_tokens: 4000, thinking: { type: 'adaptive', display: 'omitted' }, output_config: { effort: 'low' } });
    expect(await bodyFor({ RENDER_MODEL: 'claude-sonnet-5-5', RENDER_THINKING: 'omit', RENDER_EFFORT: 'medium' })).toEqual({ model: 'claude-sonnet-5-5', max_tokens: 4000, output_config: { effort: 'medium' } });
    expect(await bodyFor({ RENDER_EFFORT: 'high' })).toEqual({ model: 'claude-haiku-5-5', max_tokens: 200, thinking: { type: 'disabled' }, output_config: { effort: 'high' } });
    expect(await bodyFor({ RENDER_MODEL: 'claude-haiku-4-5', RENDER_THINKING: 'omit' })).toEqual({ model: 'claude-haiku-4-5', max_tokens: 4000 });
  });

  it('the line is the text blocks joined by a space and trimmed, the thinking never read', async () => {
    const p = resolveRenderProvider({ RENDER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY, RENDER_THINKING: 'adaptive' })!;
    const blocks = { content: [{ type: 'thinking', thinking: 'the caller wants' }, { type: 'text', text: 'And who is' }, { type: 'text', text: 'the message from? ' }], stop_reason: 'end_turn' };
    const g = await new ModelRenderClient(p, (async () => new Response(JSON.stringify(blocks), { status: 200 })) as typeof fetch).generate(req, signal);
    expect(g.text).toBe('And who is the message from?');
  });

  it('a combination the API refuses is refused before any call, so the server does not start and diagnose fails it', () => {
    const at = (env: Record<string, string>) => () => resolveRenderProvider({ RENDER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY, ...env });
    expect(at({ RENDER_MODEL: 'claude-sonnet-5-5', RENDER_THINKING: 'disabled' })).toThrow('RENDER_THINKING=disabled is refused by claude-sonnet-5-5: it cannot turn thinking off that way (its way is between-tools); unset RENDER_THINKING for the model\'s own (between-tools)');
    for (const model of ['claude-opus-5-5', 'claude-fable-5-1', 'claude-mythos-5-1']) expect(at({ RENDER_MODEL: model, RENDER_THINKING: 'disabled' })).toThrow(`RENDER_THINKING=disabled is refused by ${model}: it cannot turn thinking off`);
    for (const model of ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-fable-5', 'claude-haiku-4-5']) expect(at({ RENDER_MODEL: model, RENDER_THINKING: 'between-tools' })).toThrow('only Claude Sonnet 5.5 takes between-tools');
    for (const model of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-1', 'claude-sonnet-4-20250514', 'claude-3-5-haiku-latest']) expect(at({ RENDER_MODEL: model, RENDER_THINKING: 'adaptive' }), model).toThrow('it is older than adaptive thinking');
    for (const model of ['claude-haiku-5-5', 'claude-sonnet-4-6', 'claude-opus-4-8', 'claude-sonnet-5-5', 'some-new-model']) expect(at({ RENDER_MODEL: model, RENDER_THINKING: 'adaptive' })(), model).toMatchObject({ thinking: { mode: 'adaptive' } });
  });

  it('each setting checked, on either provider', () => {
    for (const [provider, keyVar] of [['anthropic', 'ANTHROPIC_API_KEY'], ['openrouter', 'OPENROUTER_API_KEY']] as const) {
      expect(() => resolveRenderProvider({ RENDER_PROVIDER: provider, [keyVar]: KEY, RENDER_THINKING: 'enabled' })).toThrow('RENDER_THINKING must be disabled, between-tools, adaptive, omit, got "enabled"');
      expect(() => resolveRenderProvider({ RENDER_PROVIDER: provider, [keyVar]: KEY, RENDER_EFFORT: 'max' })).toThrow('RENDER_EFFORT must be low, medium, high, got "max"');
    }
    // OpenRouter with neither: reasoning off, as always, and nothing in the run's header.
    expect(resolveRenderProvider({ RENDER_PROVIDER: 'openrouter', OPENROUTER_API_KEY: KEY })!.thinking).toBeUndefined();
    expect(() => resolveRenderProvider({ RENDER_PROVIDER: 'openrouter', OPENROUTER_API_KEY: KEY, RENDER_THINKING: 'between-tools' })).toThrow('RENDER_THINKING=between-tools is Claude Sonnet 5.5\'s on RENDER_PROVIDER=anthropic');
    expect(() => resolveRenderProvider({ RENDER_PROVIDER: 'openrouter', OPENROUTER_API_KEY: KEY, RENDER_THINKING: 'disabled', RENDER_EFFORT: 'low' })).toThrow('RENDER_EFFORT asks for reasoning, which RENDER_THINKING=disabled turns off');
  });

  const openRouterBody = async (env: Record<string, string>): Promise<Record<string, unknown>> => {
    const bodies: Record<string, unknown>[] = [];
    const p = resolveRenderProvider({ RENDER_PROVIDER: 'openrouter', OPENROUTER_API_KEY: KEY, RENDER_MODEL: 'vendor/reasoner', ...env })!;
    // A reasoning text that comes back anyway is never read: the line is the content alone.
    const answer = { choices: [{ message: { content: 'Who is it from?', reasoning: 'the caller wants' } }], usage: { prompt_tokens: 300, completion_tokens: 80 } };
    const f = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as typeof fetch;
    const g = await new ModelRenderClient(p, f).generate(req, signal);
    expect(g.text).toBe('Who is it from?');
    expect(JSON.stringify(g)).not.toContain('the caller wants');
    const { messages: _m, ...rest } = bodies[0]!;
    return rest;
  };

  it('OpenRouter reasons as RENDER_THINKING and RENDER_EFFORT say, in its reasoning setting, with room for it; off by default', async () => {
    // Off: OpenRouter's documented { effort: 'none' }.
    expect(await openRouterBody({})).toEqual({ model: 'vendor/reasoner', max_tokens: 200, reasoning: { effort: 'none' } });
    expect(await openRouterBody({ RENDER_THINKING: 'disabled' })).toEqual({ model: 'vendor/reasoner', max_tokens: 200, reasoning: { effort: 'none' } });
    // An effort alone turns reasoning on at that effort, its text not returned.
    expect(await openRouterBody({ RENDER_EFFORT: 'low' })).toEqual({ model: 'vendor/reasoner', max_tokens: 4000, reasoning: { effort: 'low', exclude: true } });
    // adaptive with no effort is OpenRouter's own default when reasoning is on, medium: sent and named so.
    expect(await openRouterBody({ RENDER_THINKING: 'adaptive' })).toEqual({ model: 'vendor/reasoner', max_tokens: 4000, reasoning: { effort: 'medium', exclude: true } });
    expect(renderCassetteModel(resolveRenderProvider({ RENDER_PROVIDER: 'openrouter', OPENROUTER_API_KEY: KEY, RENDER_MODEL: 'v/m', RENDER_THINKING: 'adaptive' })!)).toBe('v/m.thinking-adaptive.effort-medium');
    expect(await openRouterBody({ RENDER_THINKING: 'omit' })).toEqual({ model: 'vendor/reasoner', max_tokens: 4000 });
    expect(await openRouterBody({ RENDER_THINKING: 'omit', RENDER_EFFORT: 'high' })).toEqual({ model: 'vendor/reasoner', max_tokens: 4000, reasoning: { effort: 'high', exclude: true } });
    const p = resolveRenderProvider({ RENDER_PROVIDER: 'openrouter', OPENROUTER_API_KEY: KEY, RENDER_MODEL: 'openai/gpt-oss-120b', RENDER_EFFORT: 'low' })!;
    expect(renderCassetteModel(p)).toBe('openai/gpt-oss-120b.thinking-adaptive.effort-low');
    expect(renderCassetteModel(resolveRenderProvider({ RENDER_PROVIDER: 'openrouter', OPENROUTER_API_KEY: KEY, RENDER_MODEL: 'openai/gpt-oss-120b', RENDER_THINKING: 'disabled' })!)).toBe('openai/gpt-oss-120b');
    expect(renderLines(p)).toEqual(['generated lines worded by openai/gpt-oss-120b from openrouter (thinking adaptive, effort low)']);
  });

  it('a run that changes how a model thinks is recorded in a cassette of its own, beside the default one', () => {
    const at = (env: Record<string, string>) => renderCassetteModel(resolveRenderProvider({ RENDER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY, ...env })!);
    expect(at({})).toBe('claude-haiku-5-5');
    expect(at({ RENDER_THINKING: 'disabled' })).toBe('claude-haiku-5-5');
    expect(at({ RENDER_MODEL: 'claude-opus-5-5', RENDER_EFFORT: 'low' })).toBe('claude-opus-5-5');
    expect(at({ RENDER_THINKING: 'adaptive', RENDER_EFFORT: 'low' })).toBe('claude-haiku-5-5.thinking-adaptive.effort-low');
    expect(renderCassettePath('/r', at({ RENDER_THINKING: 'adaptive', RENDER_EFFORT: 'low' }))).toBe(join('/r', 'render', 'claude-haiku-5-5.thinking-adaptive.effort-low.jsonl'));
    expect(renderLines(resolveRenderProvider({ RENDER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY, RENDER_THINKING: 'adaptive', RENDER_EFFORT: 'low' })!)).toEqual(['generated lines worded by claude-haiku-5-5 from anthropic (thinking adaptive, effort low)']);
  });
});

describe('a line that adds no acknowledgement (acknowledge: false)', () => {
  it('is sent instructions of its own, in place of leave to acknowledge, and its act says so; every other line\'s are as they were', () => {
    const quiet: SpeechAct = { ...act, acknowledge: false };
    expect(instructionsOf(act)).toBe(RENDER_INSTRUCTIONS);
    expect(instructionsOf(quiet)).toBe(RENDER_INSTRUCTIONS_NO_ACKNOWLEDGEMENT);
    expect(RENDER_INSTRUCTIONS_NO_ACKNOWLEDGEMENT).toContain('"acknowledge" is false: add no acknowledgement of what the caller said, before the line or within it (no thanks, no "got it", no repeating their words, no name); reword the fixed line alone.');
    expect(RENDER_INSTRUCTIONS_NO_ACKNOWLEDGEMENT).not.toContain('you may briefly acknowledge');
    expect(RENDER_INSTRUCTIONS_NO_ACKNOWLEDGEMENT).not.toContain('An acknowledgement only shows');
    // Every rule after the acknowledgement is the same.
    expect(RENDER_INSTRUCTIONS_NO_ACKNOWLEDGEMENT.slice(RENDER_INSTRUCTIONS_NO_ACKNOWLEDGEMENT.indexOf('Say every value'))).toBe(RENDER_INSTRUCTIONS.slice(RENDER_INSTRUCTIONS.indexOf('Say every value')));
    expect(renderKey('ask_caller', quiet)).not.toBe(renderKey('ask_caller', act));
    // The default line's key is the act and RENDER_INSTRUCTIONS, as it was recorded.
    expect(renderKey('ask_caller', act)).toBe(createHash('sha256').update(canonicalJson({ promptId: 'ask_caller', act, instructions: RENDER_INSTRUCTIONS })).digest('hex'));
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
