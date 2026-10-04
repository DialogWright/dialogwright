import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from './log';
import { main } from './verifyCli';

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
  it('is a script at the repository root, which runs the engine package\'s own', () => {
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const engine = JSON.parse(readFileSync(join(ROOT, 'packages/dialogwright/package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(root.scripts['audit:verify']).toBe('pnpm --filter dialogwright audit:verify');
    expect(engine.scripts['audit:verify']).toBe('tsx src/audit/verifyCli.ts');
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

  it('reads a relative folder from where pnpm was run (INIT_CWD), not from the engine package', () => {
    chain();
    expect(main([relative(tmpdir(), dir)], { INIT_CWD: tmpdir() })).toBe(0);
    expect(lines).toEqual(['2026-10-01.jsonl: 3 entries, chain intact']);
  });
});
