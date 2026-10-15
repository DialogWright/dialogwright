import type { RenderModelChoice } from '../core/app/types';
import { actMessage, instructionsOf } from './prompt';
import { DEFAULT_RENDER_CHECK_TIMEOUT_MS, DEFAULT_RENDER_PRICE, DEFAULT_RENDER_TIMEOUT_MS, RenderClientError, type Generation, type RenderClient, type RenderPrice, type RenderRequest } from './types';

/**
 * Where generated lines are worded (generated wording, design section 5): a model reached through
 * OpenRouter (any model it serves) or the Anthropic API, with the author's own key, read from its own
 * variable and never from a flag; never logged, never in a trace. Chosen like the decision model:
 *
 * - RENDER_PROVIDER: `openrouter` or `anthropic`. Unset, the app's own (style.yaml's `model`,
 *   renderEnvOf); with neither, no line is generated: every line is its fixed text.
 * - RENDER_MODEL: the model id, read over the app's only with RENDER_PROVIDER set; default the app's
 *   own where its provider is in force, else a current Claude Haiku (`claude-haiku-5-5` on Anthropic, `anthropic/claude-haiku-5.5` on OpenRouter).
 * - the key: OPENROUTER_API_KEY or ANTHROPIC_API_KEY, the provider's own variable.
 * - RENDER_SHARE: the share of calls served generated, 0 to 100; default 100.
 * - RENDER_TIMEOUT_VOICE_MS and RENDER_TIMEOUT_CHAT_MS: how long a line's wording may take on a call and in
 *   a chat; default 900 and 1500 (the maintainer's decision, 2026-10-14: 900 on a call, where it was 700, and
 *   each channel set on its own, so changing one never changes the other). RENDER_TIMEOUT_MS sets both at
 *   once (as before), and a channel's own setting wins over it.
 * - RENDER_CHECK_TIMEOUT_VOICE_MS and RENDER_CHECK_TIMEOUT_CHAT_MS: how long the decision model's checks of a
 *   line may take together (the collected content screened again, the drift check); default 500 and 1000.
 *   RENDER_CHECK_TIMEOUT_MS sets both at once, and a channel's own setting wins over it.
 * - RENDER_PRICE_INPUT_PER_MTOK and RENDER_PRICE_OUTPUT_PER_MTOK: the model's price in US dollars per
 *   million tokens, for the cost in the trace and Insights; default the default model's.
 * - RENDER_THINKING and RENDER_EFFORT: how the model thinks (reasons) while it words a line. On Anthropic
 *   (renderThinkingOf), default the model's own way of thinking least (THINKING_BY_MODEL); on OpenRouter
 *   (openRouterThinkingOf), default reasoning off (`reasoning: { effort: 'none' }`), one vocabulary for both.
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
 *   refuse `disabled`). *
 * On OpenRouter the same words are sent as its `reasoning` setting (openRouterThinkingOf).
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
  const refused = refusedThinking(model, out.mode);
  if (refused !== null) throw new Error(`RENDER_THINKING=${out.mode} is refused by ${model}: ${refused}; unset RENDER_THINKING for the model's own (${row.mode})`);
  return out;
}

/** The models before adaptive thinking (Claude 3, and the 4 family before 4.6): they refuse `adaptive`. */
const BEFORE_ADAPTIVE = /^claude-(?:3|(?:haiku|sonnet|opus)-(?:3|4(?:-[0-5])?)(?:-\d{8})?$)/;

/**
 * Why `model` refuses thinking `mode` (the API answers a 400), or null: so the server and `pnpm
 * diagnose` refuse the setting before any call. By the model id's start, as THINKING_BY_MODEL; a model
 * neither names is let through, as the API is the judge of what it does not know.
 */
export function refusedThinking(model: string, mode: RenderThinkingMode): string | null {
  const sonnet55 = model.startsWith('claude-sonnet-5-5');
  if (mode === 'disabled' && (sonnet55 || model.startsWith('claude-opus-5-5') || model.startsWith('claude-fable-') || model.startsWith('claude-mythos-'))) {
    return sonnet55 ? 'it cannot turn thinking off that way (its way is between-tools)' : 'it cannot turn thinking off (omit it, and lower RENDER_EFFORT)';
  }
  if (mode === 'between-tools' && !sonnet55) return 'only Claude Sonnet 5.5 takes between-tools';
  if (mode === 'adaptive' && BEFORE_ADAPTIVE.test(model)) return 'it is older than adaptive thinking';
  return null;
}

/**
 * How an OpenRouter model reasons while it words a line, in the same vocabulary (RENDER_THINKING,
 * RENDER_EFFORT), sent as OpenRouter's `reasoning` object (openRouterReasoningBody); null when neither is
 * set (reasoning off, the default). An effort given alone turns reasoning on at that effort; `adaptive`
 * without an effort is OpenRouter's own default effort when reasoning is on, `medium`, and is named so
 * (in the run's header and the cassette's name); `between-tools` is Claude Sonnet 5.5's on Anthropic,
 * refused here; and `disabled` with an effort is refused (an effort is for reasoning). Which model
 * honours which setting is OpenRouter's and the model's: a model that always reasons refuses reasoning
 * off (live: "Reasoning is mandatory for this endpoint and cannot be disabled."), and needs an effort.
 */
export function openRouterThinkingOf(env: Env): RenderThinking | null {
  const mode = value(env, 'RENDER_THINKING');
  const effort = value(env, 'RENDER_EFFORT');
  if (mode === null && effort === null) return null;
  if (mode !== null && !(RENDER_THINKING_MODES as readonly string[]).includes(mode)) throw new Error(`RENDER_THINKING must be ${RENDER_THINKING_MODES.join(', ')}, got "${mode}"`);
  if (effort !== null && !(RENDER_EFFORTS as readonly string[]).includes(effort)) throw new Error(`RENDER_EFFORT must be ${RENDER_EFFORTS.join(', ')}, got "${effort}"`);
  if (mode === 'between-tools') throw new Error('RENDER_THINKING=between-tools is Claude Sonnet 5.5\'s on RENDER_PROVIDER=anthropic; on OpenRouter use disabled, adaptive or omit');
  if (mode === 'disabled' && effort !== null) throw new Error('RENDER_EFFORT asks for reasoning, which RENDER_THINKING=disabled turns off: unset one');
  const m = (mode ?? 'adaptive') as RenderThinkingMode;
  // Reasoning on with no effort named is OpenRouter's medium: said as such.
  const e = (effort ?? (m === 'adaptive' ? 'medium' : undefined)) as RenderEffort | undefined;
  return { mode: m, ...(e !== undefined ? { effort: e } : {}), overridden: m !== 'disabled' };
}

/**
 * The `reasoning` object an OpenRouter request carries for `t`, as OpenRouter's documentation describes
 * its unified setting (what each model does with it is unconfirmed): reasoning off (no setting, or
 * `disabled`) `{ effort: 'none' }`, the documented way to turn it off; an effort `{ effort, exclude: true }`
 * (`adaptive` always has one: medium unless named); `omit` alone no field, the model's own default.
 * `exclude: true` asks that the reasoning not be returned: only the line (`message.content`) is ever read,
 * and a reasoning text that comes back anyway (`message.reasoning`) is never read or kept. The body is
 * not in a recording's key (render/prompt.ts renderKey), so recordings made with the earlier off form
 * (`{ enabled: false }`) replay as they are.
 */
export function openRouterReasoningBody(t: RenderThinking | undefined): Record<string, unknown> {
  if (t === undefined || t.mode === 'disabled') return { reasoning: { effort: 'none' } };
  if (t.effort !== undefined) return { reasoning: { effort: t.effort, exclude: true } };
  return {};
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
  /** How the model thinks (RENDER_THINKING, RENDER_EFFORT): always on Anthropic; on OpenRouter only where one is set (openRouterThinkingOf). */
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
    const thinking = openRouterThinkingOf(env);
    return { provider, model, apiKey, keyVar: known.keyVar, url: known.url, ...(thinking !== null ? { thinking } : {}) };
  }
  return { provider, model, apiKey, keyVar: known.keyVar, url: known.url, thinking: renderThinkingOf(model, env) };
}

/**
 * The environment a renderer is resolved from, with the model the app names (style.yaml's `model`,
 * App.generated.model; live findings item 27) as its default:
 * - RENDER_PROVIDER unset: the app's provider and model id (the provider's default model where the app
 *   names no id). A RENDER_MODEL set without RENDER_PROVIDER is not read: an id left from another
 *   provider never reaches the app's.
 * - RENDER_PROVIDER the app's: RENDER_MODEL where set, else the app's model id.
 * - RENDER_PROVIDER another provider: the environment alone (that provider, RENDER_MODEL or its default).
 * `env` itself for an app that names none, so its renderer is chosen as before. Never a key: keys are
 * read from the environment only.
 */
export function renderEnvOf(env: Env, model: RenderModelChoice | undefined): Env {
  if (model === undefined) return env;
  const provider = value(env, 'RENDER_PROVIDER');
  if (provider !== null && provider !== model.provider) return env;
  const id = (provider !== null ? value(env, 'RENDER_MODEL') : null) ?? model.id;
  const { RENDER_MODEL: _ignored, ...rest } = env;
  return { ...rest, RENDER_PROVIDER: model.provider, ...(id !== undefined ? { RENDER_MODEL: id } : {}) };
}

/** Where the render model came from: the app's style.yaml, the environment, or nowhere (no line generated). */
export type RenderModelSource = 'style.yaml' | 'environment' | null;

/**
 * Where the model a renderer is resolved with came from (renderEnvOf): `style.yaml` where the app's
 * model is in force with its own id (RENDER_PROVIDER unset, or the app's with no RENDER_MODEL), else
 * `environment` where RENDER_PROVIDER is set, else null.
 */
export function renderModelSource(env: Env, model: RenderModelChoice | undefined): RenderModelSource {
  const provider = value(env, 'RENDER_PROVIDER');
  if (model === undefined || (provider !== null && provider !== model.provider)) return provider === null ? null : 'environment';
  if (provider === null) return 'style.yaml';
  return value(env, 'RENDER_MODEL') !== null ? 'environment' : 'style.yaml';
}

/** How a server's line and `pnpm diagnose` say where the model came from. */
export function renderModelSourceLabel(source: RenderModelSource): string {
  return source === 'style.yaml' ? "named in style.yaml" : 'named by the environment';
}

/**
 * The key's variable when the environment leaves the choice of model to the app (RENDER_PROVIDER unset,
 * style.yaml's `model` named) and that key is unset; else null. The server then says every line fixed,
 * with a warning, and `pnpm diagnose` warns, as it does with no model named at all: an app that names
 * its model still starts on a machine without the key. Where RENDER_PROVIDER is set, the environment has
 * chosen, and a missing key refuses the start as it always has (resolveRenderProvider).
 */
export function appModelKeyMissing(env: Env, model: RenderModelChoice | undefined): string | null {
  if (model === undefined || value(env, 'RENDER_PROVIDER') !== null) return null;
  const keyVar = KNOWN[model.provider].keyVar;
  return value(env, keyVar) === null ? keyVar : null;
}

/** How a run names the model an app names: `style.yaml's model, openrouter google/gemini-...`. */
export function appModelLabel(model: RenderModelChoice): string {
  return `style.yaml's model, ${model.provider}${model.id !== undefined ? ` ${model.id}` : ''}`;
}

/**
 * The render provider for an app: resolveRenderProvider over renderEnvOf (the app's own model as the
 * default, the environment over it). With the key needed (the default) and the app's model in force
 * without its key, the error names style.yaml rather than a RENDER_PROVIDER that was never set.
 */
export function resolveAppRenderProvider(env: Env, model: RenderModelChoice | undefined, opts: { needKey?: boolean } = {}): RenderProvider | null {
  const missing = (opts.needKey ?? true) ? appModelKeyMissing(env, model) : null;
  if (missing !== null) throw new Error(`missing required environment variable ${missing} (${appModelLabel(model!)})`);
  return resolveRenderProvider(renderEnvOf(env, model), opts);
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

/**
 * A budget per channel: the channel's own setting (`<base>_VOICE_MS`, `<base>_CHAT_MS`), else the setting for
 * both (`<base>_MS`), else the channel's default. Setting one channel never changes the other.
 */
function perChannel(env: Env, base: string, defaults: { readonly voice: number; readonly chat: number }): { voice: number; chat: number } {
  const both = value(env, `${base}_MS`) === null ? null : bounded(env, `${base}_MS`, 50, 30_000, 0);
  const one = (channel: 'voice' | 'chat'): number => {
    const name = `${base}_${channel.toUpperCase()}_MS`;
    return value(env, name) === null ? (both ?? defaults[channel]) : bounded(env, name, 50, 30_000, 0);
  };
  return { voice: one('voice'), chat: one('chat') };
}

/** RENDER_SHARE, the wording's and the checks' budgets per channel, and the price, with their defaults. */
export function renderSettings(env: Env = process.env): { share: number; timeoutMs: { voice: number; chat: number }; checkTimeoutMs: { voice: number; chat: number }; price: RenderPrice } {
  return {
    share: bounded(env, 'RENDER_SHARE', 0, 100, 100),
    timeoutMs: perChannel(env, 'RENDER_TIMEOUT', DEFAULT_RENDER_TIMEOUT_MS),
    checkTimeoutMs: perChannel(env, 'RENDER_CHECK_TIMEOUT', DEFAULT_RENDER_CHECK_TIMEOUT_MS),
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
  const o = e as { type?: unknown; code?: unknown; message?: unknown; metadata?: unknown };
  // Anthropic's error has a type; OpenRouter's a code, which may be the HTTP status again (a number:
  // then nothing is added to the status), or a name.
  const type = typeof o.type === 'string' ? o.type : typeof o.code === 'string' ? o.code : undefined;
  const own = typeof o.message === 'string' && o.message.trim() !== '' ? o.message : null;
  const upstream = upstreamError(o.metadata);
  const message = own !== null && upstream !== null ? `${own} (${upstream})` : own ?? upstream;
  return { ...(type !== undefined && WORD.test(type) ? { type } : {}), ...(message !== null ? { message: safeErrorText(message, key) } : {}) };
}

/** A word an error may name as it is: a type, a code, a provider. */
const WORD = /^[A-Za-z0-9_.-]{1,64}$/;

/** The longest provider message kept: a sentence saying why, never a payload. */
const SHORT_MESSAGE = 160;

/**
 * What OpenRouter passes on of an upstream provider's error (`error.metadata`), in the few fields that
 * say why: the provider's name, its error type and code where given, and its own message only when it
 * is short, read from the provider's error (`raw`, its body: `error.message` or `message` of it as
 * JSON, or the text itself). Never the rest of the payload, which may be the provider's verbatim answer
 * (a content decline can quote the caller's words), and never a moderation's flagged input. Null when
 * there is nothing.
 */
function upstreamError(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  const m = metadata as { provider_name?: unknown; error_type?: unknown; provider_code?: unknown; raw?: unknown };
  const word = (v: unknown): string | null => (typeof v === 'string' && WORD.test(v) ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
  const provider = typeof m.provider_name === 'string' && /^[A-Za-z0-9 _.-]{1,40}$/.test(m.provider_name) ? m.provider_name : null;
  let said: string | null = null;
  if (typeof m.raw === 'string' && m.raw.trim() !== '') {
    let text: unknown = m.raw;
    try {
      const parsed = JSON.parse(m.raw) as { error?: { message?: unknown } | string; message?: unknown } | null;
      text = typeof parsed?.error === 'object' && parsed.error !== null ? parsed.error.message : typeof parsed?.error === 'string' ? parsed.error : parsed?.message;
    } catch {
      // Not JSON: the text itself.
    }
    if (typeof text === 'string') {
      const one = text.replace(/\s+/g, ' ').trim();
      if (one !== '' && one.length <= SHORT_MESSAGE) said = one;
    }
  }
  const codes = [word(m.error_type), word(m.provider_code)].filter((c): c is string => c !== null);
  const parts = [...codes, ...(said !== null ? [said] : [])].join(': ');
  if (provider === null && parts === '') return null;
  return provider === null ? parts : parts === '' ? provider : `${provider}: ${parts}`;
}

/**
 * An API's account of a failed request, made safe to record: one line, at most 200 characters, the key
 * masked, anything shaped like a key (`sk-...`, `key-...`) and any long unbroken token (24 characters or
 * more of letters, digits, `_` and `-`: another provider's key such as `AIza...`, a bearer token) masked.
 */
function safeErrorText(t: string, key: string): string {
  return t.split(key).join('•').replace(/\b(sk|key)-[A-Za-z0-9_-]{8,}/g, '•').replace(/[A-Za-z0-9_-]{24,}/g, '•').replace(/\s+/g, ' ').trim().slice(0, 200);
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
    const thinking: RenderThinking = this.p.thinking ?? { mode: 'disabled', overridden: false };
    const body = anthropic
      ? { model: this.p.model, max_tokens: mayThink(thinking) ? THINKING_MAX_TOKENS : MAX_TOKENS, system, messages: [{ role: 'user', content }], ...anthropicThinkingBody(thinking) }
      // OpenRouter's own setting turns a model's reasoning off where it has one (a line, not a page; unconfirmed
      // per model), unless RENDER_THINKING or RENDER_EFFORT asks for it (openRouterReasoningBody).
      : { model: this.p.model, max_tokens: mayThink(this.p.thinking) ? THINKING_MAX_TOKENS : MAX_TOKENS, ...openRouterReasoningBody(this.p.thinking), messages: [{ role: 'system', content: system }, { role: 'user', content }] };
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
  const text = b.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join(' ').trim();
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
