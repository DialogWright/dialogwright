import { dirname, join, resolve } from 'node:path';

/**
 * CONSOLE_AUTH and its variables: who may open the operator console.
 *
 * - `local`, the default: the console is for the screen in front of the operator, as it always was
 *   (CONSOLE_LOCAL_ONLY, server/localOnly.ts). The config then has no `consoleAuth`, and nothing below is read.
 * - `token`: the console is served through the tunnel too, behind a sign-in (server/console/auth.ts):
 *   a one-time link signs one browser in, with a signed session cookie. One owner; no roles.
 */
export interface ConsoleAuthSettings {
  method: 'token';
  /**
   * CONSOLE_SESSION_KEY, decoded: the key the session cookie is signed with, so a session outlives a
   * restart. Null when unset: a key made when the process starts, and a restart signs everyone out.
   */
  sessionKey: Buffer | null;
  /** CONSOLE_SESSION_HOURS, default 12, from 1 to 168: how long a sign-in lasts. */
  sessionHours: number;
  /**
   * CONSOLE_LINK_FILE, absolute: where the server writes the current sign-in link, readable by its owner
   * alone (mode 600, in a folder of mode 700), and what `pnpm console:link` reads to reach the server.
   * Default `.console-link/link.json` beside the trace folder.
   */
  linkFile: string;
}

type Env = Record<string, string | undefined>;

export const DEFAULT_CONSOLE_SESSION_HOURS = 12;
export const MAX_CONSOLE_SESSION_HOURS = 168;
/** The fewest bytes a CONSOLE_SESSION_KEY decodes to. */
export const MIN_SESSION_KEY_BYTES = 32;

/**
 * A session key as written: hex (read first, so a hex key is never taken for base64), else base64 or
 * base64url. Null for anything else, for fewer than 32 bytes, and for bytes too alike to be random
 * (fewer than 16 different values: a key of one repeated character, say).
 */
export function parseSessionKey(raw: string): Buffer | null {
  const s = raw.trim();
  let bytes: Buffer | null = null;
  if (/^(?:[0-9a-fA-F]{2})+$/.test(s)) bytes = Buffer.from(s, 'hex');
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) {
    const decoded = Buffer.from(s, 'base64');
    // Node's decoder skips what it does not understand; a key it did not read whole is not this key.
    const norm = (t: string): string => t.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    if (norm(decoded.toString('base64')) === norm(s)) bytes = decoded;
  }
  if (bytes === null || bytes.length < MIN_SESSION_KEY_BYTES) return null;
  if (new Set(bytes).size < 16) return null;
  return bytes;
}

/**
 * Where the link file is: CONSOLE_LINK_FILE, or `.console-link/link.json` in the folder that holds the
 * trace folder (TRACE_DIR, default `traces`), each from `cwd`, where the server runs. `pnpm console:link`
 * finds it the same way.
 */
export function consoleLinkFileOf(env: Env, cwd: string): string {
  const named = env.CONSOLE_LINK_FILE?.trim();
  if (named) return resolve(cwd, named);
  return join(dirname(resolve(cwd, env.TRACE_DIR?.trim() || 'traces')), '.console-link', 'link.json');
}

/** CONSOLE_AUTH, as `local` or `token`. */
export function consoleAuthMethodOf(env: Env): 'local' | 'token' {
  const method = (env.CONSOLE_AUTH?.trim() || 'local').toLowerCase();
  if (method !== 'local' && method !== 'token') throw new Error(`CONSOLE_AUTH must be local or token, got "${env.CONSOLE_AUTH}"`);
  return method;
}

/**
 * CONSOLE_AUTH and, in token mode, its variables; undefined in local mode (the others are then not
 * read). `dashboard` is DASHBOARD's value: token mode with no console to sign in to is a mistake.
 */
export function consoleAuthOf(env: Env, dashboard: boolean, cwd: string = process.cwd()): ConsoleAuthSettings | undefined {
  if (consoleAuthMethodOf(env) === 'local') return undefined;
  if (!dashboard) throw new Error('CONSOLE_AUTH=token signs in to the console, which DASHBOARD=off turns off: set DASHBOARD=on or CONSOLE_AUTH=local');
  const rawHours = env.CONSOLE_SESSION_HOURS?.trim();
  let sessionHours = DEFAULT_CONSOLE_SESSION_HOURS;
  if (rawHours !== undefined && rawHours !== '') {
    const n = Number(rawHours);
    if (!/^\d+$/.test(rawHours) || n < 1 || n > MAX_CONSOLE_SESSION_HOURS) {
      throw new Error(`CONSOLE_SESSION_HOURS must be a whole number of hours from 1 to ${MAX_CONSOLE_SESSION_HOURS}, got "${env.CONSOLE_SESSION_HOURS}"`);
    }
    sessionHours = n;
  }
  const rawKey = env.CONSOLE_SESSION_KEY?.trim();
  let sessionKey: Buffer | null = null;
  if (rawKey) {
    sessionKey = parseSessionKey(rawKey);
    // Never the value: a key that is wrong is still mostly a key.
    if (sessionKey === null) throw new Error(`CONSOLE_SESSION_KEY must be at least ${MIN_SESSION_KEY_BYTES} random bytes, written as hex or base64 (openssl rand -hex 32): the one set is not (${rawKey.length} characters)`);
  }
  return { method: 'token', sessionKey, sessionHours, linkFile: consoleLinkFileOf(env, cwd) };
}

/** The settings as describeConfig shows them: never the key. */
export function describeConsoleAuth(s: ConsoleAuthSettings): string {
  return `console sign-in (CONSOLE_AUTH=token, sessions ${s.sessionHours} h, ${s.sessionKey ? 'key from CONSOLE_SESSION_KEY' : 'key made at start'})`;
}
