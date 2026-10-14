import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DRAIN_MS, integer, type Env } from './config';
import { joinEnvFiles, readEnvFiles, resolveEnvFiles } from './envFile';
import { findOnPath } from './tunnel';
import { ENGINE_BIN, findApp, projectRoot, workspaceApps } from './workspace';
import { hostFileOf, resolveHostFile, type ResolvedHost } from '../define/host';
import { formatProblem } from '../define/problems';

/**
 * `ENV_FILE=<path> pnpm service <launchd|systemd> --app <name> [--label <label>] [--out <file>] [--force]`
 * (or `--env-file <path>`): a service definition that keeps an app's server running on this machine, with absolute paths
 * resolved here. It runs `<pnpm> --filter <app> serve` from the repository with ENV_FILE naming the
 * settings file (the server reads it, as pnpm start does), starts it at load (login, or boot for a
 * lingering systemd user), restarts it when it exits, and gives a stop DRAIN_UNREADY_MS and DRAIN_MS and ten seconds more
 * before it is killed. It writes the file and prints the commands that install it; it runs none of them.
 *
 * - launchd: a LaunchAgent plist (default ~/Library/LaunchAgents/<label>.plist), its output in
 *   ~/Library/Logs/<label>/, ProcessType Interactive, and the PATH that holds this node and pnpm.
 * - systemd: a user unit (default ~/.config/systemd/user/<label>.service), Restart=always, KillMode=mixed
 *   so only pnpm is sent SIGTERM (it passes it on and waits), TimeoutStopSec from DRAIN_MS.
 */

export type ServiceKind = 'launchd' | 'systemd';

export interface ServiceInputs {
  kind: ServiceKind;
  label: string;
  /** The app's package name, for pnpm --filter. */
  app: string;
  /** The repository root, absolute. */
  root: string;
  /** The settings file, absolute. */
  envFile: string;
  /** pnpm, absolute. */
  pnpm: string;
  /** The PATH the service runs with. */
  path: string;
  /** launchd's log folder, absolute. */
  logDir: string;
  /** How long a stop may take before the process is killed. */
  stopSeconds: number;
  /** A project of its own (no pnpm-workspace.yaml at its root), whose file says so; this repository by default. */
  project?: boolean;
  /**
   * A host file's apps (host.yaml: several apps on one server) in place of one app: the service runs
   * `<node> <the engine's bin> serve --host <file>` in the host file's folder. `app` then names it.
   */
  host?: { file: string; dir: string; node: string; bin: string };
}

const TEMPLATES = fileURLToPath(new URL('../../templates/service/', import.meta.url));

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** A value in a unit file: `%` starts a specifier there, so it is doubled. */
const unitValue = (s: string) => s.replace(/%/g, '%%');
/** A word of ExecStart: quoted when it has a space or a quote. */
const unitWord = (s: string) => (/[\s"'\\]/.test(s) ? `"${unitValue(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : unitValue(s));

/** The file for these inputs, from its template. */
/**
 * The template for a host file's server: the one app's, its command (`<pnpm> --filter <app> serve`) and
 * the words naming the app replaced with the host's. Throws when the template no longer has them.
 */
function hostTemplate(kind: ServiceKind, template: string): string {
  const swaps: [string, string][] = kind === 'launchd'
    ? [
      ['the DialogWright app {{app}}', 'the DialogWright {{what}}'],
      ['    <string>{{pnpm}}</string>\n    <string>--filter</string>\n    <string>{{app}}</string>\n    <string>serve</string>', '{{programArguments}}'],
    ]
    : [['the DialogWright app {{app}}', 'the DialogWright {{what}}'], ['ExecStart={{pnpm}} --filter {{app}} serve', 'ExecStart={{exec}}']];
  return swaps.reduce((text, [from, to]) => {
    if (!text.includes(from)) throw new Error(`the ${kind} template has no "${from}" for a host file's server to replace`);
    return text.replace(from, to);
  }, template);
}

export function renderService(i: ServiceInputs): string {
  const own = readFileSync(join(TEMPLATES, i.kind === 'launchd' ? 'launchd.plist' : 'systemd.service'), 'utf8');
  const template = i.host ? hostTemplate(i.kind, own) : own;
  // What it runs: the app's own launcher through pnpm, or a host file's server through the engine's bin.
  const words = i.host ? [i.host.node, i.host.bin, 'serve', '--host', i.host.file] : [i.pnpm, '--filter', i.app, 'serve'];
  const what = i.host ? `host file ${i.host.file} (${i.app})` : `app ${i.app}`;
  const root = i.host ? i.host.dir : i.root;
  const values: Record<string, string> =
    i.kind === 'launchd'
      ? { label: xml(i.label), app: xml(i.app), what: xml(what), root: xml(root), envFile: xml(i.envFile), pnpm: xml(i.pnpm), path: xml(i.path), logDir: xml(i.logDir), stopSeconds: String(i.stopSeconds), programArguments: words.map((w) => `    <string>${xml(w)}</string>`).join('\n') }
      : { label: unitValue(i.label), app: unitValue(i.app), what: unitValue(what), root: unitValue(root), envFile: unitValue(i.envFile).replace(/"/g, '\\"'), path: unitValue(i.path), pnpm: unitWord(i.pnpm), logDir: unitValue(i.logDir), stopSeconds: String(i.stopSeconds), exec: words.map(unitWord).join(' ') };
  const text = template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const v = values[key];
    if (v === undefined) throw new Error(`the ${i.kind} template names {{${key}}}, which pnpm service does not fill`);
    return v;
  });
  // Its first line says who wrote it and where the app runs from: in a project of its own, the project.
  return i.project === true ? text.replace('Written by pnpm service', 'Written by npx dialogwright service').replace('run from the repository', 'run from its project') : text;
}

/** Where each manager reads a service of this label, under `home`. */
export function servicePath(kind: ServiceKind, label: string, home: string): string {
  return kind === 'launchd' ? join(home, 'Library', 'LaunchAgents', `${label}.plist`) : join(home, '.config', 'systemd', 'user', `${label}.service`);
}

/** A path as a shell word: as it is when it needs no quoting, else in single quotes. */
export function shellWord(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The commands that install, check and stop it: printed, never run. */
export function installCommands(kind: ServiceKind, file: string, label: string, logDir: string): string[] {
  const f = shellWord(file);
  if (kind === 'launchd') {
    return [
      `mkdir -p ${shellWord(logDir)}`,
      `plutil -lint ${f}`,
      `launchctl bootstrap gui/$(id -u) ${f}      # start now, and at every login`,
      `launchctl print gui/$(id -u)/${label} | grep -E 'state|pid'   # running or not`,
      `tail -f ${shellWord(`${logDir}/server.log`)} ${shellWord(`${logDir}/err.log`)}   # its output (server.log rolls at LOG_MAX_MB, LOG_KEEP kept)`,
      `launchctl kickstart -k gui/$(id -u)/${label}   # restart: live calls get DRAIN_MS to finish`,
      `launchctl bootout gui/$(id -u)/${label}        # stop, and keep it stopped`,
    ];
  }
  return [
    'systemctl --user daemon-reload',
    `systemctl --user enable --now ${label}   # start now, and at every login`,
    'loginctl enable-linger "$USER"   # and at boot, with no one logged in (once; see above)',
    `systemctl --user status ${label}   # running or not`,
    `journalctl --user -u ${label} -f   # its output`,
    `systemctl --user restart ${label}   # restart: live calls get DRAIN_MS to finish`,
    `systemctl --user disable --now ${label}   # stop, and keep it stopped`,
  ];
}

/**
 * Why a systemd user unit needs lingering, printed above its commands: without it, systemd starts a
 * user's services at their first login and stops them at their last logout.
 */
export const LINGER_NOTE: readonly string[] = [
  'A systemd user service runs only while you are logged in: systemd starts it at your first login and stops',
  'it when your last session ends (an ssh session too). For a line that starts at boot and stays up with no one',
  'logged in, turn on lingering for your user once: loginctl enable-linger "$USER" (some systems ask for sudo;',
  'loginctl show-user "$USER" --property=Linger says yes when it is on).',
];

export interface ServiceIo {
  out(line: string): void;
  /** The environment: ENV_FILE names the settings file when --env-file does not. */
  env?: Env;
  /** Where the command was run (pnpm's INIT_CWD), which relative paths are from. */
  invokedFrom: string;
  root?: string;
  home?: string;
  platform?: NodeJS.Platform;
  /** An executable on PATH, absolute, or null. */
  which?(command: string): string | null;
  /** The folder this node is in. */
  nodeDir?: string;
}

export const SERVICE_USAGE = 'usage: ENV_FILE=<path> pnpm service <launchd|systemd> (--app <name> | --host <file>) [--label <label>] [--out <file>] [--force]   (or --env-file <path>)';

/** The command; returns its exit code (2 for a command line it does not understand). */
export async function main(argv: readonly string[], io: ServiceIo): Promise<number> {
  const [kind, ...rest] = argv;
  if (kind !== 'launchd' && kind !== 'systemd') {
    io.out(SERVICE_USAGE);
    return 2;
  }
  const flags: { app?: string; host?: string; envFile?: string; label?: string; out?: string; force: boolean } = { force: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const v = rest[i + 1];
    if (a === '--force') flags.force = true;
    else if (a === '--app' && v !== undefined) flags.app = rest[++i];
    else if (a === '--host' && v !== undefined) flags.host = rest[++i];
    else if (a === '--env-file' && v !== undefined) flags.envFile = rest[++i];
    else if (a === '--label' && v !== undefined) flags.label = rest[++i];
    else if (a === '--out' && v !== undefined) flags.out = rest[++i];
    else {
      io.out(SERVICE_USAGE);
      return 2;
    }
  }
  if (flags.app !== undefined && flags.host !== undefined) {
    io.out('--app runs one app and --host a host file\'s apps: give one of them');
    return 2;
  }
  const root = io.root ?? projectRoot(io.invokedFrom);
  // A host file (host.yaml: several apps on one server): --host, else HOST_FILE, else host.yaml beside the apps.
  const hostFile = flags.app === undefined ? hostFileOf(flags.host, io.env ?? process.env, io.invokedFrom, root) : null;
  if (flags.app === undefined && hostFile === null) {
    io.out('--app <name> is needed: the app the service runs (or --host <file>, a host file\'s apps)');
    return 2;
  }
  const named = flags.envFile ?? ((io.env ?? process.env).ENV_FILE?.trim() || undefined);
  if (named === undefined) {
    io.out('the settings file the service reads is needed: ENV_FILE=<path> pnpm service ... (keep it outside the repository, mode 600)');
    return 2;
  }
  let host: ResolvedHost | null = null;
  if (hostFile !== null) {
    const resolved = existsSync(hostFile) ? resolveHostFile(hostFile) : null;
    if (resolved === null || resolved.host === null) {
      io.out(resolved === null ? `no host file at ${hostFile}` : resolved.problems.map(formatProblem).join('\n'));
      return 1;
    }
    host = resolved.host;
  }
  const app = host !== null ? { name: `${basename(host.file)}: ${host.apps.map((a) => a.id).join(', ')}`, dir: host.dir } : findApp(workspaceApps(root), flags.app!, io.invokedFrom);
  if (app === null) {
    io.out(`no app "${flags.app}" in this workspace`);
    return 2;
  }
  // Several files, comma-separated, are read in turn by the server, a later one winning: the service names them all.
  const envFiles = resolveEnvFiles(named, io.invokedFrom);
  const envFile = joinEnvFiles(envFiles);
  let drainMs: number;
  try {
    // Read for DRAIN_MS and DRAIN_UNREADY_MS alone (a stop is the unready time, then the drain); nothing
    // from it goes into the service file but its path.
    const settings = readEnvFiles(envFiles);
    drainMs = integer(settings, 'DRAIN_MS', DEFAULT_DRAIN_MS) + integer(settings, 'DRAIN_UNREADY_MS', 0);
  } catch (e) {
    io.out(e instanceof Error ? e.message : String(e));
    return 1;
  }
  const home = io.home ?? homedir();
  const which = io.which ?? ((c: string) => findOnPath(c, { ...process.env, PATH: (process.env.PATH ?? '').split(':').filter((d) => !/node_modules|node-gyp-bin/.test(d)).join(':') }));
  const pnpm = which('pnpm');
  if (pnpm === null) {
    io.out('pnpm is not on PATH: run pnpm service from the shell you run pnpm in');
    return 1;
  }
  const nodeDir = io.nodeDir ?? dirname(process.execPath);
  const platform = io.platform ?? process.platform;
  const standard = platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'] : ['/usr/local/bin', '/usr/bin', '/bin'];
  const path = [...new Set([nodeDir, dirname(pnpm), ...standard])].join(':');
  const label = flags.label ?? (host !== null ? 'com.dialogwright.host' : `com.dialogwright.${basename(app.dir)}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)) {
    io.out(`--label must be letters, digits, dots, hyphens and underscores, like com.example.ivr, got "${label}"`);
    return 2;
  }
  const logDir = join(home, 'Library', 'Logs', label);
  const file = flags.out === undefined ? servicePath(kind, label, home) : isAbsolute(flags.out) ? flags.out : resolve(io.invokedFrom, flags.out);
  if (existsSync(file) && !flags.force) {
    io.out(`${file} exists: pnpm service ... --force replaces it`);
    return 1;
  }
  const text = renderService({
    kind, label, app: app.name, root, envFile, pnpm, path, logDir, stopSeconds: Math.ceil(drainMs / 1000) + 10, project: !existsSync(join(root, 'pnpm-workspace.yaml')),
    ...(host !== null ? { host: { file: host.file, dir: host.dir, node: process.execPath, bin: ENGINE_BIN } } : {}),
  });
  mkdirSync(dirname(file), { recursive: true });
  // It names the settings file and holds no secret, so it is an ordinary file.
  writeFileSync(file, text, { mode: 0o644 });
  io.out(`wrote ${file}: ${app.name} from ${host !== null ? host.dir : root}, settings from ${envFiles.join(', ')}, ${Math.ceil(drainMs / 1000) + 10} s to stop`);
  for (const f of envFiles) {
    if (platform !== 'win32' && statSync(f).mode & 0o077) io.out(`WARNING: ${f} can be read by others, and it holds keys: chmod 600 ${shellWord(f)}`);
  }
  if (kind === 'systemd') for (const line of LINGER_NOTE) io.out(line);
  io.out('Install it (pnpm service runs none of these):');
  for (const line of installCommands(kind, file, label, logDir)) io.out(`  ${line}`);
  return 0;
}

/** `dialogwright service`: the command with this process's output, environment and folder; returns its exit code. */
export function commandLine(argv: readonly string[]): Promise<number> {
  return main(argv, { out: (line) => console.log(line), env: process.env, invokedFrom: process.env.INIT_CWD?.trim() || process.cwd() });
}

// Run when invoked directly (tsx serviceFile.ts); importing it runs nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await commandLine(process.argv.slice(2));
}
