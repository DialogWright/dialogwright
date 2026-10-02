import { readFileSync } from 'node:fs';
import { entryHash, GENESIS } from './log';
import type { AuditEntry } from './types';

export type VerifyResult = { ok: true; entries: number } | { ok: false; entries: number; brokenAt: number; why: string };

/** Re-walks a day file; `brokenAt` is the 1-based line of the first entry whose link or hash is wrong. */
export function verifyChain(path: string): VerifyResult {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  let prev = GENESIS;
  for (const [i, line] of lines.entries()) {
    const e = JSON.parse(line) as AuditEntry;
    const { hash, ...rest } = e;
    if (e.prevHash !== prev) return { ok: false, entries: lines.length, brokenAt: i + 1, why: 'broken link' };
    if (entryHash(rest) !== hash) return { ok: false, entries: lines.length, brokenAt: i + 1, why: 'hash mismatch' };
    prev = hash;
  }
  return { ok: true, entries: lines.length };
}
