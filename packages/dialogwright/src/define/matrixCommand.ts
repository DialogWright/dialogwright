import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { App } from '../core/app/types';
import { APP_MODULE_PATHS } from './check';

/**
 * `dialogwright policy:matrix [dir...]`: writes each app's policy.matrix (dialogwright/testing
 * policyMatrixText), the reviewed golden of what its gate decides. A deliberate step, as accepting
 * any golden is: run it when a policy change is meant, read the diff, commit it; never in CI, where
 * the app's test compares the file with the gate (expectPolicyMatrix) and fails on any difference.
 *
 * Each `dir` is a folder with the app's policy.yaml and a module exporting the App: app.ts (or
 * src/app.ts, as `check` looks for one) or index.ts (or src/index.ts). A folder is looked for from
 * the working directory, then from the workspace's root (the nearest folder above with
 * pnpm-workspace.yaml). With no folder, every policy.matrix under the workspace's root (or the
 * working directory) is written again. Importing the module runs it: never run this on a folder
 * whose code you would not run.
 */

/** Where an app's module may be, in the order looked in. */
export const MATRIX_APP_MODULES: readonly string[] = [...APP_MODULE_PATHS, 'index.ts', 'src/index.ts'];

export interface MatrixIo {
  out(line: string): void;
  err(line: string): void;
  cwd: string;
}

/** The nearest folder at or above `cwd` with pnpm-workspace.yaml, else `cwd`. */
export function workspaceRootOf(cwd: string): string {
  for (let at = cwd; ; at = dirname(at)) {
    if (existsSync(join(at, 'pnpm-workspace.yaml'))) return at;
    if (dirname(at) === at) return cwd;
  }
}

/** Every folder under `root` with a policy.matrix, skipping node_modules and hidden folders. */
export function findMatrixFolders(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'policy.matrix')) out.push(dir);
    for (const e of entries) if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) walk(join(dir, e.name));
  };
  walk(root);
  return out.sort();
}

function isApp(x: unknown): x is App {
  if (typeof x !== 'object' || x === null) return false;
  const a = x as Partial<App>;
  return typeof a.id === 'string' && typeof a.policy === 'object' && a.policy !== null && typeof a.tools === 'object' && typeof a.systems === 'function';
}

/** The App a folder's module exports: the one with a policy matrix (TestingHooks.policyMatrix). */
export async function loadMatrixApp(dir: string): Promise<App> {
  for (const file of MATRIX_APP_MODULES) {
    if (!existsSync(join(dir, file))) continue;
    const module = (await import(/* @vite-ignore */ pathToFileURL(resolve(dir, file)).href)) as Record<string, unknown>;
    const apps = [...new Set(Object.values(module).filter(isApp))];
    const withMatrix = apps.filter((a) => typeof a.testing?.policyMatrix === 'function');
    if (withMatrix.length === 1) return withMatrix[0]!;
    if (withMatrix.length > 1) throw new Error(`${join(dir, file)} exports more than one app with a policy matrix (${withMatrix.map((a) => a.id).join(', ')}): give each its own folder`);
    if (apps.length > 0) throw new Error(`${join(dir, file)} exports the app "${apps[0]!.id}", which has no policy matrix: add TestingHooks.policyMatrix (the principals and records the gate grid crosses)`);
  }
  throw new Error(`${dir}: no module (${MATRIX_APP_MODULES.join(', ')}) exports an App`);
}

/** Runs the command with its arguments; returns the exit code. */
export async function matrixCommand(args: readonly string[], io: MatrixIo): Promise<number> {
  const option = args.find((a) => a.startsWith('-'));
  if (option) {
    io.err(`dialogwright policy:matrix: ${option} is not an option\nusage: dialogwright policy:matrix [dir...]`);
    return 2;
  }
  const root = workspaceRootOf(io.cwd);
  const dirs = args.length > 0
    ? args.map((d) => (existsSync(resolve(io.cwd, d)) ? resolve(io.cwd, d) : resolve(root, d)))
    : findMatrixFolders(root);
  if (dirs.length === 0) {
    io.out(`no policy.matrix under ${root}: name the app's folder to write its first one`);
    return 0;
  }
  // Loaded only here: the matrix runs the gate grid, which the other commands do not need.
  const { writePolicyMatrix } = await import('../testing/policyMatrix');
  let code = 0;
  for (const dir of dirs) {
    const shown = relative(io.cwd, join(dir, 'policy.matrix')) || 'policy.matrix';
    if (!existsSync(dir)) {
      io.err(`${dir}: no such folder`);
      code = 1;
      continue;
    }
    try {
      const app = await loadMatrixApp(dir);
      const { changed, lines } = writePolicyMatrix(app, join(dir, 'policy.matrix'));
      io.out(changed ? `wrote ${shown} (${lines} lines): review the diff before you commit it` : `${shown}: unchanged`);
    } catch (error) {
      io.err(`${shown}: ${error instanceof Error ? error.message : String(error)}`);
      code = 1;
    }
  }
  return code;
}
