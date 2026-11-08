import { apiError, mayThink, openRouterReasoningBody, safeErrorText, type RenderProvider } from '../render/providers';
import type { RenderUsage } from '../render/types';
import { agentMessages } from './prompt';
import { AGENT_SCHEMA_NAME, agentJsonSchema, parseAgentAnswer } from './schema';
import type { AgentClient, AgentContext, AgentResult } from './types';

/**
 * Where the agent model is asked: OpenRouter (any model it serves, the render provider's settings and
 * key, OPENROUTER_API_KEY) or Inception's own OpenAI-compatible API (INCEPTION_API_KEY; the way to
 * Mercury Voice, which only Inception's API serves). Both get the same request: the agent's messages
 * (agent/prompt.ts), structured output with the answer's JSON Schema (`strict: true`), temperature
 * 0.6. A client never rejects: a reply past its budget is `timeout`, a body that is not the shape
 * `invalid`, and any other failure `error`, with the API's own words made safe (never the key).
 */

/** Inception's chat completions endpoint. */
export const INCEPTION_URL = 'https://api.inceptionlabs.ai/v1/chat/completions';
/** The variable Inception's key is read from. */
export const INCEPTION_KEY_VAR = 'INCEPTION_API_KEY';

/** The temperature an agent is asked at: Inception's for structured and tool work (Mercury takes 0.5 to 1.0 and resets anything else). */
export const AGENT_TEMPERATURE = 0.6;

/** How hard Mercury reasons (`reasoning_effort` on Inception's API). */
export const INCEPTION_EFFORTS = ['instant', 'low', 'medium', 'high'] as const;
export type InceptionEffort = (typeof INCEPTION_EFFORTS)[number];

/** The most tokens an answer may take: a turn's reply and its values; more where the model may reason. */
const MAX_TOKENS = 1000;
const REASONING_MAX_TOKENS = 4000;

type Env = Record<string, string | undefined>;

interface ChatEndpoint {
  /** Names the provider in a failure's detail. */
  provider: string;
  url: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  /** What the provider takes besides the shared request. */
  extra: Record<string, unknown>;
}

/** The answer of an OpenAI-compatible chat completion: the assistant's text, the tokens, and the provider's cost where it gives one. */
function completionOf(json: unknown): { text: string | null; finish: unknown; usage: RenderUsage; costUsd?: number } {
  const b = json as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: unknown } } | null;
  const content = b?.choices?.[0]?.message?.content;
  const cost = b?.usage?.cost;
  return {
    text: typeof content === 'string' ? content : null,
    finish: b?.choices?.[0]?.finish_reason,
    usage: { inputTokens: b?.usage?.prompt_tokens ?? 0, outputTokens: b?.usage?.completion_tokens ?? 0 },
    ...(typeof cost === 'number' && Number.isFinite(cost) ? { costUsd: cost } : {}),
  };
}

/** An agent client over an OpenAI-compatible chat completions endpoint. */
function chatAgent(e: ChatEndpoint, fetchFn: typeof fetch): AgentClient {
  return {
    model: e.model,
    async answer(ctx: AgentContext, timeoutMs: number): Promise<AgentResult> {
      const started = performance.now();
      const ms = (): number => Math.round(performance.now() - started);
      const actions = ctx.actions.map((a) => a.name);
      const fields = ctx.fields.map((f) => f.name);
      const { system, user } = agentMessages(ctx);
      const body = {
        model: e.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: AGENT_TEMPERATURE,
        max_tokens: e.maxTokens,
        response_format: { type: 'json_schema', json_schema: { name: AGENT_SCHEMA_NAME, strict: true, schema: agentJsonSchema(actions, fields) } },
        ...e.extra,
      };
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        let res: Response;
        try {
          res = await fetchFn(e.url, { method: 'POST', headers: { authorization: `Bearer ${e.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: abort.signal });
        } catch (err) {
          if (abort.signal.aborted) return { ok: false, reason: 'timeout', detail: `${e.provider}: no answer within ${timeoutMs} ms`, ms: ms() };
          // The failure's kind, never the request (which holds the key in a header).
          return { ok: false, reason: 'error', detail: `${e.provider}: ${err instanceof Error ? err.name : 'request failed'}`, ms: ms() };
        }
        if (!res.ok) {
          const told = apiError(await res.json().catch(() => null), e.apiKey);
          return { ok: false, reason: 'error', detail: `${e.provider}: HTTP ${res.status}${told.type !== undefined ? ` ${told.type}` : ''}${told.message !== undefined ? `: ${told.message}` : ''}`, ms: ms() };
        }
        let json: unknown;
        try {
          json = await res.json();
        } catch {
          if (abort.signal.aborted) return { ok: false, reason: 'timeout', detail: `${e.provider}: no answer within ${timeoutMs} ms`, ms: ms() };
          return { ok: false, reason: 'error', detail: `${e.provider}: the response was not JSON`, ms: ms() };
        }
        const c = completionOf(json);
        const paid = { usage: c.usage, ...(c.costUsd !== undefined ? { costUsd: c.costUsd } : {}) };
        if (c.text === null) return { ok: false, reason: 'invalid', detail: `${e.provider}: the response had no message`, ms: ms(), ...paid };
        // An answer cut off at the token limit is not an answer, whatever it parses to.
        if (c.finish === 'length') return { ok: false, reason: 'invalid', detail: `${e.provider}: the answer was cut off at the token limit`, ms: ms(), raw: c.text, ...paid };
        const parsed = parseAgentAnswer(c.text, actions, fields);
        if (!parsed.ok) return { ok: false, reason: 'invalid', detail: safeErrorText(parsed.detail, e.apiKey), ms: ms(), raw: c.text, ...paid };
        return { ok: true, answer: parsed.answer, ms: ms(), raw: c.text, ...paid };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The agent model through OpenRouter: the render provider's model, key and reasoning settings
 * (RENDER_THINKING, RENDER_EFFORT, openRouterReasoningBody: reasoning off unless one asks for it).
 * Only providers that honour every parameter are asked (`provider.require_parameters`), so structured
 * output is never dropped silently.
 */
export function openRouterAgent(p: RenderProvider, fetchFn: typeof fetch = fetch): AgentClient {
  if (p.apiKey === null) throw new Error(`missing required environment variable ${p.keyVar} (the agent model, ${p.model} from ${p.provider})`);
  if (p.provider !== 'openrouter') throw new Error(`the agent model is asked through OpenRouter or Inception, not ${p.provider}`);
  return chatAgent({
    provider: 'openrouter', url: p.url, model: p.model, apiKey: p.apiKey,
    maxTokens: mayThink(p.thinking) || p.thinking?.effort !== undefined ? REASONING_MAX_TOKENS : MAX_TOKENS,
    extra: { ...openRouterReasoningBody(p.thinking), provider: { require_parameters: true } },
  }, fetchFn);
}

/** How Inception's API is asked: the model, the key (null when unset), its reasoning effort (absent: the API's default) and `realtime`. */
export interface InceptionAgentOptions {
  model: string;
  apiKey: string | null;
  effort?: InceptionEffort;
  realtime: boolean;
}

/** The agent model on Inception's own API, with `reasoning_effort` and `realtime` where asked for. */
export function inceptionAgent(p: InceptionAgentOptions, fetchFn: typeof fetch = fetch): AgentClient {
  if (p.apiKey === null) throw new Error(`missing required environment variable ${INCEPTION_KEY_VAR} (the agent model, ${p.model} from inception)`);
  return chatAgent({
    provider: 'inception', url: INCEPTION_URL, model: p.model, apiKey: p.apiKey,
    maxTokens: p.effort === undefined || p.effort === 'instant' ? MAX_TOKENS : REASONING_MAX_TOKENS,
    extra: { ...(p.effort !== undefined ? { reasoning_effort: p.effort } : {}), ...(p.realtime ? { realtime: true } : {}) },
  }, fetchFn);
}

/** inceptionAgent with its key read from INCEPTION_API_KEY; throws, naming the variable (never a value), when it is unset. */
export function resolveInceptionAgent(env: Env, p: Omit<InceptionAgentOptions, 'apiKey'>, fetchFn: typeof fetch = fetch): AgentClient {
  return inceptionAgent({ ...p, apiKey: env[INCEPTION_KEY_VAR]?.trim() || null }, fetchFn);
}
