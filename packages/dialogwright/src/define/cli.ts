#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appFolderAt } from './appFolder';
import { HOST_FILE_NAME, resolveHostFile } from './host';
import { INSTALLED } from './home';
import { checkAppFully } from './check';
import { createApp, CreateAppError, displayNameOf, REPO_ROOT } from './createApp';
import { ConvertError, convertFolder, convertTables, toText, writeConversion } from './convert/convertPolicy';
import type { IdentityConfig, PolicyTables } from '../core/app/types';
import { matrixCommand } from './matrixCommand';
import { pageCommand, type PageCommand } from './pageCommand';
import { formatProblem, type Problem } from './problems';

/**
 * The `dialogwright` command: one command line for every command an app's author runs. In this
 * repository it is the package's bin, run through tsx (the root's `pnpm check`, `pnpm configure`,
 * `pnpm start`... all run this file); in an installed package the bin is bin/dialogwright.mjs, which
 * registers tsx's loader and runs this file's build. The commands:
 *
 *   dialogwright check [--json] [dir...]
 *   dialogwright create-app <name> [--identity] [--dir path] [--display text] [--no-install]
 *   dialogwright policy:convert (dir | --from-tables module) [--out dir] [--dry-run] [--no-sign-in]
 *   dialogwright policy:matrix [dir...]   (./matrixCommand.ts: writes each app's policy.matrix)
 *   dialogwright policy:card [dir...]     (./pageCommand.ts: writes each app's POLICY.md, the policy card)
 *   dialogwright app:diagram [dir...]     (./pageCommand.ts: writes each app's APP-MAP.md, the app map)
 *   dialogwright kb:model | kb:index | kb:bakeoff   (../kb/commands.ts: the knowledge base's retrieval)
 *   dialogwright kb:approve | kb:status             (../kb/commands.ts, ../kb/approval.ts: approving passages, and their state)
 *   dialogwright regress [dir] [options]            (../harness-text/regressCommand.ts: an app's regression run)
 *   dialogwright render:bakeoff [dir] --models ...  (../harness-text/renderBakeoffCommand.ts: render models compared)
 *   dialogwright configure | start | serve | diagnose | service | fallback | console:link   (../server: running an app, or a host file's apps)
 *   dialogwright audit:verify [dir | postgres://...] (../audit/verifyCli.ts: each audit day file's hash chain, or the audit in Postgres)
 *   dialogwright help
 *
 * `check` checks each app folder `dir` (a folder with app.yaml): see ./check.ts for what that is. One line
 * per problem, then a summary line per folder (`N problems in <dir>`, or `<dir>: ok`). Exit code 1
 * when there is any problem, 0 when there is none, 2 for a command that is not understood. With no
 * folder, it checks the working directory when that is an app folder, otherwise every app folder
 * under apps/ of the workspace it is in (a folder above with pnpm-workspace.yaml), and says so when
 * there is none. With --json it prints the problems as JSON and nothing else: the array of
 * Problem for one folder named on the command line; otherwise an object from each folder to its array.
 *
 * `create-app` writes a new app folder from the template (./createApp.ts) and prints what to do next;
 * it is `pnpm create-app` at the repository root. It exits 1 for a name it refuses or a folder that
 * exists, and 2 for a command line it does not understand.
 *
 * The commands that run an app (configure, start, serve, diagnose, service, fallback, console:link) and
 * audit:verify are their modules' own, given this process's terminal, environment and folder; each
 * prints its own usage.
 */

/** Every command, with what it does in a line: `dialogwright help` prints them. */
export const COMMANDS: readonly (readonly [name: string, summary: string])[] = [
  ['check', 'every app folder (or those named): YAML, schemas, cross-links to the code, prompts, corpus'],
  ['create-app', 'a new app from the template (--standalone: a project of its own, outside this repository)'],
  ['regress', "an app's regression run against its fixtures (the stub, or a recording with --client recorded)"],
  ['render:bakeoff', "compare render models on an app's generated lines: each recorded into its own cassette, one table (--replay: from the cassettes)"],
  ['policy:matrix', 'write policy.matrix, the reviewed golden of what the gate decides'],
  ['policy:card', 'write POLICY.md, the policy in plain English with its diagrams'],
  ['app:diagram', "write APP-MAP.md, the app's intents, forms, slots, actions and rules as diagrams"],
  ['policy:convert', 'policy.yaml and identity.yaml from the old table shape to the current one'],
  ['configure', "ask, and write the app's .env: a laptop with no keys, or a phone line"],
  ['start', "the app's server with its .env (or a host file's apps: --host), through a quick tunnel when PUBLIC_HOST is unset"],
  ['serve', "the server of a host file (host.yaml: several apps on one server), the process pnpm start --host runs"],
  ['diagnose', 'what is misconfigured, one line per check with its fix (--offline: no requests)'],
  ['service', 'a launchd or systemd service file with this machine\'s paths; prints the install commands'],
  ['fallback', 'the document a carrier plays when it cannot reach the server'],
  ['console:link', 'a new one-time sign-in link for the console (CONSOLE_AUTH=token)'],
  ['audit:verify', "each audit day file's hash chain, or the audit in Postgres (a postgres:// URL); exit 1 at the first break"],
  ['kb:model', 'download the pinned embedding model, checking its SHA-256'],
  ['kb:index', "write a knowledge base's vector index after its topics change"],
  ['kb:bakeoff', 'compare the retrievers on paraphrases offline'],
  ['kb:approve', 'approve passages, by a person at the terminal'],
  ['kb:status', 'the passages by state, each with its fix'],
  ['help', 'this list'],
];

export const USAGE = [
  'usage: dialogwright check [--json] [dir... | host.yaml...]',
  '  dir: an app folder (one with app.yaml); with none, the working directory, or the app folders under apps/ of the workspace (and host.yaml beside them)',
  '  host.yaml: a host file (several apps on one server): its apps exist, each passes its own check, no number twice, the default is one of them',
  '       dialogwright create-app <name> [--identity] [--dir path] [--display text] [--no-install] [--standalone [--dialogwright spec]]',
  '  name: lowercase letters, digits and hyphens; the new app is apps/<name> unless --dir says where',
  '  --standalone: a project of its own, outside this repository, depending on the dialogwright package (<name> in the folder it is run in, unless --dir);',
  '    run from an installed package (npx dialogwright create-app), it is always a project of its own, as if --standalone were given',
  '  --dialogwright spec: with --standalone, the dependency its package.json names (default: ^ this version; a file: path to a packed package works too)',
  '  --identity: add identity.yaml, so callers verify with two factors (an account number and a birth date) before the booking',
  '  --display text: the name the greeting and the console use (default: the name in capitals, "water-utility" is "Water Utility")',
  '  --no-install: do not run `pnpm install` afterwards, which links the new app into the workspace',
  '       dialogwright policy:convert (dir | --from-tables module) [--out dir] [--dry-run] [--no-sign-in]',
  '  dir: an app folder whose policy.yaml (and identity.yaml) are in the old shape',
  '  --from-tables module: a module exporting `policy` (PolicyTables) and, for an app that verifies callers, `identity` (IdentityConfig)',
  '  --out dir: where the new files are written (default: dir, in place; for --from-tables, the module\'s folder)',
  '  --dry-run: write nothing, only report',
  '  --no-sign-in: leave `signIn` out of identity.yaml (by default it is `signIn: { level: 2 }` where the ladder has a code,',
  '    as an app took a sign-in before identity.yaml); for an app no channel signs a caller in to',
  '       dialogwright policy:matrix [dir...]',
  '  dir: a folder with the app\'s policy.yaml and a module exporting the app; with none, every folder with a policy.matrix',
  '       dialogwright policy:card [dir...]',
  '  dir: the same; writes POLICY.md, the policy in plain English with its diagrams; with none, every folder with a POLICY.md',
  '       dialogwright app:diagram [dir...]',
  '  dir: the same; writes APP-MAP.md, the app\'s intents, forms, slots, actions and rules as diagrams; with none, every folder with an APP-MAP.md',
  '       dialogwright kb:model [id...]',
  '  downloads the pinned embedding models (potion-base-8M) into the cache, ~/.cache/dialogwright/models (or $DIALOGWRIGHT_MODEL_DIR), checking each file\'s SHA-256',
  '       dialogwright kb:index [dir...] [--locale tag]',
  '  dir: an app folder with a kb/, or a kb folder; writes kb/.index/<embedder>.json, re-embedding only changed texts; with none, every app folder with a kb/',
  '       dialogwright kb:bakeoff <dir> --paraphrases <file> [--sweep] [--locale tag] [--today YYYY-MM-DD] [--onnx-revision <commit>]',
  '  compares the retrievers (keyword, static, hybrid, onnx when installed and given the commit of its model) on a paraphrase file: recall at the cap, candidates, latency; --sweep: floor and cap',
  '       dialogwright kb:approve <id...> --by "<your name>" [--owner "<team>"] [--dir <app folder>] [--yes]',
  '  approves passages (kb/passages) and moves approved drafts out of kb/pending, recording who, for which team and when, and logging each in kb/approvals.jsonl;',
  '  --by is the person who reviewed each against its source; --owner is required for a passage approved for the first time; --dir: the app folder (default: the one here)',
  '  asks you to confirm at the terminal first; --yes confirms on the command line instead (refused in CI)',
  '       dialogwright kb:status [dir...]',
  '  dir: an app folder with a kb/, or a kb folder; lists the passages by state (fresh, stale, unapproved) and the drafts, with the fix for each',
  '       dialogwright regress [dir] [options]',
  '  the app\'s regression run, as its src/regress.ts runs it (dialogwright regress --help: the options)',
  '       dialogwright render:bakeoff [dir] --models <model>[,<model>...] [--replay | --fresh [--replace-app-cassette]] [--by-line] [--price <model>=<input>,<output>]... [--out <file.md>] [--json]',
  '  render models compared on the app\'s generated lines, each recorded into its own render cassette with your keys (refused in CI); --replay tables the cassettes alone (dialogwright render:bakeoff --help)',
  '       dialogwright configure | start | serve | diagnose | service | fallback | console:link | audit:verify [options]',
  '  running an app: each prints its own usage; dialogwright help lists every command',
].join('\n');

/** `dialogwright help`: every command, a line each. */
export function helpText(): string {
  const width = Math.max(...COMMANDS.map(([name]) => name.length));
  return ['usage: dialogwright <command> [options]', '', ...COMMANDS.map(([name, summary]) => `  ${name.padEnd(width)}  ${summary}`), '', 'In a project of your own, run them with npx dialogwright <command> (or the project\'s npm scripts); in the DialogWright repository, pnpm <command>.'].join('\n');
}

/** The commands that run an app, and audit:verify: each module's own command line. Loaded only when one runs. */
const PROCESS_COMMANDS: Readonly<Record<string, () => Promise<(argv: readonly string[]) => Promise<number> | number>>> = {
  configure: async () => (await import('../server/setup')).commandLine,
  start: async () => (await import('../server/start')).commandLine,
  serve: async () => (await import('../server/hostServe')).commandLine,
  diagnose: async () => (await import('../server/doctor')).commandLine,
  service: async () => (await import('../server/serviceFile')).commandLine,
  fallback: async () => (await import('../server/fallback')).commandLine,
  'console:link': async () => (await import('../server/console/linkCli')).commandLine,
  'audit:verify': async () => {
    const { main: verify } = await import('../audit/verifyCli');
    return (argv) => verify([...argv]);
  },
};

export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** The working directory the command runs in. */
  cwd: string;
  /** Where the user ran `pnpm <script>` from, which relative paths in a script's arguments are from (pnpm's INIT_CWD). Default: cwd. */
  invokedFrom?: string;
  /** The repository root create-app writes into and installs in. Default: the repository this package is in. */
  root?: string;
  /** Whether the package is installed in a project's node_modules, where create-app always writes a project of its own. Default: ./home.ts INSTALLED. */
  installed?: boolean;
  /** Runs `pnpm install` in `root`; returns its exit code. Default: runs it, showing its output. */
  install?(root: string): number;
  /** Today, as an ISO date (kb:approve records it). Default: today (UTC). */
  today?: () => string;
  /** kb:approve's confirmation, in place of the terminal's (../kb/commands.ts KbIo.confirm). */
  confirm?: (question: string) => Promise<boolean>;
  /** Whether stdin is a terminal. Default: process.stdin.isTTY. */
  isTTY?: boolean;
  /** The environment the kb commands read (CI, the model cache). Default: process.env. */
  env?: NodeJS.ProcessEnv;
}

const stdio = (): Io => ({
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  cwd: process.cwd(),
  ...(process.env.INIT_CWD ? { invokedFrom: process.env.INIT_CWD } : {}),
});

/** A folder's real path, or the path as given when it cannot be resolved. */
function realOrSame(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const pnpmInstall = (root: string): number => spawnSync('pnpm', ['install'], { cwd: root, stdio: 'inherit' }).status ?? 1;

/**
 * The app folders a bare `dialogwright check` means: the working directory, or, outside a workspace,
 * the app it is inside (a folder of a project of its own), or those under apps/ of the workspace, as
 * paths from the directory it looked in (`root`).
 */
export function findAppFolders(cwd: string): { root: string; dirs: string[] } {
  if (existsSync(join(cwd, 'app.yaml'))) return { root: cwd, dirs: [cwd] };
  let root = cwd;
  let workspace = false;
  for (let at = cwd; ; at = dirname(at)) {
    if (existsSync(join(at, 'pnpm-workspace.yaml'))) {
      root = at;
      workspace = true;
      break;
    }
    if (dirname(at) === at) break;
  }
  // Outside a workspace, a folder inside an app (a project of its own) means that app.
  const inside = workspace ? null : appFolderAt(cwd);
  if (inside !== null) return { root: cwd, dirs: [inside] };
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

/** The pages `policy:card` and `app:diagram` write beside policy.yaml. Their modules are loaded only when one runs: the other commands do not need them. */
const POLICY_CARD: PageCommand = {
  name: 'policy:card',
  file: 'POLICY.md',
  write: async (app, file) => (await import('../testing/policyCard')).writePolicyCard(app, file),
};
const APP_DIAGRAM: PageCommand = {
  name: 'app:diagram',
  file: 'APP-MAP.md',
  write: async (app, file) => (await import('../testing/appMap')).writeAppMap(app, file),
};

/** Runs the command with `argv` (what follows `dialogwright`); returns the exit code. */
export async function main(argv: readonly string[], io: Io = stdio()): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'help' || command === '--help' || command === '-h') {
    io.out(helpText());
    return 0;
  }
  const runner = command !== undefined && Object.hasOwn(PROCESS_COMMANDS, command) ? PROCESS_COMMANDS[command] : undefined;
  if (runner) return (await runner())(rest);
  if (command === 'regress') {
    const { regressCommand } = await import('../harness-text/regressCommand');
    return regressCommand(rest, { err: io.err, invokedFrom: io.invokedFrom ?? io.cwd });
  }
  if (command === 'render:bakeoff') {
    const { bakeoffCommand } = await import('../harness-text/renderBakeoffCommand');
    return bakeoffCommand(rest, { out: io.out, err: io.err, invokedFrom: io.invokedFrom ?? io.cwd, ...(io.env ? { env: io.env } : {}) });
  }
  if (command === 'policy:convert') return convertCommand(rest, io);
  if (command === 'create-app') return createAppCommand(rest, io);
  if (command === 'policy:matrix') return matrixCommand(rest, io);
  if (command === 'policy:card') return pageCommand(POLICY_CARD, rest, io);
  if (command === 'app:diagram') return pageCommand(APP_DIAGRAM, rest, io);
  if (command === 'kb:model' || command === 'kb:index' || command === 'kb:bakeoff' || command === 'kb:approve' || command === 'kb:status') {
    // Loaded only when one runs: the other commands do not need the knowledge base's code.
    const kb = await import('../kb/commands');
    const kbIo = { out: io.out, err: io.err, cwd: io.invokedFrom ?? io.cwd, ...(io.today ? { today: io.today } : {}), ...(io.confirm ? { confirm: io.confirm } : {}), ...(io.isTTY !== undefined ? { isTTY: io.isTTY } : {}), ...(io.env ? { env: io.env } : {}) };
    const discover = () => findAppFolders(io.invokedFrom ?? io.cwd).dirs;
    if (command === 'kb:model') return kb.kbModelCommand(rest, kbIo);
    if (command === 'kb:bakeoff') return kb.kbBakeoffCommand(rest, kbIo);
    if (command === 'kb:approve') return kb.kbApproveCommand(rest, kbIo, discover);
    if (command === 'kb:status') return kb.kbStatusCommand(rest, kbIo, discover);
    return kb.kbIndexCommand(rest, kbIo, discover);
  }
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
  /** Host files (host.yaml: several apps on one server): one named, or the one beside the apps. */
  let hosts: { label: string; path: string }[] = [];
  let discovered = false;
  if (given.length > 0) {
    // A file is read as a host file by its name (host.yaml, or the one HOST_FILE names) or its shape (a
    // top-level `apps` list); anything else is checked as an app folder, as it always was.
    const isHost = (d: string): boolean => {
      const path = resolve(io.cwd, d);
      try {
        if (!statSync(path).isFile()) return false;
      } catch {
        return false;
      }
      const named = (io.env ?? process.env).HOST_FILE?.trim();
      if (basename(path) === HOST_FILE_NAME || (named && resolve(io.cwd, named) === path)) return true;
      try {
        const doc = parseYaml(readFileSync(path, 'utf8')) as { apps?: unknown } | null;
        return Array.isArray(doc?.apps);
      } catch {
        return false;
      }
    };
    hosts = given.filter(isHost).map((d) => ({ label: d, path: resolve(io.cwd, d) }));
    dirs = given.filter((d) => !isHost(d)).map((d) => ({ label: d, path: resolve(io.cwd, d) }));
  } else {
    const found = findAppFolders(io.cwd);
    discovered = true;
    dirs = found.dirs.map((path) => ({ label: relative(found.root, path) || '.', path }));
    if (existsSync(join(found.root, HOST_FILE_NAME))) hosts = [{ label: HOST_FILE_NAME, path: join(found.root, HOST_FILE_NAME) }];
    if (dirs.length === 0 && hosts.length === 0 && !json) {
      io.out('no app folders found: no folder under apps/ has an app.yaml');
    }
  }
  // A host file's own problems, and each app it lists that is not checked already, checked as its own.
  const hostProblems = new Map<string, Problem[]>();
  for (const h of hosts) {
    const { host, problems } = resolveHostFile(h.path);
    hostProblems.set(h.label, problems.map((p) => ({ ...p, file: h.label })));
    for (const app of host?.apps ?? []) {
      if (dirs.some((d) => realOrSame(d.path) === app.dir)) continue;
      dirs.push({ label: relative(io.cwd, app.dir) || '.', path: app.dir });
    }
  }

  const results: Record<string, Problem[]> = {};
  for (const [label, problems] of hostProblems) {
    results[label] = problems;
    if (json) continue;
    for (const problem of problems) io.out(formatProblem(problem));
    io.out(problems.length === 0 ? `${label}: ok` : `${problems.length} problem${problems.length === 1 ? '' : 's'} in ${label}`);
  }
  for (const { label, path } of dirs) {
    const { problems, codeChecked, warnings } = await checkAppFully(path);
    results[label] = problems;
    // A warning is printed and never counted: on stderr under --json, so the JSON stays the problems.
    for (const warning of warnings ?? []) {
      if (json) io.err(`warning: ${formatProblem(warning)}`);
      else io.out(`warning: ${formatProblem(warning)}`);
    }
    if (json) continue;
    for (const problem of problems) io.out(formatProblem(problem));
    io.out(problems.length === 0 ? `${label}: ok` : `${problems.length} problem${problems.length === 1 ? '' : 's'} in ${label}`);
    if (!codeChecked && problems.length === 0) io.err(`${label}: checked the YAML only; there is no app.ts (or src/app.ts) to check it against (it exports the app's code parts as \`code\`)`);
  }
  if (json) io.out(JSON.stringify(dirs.length === 1 && hosts.length === 0 && !discovered ? results[dirs[0]!.label] : results, null, 2));
  return Object.values(results).some((problems) => problems.length > 0) ? 1 : 0;
}

/**
 * `dialogwright create-app`: a new app from the template (./createApp.ts), then `pnpm install` so the
 * workspace links it, then what to run next. Exit code 0 when it wrote the app, 1 when it refused
 * (a bad name, a folder that exists), 2 for a command line it does not understand.
 */
function createAppCommand(args: readonly string[], io: Io): number {
  let name: string | undefined;
  let dir: string | undefined;
  let display: string | undefined;
  let identity = false;
  let install = true;
  let standalone = false;
  let dependency: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--identity') identity = true;
    else if (arg === '--no-install') install = false;
    else if (arg === '--standalone') standalone = true;
    else if (arg === '--dir' || arg === '--display' || arg === '--dialogwright') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        io.err(`dialogwright create-app: ${arg} needs a value\n${USAGE}`);
        return 2;
      }
      i += 1;
      if (arg === '--dir') dir = value;
      else if (arg === '--display') display = value;
      else dependency = value;
    } else if (arg.startsWith('-')) {
      io.err(`dialogwright create-app: ${arg} is not an option\n${USAGE}`);
      return 2;
    } else if (name === undefined) name = arg;
    else {
      io.err(`dialogwright create-app: one name at a time\n${USAGE}`);
      return 2;
    }
  }
  if (name === undefined) {
    io.err(`dialogwright create-app: give the app a name\n${USAGE}`);
    return 2;
  }
  // Installed in a project, there is no repository to write an app into: it is always a project of its own.
  if (io.installed ?? INSTALLED) standalone = true;
  if (dependency !== undefined && !standalone) {
    io.err(`dialogwright create-app: --dialogwright goes with --standalone\n${USAGE}`);
    return 2;
  }
  const from = io.invokedFrom ?? io.cwd;
  if (standalone) return standaloneCommand({ name, identity, from, ...(dir === undefined ? {} : { dir }), ...(display === undefined ? {} : { display }), ...(dependency === undefined ? {} : { dependency }) }, io);
  try {
    const root = io.root ?? REPO_ROOT;
    const made = createApp({ name, identity, root, ...(dir === undefined ? {} : { dir: resolve(from, dir) }), ...(display === undefined ? {} : { display }) });
    const rel = relative(from, made.dir);
    const shown = rel === '' ? '.' : rel.startsWith('..') ? made.dir : rel;
    io.out(`created ${shown}: ${made.files.length} files, ${identity ? 'with' : 'without'} identity.yaml, for "${display ?? displayNameOf(name)}"`);
    let linked = false;
    if (made.inWorkspace && install) {
      io.out('running pnpm install, so the workspace links the new app');
      linked = (io.install ?? pnpmInstall)(root) === 0;
      if (!linked) io.err('pnpm install failed; run it yourself at the repository root before the commands below');
    }
    const filter = `--filter ${made.packageName}`;
    // A bare `pnpm check` reads only the folders under apps/, and runs in the package's folder, so a
    // folder elsewhere is named by its absolute path.
    const check = made.inWorkspace ? 'pnpm check' : `pnpm check ${made.dir}`;
    const steps: string[][] = [];
    if (!made.inWorkspace) steps.push(['The folder is not directly under apps/, so the workspace does not find it: add its folder to pnpm-workspace.yaml, then run pnpm install at the repository root.']);
    else if (!linked) steps.push(['pnpm install    (at the repository root: it links the new app into the workspace)']);
    steps.push(
      [made.inWorkspace ? 'pnpm check    (every app folder, this one included: it passes as created)' : `${check}    (this folder: a bare pnpm check reads only the folders under apps/; it passes as created)`],
      [`pnpm ${filter} test`, `pnpm ${filter} typecheck`, `pnpm ${filter} regress    (the stub regression: "no changes")`],
      [
        `Read ${join(shown, 'README.md')} and ${join(shown, 'CLAUDE.md')}, then replace the example intent, form, slot and tool with your own, running ${check} after each change.`,
        'The folder guide is docs/guide/README.md; the slot types are in docs/slots/README.md.',
        'The scaffold ships the example\'s baseline (fixtures/expected). Make your own app\'s first baseline once, with regress --update, and review it; never regenerate it after that.',
      ],
    );
    io.out('');
    io.out('Next:');
    steps.forEach((lines, i) => lines.forEach((line, j) => io.out(`  ${j === 0 ? `${i + 1}.` : '  '} ${line}`)));
    return 0;
  } catch (error) {
    if (!(error instanceof CreateAppError)) throw error;
    io.err(`dialogwright create-app: ${error.message}`);
    return 1;
  }
}

/** `dialogwright create-app --standalone`: a project of its own, and what to run in it. */
function standaloneCommand(o: { name: string; identity: boolean; from: string; dir?: string; display?: string; dependency?: string }, io: Io): number {
  try {
    const made = createApp({ name: o.name, identity: o.identity, standalone: true, dir: resolve(o.from, o.dir ?? o.name), ...(o.display === undefined ? {} : { display: o.display }), ...(o.dependency === undefined ? {} : { dependency: o.dependency }) });
    const rel = relative(o.from, made.dir);
    const shown = rel === '' ? '.' : rel.startsWith('..') ? made.dir : rel;
    io.out(`created ${shown}: a project of its own, ${made.files.length} files, ${o.identity ? 'with' : 'without'} identity.yaml, for "${o.display ?? displayNameOf(o.name)}"`);
    io.out('');
    io.out('Next:');
    const steps = [
      [`cd ${shown}`, 'npm install    (or pnpm install)'],
      ['npx dialogwright check    (the folder: it passes as created)'],
      ['npm run typecheck', 'npm test', 'npx dialogwright regress    (the stub regression: "no changes")'],
      [
        'Read README.md and CLAUDE.md, then replace the example intent, form, slot and tool with your own, running npx dialogwright check after each change.',
        'To build it from a paragraph describing your line, give the paragraph to an AI coding assistant and point it at .claude/skills/create-app/SKILL.md.',
        'The guide is node_modules/dialogwright/docs/guide/README.md once it is installed.',
      ],
    ];
    steps.forEach((lines, i) => lines.forEach((line, j) => io.out(`  ${j === 0 ? `${i + 1}.` : '  '} ${line}`)));
    return 0;
  } catch (error) {
    if (!(error instanceof CreateAppError)) throw error;
    io.err(`dialogwright create-app: ${error.message}`);
    return 1;
  }
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
  let signIn = true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--dry-run') dryRun = true;
    // --sign-in is the default, still accepted.
    else if (arg === '--sign-in') signIn = true;
    else if (arg === '--no-sign-in') signIn = false;
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
