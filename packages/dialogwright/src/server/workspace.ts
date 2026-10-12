import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { IN_REPOSITORY, REPO_ROOT } from '../define/home';

/**
 * The apps a repository's commands run (pnpm configure, start, diagnose, service): each workspace
 * package with an app folder (app.yaml) and a `serve` script, found from pnpm-workspace.yaml. In a
 * project of its own (`dialogwright create-app --standalone`), where the engine is installed in
 * node_modules, the project is found from where the command was run, and the project's own folder is
 * its app.
 */

export interface WorkspaceApp {
  /** The package name, which `pnpm --filter` takes (`@dialogwright/example-clinic`). */
  name: string;
  /** The app's folder, absolute. */
  dir: string;
  /** The folder from the repository root (`apps/clinic`). */
  folder: string;
}

/** The repository root: the folder with pnpm-workspace.yaml above this package (../define/home.ts). */
export const WORKSPACE_ROOT = REPO_ROOT;

/**
 * The engine's own command line as a file node runs (bin/dialogwright.mjs, which registers tsx's loader
 * and runs src/define/cli.ts here, or its build in a package): what runs a host file's server, `node
 * <it> serve --host <file>`, from `pnpm start --host` and a service file alike, in any folder.
 */
export const ENGINE_BIN = fileURLToPath(new URL('../../bin/dialogwright.mjs', import.meta.url));

/** Whether the engine runs from the DialogWright repository (src/, or a build beside it), not installed in a project's node_modules. */
export const ENGINE_IN_REPOSITORY = IN_REPOSITORY;

/**
 * Where a command finds its apps: the repository, when the engine runs from it (as before there was a
 * package to install); otherwise the project it was run in: the nearest folder at or above
 * `invokedFrom` with pnpm-workspace.yaml (unless an app folder with a package.json below it is not one
 * of its packages: then that app), else the nearest app folder with a package.json (a project of its
 * own), else the nearest folder with a package.json.
 */
export function projectRoot(invokedFrom: string, inRepository: boolean = ENGINE_IN_REPOSITORY): string {
  if (inRepository) return WORKSPACE_ROOT;
  let app: string | null = null;
  let pkg: string | null = null;
  for (let at = resolve(invokedFrom); ; at = dirname(at)) {
    // A workspace above is the project, unless the app found on the way is not one of its packages
    // (a project of its own that happens to sit inside some other workspace).
    if (existsSync(join(at, 'pnpm-workspace.yaml'))) return app !== null && !workspaceFolders(at).includes(app) ? app : at;
    if (existsSync(join(at, 'package.json'))) {
      pkg ??= at;
      if (existsSync(join(at, 'app.yaml'))) app ??= at;
    }
    if (dirname(at) === at) return app ?? pkg ?? resolve(invokedFrom);
  }
}

/** How a hint names one of the root commands: `pnpm` in a pnpm workspace (this repository), `npx dialogwright` in a project of its own. */
export function runCommand(root: string): string {
  return existsSync(join(root, 'pnpm-workspace.yaml')) ? 'pnpm' : 'npx dialogwright';
}

/**
 * How the commands' hints name a command: `pnpm <command> --app <name>` in a pnpm workspace (this
 * repository), `npx dialogwright <command>` in a project of its own, whose one app needs no --app; and
 * an app's own script, `pnpm --filter <package> <script>` or `npm run <script> --`.
 */
export function commandHints(app: WorkspaceApp, root: string): { command(name: string): string; script(name: string): string } {
  if (existsSync(join(root, 'pnpm-workspace.yaml'))) return { command: (name) => `pnpm ${name} --app ${basename(app.dir)}`, script: (name) => `pnpm --filter ${app.name} ${name}` };
  return { command: (name) => `npx dialogwright ${name}`, script: (name) => `npm run ${name} --` };
}

/**
 * How `start` runs an app's server: `pnpm --filter <app> serve` from the root of a pnpm workspace, as
 * before; in a project of its own, the app's `serve` script with npm, which every Node install has.
 */
export function serveCommand(app: WorkspaceApp, root: string): { command: string; args: string[]; cwd: string } {
  if (existsSync(join(root, 'pnpm-workspace.yaml'))) return { command: 'pnpm', args: ['--filter', app.name, 'serve'], cwd: root };
  return { command: 'npm', args: ['run', '--silent', 'serve'], cwd: app.dir };
}

function packageJson(dir: string): { name?: string; scripts?: Record<string, string> } | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; scripts?: Record<string, string> };
  } catch {
    return null;
  }
}

/** The folders pnpm-workspace.yaml names: `dir/*` patterns and plain folders (the shapes this repository uses). */
function workspaceFolders(root: string): string[] {
  let patterns: string[] = [];
  try {
    const doc = parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')) as { packages?: unknown } | null;
    patterns = Array.isArray(doc?.packages) ? doc.packages.filter((p): p is string => typeof p === 'string' && !p.startsWith('!')) : [];
  } catch {
    patterns = ['apps/*'];
  }
  const out: string[] = [];
  for (const p of patterns) {
    const clean = p.replace(/\/+$/, '');
    if (clean.endsWith('/*')) {
      const parent = join(root, clean.slice(0, -2));
      try {
        for (const e of readdirSync(parent, { withFileTypes: true })) {
          if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) out.push(join(parent, e.name));
        }
      } catch {
        // A pattern whose folder does not exist names nothing.
      }
    } else if (!clean.includes('*')) {
      out.push(join(root, clean));
    }
  }
  return [...new Set(out)].sort();
}

/** The workspace's apps, by folder; a project whose own folder is an app (one made with --standalone) is its one app, folder `.`. */
export function workspaceApps(root: string = WORKSPACE_ROOT): WorkspaceApp[] {
  const apps: WorkspaceApp[] = [];
  const self = packageJson(root);
  if (self?.name && self.scripts?.serve && existsSync(join(root, 'app.yaml'))) apps.push({ name: self.name, dir: root, folder: '.' });
  for (const dir of workspaceFolders(root)) {
    const pkg = packageJson(dir);
    if (!pkg?.name || !pkg.scripts?.serve || !existsSync(join(dir, 'app.yaml'))) continue;
    apps.push({ name: pkg.name, dir, folder: relative(root, dir).split(sep).join('/') });
  }
  return apps;
}

/**
 * The app a `--app` value names: its package name, its folder's name (`clinic`), its folder from the
 * root (`apps/clinic`), or a path to it from where the command was run.
 */
export function findApp(apps: readonly WorkspaceApp[], filter: string, invokedFrom: string): WorkspaceApp | null {
  const asPath = resolve(invokedFrom, filter);
  return (
    apps.find((a) => a.name === filter) ??
    apps.find((a) => a.folder === filter.replace(/\/+$/, '')) ??
    apps.find((a) => basename(a.dir) === filter) ??
    apps.find((a) => a.dir === asPath || (isAbsolute(filter) && a.dir === filter)) ??
    null
  );
}

/** How a command lists the apps it could mean. */
export function appList(apps: readonly WorkspaceApp[]): string {
  return apps.length === 0 ? 'none yet' : apps.map((a) => basename(a.dir)).join(', ');
}

/**
 * The app a command runs: the one `--app` names, else the only one there is, else the only one with a
 * settings file (`.env`). An error says which apps there are when it cannot tell.
 */
export function chooseApp(apps: readonly WorkspaceApp[], filter: string | undefined, invokedFrom: string, command: string): { app: WorkspaceApp } | { error: string } {
  if (filter !== undefined) {
    const app = findApp(apps, filter, invokedFrom);
    return app ? { app } : { error: `no app "${filter}" in this workspace (apps: ${appList(apps)})` };
  }
  if (apps.length === 1) return { app: apps[0]! };
  if (apps.length === 0) return { error: 'no app in this workspace yet: make one with pnpm create-app <name>' };
  // The app the folder the command was run in belongs to.
  const here = apps.find((a) => invokedFrom === a.dir || invokedFrom.startsWith(a.dir + sep));
  if (here) return { app: here };
  const configured = apps.filter((a) => existsSync(join(a.dir, '.env')));
  if (configured.length === 1) return { app: configured[0]! };
  return { error: `which app? pnpm ${command} --app <name> (apps: ${appList(apps)})` };
}
