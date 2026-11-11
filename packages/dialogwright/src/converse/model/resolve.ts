import { KNOWN } from '../../render/endpoints';
import { anthropicModel } from './anthropic';
import { openAiCompatModel } from './openaiCompat';
import type { ConverseModel } from './types';

const PROVIDERS = ['anthropic', 'inception', 'openrouter'] as const;

/**
 * The variable holding the key of the model a spec names (`anthropic:<model>` is ANTHROPIC_API_KEY, say), or
 * null for a spec no provider takes: what `pnpm diagnose` and `pnpm configure` name, never the key.
 */
export function converseModelKeyVar(spec: string): string | null {
  const provider = spec.slice(0, Math.max(0, spec.indexOf(':')));
  return (PROVIDERS as readonly string[]).includes(provider) ? KNOWN[provider as (typeof PROVIDERS)[number]].keyVar : null;
}

/**
 * The model a spec names: `anthropic:<model>`, `inception:<model>` or `openrouter:<model>`, with its key
 * from `env` (the error names the variable). Claude models are asked through the Anthropic API only.
 */
export function resolveConverseModel(spec: string, env: Record<string, string | undefined>, fetchImpl?: typeof fetch): ConverseModel {
  const at = spec.indexOf(':');
  const provider = at < 0 ? '' : spec.slice(0, at);
  const model = at < 0 ? '' : spec.slice(at + 1);
  if (!(PROVIDERS as readonly string[]).includes(provider) || model === '') throw new Error(`model "${spec}": give <provider>:<model> with the provider ${PROVIDERS.join(', ')} or openrouter (anthropic:claude-haiku-5-5, inception:mercury-3)`);
  const p = provider as (typeof PROVIDERS)[number];
  if (p === 'openrouter' && /anthropic\/|claude/i.test(model)) throw new Error(`model "${spec}": Claude models go through the Anthropic API (anthropic:<model>), not OpenRouter`);
  const keyVar = KNOWN[p].keyVar;
  const apiKey = env[keyVar]?.trim();
  if (!apiKey) throw new Error(`missing required environment variable ${keyVar} (model ${spec})`);
  return p === 'anthropic' ? anthropicModel({ model, apiKey, ...(fetchImpl ? { fetch: fetchImpl } : {}) }) : openAiCompatModel({ provider: p, model, apiKey, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}
