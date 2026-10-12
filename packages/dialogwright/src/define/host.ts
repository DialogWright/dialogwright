import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { envVariableOf } from '../core/app/envReference';
import { loadHostYaml } from './load';
import { formatPath, type DataPath, type Problem } from './problems';
import type { HostAppEntry } from './schema/host';

/**
 * A host file (host.yaml: several apps on one server) as the commands and the server read it, with no
 * app code loaded: each app's folder found (by its path, or as Node finds an installed package), the id
 * its app.yaml gives it, its own settings file, the numbers and the default. Every problem is one line
 * with its fix, positioned in host.yaml, as `pnpm check` prints them.
 */

/** The name the commands look for beside the apps, and what HOST_FILE or `--host` names. */
export const HOST_FILE_NAME = 'host.yaml';

/** One app a host file lists, found. */
export interface HostAppRef {
  /** As host.yaml writes it: a folder ("apps/clinic") or a package ("@acme/repairs-line"). */
  readonly label: string;
  /** The app's folder, absolute, links resolved. */
  readonly dir: string;
  /** The id its app.yaml gives it. */
  readonly id: string;
  /** Its own settings file, absolute: the one host.yaml names, else .env in its folder. */
  readonly envFile: string;
  /** Whether host.yaml names the file (then it must exist); a folder's own .env may be absent. */
  readonly envNamed: boolean;
}

/** One number a host file lists: the variable that holds it and the app it reaches. */
export interface HostNumberRef {
  readonly variable: string;
  readonly app: string;
}

/** A host file, read and found. */
export interface ResolvedHost {
  /** host.yaml, absolute. */
  readonly file: string;
  /** Its folder, which the paths in it are from. */
  readonly dir: string;
  /** The apps, in the order the file lists them. */
  readonly apps: readonly HostAppRef[];
  readonly numbers: readonly HostNumberRef[];
  /** The default app's id: the file's `default`, else the first app listed. */
  readonly defaultApp: string;
}

/** The app.yaml id of a folder, or why there is none. */
function appIdIn(dir: string): { id: string } | { why: string } {
  const file = join(dir, 'app.yaml');
  if (!existsSync(file)) return { why: `has no app.yaml` };
  try {
    const doc = parse(readFileSync(file, 'utf8')) as { id?: unknown } | null;
    const id = doc?.id;
    if (typeof id === 'string' && /^[a-z][a-z0-9_-]*$/.test(id)) return { id };
    return { why: 'has an app.yaml with no valid id' };
  } catch {
    return { why: 'has an app.yaml that cannot be read as YAML' };
  }
}

/**
 * An installed package's folder, as Node finds it from `from`: node_modules/<name> in `from` or a folder
 * above it, links resolved. Null when it is installed nowhere above.
 */
export function packageFolder(name: string, from: string): string | null {
  for (let at = resolve(from); ; at = dirname(at)) {
    const candidate = join(at, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) {
      try {
        return realpathSync(candidate);
      } catch {
        return null;
      }
    }
    if (dirname(at) === at) return null;
  }
}

/** A path as a problem names it: from the host file's folder, with forward slashes. */
const shown = (dir: string, path: string): string => relative(dir, path).split(sep).join('/') || '.';

/**
 * Reads the host file at `file` and finds its apps, with no app code loaded: what the server, `pnpm
 * check`, `pnpm diagnose` and `pnpm start` start from. Never throws for what is in the file or the apps'
 * folders: each is a problem, positioned in host.yaml (`file` as given names it).
 */
export function resolveHostFile(file: string): { host: ResolvedHost | null; problems: Problem[] } {
  const loaded = loadHostYaml(file);
  if (loaded.host === null) return { host: null, problems: loaded.problems };
  const yaml = loaded.host;
  const abs = resolve(file);
  const hostDir = dirname(abs);
  const problems: Problem[] = [];
  const at = (path: DataPath, message: string, fix: string): void => {
    const pos = loaded.locate(path);
    problems.push({ file, line: pos.line, column: pos.column, path: formatPath(path), message, fix });
  };
  const apps: HostAppRef[] = [];
  const seen = new Map<string, string>();
  yaml.apps.forEach((entry: HostAppEntry, i) => {
    const path: DataPath = typeof entry === 'string' ? ['apps', i] : ['apps', i, 'package' in entry ? 'package' : 'folder'];
    let dir: string | null;
    let label: string;
    if (typeof entry === 'string' || 'folder' in entry) {
      label = typeof entry === 'string' ? entry : entry.folder;
      const wanted = resolve(hostDir, label);
      if (!existsSync(wanted) || !statSync(wanted).isDirectory()) {
        at(path, `the app folder ${label} does not exist (from ${shown(process.cwd(), hostDir)})`, 'write the path of the app\'s folder (the one with app.yaml) from host.yaml\'s folder');
        return;
      }
      dir = realpathSync(wanted);
    } else {
      label = entry.package;
      dir = packageFolder(entry.package, hostDir);
      if (dir === null) {
        at(path, `the package ${label} is not installed (no node_modules/${label} in host.yaml's folder or above)`, `install it (npm install ${label}), or list the app by its folder`);
        return;
      }
    }
    const id = appIdIn(dir);
    if ('why' in id) {
      at(path, `${label} ${id.why}`, 'list an app\'s folder: the one with app.yaml, whose id names the app');
      return;
    }
    const before = seen.get(id.id);
    if (before !== undefined) {
      at(path, `${label} is the app "${id.id}", which ${before} is too`, 'list each app once: a host runs one copy of an app, however many numbers reach it');
      return;
    }
    seen.set(id.id, label);
    const named = typeof entry === 'string' ? undefined : entry.env;
    apps.push({ label, dir, id: id.id, envFile: named === undefined ? join(dir, '.env') : resolve(hostDir, named), envNamed: named !== undefined });
    if (named !== undefined && !existsSync(resolve(hostDir, named))) {
      at(['apps', i, 'env'], `the settings file ${named} does not exist`, `create it with the app's own variables, or delete "env" to read ${shown(hostDir, join(dir, '.env'))}`);
    }
  });
  const ids = apps.map((a) => a.id);
  const list = ids.length === 0 ? 'none' : ids.join(', ');
  const numbers: HostNumberRef[] = [];
  const variables = new Map<string, number>();
  (yaml.numbers ?? []).forEach((n, i) => {
    const variable = envVariableOf(n.number)!;
    const before = variables.get(variable);
    if (before !== undefined) {
      at(['numbers', i, 'number'], `${n.number} is listed twice (numbers[${before}] lists it too)`, 'list each number once: a number reaches one app');
      return;
    }
    variables.set(variable, i);
    if (!seen.has(n.app)) {
      at(['numbers', i, 'app'], `"${n.app}" is not an app this file lists (apps: ${list})`, `write the id of one of the apps (its app.yaml's id), or list the app under "apps"`);
      return;
    }
    numbers.push({ variable, app: n.app });
  });
  let defaultApp = ids[0] ?? '';
  if (yaml.default !== undefined) {
    if (!seen.has(yaml.default)) at(['default'], `"${yaml.default}" is not an app this file lists (apps: ${list})`, 'write the id of one of the apps (its app.yaml\'s id), or delete "default" for the first app listed');
    else defaultApp = yaml.default;
  }
  if (problems.length > 0 || apps.length === 0) return { host: null, problems };
  return { host: { file: abs, dir: hostDir, apps, numbers, defaultApp }, problems: [] };
}

/**
 * The host file a command means: `--host <file>` (relative to where it was run), else HOST_FILE, else
 * host.yaml in `root` (the project's folder, beside the apps) when there is one; null for none, a
 * server of one app, as before. A file named and not there is the caller's to report.
 */
export function hostFileOf(flag: string | undefined, env: Readonly<Record<string, string | undefined>>, invokedFrom: string, root: string): string | null {
  const named = flag ?? (env.HOST_FILE?.trim() || undefined);
  if (named !== undefined) return resolve(invokedFrom, named);
  const beside = join(root, HOST_FILE_NAME);
  return existsSync(beside) ? beside : null;
}
