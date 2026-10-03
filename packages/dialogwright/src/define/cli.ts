#!/usr/bin/env tsx
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkAppFully } from './check';
import { ConvertError, convertFolder, convertTables, toText, writeConversion } from './convert/convertPolicy';
import type { IdentityConfig, PolicyTables } from '../core/app/types';
import { formatProblem, type Problem } from './problems';

/**
 * The `dialogwright` command (the package's bin; run through tsx, which is how the repo runs its
 * TypeScript). Two commands:
 *
 *   dialogwright check [--json] [dir...]
 *   dialogwright policy:convert (dir | --from-tables module) [--out dir] [--dry-run] [--sign-in]
 *
 * `check` checks each app folder `dir` (a folder with app.yaml): see ./check.ts for what that is. One line
 * per problem, then a summary line per folder (`N problems in <dir>`, or `<dir>: ok`). Exit code 1
 * when there is any problem, 0 when there is none, 2 for a command that is not understood. A warning
 * (a file in a shape read only until every app is converted) goes to stderr as `<dir>: warning: ...`
 * and does not change the exit code. With no
 * folder, it checks the working directory when that is an app folder, otherwise every app folder
 * under apps/ of the workspace it is in (a folder above with pnpm-workspace.yaml), and says so when
 * there is none. With --json it prints the problems as JSON and nothing else: the array of
 * Problem for one folder named on the command line; otherwise an object from each folder to its array.
 */

export const USAGE = [
  'usage: dialogwright check [--json] [dir...]',
  '  dir: an app folder (one with app.yaml); with none, the working directory, or the app folders under apps/ of the workspace',
  '       dialogwright policy:convert (dir | --from-tables module) [--out dir] [--dry-run] [--sign-in]',
  '  dir: an app folder whose policy.yaml (and identity.yaml) are in the old shape',
  '  --from-tables module: a module exporting `policy` (PolicyTables) and, for an app that verifies callers, `identity` (IdentityConfig)',
  '  --out dir: where the new files are written (default: dir, in place; for --from-tables, the module\'s folder)',
  '  --dry-run: write nothing, only report',
  '  --sign-in: write `signIn: { level: 2 }`, for an app whose channel can sign a caller in',
].join('\n');

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
  if (command === 'policy:convert') return convertCommand(rest, io);
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
    const { problems, warnings, codeChecked } = await checkAppFully(path);
    results[label] = problems;
    if (json) continue;
    for (const problem of problems) io.out(formatProblem(problem));
    for (const warning of warnings) io.err(`${label}: warning: ${formatProblem(warning)}`);
    io.out(problems.length === 0 ? `${label}: ok` : `${problems.length} problem${problems.length === 1 ? '' : 's'} in ${label}`);
    if (!codeChecked && problems.length === 0) io.err(`${label}: checked the YAML only; there is no app.ts (or src/app.ts) to check it against (it exports the app's code parts as \`code\`)`);
  }
  if (json) io.out(JSON.stringify(dirs.length === 1 && !discovered ? results[dirs[0]!.label] : results, null, 2));
  return Object.values(results).some((problems) => problems.length > 0) ? 1 : 0;
}

/**
 * `dialogwright policy:convert`: policy.yaml and identity.yaml from the old shape to the new
 * (./convert/convertPolicy.ts). Prints what it wrote, then every old row it dropped (nothing reads
 * it, so the new shape cannot say it) and every comment it could not place, each on its own line to
 * stdout. Exit code 0 when it converted (or the files are already in the new shape), 1 when it
 * cannot (the problems are on stderr), 2 for a command that is not understood.
 */
async function convertCommand(args: readonly string[], io: Io): Promise<number> {
  let dir: string | undefined;
  let fromTables: string | undefined;
  let out: string | undefined;
  let dryRun = false;
  let signIn = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--sign-in') signIn = true;
    else if (arg === '--from-tables' || arg === '--out') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) {
        io.err(`dialogwright policy:convert: ${arg} needs a value\n${USAGE}`);
        return 2;
      }
      i += 1;
      if (arg === '--out') out = value;
      else fromTables = value;
    } else if (arg.startsWith('-')) {
      io.err(`dialogwright policy:convert: ${arg} is not an option\n${USAGE}`);
      return 2;
    } else if (dir === undefined) dir = arg;
    else {
      io.err(`dialogwright policy:convert: one folder at a time\n${USAGE}`);
      return 2;
    }
  }
  if ((dir === undefined) === (fromTables === undefined)) {
    io.err(`dialogwright policy:convert: give an app folder, or --from-tables and a module\n${USAGE}`);
    return 2;
  }

  try {
    let files: Record<string, string>;
    let dropped: string[];
    let unplaced: string[] = [];
    let into: string;
    if (dir !== undefined) {
      into = resolve(io.cwd, out ?? dir);
      const converted = convertFolder(resolve(io.cwd, dir), { out: into, signIn });
      for (const file of converted.alreadyNew) io.out(`${file} is already in the new shape: left alone`);
      ({ files, dropped, unplaced } = converted);
    } else {
      const path = resolve(io.cwd, fromTables!);
      into = resolve(io.cwd, out ?? dirname(path));
      const module = (await import(pathToFileURL(path).href)) as { policy?: PolicyTables; identity?: IdentityConfig; default?: { policy?: PolicyTables; identity?: IdentityConfig } };
      const policy = module.policy ?? module.default?.policy;
      if (!policy) throw new ConvertError([`${fromTables}: the module exports no \`policy\` (PolicyTables) -> export the app's tables as \`policy\`, and its identity as \`identity\``]);
      const converted = convertTables(policy, module.identity ?? module.default?.identity, { signIn, schemaDir: relative(realpathSync(existsSync(into) ? into : dirname(into)), join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas')) || '.' });
      files = { 'policy.yaml': toText(converted.policy), ...(converted.identity ? { 'identity.yaml': toText(converted.identity) } : {}) };
      dropped = converted.dropped;
    }
    if (dryRun) for (const file of Object.keys(files)) io.out(`${file}: would write ${join(relative(io.cwd, into) || '.', file)}`);
    else {
      writeConversion({ files, dropped, unplaced, alreadyNew: [] }, into);
      for (const file of Object.keys(files)) io.out(`wrote ${join(relative(io.cwd, into) || '.', file)}`);
    }
    for (const line of dropped) io.out(`dropped ${line}`);
    for (const line of unplaced) io.out(`comment not placed ${line}`);
    return 0;
  } catch (error) {
    if (!(error instanceof ConvertError)) throw error;
    for (const problem of error.problems) io.err(problem);
    return 1;
  }
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
