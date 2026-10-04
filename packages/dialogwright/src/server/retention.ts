import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Keeping the disk in check. A server writes two files per call (its trace and its frame log) and one
 * audit file per UTC day, and keeps them all unless told otherwise: TRACE_RETENTION_DAYS and
 * AUDIT_RETENTION_DAYS (config.ts) are how long. The server sweeps at startup and then once an hour
 * (index.ts). Nothing is swept when neither is set, as before they existed.
 */

const DAY_MS = 86_400_000;
/** An audit day file's name: the UTC day it holds (audit/log.ts). */
const AUDIT_DAY = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
/** A trace's file and its frame log (index.ts: `<stem>.jsonl`, `<stem>.frames.jsonl`). */
const TRACE_FILE = /^(.+?)(?:\.frames)?\.jsonl$/;

export interface RetentionSettings {
  traceDir: string;
  auditDir: string;
  /** TRACE_RETENTION_DAYS; unset, every trace is kept. */
  traceDays?: number;
  /** AUDIT_RETENTION_DAYS; unset, every audit day is kept. */
  auditDays?: number;
}

export interface SweepResult {
  /** Trace files and frame logs removed. */
  traceFiles: number;
  /** Audit day files removed. */
  auditDays: number;
}

/** A folder's file names, or none when it does not exist (yet). */
function names(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * One sweep. A trace file (or frame log) goes when it was last written more than `traceDays` days ago,
 * unless its call is one the server still holds (`inUse`, by file stem): a file being written was
 * written moments ago anyway, so this is the belt to that brace. An audit day file goes when its day
 * is more than `auditDays` days before today (UTC), by its name, never today's: each day is a chain of
 * its own (audit/log.ts), so the days kept still verify. A file that cannot be removed is left for the
 * next sweep.
 */
export function sweepRetention(s: RetentionSettings, at: { now: number; inUse: ReadonlySet<string> }): SweepResult {
  let traceFiles = 0;
  let auditDays = 0;
  if (s.traceDays !== undefined) {
    const cutoff = at.now - s.traceDays * DAY_MS;
    for (const name of names(s.traceDir)) {
      const m = TRACE_FILE.exec(name);
      if (!m || at.inUse.has(m[1]!)) continue;
      const path = join(s.traceDir, name);
      try {
        if (statSync(path).mtimeMs >= cutoff) continue;
        unlinkSync(path);
        traceFiles += 1;
      } catch {
        // Gone already, or not ours to remove: the next sweep tries again.
      }
    }
  }
  if (s.auditDays !== undefined) {
    const today = new Date(at.now).toISOString().slice(0, 10);
    const startOfToday = Date.parse(`${today}T00:00:00Z`);
    for (const name of names(s.auditDir)) {
      const m = AUDIT_DAY.exec(name);
      if (!m || m[1] === today) continue;
      const day = Date.parse(`${m[1]}T00:00:00Z`);
      if (Number.isNaN(day) || startOfToday - day <= s.auditDays * DAY_MS) continue;
      try {
        unlinkSync(join(s.auditDir, name));
        auditDays += 1;
      } catch {
        // As above.
      }
    }
  }
  return { traceFiles, auditDays };
}

/** The bytes of the files directly in a folder; 0 for one that does not exist. */
function bytesIn(dir: string): number {
  let total = 0;
  for (const name of names(dir)) {
    try {
      total += statSync(join(dir, name)).size;
    } catch {
      // Removed while being counted.
    }
  }
  return total;
}

export interface DiskUsage {
  traceBytes: number;
  auditBytes: number;
}

/** How much the trace and audit folders hold, counted at most once a minute (`/health` may be asked often). */
export function diskUsageCache(traceDir: string, auditDir: string, now: () => number, everyMs = 60_000): () => DiskUsage {
  let last: { at: number; usage: DiskUsage } | null = null;
  return () => {
    const t = now();
    if (last === null || t - last.at >= everyMs) last = { at: t, usage: { traceBytes: bytesIn(traceDir), auditBytes: bytesIn(auditDir) } };
    return last.usage;
  };
}
