import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { App } from '../core/app/types';
import { MATRIX_APP_MODULES, workspaceRootOf } from './matrixCommand';

/**
 * The commands that write a page from an app's configuration beside its policy.yaml, as
 * `dialogwright policy:matrix` writes policy.matrix: `policy:card` (POLICY.md). Each is a deliberate
 * step: run it when a change is meant, read the diff, commit it; never in CI, where the app's test
 * compares the page with what the app generates (expectPolicyCard) and fails on any difference. The
 * page is written only when it changed.
 *
 * Each `dir` is a folder with the app's policy.yaml and a module exporting the App: app.ts (or
 * src/app.ts) or index.ts (or src/index.ts). A folder is looked for from the working directory, then
 * from the workspace's root (the nearest folder above with pnpm-workspace.yaml). With no folder,
 * every folder under the workspace's root (or the working directory) that already has the page is
 * written again. Importing the module runs it: never run this on a folder whose code you would not run.
 */

/** What one page command writes. */
export interface PageCommand {
  /** The command's name, for messages (`policy:card`). */
  readonly name: string;
  /** The page's file name, beside the app's policy.yaml. */
  readonly file: string;
  /** Writes the app's page to `file`, when it changed. */
  write(app: App, file: string): Promise<{ changed: boolean; lines: number }>;
}

export interface PageIo {
  out(line: string): void;
  err(line: string): void;
  cwd: string;
}

/** Every folder under `root` with a file of this name, skipping node_modules and hidden folders. */
export function findPageFolders(root: string, file: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === file)) out.push(dir);
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

/** The App a folder's module exports: its only one, or, of several, the one with a policy matrix (TestingHooks.policyMatrix). */
export async function loadFolderApp(dir: string): Promise<App> {
  for (const file of MATRIX_APP_MODULES) {
    if (!existsSync(join(dir, file))) continue;
    const module = (await import(/* @vite-ignore */ pathToFileURL(resolve(dir, file)).href)) as Record<string, unknown>;
    const apps = [...new Set(Object.values(module).filter(isApp))];
    if (apps.length === 1) return apps[0]!;
    if (apps.length > 1) {
      const withMatrix = apps.filter((a) => typeof a.testing?.policyMatrix === 'function');
      if (withMatrix.length === 1) return withMatrix[0]!;
      throw new Error(`${join(dir, file)} exports more than one app (${apps.map((a) => a.id).join(', ')}): give each its own folder`);
    }
  }
  throw new Error(`${dir}: no module (${MATRIX_APP_MODULES.join(', ')}) exports an App`);
}

/** Runs a page command with its arguments; returns the exit code. */
export async function pageCommand(command: PageCommand, args: readonly string[], io: PageIo): Promise<number> {
  const option = args.find((a) => a.startsWith('-'));
  if (option) {
    io.err(`dialogwright ${command.name}: ${option} is not an option\nusage: dialogwright ${command.name} [dir...]`);
    return 2;
  }
  const root = workspaceRootOf(io.cwd);
  const dirs = args.length > 0
    ? args.map((d) => (existsSync(resolve(io.cwd, d)) ? resolve(io.cwd, d) : resolve(root, d)))
    : findPageFolders(root, command.file);
  if (dirs.length === 0) {
    io.out(`no ${command.file} under ${root}: name the app's folder to write its first one`);
    return 0;
  }
  let code = 0;
  for (const dir of dirs) {
    const shown = relative(io.cwd, join(dir, command.file)) || command.file;
    if (!existsSync(dir)) {
      io.err(`${dir}: no such folder`);
      code = 1;
      continue;
    }
    try {
      const app = await loadFolderApp(dir);
      const { changed, lines } = await command.write(app, join(dir, command.file));
      io.out(changed ? `wrote ${shown} (${lines} lines): review the diff before you commit it` : `${shown}: unchanged`);
    } catch (error) {
      io.err(`${shown}: ${error instanceof Error ? error.message : String(error)}`);
      code = 1;
    }
  }
  return code;
}
