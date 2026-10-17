import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostFileOf } from '../define/host';
import { loadHost } from './host';
import { main as serverMain, type Sidecars } from './index';
import type { ServerConfig } from './config';

/**
 * `[ENV_FILE=<path>] dialogwright serve [--host <file>]` (in this repository, `pnpm serve`): the server of a
 * host file (host.yaml: several apps on one server), every app it lists in this one process, with the
 * server's settings (ENV_FILE, `--env-file`, else the .env beside host.yaml when there is one) and each
 * app's own. It is what `pnpm start
 * --host` and a service file for a host run; an app alone runs its own launcher (`pnpm --filter <app>
 * serve`), as before. The host file is `--host`, else HOST_FILE, else host.yaml in the folder it is run in.
 *
 * Each app's code is imported from its folder (app.ts or src/app.ts, as `pnpm check` reads it), with
 * the pages it declares there (App.pages, under /<app id>). An app's own launcher, and what it starts
 * beside the server (its services, the routes it mounts), does not run under a host:
 * a deployment that needs them writes a launcher of its own, serverMain with loadHost's apps in its
 * overrides (both exported by 'dialogwright').
 */

export const SERVE_USAGE = 'usage: [ENV_FILE=<path>] dialogwright serve [--host <file>] [--env-file <path>]   (default: HOST_FILE, else host.yaml in this folder)';

export interface ServeDeps {
  out(line: string): void;
  env: NodeJS.ProcessEnv;
  invokedFrom: string;
  /** Runs the server (index.ts main) with what starts beside it; resolves once it listens. */
  serve(start: (config: ServerConfig) => Promise<Sidecars>): Promise<void>;
}

/** The command; resolves with 0 once the server listens (it then runs until stopped), 1 or 2 when it cannot start. */
export async function main(argv: readonly string[], deps: ServeDeps): Promise<number> {
  let flag: string | undefined;
  let envFileGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = argv[i + 1];
    if (a === '--host' && v !== undefined) flag = argv[++i];
    // Read by the server itself (index.ts main), from the process's own arguments.
    else if (a === '--env-file' && v !== undefined) {
      i++;
      envFileGiven = true;
    } else if (a.startsWith('--env-file=')) envFileGiven = true;
    else {
      deps.out(SERVE_USAGE);
      return 2;
    }
  }
  const file = hostFileOf(flag, deps.env, deps.invokedFrom, deps.invokedFrom);
  if (file === null) {
    deps.out(`no host file: name one with --host <file> (or HOST_FILE), or run this where host.yaml is\n${SERVE_USAGE}`);
    return 2;
  }
  if (!existsSync(file)) {
    deps.out(`no host file at ${file}`);
    return 1;
  }
  // The server's settings: the file ENV_FILE or --env-file names, else the .env beside host.yaml, as
  // `pnpm start --host` reads it, when there is one.
  const beside = join(dirname(file), '.env');
  if (!envFileGiven && !deps.env.ENV_FILE?.trim() && existsSync(beside)) deps.env.ENV_FILE = beside;
  // The apps are read once the server's settings are (ENV_FILE first): the numbers are among them.
  await deps.serve(async () => ({ overrides: { apps: await loadHost(file, deps.env) } }));
  return 0;
}

/** `dialogwright serve`: the command with this process's output, environment and folder. */
export function commandLine(argv: readonly string[]): Promise<number> {
  return main(argv, {
    out: (line) => console.log(line),
    env: process.env,
    invokedFrom: process.env.INIT_CWD?.trim() || process.cwd(),
    serve: (start) => serverMain(start),
  });
}

// Run when invoked directly (tsx hostServe.ts); importing it runs nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await commandLine(process.argv.slice(2));
}
