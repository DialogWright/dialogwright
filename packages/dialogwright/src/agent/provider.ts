import { apiError, mayThink, openRouterReasoningBody, resolveRenderProvider, safeErrorText, type RenderProvider, type RenderThinking } from '../render/providers';
import type { RenderUsage } from '../render/types';
import { agentMessages } from './prompt';
import { AGENT_SCHEMA_NAME, agentJsonSchema, parseAgentAnswer } from './schema';
import type { AgentClient, AgentContext, AgentModelChoice, AgentRequest, AgentResult } from './types';

/**
 * Where the agent model is asked: OpenRouter (any model it serves, the render provider's settings and
 * key, OPENROUTER_API_KEY) or Inception's own OpenAI-compatible API (INCEPTION_API_KEY; the way to
 * Mercury Voice, which only Inception's API serves). Both get the same request: the agent's messages
 * (agent/prompt.ts), structured output with the answer's JSON Schema (`strict: true`), temperature
 * 0.6. A client never rejects: a reply past its budget (or a gateway's 504) is `timeout`, a body that
 * is not the shape `invalid`, and any other failure `error`, with the API's own words made safe (never
 * the key). Each request is built without the key (AgentRequest), so a cassette keys answers by
 * everything sent but the key, and a replay builds the same request with no key at all.
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

/**
 * The most tokens an answer may take (`max_tokens`, the OpenAI-compatible chat API's, which Inception's
 * and OpenRouter's take): a turn's reply and its values. 400: the largest valid answer of the bake-off and
 * the wheelshop recordings was 302 tokens (of 560), and a third more is headroom; the answers that ran on
 * ("Goodbye. Goodbye. ...", 950 to 1000 tokens) were none of them valid. An answer cut off at it is
 * `invalid` at once (finish_reason `length`), never parsed. More where the model may reason, since its
 * reasoning counts against the limit (the agent-mode design, call 38).
 */
export const AGENT_MAX_TOKENS = 400;
const MAX_TOKENS = AGENT_MAX_TOKENS;
const REASONING_MAX_TOKENS = 4000;

type Env = Record<string, string | undefined>;

/** The request every provider is sent for a turn, with what that provider takes besides. Throws where the turn cannot be put into one. */
function chatRequest(model: string, maxTokens: number, extra: Record<string, unknown>): AgentRequest {
  return {
    body(ctx: AgentContext): Record<string, unknown> {
      const { system, user } = agentMessages(ctx);
      return {
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: AGENT_TEMPERATURE,
        max_tokens: maxTokens,
        response_format: { type: 'json_schema', json_schema: { name: AGENT_SCHEMA_NAME, strict: true, schema: agentJsonSchema(ctx.actions.map((a) => a.name), ctx.fields.map((f) => f.name), ctx.lines) } },
        ...extra,
      };
    },
  };
}

/**
 * What OpenRouter is sent: only providers that honour every parameter are asked
 * (`provider.require_parameters`), so structured output is never dropped silently; the answer's cost is
 * asked for (`usage.include`, OpenRouter's usage accounting). `reasoning` is sent only where a thinking
 * setting is given (RENDER_THINKING, RENDER_EFFORT; openRouterReasoningBody): with none, the model's own
 * default, since some models refuse reasoning off ("Reasoning is mandatory") and a required parameter they
 * refuse would turn every request away.
 */
export function openRouterRequest(p: { model: string; thinking?: RenderThinking }): AgentRequest {
  const reasons = p.thinking !== undefined && (mayThink(p.thinking) || p.thinking.effort !== undefined);
  return chatRequest(p.model, reasons ? REASONING_MAX_TOKENS : MAX_TOKENS, {
    ...(p.thinking !== undefined ? openRouterReasoningBody(p.thinking) : {}),
    provider: { require_parameters: true },
    usage: { include: true },
  });
}

/** How Inception's API is asked: the model, its reasoning effort (absent: the API's default) and `realtime`. */
export interface InceptionRequestOptions {
  model: string;
  effort?: InceptionEffort;
  realtime: boolean;
}

/** What Inception's API is sent: `reasoning_effort` and `realtime` where asked for. */
export function inceptionRequest(p: InceptionRequestOptions): AgentRequest {
  return chatRequest(p.model, p.effort === undefined || p.effort === 'instant' ? MAX_TOKENS : REASONING_MAX_TOKENS, {
    ...(p.effort !== undefined ? { reasoning_effort: p.effort } : {}),
    ...(p.realtime ? { realtime: true } : {}),
  });
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

interface ChatEndpoint {
  /** Names the provider in a failure's detail. */
  provider: string;
  url: string;
  model: string;
  apiKey: string;
  request: AgentRequest;
}

/** An agent client over an OpenAI-compatible chat completions endpoint. */
function chatAgent(e: ChatEndpoint, fetchFn: typeof fetch): AgentClient {
  return {
    model: e.model,
    request: e.request,
    async answer(ctx: AgentContext, timeoutMs: number): Promise<AgentResult> {
      const started = performance.now();
      const ms = (): number => Math.round(performance.now() - started);
      const timedOut = (): AgentResult => ({ ok: false, reason: 'timeout', detail: `${e.provider}: no answer within ${timeoutMs} ms`, ms: ms() });
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        let body: string;
        try {
          body = JSON.stringify(e.request.body(ctx));
        } catch (err) {
          return { ok: false, reason: 'error', detail: `${e.provider}: the turn could not be put into a request (${err instanceof Error ? err.name : 'error'})`, ms: ms() };
        }
        let res: Response;
        try {
          res = await fetchFn(e.url, { method: 'POST', headers: { authorization: `Bearer ${e.apiKey}`, 'content-type': 'application/json' }, body, signal: abort.signal });
        } catch (err) {
          if (abort.signal.aborted) return timedOut();
          // The failure's kind, never the request (which holds the key in a header).
          return { ok: false, reason: 'error', detail: `${e.provider}: ${err instanceof Error ? err.name : 'request failed'}`, ms: ms() };
        }
        if (!res.ok) {
          const told = apiError(await res.json().catch(() => null), e.apiKey);
          const detail = `${e.provider}: HTTP ${res.status}${told.type !== undefined ? ` ${told.type}` : ''}${told.message !== undefined ? `: ${told.message}` : ''}`;
          // A gateway that gave up waiting for the model: the model was slow, as a timeout is.
          if (res.status === 504) return { ok: false, reason: 'timeout', detail, ms: ms() };
          return { ok: false, reason: 'error', detail, ms: ms() };
        }
        let json: unknown;
        try {
          json = await res.json();
        } catch {
          if (abort.signal.aborted) return timedOut();
          return { ok: false, reason: 'error', detail: `${e.provider}: the response was not JSON`, ms: ms() };
        }
        const c = completionOf(json);
        const paid = { usage: c.usage, ...(c.costUsd !== undefined ? { costUsd: c.costUsd } : {}) };
        if (c.text === null) return { ok: false, reason: 'invalid', detail: `${e.provider}: the response had no message`, ms: ms(), ...paid };
        // An answer cut off at the token limit is not an answer, whatever it parses to.
        if (c.finish === 'length') return { ok: false, reason: 'invalid', detail: `${e.provider}: the answer was cut off at the token limit`, ms: ms(), raw: c.text, ...paid };
        const parsed = parseAgentAnswer(c.text, ctx.actions.map((a) => a.name), ctx.fields.map((f) => f.name), ctx.lines);
        if (!parsed.ok) return { ok: false, reason: 'invalid', detail: safeErrorText(parsed.detail, e.apiKey), ms: ms(), raw: c.text, ...paid };
        return { ok: true, answer: parsed.answer, ms: ms(), raw: c.text, ...paid };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** The agent model through OpenRouter: the render provider's model, key and reasoning settings (openRouterRequest). */
export function openRouterAgent(p: RenderProvider, fetchFn: typeof fetch = fetch): AgentClient {
  if (p.apiKey === null) throw new Error(`missing required environment variable ${p.keyVar} (the agent model, ${p.model} from ${p.provider})`);
  if (p.provider !== 'openrouter') throw new Error(`the agent model is asked through OpenRouter or Inception, not ${p.provider}`);
  return chatAgent({ provider: 'openrouter', url: p.url, model: p.model, apiKey: p.apiKey, request: openRouterRequest(p) }, fetchFn);
}

/** How Inception's API is asked, with the key (null when unset). */
export interface InceptionAgentOptions extends InceptionRequestOptions {
  apiKey: string | null;
}

/** The agent model on Inception's own API, with `reasoning_effort` and `realtime` where asked for. */
export function inceptionAgent(p: InceptionAgentOptions, fetchFn: typeof fetch = fetch): AgentClient {
  if (p.apiKey === null) throw new Error(`missing required environment variable ${INCEPTION_KEY_VAR} (the agent model, ${p.model} from inception)`);
  return chatAgent({ provider: 'inception', url: INCEPTION_URL, model: p.model, apiKey: p.apiKey, request: inceptionRequest(p) }, fetchFn);
}

/** inceptionAgent with its key read from INCEPTION_API_KEY; throws, naming the variable (never a value), when it is unset. */
export function resolveInceptionAgent(env: Env, p: InceptionRequestOptions, fetchFn: typeof fetch = fetch): AgentClient {
  return inceptionAgent({ ...p, apiKey: env[INCEPTION_KEY_VAR]?.trim() || null }, fetchFn);
}

/** The variable an app's agent model's key is read from (style.yaml's `agent.provider`). */
export function agentKeyVar(model: Pick<AgentModelChoice, 'provider'>): string {
  return model.provider === 'inception' ? INCEPTION_KEY_VAR : 'OPENROUTER_API_KEY';
}

/**
 * The client of an app's agent model (App.agent.model, style.yaml's `agent`), its key read from `env` (the
 * app's own settings): Mercury on Inception's API with its effort and `realtime`, or a model through
 * OpenRouter at its effort (`instant` there asks for no reasoning setting, the model's own default).
 * Throws, naming the variable (never a value), when the key is unset.
 */
export function appAgentClient(env: Env, model: AgentModelChoice, fetchFn: typeof fetch = fetch): AgentClient {
  if (model.provider === 'inception') return resolveInceptionAgent(env, { model: model.model, effort: model.effort, realtime: true }, fetchFn);
  const provider = resolveRenderProvider({ ...env, RENDER_PROVIDER: 'openrouter', RENDER_MODEL: model.model, RENDER_THINKING: undefined, RENDER_EFFORT: model.effort === 'instant' ? undefined : model.effort });
  return openRouterAgent(provider!, fetchFn);
}
