import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import type { Env } from './config';

/**
 * A settings file: `KEY=value` lines, `#` comments, quotes as dotenv takes them (Node's own parser,
 * util.parseEnv, the one `node --env-file` uses). The server reads one at startup when ENV_FILE or
 * `--env-file <path>` names it; `pnpm start`, `pnpm diagnose` and a service file name the same file,
 * so every way of running the line reads it the same way. A variable already in the environment wins
 * over the file, so a one-off `PORT=3001 pnpm start` needs no edit.
 */

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
 * The settings file a process is asked to read: `--env-file` wins over ENV_FILE, and a relative path
 * is from where the command was run (pnpm's INIT_CWD, since `pnpm --filter` runs a script in its
 * package's folder), else from `cwd`. Null when neither names one.
 */
export function envFilePathOf(argv: readonly string[], env: Env, cwd: string = process.cwd()): string | null {
  const named = envFileArgument(argv) ?? (env.ENV_FILE?.trim() || undefined);
  if (named === undefined) return null;
  return isAbsolute(named) ? named : resolve(env.INIT_CWD?.trim() || cwd, named);
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
 * Sets each of the file's variables in `env` that `env` does not have already; returns the names it set.
 * An empty value in the environment counts as set, as it does for the shell.
 */
export function applyEnvFile(path: string, env: Env): string[] {
  const set: string[] = [];
  for (const [k, v] of Object.entries(readEnvFile(path))) {
    if (env[k] !== undefined) continue;
    env[k] = v;
    set.push(k);
  }
  return set;
}

/**
 * The settings file a harness command reads (the regression run and the text harness against a model
 * or its cassette, and the cassette trim): the file ENV_FILE names, relative to where the command was
 * run as for `pnpm start`, else the app's own `.env` in the folder the command runs in (`pnpm --filter
 * <app>` runs a script in its package folder, where `pnpm configure` writes it), if there is one.
 * Null when ENV_FILE is unset and there is no `.env`.
 */
export function harnessEnvFilePath(env: Env, cwd: string = process.cwd()): string | null {
  const named = envFilePathOf([], env, cwd);
  if (named !== null) return named;
  const own = resolve(cwd, '.env');
  try {
    return statSync(own).isFile() ? own : null;
  } catch {
    return null;
  }
}

/**
 * Reads the harness's settings file (harnessEnvFilePath) into `env`, a variable already there winning
 * over the file, and returns the line that says so (the path and how many it set; never a value), or
 * null when there is no file. Throws, as the server does, when ENV_FILE names a file that is not there.
 */
export function loadHarnessEnv(env: Env = process.env, cwd: string = process.cwd()): string | null {
  const path = harnessEnvFilePath(env, cwd);
  if (path === null) return null;
  const total = Object.keys(readEnvFile(path)).length;
  const set = applyEnvFile(path, env).length;
  const kept = total - set;
  return `settings from ${path} (${set} set${kept > 0 ? `, ${kept} already in the environment, which wins` : ''})`;
}
