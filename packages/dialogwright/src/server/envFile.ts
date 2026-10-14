import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import type { Env } from './config';

/**
 * A settings file: `KEY=value` lines, `#` comments, quotes as dotenv takes them (Node's own parser,
 * util.parseEnv, the one `node --env-file` uses). The server reads one at startup when ENV_FILE or
 * `--env-file <path>` names it; `pnpm start`, `pnpm diagnose` and a service file name the same file,
 * so every way of running the line reads it the same way. A variable already in the environment wins
 * over the file, so a one-off `PORT=3001 pnpm start` needs no edit.
 *
 * ENV_FILE (and `--env-file`) may name more than one file, separated by commas
 * (`ENV_FILE=.env,../render.env`): each is read in turn, a later file's variable replacing an earlier
 * one's, and the environment still winning over them all. So an app's settings and a key kept in a
 * file of its own are read together, with no shell `source`. A comma, not a colon, since a colon is in
 * a Windows path; a path with a comma in it cannot be named.
 */

/** The separator of the files ENV_FILE or `--env-file` names. */
export const ENV_FILE_SEPARATOR = ',';

/** The paths a value of ENV_FILE or `--env-file` names, in order, each trimmed, empty ones left out. */
export function envFileNames(value: string): string[] {
  return value.split(ENV_FILE_SEPARATOR).map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * The files a value of ENV_FILE names, each resolved from `base` unless absolute; a leading `~/` is the
 * home folder, since a shell expands `~` only at the start of the value, never after a comma.
 */
export function resolveEnvFiles(value: string, base: string, home: string = homedir()): string[] {
  const names = envFileNames(value);
  // A value with no path in it ("," or " , ") is refused by every reader alike, never read as unset.
  if (names.length === 0) throw new Error(`ENV_FILE names no file: "${value}"`);
  return names.map((n) => (n === '~' || n.startsWith('~/') ? join(home, n.slice(1)) : n)).map((n) => (isAbsolute(n) ? n : resolve(base, n)));
}

/** Files as ENV_FILE names them (comma-separated), for a child process or a line to copy. */
export function joinEnvFiles(paths: readonly string[]): string {
  return paths.join(ENV_FILE_SEPARATOR);
}

/** The value of `--env-file <path>` or `--env-file=<path>` among a command's arguments, if there is one. */
export function envFileArgument(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--env-file') return argv[i + 1];
    if (a.startsWith('--env-file=')) return a.slice('--env-file='.length);
  }
  return undefined;
}

/**
 * The settings files a process is asked to read, in order: `--env-file` wins over ENV_FILE, either may
 * name several (comma-separated), and a relative path is from where the command was run (pnpm's
 * INIT_CWD, since `pnpm --filter` runs a script in its package's folder), else from `cwd`. Null when
 * neither names one.
 */
export function envFilePathsOf(argv: readonly string[], env: Env, cwd: string = process.cwd()): string[] | null {
  const named = envFileArgument(argv) ?? (env.ENV_FILE?.trim() || undefined);
  if (named === undefined) return null;
  return resolveEnvFiles(named, env.INIT_CWD?.trim() || cwd);
}

/** A settings file's variables. Throws `ENV_FILE does not exist: <path>` for a path that is not a file. */
export function readEnvFile(path: string): Record<string, string> {
  let isFile = false;
  try {
    isFile = statSync(path).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) throw new Error(`ENV_FILE does not exist: ${path}`);
  const parsed = parseEnv(readFileSync(path, 'utf8'));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * The variables of several settings files, read in order: a later file's value of a variable replaces
 * an earlier one's. Throws, as readEnvFile does, at the first that is not a file.
 */
export function readEnvFiles(paths: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of paths) Object.assign(out, readEnvFile(path));
  return out;
}

/**
 * Sets each of the files' variables (readEnvFiles: a later file's winning over an earlier's) in `env`
 * that `env` does not have already; returns the names it set. An empty value in the environment counts
 * as set, as it does for the shell. One path or several.
 */
export function applyEnvFile(paths: string | readonly string[], env: Env): string[] {
  const set: string[] = [];
  for (const [k, v] of Object.entries(readEnvFiles(typeof paths === 'string' ? [paths] : paths))) {
    if (env[k] !== undefined) continue;
    env[k] = v;
    set.push(k);
  }
  return set;
}

/**
 * The settings files a harness command reads (the regression run and the text harness against a model
 * or its cassette, and the cassette trim): the files ENV_FILE names (one or several, comma-separated),
 * relative to where the command was run as for `pnpm start`, else the app's own `.env` in the folder the
 * command runs in (`pnpm --filter <app>` runs a script in its package folder, where `pnpm configure`
 * writes it), if there is one. Null when ENV_FILE is unset and there is no `.env`.
 */
export function harnessEnvFilePaths(env: Env, cwd: string = process.cwd()): string[] | null {
  const named = envFilePathsOf([], env, cwd);
  if (named !== null) return named;
  const own = resolve(cwd, '.env');
  try {
    return statSync(own).isFile() ? [own] : null;
  } catch {
    return null;
  }
}

/**
 * Reads the harness's settings files (harnessEnvFilePaths) into `env`, a later file winning over an
 * earlier one and a variable already in the environment over them all, and returns the line that says
 * so (the paths and how many it set; never a value), or null when there is no file. Throws, as the
 * server does, when ENV_FILE names a file that is not there.
 */
export function loadHarnessEnv(env: Env = process.env, cwd: string = process.cwd()): string | null {
  const paths = harnessEnvFilePaths(env, cwd);
  if (paths === null) return null;
  const total = Object.keys(readEnvFiles(paths)).length;
  const set = applyEnvFile(paths, env).length;
  const kept = total - set;
  return `settings from ${paths.join(', ')} (${set} set${kept > 0 ? `, ${kept} already in the environment, which wins` : ''})`;
}
