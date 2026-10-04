import { JEV_MODEL } from './sdkClient';

/**
 * Where the decision model is reached. The same API contract (POST <baseURL>/v1/systemone, a
 * Bearer key, the same request and answer shapes) is served by TypeSafe itself, by two gateways
 * that resell TypeSafe's Jev, and by any endpoint that mimics it:
 *
 * - `typesafe` (the default): https://api.typesafe.ai, TYPESAFE_API_KEY, the pinned JEV_MODEL.
 * - `openrouter`: https://openrouter.ai/api, OPENROUTER_API_KEY, `typesafe/jev-1.13`.
 * - `vercel` (the AI Gateway): https://ai-gateway.vercel.sh/typesafe, AI_GATEWAY_API_KEY, `typesafe-ai/jev`.
 * - `custom`: JEV_BASE_URL and JEV_MODEL (both required), JEV_API_KEY (optional: a local server may need none).
 *
 * The first three serve TypeSafe's Jev, so they are `official`. A custom endpoint, an open-weight
 * model that speaks the same API, is not: it answers in the same shape, but its probabilities are
 * not calibrated like Jev's, and every confidence threshold was measured on Jev.
 */
export const JEV_PROVIDERS = ['typesafe', 'openrouter', 'vercel', 'custom'] as const;
export type JevProviderName = (typeof JEV_PROVIDERS)[number];

export interface JevProvider {
  provider: JevProviderName;
  /** No trailing slash; the SDK appends /v1/systemone. */
  baseURL: string;
  /** The model id sent with every request, and the name of its cassette (cassetteFileName). */
  model: string;
  /** Null when the variable is unset: a replay needs none, and a custom endpoint may need none. */
  apiKey: string | null;
  /** The variable the key is read from, for messages; never the key itself. */
  keyVar: string;
  /** True for the providers that serve TypeSafe's Jev, whose probabilities the thresholds were measured on. */
  official: boolean;
}

const OFFICIAL: Record<Exclude<JevProviderName, 'custom'>, { baseURL: string; keyVar: string; model: string }> = {
  typesafe: { baseURL: 'https://api.typesafe.ai', keyVar: 'TYPESAFE_API_KEY', model: JEV_MODEL },
  // OpenRouter documents POST /api/v1/systemone; the SDK appends /v1/systemone to the base.
  openrouter: { baseURL: 'https://openrouter.ai/api', keyVar: 'OPENROUTER_API_KEY', model: 'typesafe/jev-1.13' },
  vercel: { baseURL: 'https://ai-gateway.vercel.sh/typesafe', keyVar: 'AI_GATEWAY_API_KEY', model: 'typesafe-ai/jev' },
};

type Env = Record<string, string | undefined>;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function value(env: Env, name: string): string | null {
  return env[name]?.trim() || null;
}

/**
 * A base URL a key may be sent to: https, or plain http only to this machine, so a key never
 * crosses the network in the clear. The messages name the variable and, at most, the scheme and
 * host: never the whole value, which could carry a credential.
 */
function baseUrl(raw: string, from: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${from} must be a URL like https://jev.example.com`);
  }
  if (url.username || url.password) throw new Error(`${from} must not carry credentials; put the key in its own variable`);
  const local = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !local) {
    throw new Error(`${from} must be https unless its host is localhost, 127.0.0.1 or [::1] (a key must not go over plain http to another machine), got ${url.protocol}//${url.hostname}`);
  }
  return raw.replace(/\/+$/, '');
}

/**
 * The one place a live or recorded client learns where the model is: from JEV_PROVIDER (default
 * `typesafe`), the overrides JEV_BASE_URL and JEV_MODEL, and the provider's key variable.
 * `needKey` (default true) is false for a replay, which reads a cassette and sends nothing.
 */
export function resolveJevProvider(env: Env = process.env, opts: { needKey?: boolean } = {}): JevProvider {
  const needKey = opts.needKey ?? true;
  const raw = value(env, 'JEV_PROVIDER') ?? 'typesafe';
  if (!(JEV_PROVIDERS as readonly string[]).includes(raw)) {
    throw new Error(`JEV_PROVIDER must be ${JEV_PROVIDERS.slice(0, -1).join(', ')} or ${JEV_PROVIDERS.at(-1)!}, got "${raw}"`);
  }
  const provider = raw as JevProviderName;
  const missing = (name: string) => new Error(`missing required environment variable ${name} (JEV_PROVIDER=${provider})`);
  if (provider === 'custom') {
    const base = value(env, 'JEV_BASE_URL');
    if (!base) throw missing('JEV_BASE_URL');
    const model = value(env, 'JEV_MODEL');
    if (!model) throw missing('JEV_MODEL');
    return { provider, baseURL: baseUrl(base, 'JEV_BASE_URL'), model, apiKey: value(env, 'JEV_API_KEY'), keyVar: 'JEV_API_KEY', official: false };
  }
  const known = OFFICIAL[provider];
  // The SDK's own variable, kept for whoever already points TypeSafe's client at another host with it.
  const legacy = provider === 'typesafe' ? value(env, 'TYPESAFE_BASE_URL') : null;
  const base = value(env, 'JEV_BASE_URL');
  const baseURL = base ? baseUrl(base, 'JEV_BASE_URL') : legacy ? baseUrl(legacy, 'TYPESAFE_BASE_URL') : known.baseURL;
  const apiKey = value(env, known.keyVar);
  if (needKey && !apiKey) throw missing(known.keyVar);
  return { provider, baseURL, model: value(env, 'JEV_MODEL') ?? known.model, apiKey, keyVar: known.keyVar, official: true };
}

/**
 * A cassette's file name: the model id, made safe to name a file. A slash or backslash (a
 * gateway's `vendor/model`) becomes two underscores, anything else outside letters, digits, dot,
 * dash and underscore one. The pinned model's is `jev-1.13.0.jsonl`, as it always was.
 */
export function cassetteFileName(model: string): string {
  return `${model.replace(/[/\\]/g, '__').replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`;
}

export const UNCALIBRATED_WARNING =
  "warning: this model's probabilities are not Jev's, so the confidence thresholds (measured on Jev) may need re-measuring: record a cassette with this model and compare it with regress";

/**
 * What a run prints at its start about the model: which one, from where (or, `replayed`, that its
 * answers come from its cassette), and for a model that is not Jev, the warning. Never the key.
 */
export function modelLines(p: JevProvider, opts: { replayed?: boolean } = {}): string[] {
  const where = opts.replayed ? ', replayed from its cassette' : ` (${p.baseURL})`;
  return [`model ${p.model} from ${p.provider}${where}`, ...(p.official ? [] : [UNCALIBRATED_WARNING])];
}
