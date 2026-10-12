import { existsSync, readdirSync, statfsSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
/** The console's daily figures, beside the traces (dashboard/figuresCache.ts): a file per UTC day. */
const FIGURES_DIR = '.figures';
const FIGURES_DAY = /^(\d{4}-\d{2}-\d{2})\.json$/;

export interface RetentionSettings {
  traceDir: string;
  auditDir: string;
  /** TRACE_RETENTION_DAYS; unset, every trace is kept. */
  traceDays?: number;
  /** AUDIT_RETENTION_DAYS; unset, every audit day is kept. */
  auditDays?: number;
  /** TRACE_MAX_GB in bytes; unset, no size bound. */
  traceMaxBytes?: number;
  /** FIGURES_RETENTION_DAYS: the console's daily figures (`<traceDir>/.figures`); unset, kept. */
  figuresDays?: number;
}

export interface SweepResult {
  /** Trace files and frame logs removed. */
  traceFiles: number;
  /** Audit day files removed. */
  auditDays: number;
  /** Of the trace files removed, those removed for the size bound, and the calls they were. */
  trimmed?: { files: number; calls: number };
  /** The console's daily figures files removed (FIGURES_RETENTION_DAYS). */
  figuresDays?: number;
}

/** A folder's plain file names (not a link, not a folder), or none when it does not exist (yet). */
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
      // An audit day file is never a trace, even in a folder the two share (TRACE_DIR and AUDIT_DIR the same).
      if (!m || at.inUse.has(m[1]!) || AUDIT_DAY.test(name)) continue;
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
  // The console's daily figures (dashboard/figuresCache.ts) outlive the traces, under their own retention:
  // a day's file goes when its day is more than `figuresDays` days before today (UTC), by its name.
  let figuresDays = 0;
  if (s.figuresDays !== undefined) {
    const today = Date.parse(`${new Date(at.now).toISOString().slice(0, 10)}T00:00:00Z`);
    const figures = join(s.traceDir, FIGURES_DIR);
    for (const name of names(figures)) {
      const m = FIGURES_DAY.exec(name);
      const day = m ? Date.parse(`${m[1]}T00:00:00Z`) : Number.NaN;
      if (Number.isNaN(day) || today - day <= s.figuresDays * DAY_MS) continue;
      try {
        unlinkSync(join(figures, name));
        figuresDays += 1;
      } catch {
        // As above.
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
  // The size bound: while the traces are larger, the calls written least recently go first, whole.
  if (s.traceMaxBytes !== undefined) {
    const calls = new Map<string, { paths: string[]; size: number; newest: number }>();
    let total = 0;
    for (const name of names(s.traceDir)) {
      const m = TRACE_FILE.exec(name);
      if (!m || AUDIT_DAY.test(name)) continue;
      const path = join(s.traceDir, name);
      try {
        const st = statSync(path);
        const c = calls.get(m[1]!) ?? { paths: [], size: 0, newest: 0 };
        c.paths.push(path);
        c.size += st.size;
        c.newest = Math.max(c.newest, st.mtimeMs);
        calls.set(m[1]!, c);
        total += st.size;
      } catch {
        // Gone while being counted.
      }
    }
    let files = 0;
    let removedCalls = 0;
    for (const [stem, c] of [...calls].sort((a, b) => a[1].newest - b[1].newest)) {
      if (total <= s.traceMaxBytes) break;
      if (at.inUse.has(stem)) continue;
      for (const path of c.paths) {
        try {
          unlinkSync(path);
          files += 1;
        } catch {
          // As above.
        }
      }
      total -= c.size;
      removedCalls += 1;
    }
    traceFiles += files;
    return { traceFiles, auditDays, trimmed: { files, calls: removedCalls }, ...(s.figuresDays !== undefined ? { figuresDays } : {}) };
  }
  return { traceFiles, auditDays, ...(s.figuresDays !== undefined ? { figuresDays } : {}) };
}

/** The bytes free to this user on the disk `dir` is on (its nearest folder that exists), or null when that cannot be told. */
export function freeBytesAt(dir: string): number | null {
  let d = dir;
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  try {
    const s = statfsSync(d);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
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
  /** With DISK_WARN_FREE_GB: the least free space on the trace and audit folders' disks, and whether it is under the bound. */
  freeBytes?: number | null;
  low?: boolean;
}

/**
 * How much the trace and audit folders hold, counted at most once a minute (`/health` may be asked
 * often); with `warnFreeBytes` (DISK_WARN_FREE_GB), the free space beside it and whether it is low.
 */
export function diskUsageCache(traceDir: string | readonly string[], auditDir: string | readonly string[], now: () => number, everyMs = 60_000, warnFreeBytes?: number, freeBytes: (dir: string) => number | null = freeBytesAt): () => DiskUsage {
  // On a server of several apps (host.yaml), each app's folders, counted together.
  const traceDirs = typeof traceDir === 'string' ? [traceDir] : traceDir;
  const auditDirs = typeof auditDir === 'string' ? [auditDir] : auditDir;
  const sum = (dirs: readonly string[]): number => dirs.reduce((n, d) => n + bytesIn(d), 0);
  let last: { at: number; usage: DiskUsage } | null = null;
  return () => {
    const t = now();
    if (last === null || t - last.at >= everyMs) {
      const usage: DiskUsage = { traceBytes: sum(traceDirs), auditBytes: sum(auditDirs) };
      if (warnFreeBytes !== undefined) {
        const free = [...traceDirs, ...auditDirs].map((d) => freeBytes(d)).filter((n): n is number => n !== null);
        usage.freeBytes = free.length === 0 ? null : Math.min(...free);
        usage.low = usage.freeBytes !== null && usage.freeBytes < warnFreeBytes;
      }
      last = { at: t, usage };
    }
    return last.usage;
  };
}
