import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * The server's own log in a file it rolls itself (LOG_FILE, LOG_MAX_MB, LOG_KEEP): for a machine whose
 * service manager keeps what a process prints in a file that only grows (launchd's StandardOutPath).
 * Everything the process writes to stdout and stderr is also appended to LOG_FILE; past LOG_MAX_MB the
 * file is renamed `<file>.1` (the one before it `<file>.2`, and so on), keeping LOG_KEEP of them, and a
 * new one begun. Unset, nothing changes: what the process prints goes where it always went.
 */

export interface LogFileSetting {
  /** The file, absolute (a relative one is from where the server runs). */
  file: string;
  /** LOG_MAX_MB in bytes, default 10 MB. */
  maxBytes: number;
  /** LOG_KEEP: the rolled files kept beside it, default 5. */
  keep: number;
}

export const DEFAULT_LOG_MAX_MB = 10;
export const DEFAULT_LOG_KEEP = 5;

/** LOG_FILE, LOG_MAX_MB and LOG_KEEP read and checked; null when LOG_FILE is unset (LOG_MAX_MB and LOG_KEEP are still checked). */
export function logFileSettingOf(env: Readonly<Record<string, string | undefined>>, cwd = process.cwd()): LogFileSetting | null {
  const mbRaw = env.LOG_MAX_MB?.trim() ?? '';
  const mb = mbRaw === '' ? DEFAULT_LOG_MAX_MB : Number(mbRaw);
  if (!Number.isInteger(mb) || mb < 1 || mb > 10_000) throw new Error(`LOG_MAX_MB must be a whole number of megabytes from 1 to 10000, got "${env.LOG_MAX_MB}"`);
  const keepRaw = env.LOG_KEEP?.trim() ?? '';
  const keep = keepRaw === '' ? DEFAULT_LOG_KEEP : Number(keepRaw);
  if (!Number.isInteger(keep) || keep < 0 || keep > 100) throw new Error(`LOG_KEEP must be a whole number of files from 0 to 100, got "${env.LOG_KEEP}"`);
  const file = env.LOG_FILE?.trim() ?? '';
  if (file === '') return null;
  return { file: resolve(cwd, file), maxBytes: mb * 1024 * 1024, keep };
}

/** A log file the process appends to, rolled past its size. Writes never throw: a log that cannot be written is not a reason to stop. */
export class RollingLog {
  private fd: number | null = null;
  private size = 0;
  failures = 0;

  private readonly lockFile: string;

  /**
   * The log file, taken for this process alone (`<file>.lock`, holding its pid): two processes rolling
   * one file would rename it under each other, so a second one is refused, naming the first. A lock
   * whose process is gone is taken over.
   */
  constructor(readonly setting: LogFileSetting) {
    mkdirSync(dirname(setting.file), { recursive: true, mode: 0o700 });
    this.lockFile = `${setting.file}.lock`;
    this.lock();
    this.open();
  }

  private lock(): void {
    for (let tries = 0; tries < 2; tries++) {
      try {
        writeFileSync(this.lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
        process.once('exit', () => this.unlock());
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const pid = Number(readFileSync(this.lockFile, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) {
        throw new Error(`LOG_FILE ${this.setting.file} is written by another process (pid ${pid}): give each server a log file of its own`);
      }
      rmSync(this.lockFile, { force: true });
    }
    throw new Error(`LOG_FILE ${this.setting.file}: its lock could not be taken`);
  }

  private unlock(): void {
    try {
      if (readFileSync(this.lockFile, 'utf8').trim() === String(process.pid)) rmSync(this.lockFile, { force: true });
    } catch {
      // Gone already.
    }
  }

  private open(): void {
    this.fd = openSync(this.setting.file, 'a', 0o600);
    this.size = fstatSync(this.fd).size;
  }

  /** `<file>` to `<file>.1`, each `.n` to `.n+1`, the oldest past LOG_KEEP removed; a new file begun. */
  private roll(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
    const f = this.setting.file;
    rmSync(`${f}.${this.setting.keep}`, { force: true });
    for (let n = this.setting.keep - 1; n >= 1; n--) if (existsSync(`${f}.${n}`)) renameSync(`${f}.${n}`, `${f}.${n + 1}`);
    if (this.setting.keep > 0) renameSync(f, `${f}.1`);
    else rmSync(f, { force: true });
    this.open();
  }

  write(chunk: string | Uint8Array): void {
    try {
      const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
      if (this.size > 0 && this.size + data.length > this.setting.maxBytes) this.roll();
      if (this.fd === null) this.open();
      writeSync(this.fd!, data);
      this.size += data.length;
    } catch {
      this.failures += 1;
    }
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
    this.unlock();
  }
}

/** Everything the process writes to stdout and stderr also appended to `log`; returns what undoes it. */
export function teeProcessOutput(log: RollingLog): () => void {
  const streams = [process.stdout, process.stderr] as const;
  const originals = streams.map((s) => s.write.bind(s));
  streams.forEach((s, i) => {
    s.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      log.write(chunk);
      return (originals[i] as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof s.write;
  });
  return () => streams.forEach((s, i) => {
    s.write = originals[i] as typeof s.write;
  });
}

/** Whether a process is running (signal 0 asks, sends nothing). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
