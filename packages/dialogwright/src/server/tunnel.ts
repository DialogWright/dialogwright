import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Readable } from 'node:stream';
import type { Env } from './config';

/**
 * A tunnel that needs no account: Cloudflare's quick tunnel. `cloudflared tunnel --url
 * http://localhost:<port>` connects out to Cloudflare and prints the hostname it was given,
 * `https://<words>.trycloudflare.com`, inside a box on standard error; requests to it come back down
 * the connection, so the router opens no port. The hostname is new each run (start.ts says so).
 * Nothing here runs cloudflared; start.ts does, and only when asked.
 */

/** The assigned hostname as cloudflared prints it. */
const QUICK_HOST = /https:\/\/([a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com)\b/i;

/** The quick tunnel's hostname in cloudflared's output so far, or null when it has not printed it yet. */
export function quickTunnelHost(output: string): string | null {
  return QUICK_HOST.exec(output)?.[1]?.toLowerCase() ?? null;
}

/** How long start waits for cloudflared to print the hostname. */
export const QUICK_TUNNEL_TIMEOUT_MS = 30_000;

/** What waitForQuickTunnel reads: a process's two output streams and its exit. */
export interface TunnelProcess {
  stdout?: Readable | null;
  stderr?: Readable | null;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  removeListener(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

/**
 * The hostname, once cloudflared prints it (on either stream, in any pieces). Rejects when it has not
 * within `timeoutMs`, or when cloudflared exits first, quoting its last line (cloudflared prints no secret).
 */
export function waitForQuickTunnel(child: TunnelProcess, timeoutMs: number = QUICK_TUNNEL_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = '';
    const lastLine = (): string => {
      const line = seen.trimEnd().split('\n').at(-1)?.trim() ?? '';
      return line ? ` (its last line: "${line.slice(0, 300)}")` : '';
    };
    const finish = (): void => {
      clearTimeout(timer);
      child.stdout?.removeListener('data', onData);
      child.stderr?.removeListener('data', onData);
      child.removeListener('exit', onExit);
    };
    const onData = (chunk: Buffer | string): void => {
      seen += chunk.toString();
      const host = quickTunnelHost(seen);
      if (host !== null) {
        finish();
        resolve(host);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish();
      reject(new Error(`cloudflared exited (${code !== null ? `code ${code}` : `signal ${signal}`}) before it gave a hostname${lastLine()}`));
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error(`cloudflared gave no quick tunnel hostname within ${timeoutMs / 1000} seconds${lastLine()}`));
    }, timeoutMs);
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', onExit);
  });
}

/** An executable named `command` in a folder on PATH, or null. Looks at the files; runs nothing. */
export function findOnPath(command: string, env: Env): string | null {
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const path = join(dir, command + ext);
      try {
        if (!statSync(path).isFile()) continue;
        accessSync(path, constants.X_OK);
        return path;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

/** What to do when cloudflared is not installed. */
export const CLOUDFLARED_INSTALL: readonly string[] = [
  'cloudflared is not installed. It opens the quick tunnel, which needs no account. Install it:',
  '  macOS:             brew install cloudflared',
  "  Debian or Ubuntu:  add Cloudflare's package repository (pkg.cloudflare.com), then sudo apt install cloudflared",
  '  anywhere else:     a release from https://github.com/cloudflare/cloudflared/releases',
  'then run pnpm start again. Or start without a tunnel: pnpm start --tunnel none (on a laptop, or with a hostname you already have).',
];
