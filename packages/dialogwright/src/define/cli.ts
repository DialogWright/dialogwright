#!/usr/bin/env tsx
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAppFully } from './check';
import { formatProblem, type Problem } from './problems';

/**
 * The `dialogwright` command (the package's bin; run through tsx, which is how the repo runs its
 * TypeScript). One command so far:
 *
 *   dialogwright check [--json] [dir...]
 *
 * Checks each app folder `dir` (a folder with app.yaml): see ./check.ts for what that is. One line
 * per problem, then a summary line per folder (`N problems in <dir>`, or `<dir>: ok`). Exit code 1
 * when there is any problem, 0 when there is none, 2 for a command that is not understood. With no
 * folder, it checks the working directory when that is an app folder, otherwise every app folder
 * under apps/ of the workspace it is in (a folder above with pnpm-workspace.yaml), and says so when
 * there is none. With --json it prints the problems as JSON and nothing else: the array of
 * Problem for one folder named on the command line; otherwise an object from each folder to its array.
 */

export const USAGE = 'usage: dialogwright check [--json] [dir...]\n  dir: an app folder (one with app.yaml); with none, the working directory, or the app folders under apps/ of the workspace';

export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** The working directory the command runs in. */
  cwd: string;
}

const stdio = (): Io => ({ out: (line) => console.log(line), err: (line) => console.error(line), cwd: process.cwd() });

/** The app folders a bare `dialogwright check` means: the working directory, or those under apps/ of the workspace, as paths from the directory it looked in. */
export function findAppFolders(cwd: string): { root: string; dirs: string[] } {
  if (existsSync(join(cwd, 'app.yaml'))) return { root: cwd, dirs: [cwd] };
  let root = cwd;
  for (let at = cwd; ; at = dirname(at)) {
    if (existsSync(join(at, 'pnpm-workspace.yaml'))) {
      root = at;
      break;
    }
    if (dirname(at) === at) break;
  }
  const subfolders = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')).map((e) => join(dir, e.name)).sort();
    } catch {
      return [];
    }
  };
  const dirs: string[] = [];
  for (const app of subfolders(join(root, 'apps'))) {
    if (existsSync(join(app, 'app.yaml'))) dirs.push(app);
    else dirs.push(...subfolders(app).filter((sub) => existsSync(join(sub, 'app.yaml'))));
  }
  return { root, dirs };
}

/** Runs the command with `argv` (what follows `dialogwright`); returns the exit code. */
export async function main(argv: readonly string[], io: Io = stdio()): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'check') {
    io.err(command === undefined ? USAGE : `dialogwright: "${command}" is not a command\n${USAGE}`);
    return 2;
  }
  const json = rest.includes('--json');
  const unknown = rest.find((a) => a.startsWith('-') && a !== '--json');
  if (unknown) {
    io.err(`dialogwright check: ${unknown} is not an option\n${USAGE}`);
    return 2;
  }
  const given = rest.filter((a) => !a.startsWith('-'));
  let dirs: { label: string; path: string }[];
  let discovered = false;
  if (given.length > 0) {
    dirs = given.map((d) => ({ label: d, path: resolve(io.cwd, d) }));
  } else {
    const found = findAppFolders(io.cwd);
    discovered = true;
    dirs = found.dirs.map((path) => ({ label: relative(found.root, path) || '.', path }));
    if (dirs.length === 0 && !json) {
      io.out('no app folders found: no folder under apps/ has an app.yaml');
    }
  }

  const results: Record<string, Problem[]> = {};
  for (const { label, path } of dirs) {
    const { problems, codeChecked } = await checkAppFully(path);
    results[label] = problems;
    if (json) continue;
    for (const problem of problems) io.out(formatProblem(problem));
    io.out(problems.length === 0 ? `${label}: ok` : `${problems.length} problem${problems.length === 1 ? '' : 's'} in ${label}`);
    if (!codeChecked && problems.length === 0) io.err(`${label}: checked the YAML only; there is no app.ts to check it against (it exports the app's code parts as \`code\`)`);
  }
  if (json) io.out(JSON.stringify(dirs.length === 1 && !discovered ? results[dirs[0]!.label] : results, null, 2));
  return Object.values(results).some((problems) => problems.length > 0) ? 1 : 0;
}

/** True when this file is the program being run (and not imported by a test). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2));
}
