import { KNOWN, safeErrorText } from '../../render/endpoints';
import { parseSse } from './sse';
import { httpError, jsonOf, thrownError } from './shared';
import type { ConverseModel, ModelContent, ModelEvent, ModelRequest } from './types';

const VERSION = '2023-06-01';

const blockOf = (c: ModelContent): Record<string, unknown> =>
  c.type === 'text'
    ? { type: 'text', text: c.text }
    : c.type === 'tool_call'
      ? { type: 'tool_use', id: c.id, name: c.name, input: c.args }
      : { type: 'tool_result', tool_use_id: c.id, content: c.content, ...(c.isError ? { is_error: true } : {}) };

/** The Messages API body for a request (no key in it); the effort as `output_config.effort`, minimal (which the API does not have) as low. */
export function anthropicBody(model: string, req: ModelRequest): Record<string, unknown> {
  return {
    ...(req.effort !== undefined ? { output_config: { effort: req.effort === 'minimal' ? 'low' : req.effort } } : {}),
    model,
    max_tokens: req.maxTokens,
    stream: true,
    system: req.system,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content.map(blockOf) })),
    ...(req.tools.length > 0 ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  };
}

export function anthropicModel(o: { model: string; apiKey: string; fetch?: typeof fetch; url?: string }): ConverseModel {
  const doFetch = o.fetch ?? fetch;
  return {
    id: `anthropic:${o.model}`,
    async *stream(req, signal): AsyncIterable<ModelEvent> {
      let res: Response;
      try {
        res = await doFetch(o.url ?? KNOWN.anthropic.url, {
          method: 'POST',
          headers: { 'x-api-key': o.apiKey, 'anthropic-version': VERSION, 'content-type': 'application/json' },
          body: JSON.stringify(anthropicBody(o.model, req)),
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
      let tool: { id: string; name: string; json: string } | null = null;
      let inputTokens = 0;
      let outputTokens = 0;
      let stop: 'end' | 'tool' | 'length' | null = null;
      try {
        for await (const payload of parseSse(res.body)) {
          const ev = jsonOf(payload);
          if (ev === null) continue;
          switch (ev.type) {
            case 'message_start':
              inputTokens = ev.message?.usage?.input_tokens ?? 0;
              outputTokens = ev.message?.usage?.output_tokens ?? 0;
              break;
            case 'content_block_start':
              if (ev.content_block?.type === 'tool_use') tool = { id: String(ev.content_block.id), name: String(ev.content_block.name), json: '' };
              break;
            case 'content_block_delta':
              if (ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') yield { type: 'text', delta: ev.delta.text };
              else if (ev.delta?.type === 'input_json_delta' && tool !== null) tool.json += String(ev.delta.partial_json ?? '');
              break;
            case 'content_block_stop':
              if (tool !== null) {
                const t = tool;
                tool = null;
                let args: unknown;
                try {
                  args = t.json.trim() === '' ? {} : JSON.parse(t.json);
                } catch {
                  yield { type: 'error', kind: 'invalid', detail: `the arguments of ${t.name} were not JSON` };
                  return;
                }
                if (args === null || typeof args !== 'object' || Array.isArray(args)) {
                  yield { type: 'error', kind: 'invalid', detail: `the arguments of ${t.name} were not an object` };
                  return;
                }
                yield { type: 'tool_call', id: t.id, name: t.name, args: args as Record<string, unknown> };
              }
              break;
            case 'message_delta':
              if (ev.usage?.output_tokens !== undefined) outputTokens = ev.usage.output_tokens;
              if (ev.usage?.input_tokens !== undefined) inputTokens = ev.usage.input_tokens;
              if (ev.delta?.stop_reason !== undefined) stop = ev.delta.stop_reason === 'tool_use' ? 'tool' : ev.delta.stop_reason === 'max_tokens' ? 'length' : 'end';
              if (ev.delta?.stop_reason === 'refusal') {
                yield { type: 'error', kind: 'filtered', detail: 'the model refused the request' };
                return;
              }
              break;
            case 'error': {
              const type = String(ev.error?.type ?? '');
              // A rate limit told in the stream (Anthropic's rate_limit_error) is one as a 429 is, with no wait named.
              yield { type: 'error', kind: /content[_ -]?filter/i.test(type) ? 'filtered' : type === 'rate_limit_error' ? 'rate_limited' : 'http', detail: safeErrorText(`${type}: ${String(ev.error?.message ?? '')}`, o.apiKey) };
              return;
            }
          }
        }
      } catch (e) {
        yield thrownError(e, signal, o.apiKey);
        return;
      }
      if (stop === null) {
        yield signal.aborted ? { type: 'error', kind: 'timeout', detail: 'the request was aborted' } : { type: 'error', kind: 'invalid', detail: 'the stream ended before the message did' };
        return;
      }
      yield { type: 'done', stop, usage: { inputTokens, outputTokens } };
    },
  };
}
