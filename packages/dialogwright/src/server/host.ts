import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { App } from '../core/app/types';
import { getApp, registerApp, registerConverseApp, registeredConverseApps } from '../core/app/registry';
import { isConverseApp, type ConverseApp } from '../converse/app';
import { digitsOf, sameNumber } from '../core/conditions';
import { appYamlEnvReferences } from '../define/envReferences';
import { resolveHostFile, type HostAppRef, type ResolvedHost } from '../define/host';
import { formatProblem } from '../define/problems';
import type { Env } from './config';
import { readEnvFile } from './envFile';
import { E164 } from './transfer';
import { serverSettingNames } from './serverSettings';


/**
 * Several apps on one server (host.yaml, ../define/host.ts): the apps it runs, each with the
 * environment its own references are read from, and the numbers that reach each. The number called,
 * as the carrier delivers it (the same matching as a `called` condition, core/conditions.ts
 * sameNumber), picks the app for a call; a number listed nowhere, or none, picks the default.
 *
 * Settings come in two layers. The server's settings file (ENV_FILE, or the environment) holds what
 * every app shares: carrier secrets, the model and its key, PUBLIC_HOST, the stores, the port, and the
 * numbers host.yaml lists. Each app's own settings file (its .env, or the one host.yaml names) is read
 * only for the variables the app's YAML names (env.<NAME>: transfer targets, startParameters, called
 * numbers, voice.numbers), and only for that app: two apps may each give MAIN_LINE a number of their
 * own. A variable an app names and its own file does not set is read from the server's settings. The
 * app's code reads its settings by name at call time (AppContext.env): its own file, the whole of it,
 * over the server's settings; `process.env` is the server's alone.
 */

/**
 * An app a server runs: a scripted app (App, the engine's turn) or a converse app (ConverseApp, whose
 * model holds the conversation: src/converse). The server dispatches by it: a converse app's chat runs on
 * the converse runtime, and it takes no calls yet.
 */
export type HostedApp = App | ConverseApp;

/** One app a host runs. `A`: any app a server runs (HostedApp, the default: what loadHost and ServerOverrides.apps carry), or a scripted app (App) where a caller knows it is one. */
export interface HostApp<A extends HostedApp = HostedApp> {
  readonly id: string;
  readonly app: A;
  /** The app's folder, when it has one (a host file's apps all do). */
  readonly dir?: string;
  /** The environment the app's references are read from: the server's, with the app's own file's values of its variables over it. */
  readonly env: Env;
  /** The variables its own file set for it, by name only (the log says them, never a value). */
  readonly own: readonly string[];
  /** The variables in its own file it does not name, which the server does not read for it (a server setting left in an app's .env, say); its code may (`settings`). */
  readonly ignored: readonly string[];
  /**
   * What the app's code reads by name (AppContext.env, RunOptions.settings): the server's settings with
   * the whole of its own file over them, its variables and the rest. Absent, `env`.
   */
  readonly settings?: Env;
  /** The variable that holds each of its services' URLs (host.yaml's `services`), by service name; absent, none. */
  readonly services?: Readonly<Record<string, string>>;
}

/**
 * The server settings an app may give its own value under a host, in its own settings file: where its
 * handoffs go when it has no transfer targets (HANDOFF_NUMBER), and its chat's sign-in: whom its tokens
 * are for (CHAT_AUDIENCE), who issues them (CHAT_ISSUER) and where that issuer's keys are
 * (CHAT_JWKS_URL), so each app's portal may use an identity provider of its own; and the number its texts are
 * sent from (TEXT_FROM: a business's own number, texts/settings.ts) and its texts' abuse limits
 * (TEXT_LIMIT_PER_NUMBER, TEXT_LIMIT_PER_HOUR, TEXT_LIMIT_EXEMPT). Absent there, the server's.
 */
export const APP_OWN_SETTINGS: readonly string[] = ['HANDOFF_NUMBER', 'CHAT_AUDIENCE', 'CHAT_ISSUER', 'CHAT_JWKS_URL', 'TEXT_FROM', 'TEXT_LIMIT_PER_NUMBER', 'TEXT_LIMIT_PER_HOUR', 'TEXT_LIMIT_EXEMPT'];

/**
 * What an app's own settings file sets beyond what the server reads from it (`ignored`), in two: the
 * server's own settings left there (serverSettingNames: a carrier's secret, a model's key, PUBLIC_HOST, a
 * store's URL), which do nothing in an app's file under a host and are worth a warning; and the rest, the
 * app's code's (ctx.env). Names only.
 */
export function splitOwnSettings(ignored: readonly string[]): { server: string[]; code: string[] } {
  const known = serverSettingNames();
  return { server: ignored.filter((n) => known.has(n)), code: ignored.filter((n) => !known.has(n)) };
}

/** What a server's log and diagnose say of an app's own settings file beyond what the server reads from it, a line each (WARNING for the server's settings). */
export function ownSettingsLines(file: string, ignored: readonly string[]): { warn: string | null; info: string | null } {
  const { server, code } = splitOwnSettings(ignored);
  return {
    warn: server.length === 0 ? null : `${file} sets ${server.join(', ')}, the server's own setting${server.length === 1 ? '' : 's'}: under a host the server reads ${server.length === 1 ? 'it' : 'them'} only from its own settings file, so here ${server.length === 1 ? 'it does' : 'they do'} nothing`,
    info: code.length === 0 ? null : `${file} also sets ${code.join(', ')}, not named by its YAML: available to its code through ctx.env`,
  };
}

/** The fix for a server setting left in an app's own settings file. */
export const OWN_SERVER_SETTING_FIX = 'move it to the server\'s settings file (the .env beside host.yaml, or ENV_FILE), or delete it here';

/** One number a host routes: the variable that holds it, its value, and the app it reaches. */
export interface HostNumber {
  readonly variable: string;
  readonly value: string;
  readonly app: string;
}

/** The apps a host runs and how a call finds its app. */
export interface HostRouting<A extends HostedApp = HostedApp> {
  /** The apps, the default first, then in the order host.yaml lists them. */
  readonly apps: readonly HostApp<A>[];
  readonly defaultApp: string;
  readonly numbers: readonly HostNumber[];
  /** The app a call to `called` reaches: the one its number points at, else the default. */
  appFor(called: string | null | undefined): string;
  /** The app host.yaml's `numbers` list `called` for, or null where none does (no default). */
  listedFor(called: string | null | undefined): string | null;
  /**
   * What the server says as it starts about the numbers: a ten-digit national number that would match
   * two of them (a +1 number and another country's ending in the same ten digits) reaches the first.
   */
  readonly warnings: readonly string[];
  /** Whether the host runs an app of this id. */
  has(id: string): boolean;
  /** The app of this id; throws for one the host does not run. */
  get(id: string): HostApp<A>;
}

/**
 * The routing over `apps` (the default first, or named by `defaultApp`) and `numbers`, each number's
 * value read from `env` (the server's settings). Throws, with the fix, for a number unset or not E.164,
 * and for two variables holding one number: a call to it could reach either app.
 */
export function hostRouting<A extends HostedApp = HostedApp>(o: { apps: readonly HostApp<A>[]; numbers: readonly { variable: string; app: string }[]; defaultApp: string; env: Env }): HostRouting<A> {
  const byId = new Map(o.apps.map((a) => [a.id, a]));
  if (!byId.has(o.defaultApp)) throw new Error(`host: the default app "${o.defaultApp}" is not one of the apps (${[...byId.keys()].join(', ')})`);
  const numbers = hostNumbers(o.numbers, [...byId.keys()], o.env);
  const ordered = [byId.get(o.defaultApp)!, ...o.apps.filter((a) => a.id !== o.defaultApp)];
  const listedFor = (called: string | null | undefined): string | null => {
    if (called === null || called === undefined || called.trim() === '') return null;
    // Digit for digit first; a ten-digit national number's match only when none is exact.
    const digits = digitsOf(called);
    return (numbers.find((n) => digitsOf(n.value) === digits) ?? numbers.find((n) => sameNumber(called, n.value)))?.app ?? null;
  };
  return {
    apps: ordered,
    defaultApp: o.defaultApp,
    numbers,
    appFor: (called) => listedFor(called) ?? o.defaultApp,
    listedFor,
    warnings: nationalTwins(numbers),
    has: (id) => byId.has(id),
    get(id) {
      const app = byId.get(id);
      if (app === undefined) throw new Error(`host: no app "${id}"`);
      return app;
    },
  };
}

/** The pairs of numbers whose last ten digits are the same: a call delivered as that ten-digit number matches both. */
function nationalTwins(numbers: readonly HostNumber[]): string[] {
  const out: string[] = [];
  numbers.forEach((n, i) => {
    for (const m of numbers.slice(0, i)) {
      const a = digitsOf(n.value);
      const b = digitsOf(m.value);
      if (a.length > 10 && b.length > 10 && a.slice(-10) === b.slice(-10)) {
        out.push(`${m.variable} and ${n.variable} end in the same ten digits: a call whose number called comes as those ten digits alone reaches "${m.app}", the first listed`);
      }
    }
  });
  return out;
}

/**
 * The numbers a host routes, each read from `env` (the server's settings): throws, with the fix, for one
 * unset or not E.164, for one that points at an app not among `apps`, and for two variables holding one
 * number. What the server checks as it starts, and `pnpm diagnose` before.
 */
export function hostNumbers(wanted: readonly { variable: string; app: string }[], apps: readonly string[], env: Env): HostNumber[] {
  const numbers: HostNumber[] = [];
  for (const n of wanted) {
    if (!apps.includes(n.app)) throw new Error(`host: ${n.variable} points at "${n.app}", which is not one of the apps (${apps.join(', ')})`);
    const value = env[n.variable]?.trim();
    if (value === undefined || value === '') throw new Error(`host.yaml's numbers name ${n.variable}, which is not set: set ${n.variable} in the server's settings file to the E.164 number callers dial for "${n.app}", or take it out of host.yaml`);
    if (!E164.test(value)) throw new Error(`${n.variable} (a number in host.yaml) is not an E.164 number: set it to the number callers dial, like +15551234567`);
    const twin = numbers.find((m) => sameNumber(m.value, value));
    if (twin !== undefined) {
      throw new Error(`${n.variable} and ${twin.variable} hold the same number, so a call to it could reach "${twin.app}" or "${n.app}": give each its own number, or list the number once in host.yaml`);
    }
    numbers.push({ variable: n.variable, value, app: n.app });
  }
  return numbers;
}

/**
 * The app a new call's setup starts it in: the one its start document named (HOST_APP_PARAMETER, which the
 * answer webhook chose by the number called and the carrier hands back), else the one the setup's own
 * number called reaches, else the default. So the setup agrees with the answer on whichever server it lands.
 */
export function appOfSetup(host: Pick<HostRouting, 'appFor' | 'has'>, named: string | undefined, called: string | null): string {
  if (typeof named === 'string' && host.has(named)) return named;
  return host.appFor(called);
}

/**
 * The environment one app's references are read from: `server` with the values `own` (its own settings
 * file, or null for none) gives the variables the app names (`variables`) over it. The rest of its own
 * file is not read for the server's purposes: `ignored` names them (a server setting left in an app's
 * .env from before the host). `settings` is what the app's code reads by name (AppContext.env): `server`
 * with the whole of `own` over it.
 */
export function appEnvironment(server: Env, own: Readonly<Record<string, string>> | null, variables: readonly string[]): { env: Env; own: string[]; ignored: string[]; settings: Env } {
  const named = new Set(variables);
  const env: Env = { ...server };
  const set: string[] = [];
  const ignored: string[] = [];
  for (const [k, v] of Object.entries(own ?? {})) {
    if (named.has(k)) {
      env[k] = v;
      set.push(k);
    } else ignored.push(k);
  }
  return { env, own: set, ignored, settings: { ...server, ...(own ?? {}) } };
}

/**
 * Where an app folder's module may be, in the order looked in: what `pnpm check` reads (app.ts, or a
 * build of it, in the folder then its src/: define/check.ts APP_MODULE_PATHS), then index.ts.
 */
const APP_MODULE_FILES: readonly string[] = (() => {
  const own = ['app.ts', 'app.mts', 'app.js', 'app.mjs'];
  return [...own, ...own.map((f) => `src/${f}`), 'index.ts', 'src/index.ts', 'index.js', 'src/index.js'];
})();

function isApp(x: unknown): x is App {
  if (typeof x !== 'object' || x === null) return false;
  const a = x as Partial<App>;
  return typeof a.id === 'string' && typeof a.policy === 'object' && a.policy !== null && typeof a.tools === 'object' && typeof a.systems === 'function';
}

/**
 * The app of id `id` an app folder's module exports: app.ts or src/app.ts (what `pnpm check` reads), else
 * index.ts or src/index.ts. A scripted app (the App defineApp builds), or a converse app (the ConverseApp
 * defineConverseApp builds, for a folder whose app.yaml says mode: converse). Its module is imported as
 * the app's own code is anywhere else.
 */
export async function importApp(dir: string, id: string): Promise<HostedApp> {
  const tried: string[] = [];
  for (const file of APP_MODULE_FILES) {
    if (!existsSync(join(dir, file))) continue;
    tried.push(file);
    const module = (await import(/* @vite-ignore */ pathToFileURL(resolve(dir, file)).href)) as Record<string, unknown>;
    const found = Object.values(module).find((a): a is HostedApp => (isApp(a) || isConverseApp(a)) && a.id === id);
    if (found) return found;
  }
  throw new Error(`${dir}: ${tried.length === 0 ? `no module (${APP_MODULE_FILES.join(', ')})` : tried.join(' or ')} exports the app "${id}" (its app.yaml's id): export the App defineApp builds (export const app = defineApp(...)), or for a converse app the one defineConverseApp builds`);
}

/**
 * Every variable an app's own settings file is read for under a host: those its YAML names, its
 * services' (host.yaml), and the server settings an app may give its own value (APP_OWN_SETTINGS).
 */
export function ownVariablesOf(ref: Pick<HostAppRef, 'dir' | 'services'>): string[] {
  return [...new Set([...variablesOf(ref.dir), ...Object.values(ref.services), ...APP_OWN_SETTINGS])];
}

/** The variables an app's YAML names (env.<NAME>), by name. */
export function variablesOf(dir: string): string[] {
  return [...new Set((appYamlEnvReferences(dir) ?? []).map((r) => r.variable))];
}

/** Registers `app`, unless an app of its id is registered already (the same one, or a test's). */
function ensureRegistered(app: HostedApp): HostedApp {
  if (isConverseApp(app)) {
    const known = registeredConverseApps().find((a) => a.id === app.id);
    if (known) return known;
    registerConverseApp(app);
    return app;
  }
  try {
    return getApp(app.id);
  } catch {
    registerApp(app);
    return app;
  }
}

/**
 * The host the file at `file` describes, ready to serve: each app's code imported and registered (the
 * default first, so the registry's default is the host's), each app's environment (`server`, with its
 * own file's values of its variables), and the numbers read from `server`. Throws with every problem
 * the file has, one line each with its fix, or the first a setting has.
 */
export async function loadHost(file: string, server: Env): Promise<HostRouting<HostedApp> & { readonly file: string }> {
  const { host, problems } = resolveHostFile(file);
  if (host === null) throw new Error(`${file} has ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n${problems.map((p) => `  ${formatProblem(p)}`).join('\n')}`);
  const refs = [host.apps.find((a) => a.id === host.defaultApp)!, ...host.apps.filter((a) => a.id !== host.defaultApp)];
  const apps: HostApp<HostedApp>[] = [];
  for (const ref of refs) apps.push(await hostApp(ref, server));
  // In the order host.yaml lists them, the default first (hostRouting's order).
  const routing = hostRouting({ apps: host.apps.map((r) => apps.find((a) => a.id === r.id)!), numbers: host.numbers, defaultApp: host.defaultApp, env: server });
  return { ...routing, file: host.file };
}

/** One app of a resolved host file: its code, registered, and its environment. */
async function hostApp(ref: HostAppRef, server: Env): Promise<HostApp<HostedApp>> {
  const app = ensureRegistered(await importApp(ref.dir, ref.id));
  const own = existsSync(ref.envFile) ? readEnvFile(ref.envFile) : null;
  const env = appEnvironment(server, own, ownVariablesOf(ref));
  return { id: app.id, app, dir: ref.dir, env: env.env, own: env.own, ignored: env.ignored, settings: env.settings, services: ref.services };
}

/** What a server's log says of a host, a line each: the apps, and which numbers reach each. Names only, never a number. */
export function describeHost(host: HostRouting<HostedApp>): string[] {
  return host.apps.map((a) => {
    const numbers = host.numbers.filter((n) => n.app === a.id).map((n) => n.variable);
    const reached = numbers.length > 0 ? `numbers ${numbers.join(', ')}` : 'no number';
    const own = a.own.length > 0 ? `; its own ${a.own.join(', ')}` : '';
    return `app ${a.id}: ${reached}${a.id === host.defaultApp ? ' (the default: any other number, or none)' : ''}${own}`;
  });
}

export type { ResolvedHost };
