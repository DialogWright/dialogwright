import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * The apps a repository's commands run (pnpm configure, start, diagnose, service): each workspace
 * package with an app folder (app.yaml) and a `serve` script, found from pnpm-workspace.yaml.
 */

export interface WorkspaceApp {
  /** The package name, which `pnpm --filter` takes (`@dialogwright/example-clinic`). */
  name: string;
  /** The app's folder, absolute. */
  dir: string;
  /** The folder from the repository root (`apps/clinic`). */
  folder: string;
}

/** The repository root: the folder with pnpm-workspace.yaml above this package. */
export const WORKSPACE_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

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

/** The workspace's apps, by folder. */
export function workspaceApps(root: string = WORKSPACE_ROOT): WorkspaceApp[] {
  const apps: WorkspaceApp[] = [];
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
