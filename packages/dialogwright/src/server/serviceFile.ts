import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DRAIN_MS, integer } from './config';
import { readEnvFile } from './envFile';
import { findOnPath } from './tunnel';
import { findApp, workspaceApps, WORKSPACE_ROOT } from './workspace';

/**
 * `pnpm service <launchd|systemd> --app <name> --env-file <path> [--label <label>] [--out <file>] [--force]`:
 * a service definition that keeps an app's server running on this machine, with absolute paths
 * resolved here. It runs `<pnpm> --filter <app> serve` from the repository with ENV_FILE naming the
 * settings file (the server reads it, as pnpm start does), starts it at load (login, or boot for a
 * lingering systemd user), restarts it when it exits, and gives a stop DRAIN_MS and ten seconds more
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
}

const TEMPLATES = fileURLToPath(new URL('../../templates/service/', import.meta.url));

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** A value in a unit file: `%` starts a specifier there, so it is doubled. */
const unitValue = (s: string) => s.replace(/%/g, '%%');
/** A word of ExecStart: quoted when it has a space or a quote. */
const unitWord = (s: string) => (/[\s"'\\]/.test(s) ? `"${unitValue(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : unitValue(s));

/** The file for these inputs, from its template. */
export function renderService(i: ServiceInputs): string {
  const template = readFileSync(join(TEMPLATES, i.kind === 'launchd' ? 'launchd.plist' : 'systemd.service'), 'utf8');
  const values: Record<string, string> =
    i.kind === 'launchd'
      ? { label: xml(i.label), app: xml(i.app), root: xml(i.root), envFile: xml(i.envFile), pnpm: xml(i.pnpm), path: xml(i.path), logDir: xml(i.logDir), stopSeconds: String(i.stopSeconds) }
      : { label: unitValue(i.label), app: unitValue(i.app), root: unitValue(i.root), envFile: unitValue(i.envFile).replace(/"/g, '\\"'), path: unitValue(i.path), pnpm: unitWord(i.pnpm), logDir: unitValue(i.logDir), stopSeconds: String(i.stopSeconds) };
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const v = values[key];
    if (v === undefined) throw new Error(`the ${i.kind} template names {{${key}}}, which pnpm service does not fill`);
    return v;
  });
}

/** Where each manager reads a service of this label, under `home`. */
export function servicePath(kind: ServiceKind, label: string, home: string): string {
  return kind === 'launchd' ? join(home, 'Library', 'LaunchAgents', `${label}.plist`) : join(home, '.config', 'systemd', 'user', `${label}.service`);
}

/** The commands that install, check and stop it: printed, never run. */
export function installCommands(kind: ServiceKind, file: string, label: string, logDir: string): string[] {
  if (kind === 'launchd') {
    return [
      `mkdir -p ${logDir}`,
      `plutil -lint ${file}`,
      `launchctl bootstrap gui/$(id -u) ${file}      # start now, and at every login`,
      `launchctl print gui/$(id -u)/${label} | grep -E 'state|pid'   # running or not`,
      `tail -f ${logDir}/out.log ${logDir}/err.log   # its output`,
      `launchctl kickstart -k gui/$(id -u)/${label}   # restart: live calls get DRAIN_MS to finish`,
      `launchctl bootout gui/$(id -u)/${label}        # stop, and keep it stopped`,
    ];
  }
  return [
    'systemctl --user daemon-reload',
    `systemctl --user enable --now ${label}   # start now, and at every login`,
    'loginctl enable-linger "$USER"   # and at boot, before anyone logs in',
    `systemctl --user status ${label}   # running or not`,
    `journalctl --user -u ${label} -f   # its output`,
    `systemctl --user restart ${label}   # restart: live calls get DRAIN_MS to finish`,
    `systemctl --user disable --now ${label}   # stop, and keep it stopped`,
  ];
}

export interface ServiceIo {
  out(line: string): void;
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

export const SERVICE_USAGE = 'usage: pnpm service <launchd|systemd> --app <name> --env-file <path> [--label <label>] [--out <file>] [--force]';

/** The command; returns its exit code (2 for a command line it does not understand). */
export async function main(argv: readonly string[], io: ServiceIo): Promise<number> {
  const [kind, ...rest] = argv;
  if (kind !== 'launchd' && kind !== 'systemd') {
    io.out(SERVICE_USAGE);
    return 2;
  }
  const flags: { app?: string; envFile?: string; label?: string; out?: string; force: boolean } = { force: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const v = rest[i + 1];
    if (a === '--force') flags.force = true;
    else if (a === '--app' && v !== undefined) flags.app = rest[++i];
    else if (a === '--env-file' && v !== undefined) flags.envFile = rest[++i];
    else if (a === '--label' && v !== undefined) flags.label = rest[++i];
    else if (a === '--out' && v !== undefined) flags.out = rest[++i];
    else {
      io.out(SERVICE_USAGE);
      return 2;
    }
  }
  if (flags.app === undefined) {
    io.out('--app <name> is needed: the app the service runs');
    return 2;
  }
  if (flags.envFile === undefined) {
    io.out('--env-file <path> is needed: the settings file the service reads (keep it outside the repository, mode 600)');
    return 2;
  }
  const root = io.root ?? WORKSPACE_ROOT;
  const app = findApp(workspaceApps(root), flags.app, io.invokedFrom);
  if (app === null) {
    io.out(`no app "${flags.app}" in this workspace`);
    return 2;
  }
  const envFile = isAbsolute(flags.envFile) ? flags.envFile : resolve(io.invokedFrom, flags.envFile);
  let drainMs: number;
  try {
    // Read for DRAIN_MS alone; nothing from it goes into the service file but its path.
    drainMs = integer(readEnvFile(envFile), 'DRAIN_MS', DEFAULT_DRAIN_MS);
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
  const label = flags.label ?? `com.dialogwright.${basename(app.dir)}`;
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
  const text = renderService({ kind, label, app: app.name, root, envFile, pnpm, path, logDir, stopSeconds: Math.ceil(drainMs / 1000) + 10 });
  mkdirSync(dirname(file), { recursive: true });
  // It names the settings file and holds no secret, so it is an ordinary file.
  writeFileSync(file, text, { mode: 0o644 });
  io.out(`wrote ${file}: ${app.name} from ${root}, settings from ${envFile}, ${Math.ceil(drainMs / 1000) + 10} s to stop`);
  io.out('Install it (pnpm service runs none of these):');
  for (const line of installCommands(kind, file, label, logDir)) io.out(`  ${line}`);
  return 0;
}

// Run when invoked directly (tsx serviceFile.ts); importing it runs nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2), { out: (line) => console.log(line), invokedFrom: process.env.INIT_CWD?.trim() || process.cwd() });
}
