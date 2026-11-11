import { KNOWN } from '../../render/endpoints';
import { anthropicModel } from './anthropic';
import { openAiCompatModel } from './openaiCompat';
import type { ConverseModel } from './types';

const PROVIDERS = ['anthropic', 'inception', 'openrouter', 'meta'] as const;
type Provider = (typeof PROVIDERS)[number];

/** Meta's Model API (the Muse models) is the converse runtime's alone, so its key variable is named here. */
const keyVarOf = (p: Provider): string => (p === 'meta' ? 'META_API_KEY' : KNOWN[p].keyVar);

/**
 * The variable holding the key of the model a spec names (`anthropic:<model>` is ANTHROPIC_API_KEY, say), or
 * null for a spec no provider takes: what `pnpm diagnose` and `pnpm configure` name, never the key.
 */
export function converseModelKeyVar(spec: string): string | null {
  const provider = spec.slice(0, Math.max(0, spec.indexOf(':')));
  return (PROVIDERS as readonly string[]).includes(provider) ? keyVarOf(provider as Provider) : null;
}

/**
 * An OpenRouter model and the hosts it is pinned to: `vendor/model@groq` (or `@groq,cerebras`) asks those
 * hosts alone, never another; `vendor/model` lets OpenRouter choose among the hosts that collect no data.
 */
export function openRouterHosts(model: string): { model: string; only: string[] } {
  const at = model.indexOf('@');
  if (at < 0) return { model, only: [] };
  const only = model.slice(at + 1).split(',').map((h) => h.trim());
  if (only.some((h) => h === '')) throw new Error(`model "openrouter:${model}": name the OpenRouter hosts after @ (vendor/model@groq)`);
  return { model: model.slice(0, at), only };
}

/**
 * The model a spec names: `anthropic:<model>`, `inception:<model>`, `openrouter:<model>[@<host>,...]` or
 * `meta:<model>`, with its key from `env` (the error names the variable). Claude models are asked through the
 * Anthropic API only.
 */
export function resolveConverseModel(spec: string, env: Record<string, string | undefined>, fetchImpl?: typeof fetch): ConverseModel {
  const at = spec.indexOf(':');
  const provider = at < 0 ? '' : spec.slice(0, at);
  const model = at < 0 ? '' : spec.slice(at + 1);
  if (!(PROVIDERS as readonly string[]).includes(provider) || model === '') throw new Error(`model "${spec}": give <provider>:<model> with the provider ${PROVIDERS.join(', ')} (anthropic:claude-haiku-5-5, inception:mercury-3)`);
  const p = provider as Provider;
  if (p === 'openrouter' && /anthropic\/|claude/i.test(model)) throw new Error(`model "${spec}": Claude models go through the Anthropic API (anthropic:<model>), not OpenRouter`);
  if (p !== 'openrouter' && model.includes('@')) throw new Error(`model "${spec}": only an OpenRouter model names its hosts after @`);
  const hosts = p === 'openrouter' ? openRouterHosts(model) : { model, only: [] };
  const keyVar = keyVarOf(p);
  const apiKey = env[keyVar]?.trim();
  if (!apiKey) throw new Error(`missing required environment variable ${keyVar} (model ${spec})`);
  const f = fetchImpl ? { fetch: fetchImpl } : {};
  if (p === 'anthropic') return anthropicModel({ model, apiKey, ...f });
  return openAiCompatModel({ provider: p, model: hosts.model, apiKey, ...(hosts.only.length > 0 ? { only: hosts.only } : {}), ...f });
}
