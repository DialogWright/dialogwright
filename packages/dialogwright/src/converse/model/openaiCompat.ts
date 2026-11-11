import { KNOWN, apiError, safeErrorText } from '../../render/endpoints';
import { parseSse } from './sse';
import { filteredBy, httpError, jsonOf, thrownError } from './shared';
import type { ConverseModel, ModelEvent, ModelMessage, ModelRequest } from './types';

/** The chat-completions messages for a conversation: tool results are `tool` messages, an assistant's tool calls `tool_calls`. */
function messagesOf(system: string, messages: ModelMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('');
      const calls = m.content.flatMap((c) => (c.type === 'tool_call' ? [{ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] : []));
      out.push({ role: 'assistant', content: text === '' && calls.length > 0 ? null : text, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const c of m.content) if (c.type === 'tool_result') out.push({ role: 'tool', tool_call_id: c.id, content: c.content });
    const text = m.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('');
    if (text !== '') out.push({ role: 'user', content: text });
  }
  return out;
}

/** The providers asked through OpenAI-compatible chat completions. */
export type OpenAiCompatProvider = 'inception' | 'openrouter' | 'meta';

const URLS: Record<OpenAiCompatProvider, string> = { inception: KNOWN.inception.url, openrouter: KNOWN.openrouter.url, meta: 'https://api.meta.ai/v1/chat/completions' };

/**
 * The reasoning effort in the provider's own form: Inception's `reasoning_effort` (its least is `instant`, which
 * `minimal` names), Meta's `reasoning_effort` (minimal is its own), OpenRouter's `reasoning.effort`. Nothing
 * where the request names none.
 */
function effortOf(provider: OpenAiCompatProvider, req: ModelRequest): Record<string, unknown> {
  if (req.effort === undefined) return {};
  if (provider === 'inception') return { reasoning_effort: req.effort === 'minimal' ? 'instant' : req.effort };
  return provider === 'meta' ? { reasoning_effort: req.effort } : { reasoning: { effort: req.effort } };
}

/**
 * The chat completions body for a request (no key in it); `temperature` only where the request sets it, the
 * effort in the provider's form. OpenRouter is asked for hosts that collect no data (`data_collection: deny`),
 * and only the hosts `only` names where it names any, with no fallback to others. Meta takes the token limit
 * as `max_completion_tokens`.
 */
export function openAiCompatBody(model: string, req: ModelRequest, provider: OpenAiCompatProvider, only: readonly string[] = []): Record<string, unknown> {
  return {
    ...effortOf(provider, req),
    model,
    stream: true,
    stream_options: { include_usage: true },
    ...(provider === 'meta' ? { max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens }),
    ...(provider === 'openrouter' ? { provider: { data_collection: 'deny', ...(only.length > 0 ? { order: [...only], allow_fallbacks: false } : {}) } } : {}),
    messages: messagesOf(req.system, req.messages),
    ...(req.tools.length > 0 ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  };
}

export function openAiCompatModel(o: { provider: OpenAiCompatProvider; model: string; apiKey: string; only?: readonly string[]; url?: string; fetch?: typeof fetch }): ConverseModel {
  const doFetch = o.fetch ?? fetch;
  const only = o.only ?? [];
  return {
    id: `${o.provider}:${o.model}${only.length > 0 ? `@${only.join(',')}` : ''}`,
    async *stream(req, signal): AsyncIterable<ModelEvent> {
      let res: Response;
      try {
        res = await doFetch(o.url ?? URLS[o.provider], {
          method: 'POST',
          headers: { authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(openAiCompatBody(o.model, req, o.provider, only)),
          signal,
        });
      } catch (e) {
        yield thrownError(e, signal, o.apiKey);
        return;
      }
      if (!res.ok) {
        yield await httpError(res, o.apiKey);
        return;
      }
      if (res.body === null) {
        yield { type: 'error', kind: 'invalid', detail: 'the response had no body' };
        return;
      }
      const calls = new Map<number, { id: string; name: string; args: string }>();
      let emitted = 0;
      let finish: unknown = null;
      let inputTokens = 0;
      let outputTokens = 0;
      try {
        for await (const payload of parseSse(res.body)) {
          const ev = jsonOf(payload);
          if (ev === null) continue;
          if (ev.error !== undefined) {
            const told = apiError(ev, o.apiKey);
            yield { type: 'error', kind: filteredBy(200, ev, told) ? 'filtered' : 'http', detail: `${told.type ?? 'error'}${told.message ? `: ${told.message}` : ''}` };
            return;
          }
          if (ev.usage) {
            inputTokens = ev.usage.prompt_tokens ?? inputTokens;
            outputTokens = ev.usage.completion_tokens ?? outputTokens;
          }
          const choice = ev.choices?.[0];
          if (choice === undefined) continue;
          const delta = choice.delta ?? {};
          if (typeof delta.content === 'string' && delta.content !== '') yield { type: 'text', delta: delta.content };
          for (const tc of delta.tool_calls ?? []) {
            const i = typeof tc.index === 'number' ? tc.index : 0;
            const cur = calls.get(i) ?? { id: '', name: '', args: '' };
            if (typeof tc.id === 'string') cur.id = tc.id;
            if (typeof tc.function?.name === 'string') cur.name += tc.function.name;
            if (typeof tc.function?.arguments === 'string') cur.args += tc.function.arguments;
            calls.set(i, cur);
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      } catch (e) {
        yield thrownError(e, signal, o.apiKey);
        return;
      }
      if (finish === null) {
        yield signal.aborted ? { type: 'error', kind: 'timeout', detail: 'the request was aborted' } : { type: 'error', kind: 'invalid', detail: 'the stream ended before the message did' };
        return;
      }
      if (filteredBy(200, null, {}, finish)) {
        yield { type: 'error', kind: 'filtered', detail: safeErrorText("the answer was stopped by the provider's content filter", o.apiKey) };
        return;
      }
      for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
        let args: unknown;
        try {
          args = c.args.trim() === '' ? {} : JSON.parse(c.args);
        } catch {
          yield { type: 'error', kind: 'invalid', detail: `the arguments of ${c.name} were not JSON` };
          return;
        }
        if (args === null || typeof args !== 'object' || Array.isArray(args)) {
          yield { type: 'error', kind: 'invalid', detail: `the arguments of ${c.name} were not an object` };
          return;
        }
        emitted++;
        // A call the provider gave no id gets one, so its result can be paired with it.
        yield { type: 'tool_call', id: c.id !== '' ? c.id : `call_${emitted}`, name: c.name, args: args as Record<string, unknown> };
      }
      yield { type: 'done', stop: emitted > 0 || finish === 'tool_calls' || finish === 'function_call' ? 'tool' : finish === 'length' ? 'length' : 'end', usage: { inputTokens, outputTokens } };
    },
  };
}
