import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskUsageCache, sweepRetention } from './retention';
import { loadConfig } from './config';
import { logFileSettingOf, RollingLog } from './logFile';

/**
 * The retention policy (the maintainer's decision, 8b2's review): traces by time and by size, the
 * oldest calls first and never a live one; the audit by time only; a free-space warning; the server's
 * own log rolled. Unset, everything is kept and nothing is said, as before.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function folder(): string {
  const d = mkdtempSync(join(tmpdir(), 'retention-'));
  dirs.push(d);
  return d;
}

const base = { PUBLIC_HOST: 'demo.ngrok.app', TWILIO_AUTH_TOKEN: 'tok', HANDOFF_NUMBER: '+15551234567' };

describe('TRACE_MAX_GB on one machine', () => {
  it('removes the calls written least recently, whole (trace and frame log), until under the bound, never a live call', () => {
    const traces = folder();
    const t0 = Date.parse('2026-10-01T00:00:00Z');
    const write = (stem: string, ageDays: number, bytes: number): void => {
      for (const f of [`${stem}.jsonl`, `${stem}.frames.jsonl`]) {
        writeFileSync(join(traces, f), 'x'.repeat(bytes));
        const at = new Date(t0 - ageDays * 86_400_000);
        utimesSync(join(traces, f), at, at);
      }
    };
    write('CA-oldest', 3, 100);
    write('CA-live', 2, 100);
    write('CA-older', 1, 100);
    write('CA-newest', 0, 100);
    const r = sweepRetention({ traceDir: traces, auditDir: join(traces, 'audit'), traceMaxBytes: 450 }, { now: t0, inUse: new Set(['CA-live']) });
    expect(r).toEqual({ traceFiles: 4, auditDays: 0, trimmed: { files: 4, calls: 2 } });
    expect(readdirSync(traces).sort()).toEqual(['CA-live.frames.jsonl', 'CA-live.jsonl', 'CA-newest.frames.jsonl', 'CA-newest.jsonl']);
    // Under the bound: nothing more goes.
    expect(sweepRetention({ traceDir: traces, auditDir: join(traces, 'audit'), traceMaxBytes: 450 }, { now: t0, inUse: new Set() })).toEqual({ traceFiles: 0, auditDays: 0, trimmed: { files: 0, calls: 0 } });
  });
});

describe('DISK_WARN_FREE_GB', () => {
  it("says the free space and whether it is under the bound; unset, /health's disk is as it was", () => {
    const d = folder();
    const free = (n: number) => () => n;
    expect(diskUsageCache(d, d, () => 0, 60_000, 2 * 1024 ** 3, free(1024 ** 3))()).toEqual({ traceBytes: 0, auditBytes: 0, freeBytes: 1024 ** 3, low: true });
    expect(diskUsageCache(d, d, () => 0, 60_000, 2 * 1024 ** 3, free(5 * 1024 ** 3))()).toEqual({ traceBytes: 0, auditBytes: 0, freeBytes: 5 * 1024 ** 3, low: false });
    expect(diskUsageCache(d, d, () => 0)()).toEqual({ traceBytes: 0, auditBytes: 0 });
  });
});

describe('the options', () => {
  it('are unset by default; set, read and said at startup; malformed, refused naming the variable', () => {
    const c = loadConfig(base);
    for (const k of ['traceMaxBytes', 'diskWarnFreeBytes', 'logFile']) expect(k in c).toBe(false);
    const set = loadConfig({ ...base, TRACE_MAX_GB: '0.5', DISK_WARN_FREE_GB: '2', LOG_FILE: '/var/log/ivr/server.log', LOG_MAX_MB: '20', LOG_KEEP: '3' });
    expect(set.traceMaxBytes).toBe(512 * 1024 ** 2);
    expect(set.diskWarnFreeBytes).toBe(2 * 1024 ** 3);
    expect(set.logFile).toEqual({ file: '/var/log/ivr/server.log', maxBytes: 20 * 1024 ** 2, keep: 3 });
    expect(() => loadConfig({ ...base, TRACE_MAX_GB: '-1' })).toThrow('TRACE_MAX_GB must be a number of gigabytes above 0 (like 5 or 0.5), got "-1"');
    expect(() => loadConfig({ ...base, DISK_WARN_FREE_GB: 'lots' })).toThrow('DISK_WARN_FREE_GB must be a number of gigabytes');
    expect(() => loadConfig({ ...base, LOG_MAX_MB: '0' })).toThrow('LOG_MAX_MB must be a whole number of megabytes from 1 to 10000, got "0"');
    expect(() => loadConfig({ ...base, LOG_KEEP: 'x' })).toThrow('LOG_KEEP must be a whole number of files from 0 to 100, got "x"');
  });
});

describe('LOG_FILE', () => {
  it('appends, and past LOG_MAX_MB rolls the file, keeping LOG_KEEP', () => {
    const d = folder();
    const setting = logFileSettingOf({ LOG_FILE: join(d, 'logs', 'server.log'), LOG_MAX_MB: '1', LOG_KEEP: '2' })!;
    const log = new RollingLog(setting);
    const line = `${'x'.repeat(1023)}\n`;
    for (let i = 0; i < 1024 * 3 + 10; i++) log.write(line);
    log.close();
    const files = readdirSync(join(d, 'logs')).sort();
    expect(files).toEqual(['server.log', 'server.log.1', 'server.log.2']);
    for (const f of files) expect(readFileSync(join(d, 'logs', f)).length).toBeLessThanOrEqual(1024 * 1024);
    expect(existsSync(join(d, 'logs', 'server.log.3'))).toBe(false);
    expect(log.failures).toBe(0);
  });

  it('a second process on the same LOG_FILE is refused, naming the first; a lock left by a process that is gone is taken over', () => {
    const d = folder();
    const setting = logFileSettingOf({ LOG_FILE: join(d, 'server.log') })!;
    // A process that is running (this test's parent) holds it.
    writeFileSync(join(d, 'server.log.lock'), String(process.ppid));
    expect(() => new RollingLog(setting)).toThrow(`LOG_FILE ${join(d, 'server.log')} is written by another process (pid ${process.ppid}): give each server a log file of its own`);
    // One that is gone does not.
    writeFileSync(join(d, 'server.log.lock'), '999999999');
    const log = new RollingLog(setting);
    expect(readFileSync(join(d, 'server.log.lock'), 'utf8')).toBe(String(process.pid));
    log.close();
    expect(existsSync(join(d, 'server.log.lock'))).toBe(false);
  });

  it('a log that cannot be written never throws', () => {
    const d = folder();
    const log = new RollingLog(logFileSettingOf({ LOG_FILE: join(d, 'server.log') })!);
    log.close();
    rmSync(join(d, 'server.log'));
    mkdirSync(join(d, 'server.log'));
    expect(() => log.write('a line\n')).not.toThrow();
    expect(log.failures).toBe(1);
  });
});
