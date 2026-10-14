import { actMessage, instructionsOf } from './prompt';
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
 * - RENDER_THINKING and RENDER_EFFORT, Anthropic only: how the model thinks (renderThinkingOf); default
 *   the model's own way of thinking least (THINKING_BY_MODEL).
 */
export const RENDER_PROVIDERS = ['openrouter', 'anthropic'] as const;
export type RenderProviderName = (typeof RENDER_PROVIDERS)[number];

/**
 * How an Anthropic model is asked to think while it words a line (RENDER_THINKING):
 * - `disabled`: `thinking: { type: 'disabled' }`, no thinking (Claude Haiku 5.5, and models before the 5.5s);
 * - `between-tools`: `thinking: { type: 'between_tools' }`, Claude Sonnet 5.5's way to think not at all
 *   (it refuses `disabled`; accepted at effort high or below, and takes no other field);
 * - `adaptive`: `thinking: { type: 'adaptive', display: 'omitted' }`, the model thinks as much as it
 *   judges it needs (the thinking is never read: only the line's text block is, and its tokens are
 *   counted in the usage and the cost);
 * - `omit`: no `thinking` field, the model's default (Claude Opus 5.5 and Claude Fable think always, and
 *   refuse `disabled`).
 */
export const RENDER_THINKING_MODES = ['disabled', 'between-tools', 'adaptive', 'omit'] as const;
export type RenderThinkingMode = (typeof RENDER_THINKING_MODES)[number];
/** The effort an Anthropic model is asked for (RENDER_EFFORT, `output_config.effort`); absent, its own default. */
export const RENDER_EFFORTS = ['low', 'medium', 'high'] as const;
export type RenderEffort = (typeof RENDER_EFFORTS)[number];

export interface RenderThinking {
  mode: RenderThinkingMode;
  effort?: RenderEffort;
  /** True when the settings changed the model's default (THINKING_BY_MODEL): its recordings go to a cassette of their own. */
  overridden: boolean;
}

/**
 * Each Anthropic model's way of thinking least, by the start of its id, first match: a line is a few
 * words in well under a second. A model a row does not name is asked `disabled`, as every model was
 * before. Claude Opus 5.5 cannot stop thinking (it refuses `disabled` at every effort), so it is asked
 * for the least effort; it thinks still, and is slow for a line on a call.
 */
export const THINKING_BY_MODEL: readonly { prefix: string; thinking: { mode: RenderThinkingMode; effort?: RenderEffort } }[] = [
  { prefix: 'claude-haiku-5-5', thinking: { mode: 'disabled' } },
  { prefix: 'claude-sonnet-5-5', thinking: { mode: 'between-tools' } },
  { prefix: 'claude-opus-5-5', thinking: { mode: 'omit', effort: 'low' } },
  { prefix: 'claude-fable-', thinking: { mode: 'omit' } },
  { prefix: 'claude-mythos-', thinking: { mode: 'omit' } },
];

/** The model's default thinking (THINKING_BY_MODEL), then RENDER_THINKING and RENDER_EFFORT over it, each checked. */
export function renderThinkingOf(model: string, env: Env): RenderThinking {
  const row = THINKING_BY_MODEL.find((r) => model.startsWith(r.prefix))?.thinking ?? { mode: 'disabled' as const };
  const mode = value(env, 'RENDER_THINKING');
  const effort = value(env, 'RENDER_EFFORT');
  if (mode !== null && !(RENDER_THINKING_MODES as readonly string[]).includes(mode)) throw new Error(`RENDER_THINKING must be ${RENDER_THINKING_MODES.join(', ')}, got "${mode}"`);
  if (effort !== null && !(RENDER_EFFORTS as readonly string[]).includes(effort)) throw new Error(`RENDER_EFFORT must be ${RENDER_EFFORTS.join(', ')}, got "${effort}"`);
  const out: RenderThinking = {
    mode: (mode ?? row.mode) as RenderThinkingMode,
    ...((effort ?? row.effort) !== undefined ? { effort: (effort ?? row.effort) as RenderEffort } : {}),
    overridden: false,
  };
  out.overridden = out.mode !== row.mode || out.effort !== row.effort;
  return out;
}

/** The `thinking` and `output_config` an Anthropic request carries for `t`. */
export function anthropicThinkingBody(t: RenderThinking): Record<string, unknown> {
  const thinking = t.mode === 'disabled' ? { type: 'disabled' } : t.mode === 'between-tools' ? { type: 'between_tools' } : t.mode === 'adaptive' ? { type: 'adaptive', display: 'omitted' } : undefined;
  return { ...(thinking !== undefined ? { thinking } : {}), ...(t.effort !== undefined ? { output_config: { effort: t.effort } } : {}) };
}

/** Whether the model may think under `t`: then a request's max_tokens leaves room for it (THINKING_MAX_TOKENS). */
export function mayThink(t: RenderThinking | undefined): boolean {
  return t !== undefined && (t.mode === 'adaptive' || t.mode === 'omit');
}

/** How a run names `t`: "thinking disabled", "thinking adaptive, effort low". */
export function thinkingLabel(t: RenderThinking): string {
  return `thinking ${t.mode}${t.effort !== undefined ? `, effort ${t.effort}` : ''}`;
}

export interface RenderProvider {
  provider: RenderProviderName;
  model: string;
  /** Null when the variable is unset: a replay needs none. */
  apiKey: string | null;
  /** The variable the key is read from, for messages; never the key itself. */
  keyVar: string;
  url: string;
  /** How an Anthropic model thinks (RENDER_THINKING, RENDER_EFFORT); absent for OpenRouter. */
  thinking?: RenderThinking;
}

/**
 * The name a provider's recordings are kept under (render/cassette.ts renderCassettePath): the model,
 * and where the settings change how it thinks, that too (`claude-haiku-5-5.thinking-adaptive.effort-low`),
 * so a run with thinking on is recorded beside the one with it off rather than replaying it.
 */
export function renderCassetteModel(p: RenderProvider): string {
  const t = p.thinking;
  if (t === undefined || !t.overridden) return p.model;
  return `${p.model}.thinking-${t.mode}${t.effort !== undefined ? `.effort-${t.effort}` : ''}`;
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
  const model = value(env, 'RENDER_MODEL') ?? known.model;
  if (provider !== 'anthropic') {
    for (const name of ['RENDER_THINKING', 'RENDER_EFFORT']) if (value(env, name) !== null) throw new Error(`${name} applies to RENDER_PROVIDER=anthropic only (OpenRouter is asked to turn reasoning off); unset it`);
    return { provider, model, apiKey, keyVar: known.keyVar, url: known.url };
  }
  return { provider, model, apiKey, keyVar: known.keyVar, url: known.url, thinking: renderThinkingOf(model, env) };
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
/**
 * The most tokens a request may take when the model may think (RENDER_THINKING adaptive or omit): a
 * model's thinking counts against max_tokens, so 200 would cut the line off after its thinking (an
 * error, the fixed line said). The line itself is still held to its checks (600 characters, the word
 * budget); this only leaves the thinking room, and the turn's budget (RENDER_TIMEOUT_MS) bounds it anyway.
 */
const THINKING_MAX_TOKENS = 4000;

/** The API's own account of a failed request (its error's type and message), made safe to record: one line, short, no key. */
function apiError(json: unknown, key: string): { type?: string; message?: string } {
  const e = (json as { error?: unknown } | null)?.error;
  if (e === null || typeof e !== 'object') return {};
  const o = e as { type?: unknown; code?: unknown; message?: unknown };
  const type = typeof o.type === 'string' ? o.type : typeof o.code === 'string' ? o.code : undefined;
  const clean = (t: string): string => t.split(key).join('•').replace(/\b(sk|key)-[A-Za-z0-9_-]{8,}/g, '•').replace(/\s+/g, ' ').trim().slice(0, 200);
  return { ...(type !== undefined && /^[A-Za-z0-9_.-]{1,64}$/.test(type) ? { type } : {}), ...(typeof o.message === 'string' && o.message.trim() !== '' ? { message: clean(o.message) } : {}) };
}

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
    // A line's instructions, or a framed line's span's.
    const system = instructionsOf(req.act);
    const anthropic = this.p.provider === 'anthropic';
    const thinking = this.p.thinking ?? { mode: 'disabled', overridden: false };
    const body = anthropic
      ? { model: this.p.model, max_tokens: mayThink(thinking) ? THINKING_MAX_TOKENS : MAX_TOKENS, system, messages: [{ role: 'user', content }], ...anthropicThinkingBody(thinking) }
      // OpenRouter's own setting turns a model's reasoning off where it has one (a line, not a page; unconfirmed per model).
      : { model: this.p.model, max_tokens: MAX_TOKENS, reasoning: { enabled: false }, messages: [{ role: 'system', content: system }, { role: 'user', content }] };
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
    if (!res.ok) {
      // The status and the API's own error type, and its message for the trace: never the key or the request.
      const told = apiError(await res.json().catch(() => null), this.p.apiKey!);
      throw new RenderClientError(`${this.p.provider}: HTTP ${res.status}${told.type !== undefined ? ` ${told.type}` : ''}`, 'error', told.message);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new RenderClientError(`${this.p.provider}: the answer was not JSON`);
    }
    const parsed = anthropic ? anthropicAnswer(json) : openRouterAnswer(json);
    if ('stopped' in parsed) throw new RenderClientError(`${this.p.provider}: the answer had no line${parsed.stopped !== null ? ` (${parsed.stopped})` : ''}`);
    return { ...parsed, model: parsed.model ?? this.p.model, latencyMs: performance.now() - started, source: 'model' };
  }
}

type Answer = { text: string; model?: string; usage: { inputTokens: number; outputTokens: number } } | { stopped: string | null };

function anthropicAnswer(json: unknown): Answer {
  const b = json as { content?: { type?: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number }; model?: string; stop_reason?: string } | null;
  // A refusal, or a line cut off at the token limit (its thinking's tokens count against it), is no line.
  if (b === null || typeof b !== 'object' || !Array.isArray(b.content)) return { stopped: null };
  if (b.stop_reason === 'refusal' || b.stop_reason === 'max_tokens') return { stopped: b.stop_reason };
  // The line is the text blocks alone: a thinking block (empty, with display omitted) is never read or kept.
  const text = b.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  // The output tokens include any thinking's, so the cost counts it.
  return { text, ...(typeof b.model === 'string' ? { model: b.model } : {}), usage: { inputTokens: b.usage?.input_tokens ?? 0, outputTokens: b.usage?.output_tokens ?? 0 } };
}

function openRouterAnswer(json: unknown): Answer {
  const b = json as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string } | null;
  const text = b?.choices?.[0]?.message?.content;
  // A line cut off at the token limit is no line.
  if (b?.choices?.[0]?.finish_reason === 'length') return { stopped: 'length' };
  if (typeof text !== 'string') return { stopped: null };
  return { text, ...(typeof b?.model === 'string' ? { model: b.model } : {}), usage: { inputTokens: b?.usage?.prompt_tokens ?? 0, outputTokens: b?.usage?.completion_tokens ?? 0 } };
}

/** The lines a run prints about its renderer: which model, from where, or that it is replayed. Never the key. */
export function renderLines(p: RenderProvider | null, opts: { replayed?: boolean; fake?: boolean } = {}): string[] {
  if (opts.fake) return ['generated lines worded by the fake renderer (no model asked)'];
  if (p === null) return ['generated lines said fixed (RENDER_PROVIDER unset)'];
  return [`generated lines worded by ${p.model} from ${p.provider}${p.thinking !== undefined ? ` (${thinkingLabel(p.thinking)})` : ''}${opts.replayed ? ', replayed from its cassette' : ''}`];
}
