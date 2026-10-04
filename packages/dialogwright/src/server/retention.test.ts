import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskUsageCache, sweepRetention } from './retention';
import { startServer, type RunningServer } from './index';
import { loadConfig } from './config';
import { useTestkit } from '../testing/apps';
import { HeuristicStubClient } from '../jev/heuristicStub';

useTestkit();

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);

let running: RunningServer | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function folders() {
  const root = mkdtempSync(join(tmpdir(), 'retention-'));
  dirs.push(root);
  const traceDir = join(root, 'traces');
  const auditDir = join(root, 'audit');
  mkdirSync(traceDir);
  mkdirSync(auditDir);
  return { root, traceDir, auditDir };
}

/** A file whose last change was `daysAgo` days before NOW. */
function aged(path: string, daysAgo: number, body = '{}\n'): void {
  writeFileSync(path, body);
  const t = new Date(NOW - daysAgo * DAY);
  utimesSync(path, t, t);
}

describe('sweepRetention', () => {
  it('removes trace files and their frame logs older than TRACE_RETENTION_DAYS, and keeps the rest', () => {
    const { traceDir, auditDir } = folders();
    aged(join(traceDir, 'CA-old.jsonl'), 10);
    aged(join(traceDir, 'CA-old.frames.jsonl'), 10);
    aged(join(traceDir, 'CA-new.jsonl'), 2);
    aged(join(traceDir, 'CA-new.frames.jsonl'), 2);
    aged(join(traceDir, 'notes.txt'), 30);
    const r = sweepRetention({ traceDir, auditDir, traceDays: 7 }, { now: NOW, inUse: new Set() });
    expect(r).toEqual({ traceFiles: 2, auditDays: 0 });
    expect(readdirSync(traceDir).sort()).toEqual(['CA-new.frames.jsonl', 'CA-new.jsonl', 'notes.txt']);
  });

  it('never removes the files of a call the server still holds', () => {
    const { traceDir, auditDir } = folders();
    aged(join(traceDir, 'CA-live.jsonl'), 10);
    aged(join(traceDir, 'CA-live.frames.jsonl'), 10);
    const r = sweepRetention({ traceDir, auditDir, traceDays: 1 }, { now: NOW, inUse: new Set(['CA-live']) });
    expect(r.traceFiles).toBe(0);
    expect(readdirSync(traceDir)).toHaveLength(2);
  });

  it('removes audit day files older than AUDIT_RETENTION_DAYS by their day, never today\'s', () => {
    const { traceDir, auditDir } = folders();
    for (const day of ['2026-09-01', '2026-10-01', '2026-10-02', '2026-10-03']) aged(join(auditDir, `${day}.jsonl`), 0);
    // Today's file, even with an old time on it, and a file that is not a day file, stay.
    aged(join(auditDir, '2026-10-04.jsonl'), 40);
    aged(join(auditDir, 'export.jsonl'), 40);
    const r = sweepRetention({ traceDir, auditDir, auditDays: 2 }, { now: NOW, inUse: new Set() });
    expect(r).toEqual({ traceFiles: 0, auditDays: 2 });
    expect(readdirSync(auditDir).sort()).toEqual(['2026-10-02.jsonl', '2026-10-03.jsonl', '2026-10-04.jsonl', 'export.jsonl']);
  });

  it('never removes an audit day by the trace retention, when the two share a folder', () => {
    const { traceDir } = folders();
    aged(join(traceDir, '2026-09-01.jsonl'), 30);
    aged(join(traceDir, 'CA-old.jsonl'), 30);
    const r = sweepRetention({ traceDir, auditDir: traceDir, traceDays: 7 }, { now: NOW, inUse: new Set() });
    expect(r).toEqual({ traceFiles: 1, auditDays: 0 });
    expect(readdirSync(traceDir)).toEqual(['2026-09-01.jsonl']);
  });

  it('leaves links and folders alone, and what a link points to', () => {
    const { root, traceDir, auditDir } = folders();
    const outside = join(root, 'elsewhere.jsonl');
    aged(outside, 30);
    symlinkSync(outside, join(traceDir, 'CA-link.jsonl'));
    symlinkSync(outside, join(auditDir, '2026-09-01.jsonl'));
    mkdirSync(join(traceDir, 'CA-folder.jsonl'));
    const r = sweepRetention({ traceDir, auditDir, traceDays: 1, auditDays: 1 }, { now: NOW, inUse: new Set() });
    expect(r).toEqual({ traceFiles: 0, auditDays: 0 });
    expect(existsSync(outside)).toBe(true);
    expect(readdirSync(traceDir).sort()).toEqual(['CA-folder.jsonl', 'CA-link.jsonl']);
  });

  it('removes nothing with no retention set, and copes with folders that do not exist yet', () => {
    const { root, traceDir, auditDir } = folders();
    aged(join(traceDir, 'CA-old.jsonl'), 400);
    aged(join(auditDir, '2025-01-01.jsonl'), 400);
    expect(sweepRetention({ traceDir, auditDir }, { now: NOW, inUse: new Set() })).toEqual({ traceFiles: 0, auditDays: 0 });
    expect(sweepRetention({ traceDir: join(root, 'none'), auditDir: join(root, 'none2'), traceDays: 1, auditDays: 1 }, { now: NOW, inUse: new Set() })).toEqual({ traceFiles: 0, auditDays: 0 });
    expect(existsSync(join(traceDir, 'CA-old.jsonl'))).toBe(true);
  });
});

describe('diskUsageCache', () => {
  it('adds up the trace and audit folders, at most once a minute', () => {
    const { traceDir, auditDir } = folders();
    writeFileSync(join(traceDir, 'CA1.jsonl'), 'x'.repeat(100));
    writeFileSync(join(traceDir, 'CA1.frames.jsonl'), 'x'.repeat(50));
    writeFileSync(join(auditDir, '2026-10-04.jsonl'), 'x'.repeat(30));
    let t = NOW;
    const usage = diskUsageCache(traceDir, auditDir, () => t);
    expect(usage()).toEqual({ traceBytes: 150, auditBytes: 30 });
    writeFileSync(join(traceDir, 'CA2.jsonl'), 'x'.repeat(1000));
    t += 59_000;
    expect(usage()).toEqual({ traceBytes: 150, auditBytes: 30 });
    t += 2_000;
    expect(usage()).toEqual({ traceBytes: 1150, auditBytes: 30 });
  });
});

describe('retention in the server', () => {
  function config(dir: { traceDir: string; auditDir: string; root: string }, extra: Record<string, string>) {
    return loadConfig({
      PUBLIC_HOST: 'localhost', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567', PORT: '0', SIGNATURE_CHECK: 'off',
      TODAY_OVERRIDE: '2026-10-04', TRACE_DIR: dir.traceDir, AUDIT_DIR: dir.auditDir, AUDIO_DIR: dir.root, ...extra,
    });
  }

  it('sweeps at startup and then once an hour from the idle sweep, and reports disk in health', async () => {
    const dir = folders();
    aged(join(dir.traceDir, 'CA-old.jsonl'), 10);
    aged(join(dir.auditDir, '2026-09-01.jsonl'), 0);
    let t = NOW;
    const logs: string[] = [];
    running = await startServer(config(dir, { TRACE_RETENTION_DAYS: '7', AUDIT_RETENTION_DAYS: '30' }), { host: '127.0.0.1', client: new HeuristicStubClient(), log: (l) => logs.push(l), now: () => t });
    expect(logs).toContain('retention: traces kept 7 days, audit days kept 30 days');
    expect(logs).toContain('WARNING: AUDIT_RETENTION_DAYS=30: audit day files older than 30 days are deleted, which ends the record for those days');
    expect(logs).toContain('retention: removed 1 trace files, 1 audit days');
    const health = (await (await fetch(`http://127.0.0.1:${running.port}/health`)).json()) as { disk: { traceBytes: number; auditBytes: number } };
    expect(health.disk).toEqual({ traceBytes: 0, auditBytes: expect.any(Number) });

    aged(join(dir.traceDir, 'CA-later.jsonl'), 10);
    t += 30 * 60_000;
    running.sweep();
    expect(existsSync(join(dir.traceDir, 'CA-later.jsonl'))).toBe(true);
    t += 31 * 60_000;
    running.sweep();
    expect(existsSync(join(dir.traceDir, 'CA-later.jsonl'))).toBe(false);
    expect(logs.filter((l) => l.startsWith('retention: removed'))).toEqual(['retention: removed 1 trace files, 1 audit days', 'retention: removed 1 trace files, 0 audit days']);
  });

  it('removes nothing, says nothing and reports no disk when no retention is set', async () => {
    const dir = folders();
    aged(join(dir.traceDir, 'CA-old.jsonl'), 400);
    const logs: string[] = [];
    running = await startServer(config(dir, {}), { host: '127.0.0.1', client: new HeuristicStubClient(), log: (l) => logs.push(l), now: () => NOW });
    expect(logs.filter((l) => l.startsWith('retention'))).toEqual([]);
    expect(existsSync(join(dir.traceDir, 'CA-old.jsonl'))).toBe(true);
    expect(await (await fetch(`http://127.0.0.1:${running.port}/health`)).json()).toEqual({ ok: true, sessions: 0, retained: 0 });
  });

  it('refuses a retention that is not a whole number of days', () => {
    const dir = folders();
    expect(() => config(dir, { TRACE_RETENTION_DAYS: '0' })).toThrow('TRACE_RETENTION_DAYS must be a positive whole number of days, got "0"');
    expect(() => config(dir, { AUDIT_RETENTION_DAYS: '1.5' })).toThrow('AUDIT_RETENTION_DAYS must be a non-negative integer, got "1.5"');
  });
});
