import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from './log';
import { main } from './verifyCli';
import { PGlite } from '@electric-sql/pglite';
import { pgliteSql } from '../server/stores/pgliteSql';
import { openPostgresAudit } from './postgres';

/** `pnpm audit:verify [dir]`: the root script exists, and the command it runs says whether each day's chain is whole. */

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

let dir: string;
let lines: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'audit-verify-'));
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function chain(): string {
  const log = new AuditLog(dir, () => Date.UTC(2026, 9, 1, 17, 0, 0));
  log.append('CA1', 'voice', { type: 'call_started', detail: {} });
  log.append('CA1', 'voice', { type: 'gate', detail: { tool: 'getParcel', verdict: 'ALLOW' } });
  log.append('CA1', 'voice', { type: 'call_ended', detail: { reason: 'hangup' } });
  return log.path;
}

describe('pnpm audit:verify', () => {
  it('is a script at the repository root', () => {
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(root.scripts['audit:verify']).toBe('tsx packages/dialogwright/src/define/cli.ts audit:verify');
  });

  it('exits 0 on a whole chain', () => {
    chain();
    expect(main([dir], {})).toBe(0);
    expect(lines).toEqual(['2026-10-01.jsonl: 3 entries, chain intact']);
  });

  it('exits 1 on a tampered one, naming the line', () => {
    const file = chain();
    const entries = readFileSync(file, 'utf8').split('\n');
    entries[1] = entries[1]!.replace('ALLOW', 'BLOCK');
    writeFileSync(file, entries.join('\n'));
    expect(main([dir], {})).toBe(1);
    expect(lines).toEqual(['2026-10-01.jsonl: BROKEN at line 2 of 3 (hash mismatch)']);
  });

  it('verifies each app\'s folder of a server of several apps (host.yaml), entries naming their app, and exits 1 at a break in any', () => {
    for (const app of ['clinic', 'utility']) {
      const log = new AuditLog(join(dir, app), () => Date.UTC(2026, 9, 1, 17, 0, 0));
      log.append(`CA-${app}`, 'voice', { type: 'call_started', detail: {}, app });
    }
    expect(main([dir])).toBe(0);
    expect(lines).toEqual(['clinic/2026-10-01.jsonl: 1 entries, chain intact', 'utility/2026-10-01.jsonl: 1 entries, chain intact']);
    const file = join(dir, 'utility', '2026-10-01.jsonl');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"app":"utility"', '"app":"clinic"'));
    lines = [];
    expect(main([dir])).toBe(1);
    expect(lines[1]).toMatch(/^utility\/2026-10-01\.jsonl: BROKEN at line 1 of 1/);
  });

  it('reads a relative folder from where pnpm was run (INIT_CWD), not from the engine package', () => {
    chain();
    expect(main([relative(tmpdir(), dir)], { INIT_CWD: tmpdir() })).toBe(0);
    expect(lines).toEqual(['2026-10-01.jsonl: 3 entries, chain intact']);
  });
});

describe('pnpm audit:verify postgres://... (AUDIT_STORE=postgres)', () => {
  const URL = 'postgres://dialogwright:s3cret-pass@db.invalid:5432/dialogwright';

  it('verifies every call\'s chain and every day\'s anchors, says the database with its password masked, and exits 1 at a break', async () => {
    const db = await PGlite.create();
    try {
      const audit = await openPostgresAudit(pgliteSql(db), { now: () => Date.UTC(2026, 9, 11, 12, 0, 0) });
      await audit.appendAll('CA1', 'voice', [{ type: 'call_started', detail: {} }, { type: 'call_ended', detail: { reason: 'hangup' } }]);
      await audit.append('CA2', 'voice', { type: 'call_started', detail: {} });
      expect(await main([URL], {}, { sql: pgliteSql(db) })).toBe(0);
      expect(lines).toEqual([
        'postgres://dialogwright:***@db.invalid:5432/dialogwright: 2 chains, 3 entries',
        '2026-10-11 (server): 2 anchors, chain intact',
        "every call's chain intact, and each one's newest entry anchored",
      ]);
      // AUDIT_STORE is read when no argument names a place.
      lines = [];
      expect(await main([], { AUDIT_STORE: URL, AUDIT_DIR: dir }, { sql: pgliteSql(db) })).toBe(0);
      expect(lines[0]).toBe('postgres://dialogwright:***@db.invalid:5432/dialogwright: 2 chains, 3 entries');
      await db.query("UPDATE dw_audit_entries SET body = replace(body, 'hangup', 'completed') WHERE chain = 'CA1' AND seq = 2");
      lines = [];
      expect(await main([URL], {}, { sql: pgliteSql(db) })).toBe(1);
      expect(lines).toContain('call CA1: BROKEN at entry 2 (hash mismatch)');
      expect(lines.join('\n')).not.toContain('s3cret-pass');
    } finally {
      await db.close();
    }
  });

  it('a database with no audit tables has nothing to verify; one that cannot be reached exits 1 without its password', async () => {
    const db = await PGlite.create();
    try {
      expect(await main([URL], {}, { sql: pgliteSql(db) })).toBe(0);
      expect(lines).toEqual(['no audit tables in postgres://dialogwright:***@db.invalid:5432/dialogwright']);
      const cut = pgliteSql(db);
      cut.cut();
      lines = [];
      expect(await main([URL], {}, { sql: cut })).toBe(1);
      expect(lines).toEqual(['postgres://dialogwright:***@db.invalid:5432/dialogwright: connection cut (the server went away)']);
    } finally {
      await db.close();
    }
  });
});
