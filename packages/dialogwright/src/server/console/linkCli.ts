import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../config';
import { readEnvFile } from '../envFile';
import { chooseApp, findApp, workspaceApps, WORKSPACE_ROOT, type WorkspaceApp } from '../workspace';
import { CODE_TTL_MS, LINK_KEY_HEADER, LINK_PATH, type LinkFile } from './auth';
import { consoleAuthMethodOf, consoleLinkFileOf } from './settings';

/**
 * `[ENV_FILE=<path>] pnpm console:link [--app <name>]`: a new one-time sign-in link for the console of a
 * server running with CONSOLE_AUTH=token, printed here, on the machine the server runs on. The link the
 * server made before it stops working.
 *
 * It reads the settings the server reads (the app's `.env`, or the file ENV_FILE or `--env-file` names,
 * a variable in the environment winning), finds the link file the server wrote (CONSOLE_LINK_FILE, by
 * default `.console-link/link.json` beside the trace folder), checks that only its owner can read it,
 * and posts the key in it to the server's `/dashboard/link` on 127.0.0.1. Nothing else can make a link:
 * the endpoint answers only a request made on this machine that carries that key, and is not there at
 * all through the tunnel. Exit 0 with a link, 1 without one, 2 for a command line it does not understand.
 */

export const LINK_USAGE = 'usage: [ENV_FILE=<path>] pnpm console:link [--app <name>]   (ENV_FILE names a settings file other than <app>/.env)';
const ASK_MS = 5_000;

export interface LinkIo {
  out(line: string): void;
  /** The environment, which wins over the settings file. */
  env: Env;
  /** Where the command was run (pnpm's INIT_CWD), which relative paths are from. */
  invokedFrom: string;
  /** The repository root, where the apps are found. */
  root?: string;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
}

/** The settings and the folder the server runs in, as `pnpm diagnose` finds them; or what went wrong. */
function settingsOf(appName: string | undefined, envFileArg: string | undefined, io: LinkIo): { env: Env; cwd: string } | { error: string; code: number } {
  const apps = workspaceApps(io.root ?? WORKSPACE_ROOT);
  let app: WorkspaceApp | null = null;
  if (appName !== undefined) {
    app = findApp(apps, appName, io.invokedFrom);
    if (app === null) return { error: `no app "${appName}" in this workspace`, code: 2 };
  }
  const named = envFileArg ?? (io.env.ENV_FILE?.trim() || undefined);
  let file: string;
  if (named !== undefined) file = isAbsolute(named) ? named : resolve(io.invokedFrom, named);
  else {
    if (app === null) {
      const chosen = chooseApp(apps, undefined, io.invokedFrom, 'console:link');
      if ('error' in chosen) return { error: chosen.error, code: 2 };
      app = chosen.app;
    }
    file = join(app.dir, '.env');
  }
  let fromFile: Record<string, string>;
  try {
    fromFile = readEnvFile(file);
  } catch (e) {
    return { error: `${e instanceof Error ? e.message : String(e)}: run pnpm configure, or name the file: ENV_FILE=<path> pnpm console:link`, code: 1 };
  }
  const env: Env = { ...fromFile };
  for (const [k, v] of Object.entries(io.env)) if (v !== undefined) env[k] = v;
  if (app === null) {
    const here = apps.find((a) => io.invokedFrom === a.dir || io.invokedFrom.startsWith(a.dir + sep));
    app = here ?? (apps.length === 1 ? apps[0]! : null);
  }
  return { env, cwd: app?.dir ?? io.invokedFrom };
}

function messageOf(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown } }).cause;
  if (typeof cause?.code === 'string') return cause.code;
  return err instanceof Error ? err.message : String(err);
}

export async function main(argv: readonly string[], io: LinkIo): Promise<number> {
  let appName: string | undefined;
  let envFileArg: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if ((a === '--app' || a === '--env-file') && argv[i + 1] !== undefined) {
      if (a === '--app') appName = argv[++i];
      else envFileArg = argv[++i];
    } else {
      io.out(LINK_USAGE);
      return 2;
    }
  }
  const found = settingsOf(appName, envFileArg, io);
  if ('error' in found) {
    io.out(found.error);
    return found.code;
  }
  const { env, cwd } = found;
  let method: 'local' | 'token';
  try {
    method = consoleAuthMethodOf(env);
  } catch (e) {
    io.out(e instanceof Error ? e.message : String(e));
    return 1;
  }
  if (method === 'local') {
    io.out(`CONSOLE_AUTH is local: the console needs no link; open http://localhost:${env.PORT?.trim() || '3000'}/dashboard on this machine (CONSOLE_AUTH=token opens it from elsewhere, behind a sign-in)`);
    return 1;
  }
  const file = consoleLinkFileOf(env, cwd);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    io.out(`no sign-in link file at ${file}: start the server with CONSOLE_AUTH=token (pnpm start), which writes it`);
    return 1;
  }
  if ((io.platform ?? process.platform) !== 'win32') {
    const st = statSync(file);
    const mode = st.mode & 0o777;
    if (mode & 0o077) {
      io.out(`${file} can be read by others (mode ${mode.toString(8)}): it holds the key that makes sign-in links; chmod 600 ${file}, then restart the server`);
      return 1;
    }
    if (process.getuid && st.uid !== process.getuid()) {
      io.out(`${file} belongs to another account: run pnpm console:link as the account the server runs as`);
      return 1;
    }
  }
  let link: LinkFile;
  try {
    link = JSON.parse(text) as LinkFile;
    if (!Number.isInteger(link.port) || typeof link.key !== 'string') throw new Error('not a link file');
  } catch {
    io.out(`${file} is not a link file the server wrote: restart the server, which writes it again`);
    return 1;
  }
  let res: Response;
  try {
    res = await (io.fetch ?? fetch)(`http://127.0.0.1:${link.port}${LINK_PATH}`, { method: 'POST', headers: { [LINK_KEY_HEADER]: link.key }, signal: AbortSignal.timeout(ASK_MS), redirect: 'manual' });
  } catch (e) {
    io.out(`the server is not answering on port ${link.port}: is it running? (${messageOf(e)})`);
    return 1;
  }
  if (res.status === 403) {
    io.out('the server refused the link file\'s key: the file is from an earlier run; restart the server, which writes it again');
    return 1;
  }
  if (res.status !== 200) {
    io.out(`the server on port ${link.port} answered ${res.status}: is it this app's server, with CONSOLE_AUTH=token?`);
    return 1;
  }
  const made = (await res.json()) as { url: string; expiresAt: string };
  io.out('Open this on your phone (or anywhere) to sign in to the console:');
  io.out(made.url);
  io.out(`It works once, for ${CODE_TTL_MS / 60_000} minutes (until ${made.expiresAt.slice(11, 16)} UTC). The link before it no longer works.`);
  return 0;
}

// Run when invoked directly (tsx linkCli.ts); importing it runs nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2), {
    out: (line) => console.log(line),
    env: process.env,
    invokedFrom: process.env.INIT_CWD?.trim() || process.cwd(),
  });
}
