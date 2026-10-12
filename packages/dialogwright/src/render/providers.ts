import { RENDER_INSTRUCTIONS, actMessage } from './prompt';
import { DEFAULT_RENDER_CHECK_TIMEOUT_MS, DEFAULT_RENDER_PRICE, DEFAULT_RENDER_TIMEOUT_MS, RenderClientError, type Generation, type RenderClient, type RenderPrice, type RenderRequest } from './types';

/**
 * Where generated lines are worded (generated wording, design section 5): a model reached through
 * OpenRouter (any model it serves) or the Anthropic API, with the author's own key, read from its own
 * variable and never from a flag; never logged, never in a trace. Chosen like the decision model:
 *
 * - RENDER_PROVIDER: `openrouter` or `anthropic`. Unset, no line is generated: every line is its fixed text.
 * - RENDER_MODEL: the model id; default a current Claude Haiku (`claude-haiku-5-5` on Anthropic,
 *   `anthropic/claude-haiku-5.5` on OpenRouter).
 * - the key: OPENROUTER_API_KEY or ANTHROPIC_API_KEY, the provider's own variable.
 * - RENDER_SHARE: the share of calls served generated, 0 to 100; default 100.
 * - RENDER_TIMEOUT_MS: how long a line's wording may take; default 700 on a call and 1500 in a chat
 *   (one value given sets both).
 * - RENDER_CHECK_TIMEOUT_MS: how long the decision model's checks of a line may take together (the
 *   collected content screened again, the drift check); default 500 on a call and 1000 in a chat.
 * - RENDER_PRICE_INPUT_PER_MTOK and RENDER_PRICE_OUTPUT_PER_MTOK: the model's price in US dollars per
 *   million tokens, for the cost in the trace and Insights; default the default model's.
 */
export const RENDER_PROVIDERS = ['openrouter', 'anthropic'] as const;
export type RenderProviderName = (typeof RENDER_PROVIDERS)[number];

export interface RenderProvider {
  provider: RenderProviderName;
  model: string;
  /** Null when the variable is unset: a replay needs none. */
  apiKey: string | null;
  /** The variable the key is read from, for messages; never the key itself. */
  keyVar: string;
  url: string;
}

const KNOWN: Record<RenderProviderName, { url: string; keyVar: string; model: string }> = {
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', keyVar: 'OPENROUTER_API_KEY', model: 'anthropic/claude-haiku-5.5' },
  anthropic: { url: 'https://api.anthropic.com/v1/messages', keyVar: 'ANTHROPIC_API_KEY', model: 'claude-haiku-5-5' },
};

type Env = Record<string, string | undefined>;
const value = (env: Env, name: string): string | null => env[name]?.trim() || null;

/**
 * The render provider RENDER_PROVIDER names, with its model and key; null when it is unset (no line is
 * generated). `needKey` (default true) is false for a replay, which sends nothing.
 */
export function resolveRenderProvider(env: Env = process.env, opts: { needKey?: boolean } = {}): RenderProvider | null {
  const raw = value(env, 'RENDER_PROVIDER');
  if (raw === null) return null;
  if (!(RENDER_PROVIDERS as readonly string[]).includes(raw)) throw new Error(`RENDER_PROVIDER must be ${RENDER_PROVIDERS.join(' or ')}, got "${raw}"`);
  const provider = raw as RenderProviderName;
  const known = KNOWN[provider];
  const apiKey = value(env, known.keyVar);
  if ((opts.needKey ?? true) && apiKey === null) throw new Error(`missing required environment variable ${known.keyVar} (RENDER_PROVIDER=${provider})`);
  return { provider, model: value(env, 'RENDER_MODEL') ?? known.model, apiKey, keyVar: known.keyVar, url: known.url };
}

/** A whole number in [min, max] from `name`, or `fallback` when it is unset. */
function bounded(env: Env, name: string, min: number, max: number, fallback: number): number {
  const raw = value(env, name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
  return n;
}

function price(env: Env, name: string, fallback: number): number {
  const raw = value(env, name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a price in US dollars per million tokens (a number, 0 or more), got "${raw}"`);
  return n;
}

/** RENDER_SHARE, RENDER_TIMEOUT_MS and the price, with their defaults. */
export function renderSettings(env: Env = process.env): { share: number; timeoutMs: { voice: number; chat: number }; checkTimeoutMs: { voice: number; chat: number }; price: RenderPrice } {
  const timeout = value(env, 'RENDER_TIMEOUT_MS') === null ? null : bounded(env, 'RENDER_TIMEOUT_MS', 50, 30_000, 0);
  const checks = value(env, 'RENDER_CHECK_TIMEOUT_MS') === null ? null : bounded(env, 'RENDER_CHECK_TIMEOUT_MS', 50, 30_000, 0);
  return {
    share: bounded(env, 'RENDER_SHARE', 0, 100, 100),
    timeoutMs: timeout === null ? { ...DEFAULT_RENDER_TIMEOUT_MS } : { voice: timeout, chat: timeout },
    checkTimeoutMs: checks === null ? { ...DEFAULT_RENDER_CHECK_TIMEOUT_MS } : { voice: checks, chat: checks },
    price: { input: price(env, 'RENDER_PRICE_INPUT_PER_MTOK', DEFAULT_RENDER_PRICE.input), output: price(env, 'RENDER_PRICE_OUTPUT_PER_MTOK', DEFAULT_RENDER_PRICE.output) },
  };
}

/** The most tokens a generated line may take: a line, never a page. */
const MAX_TOKENS = 200;

/** Words a line through OpenRouter's OpenAI-compatible chat completions, or the Anthropic Messages API. */
export class ModelRenderClient implements RenderClient {
  constructor(private readonly p: RenderProvider, private readonly fetchFn: typeof fetch = fetch) {
    if (p.apiKey === null) throw new Error(`missing required environment variable ${p.keyVar} (RENDER_PROVIDER=${p.provider})`);
  }

  get model(): string {
    return this.p.model;
  }

  async generate(req: RenderRequest, signal: AbortSignal): Promise<Generation> {
    const started = performance.now();
    const content = actMessage(req.act);
    const anthropic = this.p.provider === 'anthropic';
    const body = anthropic
      ? { model: this.p.model, max_tokens: MAX_TOKENS, system: RENDER_INSTRUCTIONS, messages: [{ role: 'user', content }], thinking: { type: 'disabled' } }
      // OpenRouter's own setting turns a model's reasoning off where it has one (a line, not a page; unconfirmed per model).
      : { model: this.p.model, max_tokens: MAX_TOKENS, reasoning: { enabled: false }, messages: [{ role: 'system', content: RENDER_INSTRUCTIONS }, { role: 'user', content }] };
    const headers: Record<string, string> = anthropic
      ? { 'x-api-key': this.p.apiKey!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
      : { authorization: `Bearer ${this.p.apiKey!}`, 'content-type': 'application/json' };
    let res: Response;
    try {
      res = await this.fetchFn(this.p.url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (e) {
      // The message names the provider and the failure's kind, never the request (which holds the key in a header).
      throw new RenderClientError(`${this.p.provider}: ${e instanceof Error ? e.name : 'request failed'}`);
    }
    if (!res.ok) throw new RenderClientError(`${this.p.provider}: HTTP ${res.status}`);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new RenderClientError(`${this.p.provider}: the answer was not JSON`);
    }
    const parsed = anthropic ? anthropicAnswer(json) : openRouterAnswer(json);
    if (parsed === null) throw new RenderClientError(`${this.p.provider}: the answer had no line`);
    return { ...parsed, model: parsed.model ?? this.p.model, latencyMs: performance.now() - started, source: 'model' };
  }
}

function anthropicAnswer(json: unknown): { text: string; model?: string; usage: { inputTokens: number; outputTokens: number } } | null {
  const b = json as { content?: { type?: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number }; model?: string; stop_reason?: string } | null;
  // A refusal, or a line cut off at the token limit, is no line.
  if (b === null || typeof b !== 'object' || b.stop_reason === 'refusal' || b.stop_reason === 'max_tokens' || !Array.isArray(b.content)) return null;
  const text = b.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  return { text, ...(typeof b.model === 'string' ? { model: b.model } : {}), usage: { inputTokens: b.usage?.input_tokens ?? 0, outputTokens: b.usage?.output_tokens ?? 0 } };
}

function openRouterAnswer(json: unknown): { text: string; model?: string; usage: { inputTokens: number; outputTokens: number } } | null {
  const b = json as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string } | null;
  const text = b?.choices?.[0]?.message?.content;
  // A line cut off at the token limit is no line.
  if (typeof text !== 'string' || b?.choices?.[0]?.finish_reason === 'length') return null;
  return { text, ...(typeof b?.model === 'string' ? { model: b.model } : {}), usage: { inputTokens: b?.usage?.prompt_tokens ?? 0, outputTokens: b?.usage?.completion_tokens ?? 0 } };
}

/** The lines a run prints about its renderer: which model, from where, or that it is replayed. Never the key. */
export function renderLines(p: RenderProvider | null, opts: { replayed?: boolean; fake?: boolean } = {}): string[] {
  if (opts.fake) return ['generated lines worded by the fake renderer (no model asked)'];
  if (p === null) return ['generated lines said fixed (RENDER_PROVIDER unset)'];
  return [`generated lines worded by ${p.model} from ${p.provider}${opts.replayed ? ', replayed from its cassette' : ''}`];
}
