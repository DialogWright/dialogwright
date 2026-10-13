import { loadConfig } from './config';
import { resolveJevProvider } from '../jev/provider';
import { renderSettings, resolveRenderProvider } from '../render/providers';

/**
 * The names of the server's own settings: what its readers read (loadConfig, the decision model's and
 * the renderer's provider settings), found by running them over environments that record each name
 * asked for, never by a list kept by hand, so a setting added to a reader is known here at once. Each
 * environment turns on one part of the server (both carriers, the trace store, a database, the chat and
 * its sign-in, each model provider, the console's sign-in, the widget), and a reader that stops on a
 * setting it needs is given that setting and run again, so the settings behind it are read too.
 *
 * Under a host (host.yaml) an app's own settings file is not read for these: one left there (a carrier's
 * secret, a model's key, PUBLIC_HOST, a store's URL) does nothing, which is worth a warning; any other
 * name in it is the app's code's (ctx.env). Names only: no value is read from anything real.
 */

/** The environments the readers are run over, each turning one part of the server on. */
const PARTS: readonly Readonly<Record<string, string>>[] = [
  {},
  { VOICE_PROVIDERS: 'twilio,telnyx' },
  { TRACE_STORE: 's3://bucket/prefix', S3_ACCESS_KEY_ID: 'x', S3_SECRET_ACCESS_KEY: 'x' },
  { SESSION_STORE: 'postgres://user@localhost/db', AUDIT_STORE: 'postgres://user@localhost/db' },
  { CHAT: 'on', CHAT_ALLOWED_ORIGINS: 'https://www.example.com', CHAT_SIGNIN: 'jwt', CHAT_JWKS_URL: 'https://id.example.com/jwks' },
  { JEV_CLIENT: 'jev', JEV_PROVIDER: 'typesafe' },
  { JEV_CLIENT: 'jev', JEV_PROVIDER: 'openrouter' },
  { JEV_CLIENT: 'jev', JEV_PROVIDER: 'vercel' },
  { JEV_CLIENT: 'jev', JEV_PROVIDER: 'custom', JEV_BASE_URL: 'https://jev.example.com' },
  { RENDER_PROVIDER: 'openrouter' },
  { RENDER_PROVIDER: 'anthropic' },
  { CONSOLE_AUTH: 'token' },
  { WIDGET: 'on' },
];

/** What every environment starts with: the settings a server cannot start without. */
const BASE: Readonly<Record<string, string>> = { PUBLIC_HOST: 'example.com', TWILIO_AUTH_TOKEN: 'x', HANDOFF_NUMBER: '+15555550100' };

const READERS: readonly ((env: Record<string, string | undefined>) => unknown)[] = [
  (env) => loadConfig(env),
  (env) => resolveJevProvider(env, { needKey: true }),
  (env) => resolveRenderProvider(env, { needKey: true }),
  (env) => renderSettings(env),
];

/** A setting's name, as a message from a reader names one. */
const NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b[A-Z]{4,}\b/g;

let known: ReadonlySet<string> | null = null;

/** The names of the server's own settings (above), worked out once. */
export function serverSettingNames(): ReadonlySet<string> {
  if (known !== null) return known;
  const read = new Set<string>();
  for (const part of PARTS) {
    for (const reader of READERS) {
      const values: Record<string, string> = { ...BASE, ...part };
      for (let round = 0; round < 8; round++) {
        const env = new Proxy(values, {
          get: (t, k) => {
            if (typeof k === 'string') read.add(k);
            return Reflect.get(t, k) as unknown;
          },
          has: (t, k) => {
            if (typeof k === 'string') read.add(k);
            return Reflect.has(t, k);
          },
        });
        try {
          reader(env);
          break;
        } catch (err) {
          // A setting the reader needs: given a value, and the reader run again to reach what is behind it.
          const named = (err instanceof Error ? err.message : '').match(NAME) ?? [];
          const fresh = named.filter((n) => read.has(n) && !Object.hasOwn(values, n));
          if (fresh.length === 0) break;
          for (const n of fresh) values[n] = 'x';
        }
      }
    }
  }
  known = read;
  return known;
}
