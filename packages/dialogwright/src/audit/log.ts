import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../jev/cassette';
import type { AuditDraft, AuditEntry } from './types';

export const GENESIS = '0'.repeat(64);

export function entryHash(e: Omit<AuditEntry, 'hash'>): string {
  return createHash('sha256').update(canonicalJson(e), 'utf8').digest('hex');
}

/**
 * Append-only, hash-chained audit log, one file per UTC day in `dir`. Each entry carries the hash of
 * the one before, so an edit anywhere breaks every later link; `pnpm audit:verify` finds the first break.
 *
 * Each day file is its own chain: its first entry links to GENESIS and its `seq` starts at 1, so
 * `seq` is the entry's line in its file and any one day verifies without the days before it. The
 * day is resolved on every append, not once, so a process running across midnight UTC rolls over to
 * the new day's file (and a new chain) with the first entry after it. A process restarted mid-day
 * picks up that day's chain where the file ends. What a per-day chain cannot show on its own is a
 * whole day file deleted; the directory listing (one file per day) is where that shows.
 */
export class AuditLog {
  private file = '';
  private seq = 0;
  private prev = GENESIS;

  constructor(private readonly dir: string, private readonly now: () => number = () => Date.now()) {
    mkdirSync(dir, { recursive: true });
    this.roll(now());
  }

  /** The day file the next entry goes to, as of the last append (or construction). */
  get path(): string {
    return this.file;
  }

  /** Point the log at `atMs`'s day file, continuing its chain if it has one, or starting a new one. */
  private roll(atMs: number): void {
    const file = join(this.dir, `${new Date(atMs).toISOString().slice(0, 10)}.jsonl`);
    if (file === this.file) return;
    this.file = file;
    this.seq = 0;
    this.prev = GENESIS;
    if (existsSync(file)) {
      const last = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).at(-1);
      if (last) {
        const e = JSON.parse(last) as AuditEntry;
        this.seq = e.seq;
        this.prev = e.hash;
      }
    }
  }

  append(callId: string, channel: string, d: AuditDraft): AuditEntry {
    const atMs = this.now();
    this.roll(atMs);
    const base = { ...d, seq: this.seq + 1, at: new Date(atMs).toISOString(), callId, channel, prevHash: this.prev };
    const entry: AuditEntry = { ...base, hash: entryHash(base) };
    appendFileSync(this.file, JSON.stringify(entry) + '\n');
    this.seq = entry.seq;
    this.prev = entry.hash;
    return entry;
  }
}
