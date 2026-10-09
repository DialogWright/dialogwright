import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getApp, registerApp } from '../core/app/registry';
import { loadFolderApp } from '../define/pageCommand';
import { main as regressMain } from './regress';

/**
 * `dialogwright regress [dir] [options]`: an app's regression run, as its own launcher (`src/regress.ts`,
 * `pnpm --filter <app> regress`) runs it: the App the folder's module exports (app.ts, src/app.ts,
 * index.ts or src/index.ts, as `policy:matrix` finds it) is registered, the working directory becomes
 * the folder (so the run reads the app's own `.env`, as `pnpm --filter` would), and the options go to
 * the run as they are (`--client`, `--scenario`, `--corpus`, `--update`, `--threshold`, `--screen`,
 * `--json`). With no folder, the folder it is run in, or the nearest above it with an app.yaml.
 * Importing the module runs it: never run this on a folder whose code you would not run.
 */

export const REGRESS_USAGE = [
  'usage: dialogwright regress [dir] [--client stub|heuristic|jev|record|recorded] [--scenario <id>]... [--corpus <id>]... [--update] [--threshold NAME=value]... [--screen inline|separate] [--json]',
  '  dir: the app folder (one with app.yaml); with none, the folder it is run in, or the nearest above it with an app.yaml',
].join('\n');

export interface RegressIo {
  err(line: string): void;
  /** Where the command was run (pnpm's INIT_CWD), which a relative folder is from. */
  invokedFrom: string;
  /** Moves the process into the app's folder. Default: process.chdir. */
  chdir?(dir: string): void;
}

/** The nearest folder at or above `from` with an app.yaml, or null. */
export function appFolderAt(from: string): string | null {
  for (let at = from; ; at = dirname(at)) {
    if (existsSync(join(at, 'app.yaml'))) return at;
    if (existsSync(join(at, 'pnpm-workspace.yaml')) || dirname(at) === at) return null;
  }
}

/** Runs the regression for the app folder `argv` names (or the one it is run in); returns the exit code. */
export async function regressCommand(argv: readonly string[], io: RegressIo): Promise<number> {
  const [first, ...after] = argv;
  if (first === '--help' || first === '-h') {
    io.err(REGRESS_USAGE);
    return 0;
  }
  const named = first !== undefined && !first.startsWith('-');
  const options = named ? after : argv;
  let dir: string | null;
  if (named) {
    dir = resolve(io.invokedFrom, first);
    if (!existsSync(join(dir, 'app.yaml'))) {
      io.err(`dialogwright regress: ${first} is not an app folder (it has no app.yaml)\n${REGRESS_USAGE}`);
      return 2;
    }
  } else {
    dir = appFolderAt(io.invokedFrom);
    if (dir === null) {
      io.err(`dialogwright regress: ${io.invokedFrom} is not in an app folder (no app.yaml here or above): name the folder\n${REGRESS_USAGE}`);
      return 2;
    }
  }
  let app;
  try {
    app = await loadFolderApp(dir);
  } catch (e) {
    io.err(`dialogwright regress: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  try {
    getApp(app.id);
  } catch {
    registerApp(app);
  }
  (io.chdir ?? ((to: string) => process.chdir(to)))(dir);
  const before = process.exitCode;
  process.exitCode = undefined;
  await regressMain(options);
  const code = typeof process.exitCode === 'number' ? process.exitCode : Number(process.exitCode ?? 0) || 0;
  process.exitCode = before;
  return code;
}
