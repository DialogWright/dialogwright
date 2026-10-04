import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** fsyncSync watched, so a test can see a save flushed (SESSION_FSYNC=on) or not (off, the default). */
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) };
});

const fs = await import('node:fs');
const { openFileStores, writeAtomic } = await import('./file');
const { contractCall } = await import('../../testing/storeContract');

const dirs: string[] = [];
afterEach(() => {
  vi.mocked(fs.fsyncSync).mockClear();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'fsync-'));
  dirs.push(d);
  return d;
}

describe('SESSION_FSYNC', () => {
  it('off (the default): a save is renamed into place without being flushed to the disk', () => {
    const dir = temp();
    writeAtomic(join(dir, 'one.json'), '{"a":1}');
    const stores = openFileStores(join(dir, 'sessions'), { tokenTtlMs: 60_000 });
    stores.calls.save(contractCall('CA0001'));
    stores.tokens.mint('CA0001');
    expect(fs.fsyncSync).not.toHaveBeenCalled();
  });

  it('on: each save, call and token alike, is flushed, and then its folder, so a power cut keeps it', () => {
    const dir = temp();
    writeAtomic(join(dir, 'one.json'), '{"a":1}', { fsync: true });
    expect(readFileSync(join(dir, 'one.json'), 'utf8')).toBe('{"a":1}');
    // The file, then the folder that names it.
    expect(fs.fsyncSync).toHaveBeenCalledTimes(2);
    const stores = openFileStores(join(dir, 'sessions'), { tokenTtlMs: 60_000, fsync: true });
    vi.mocked(fs.fsyncSync).mockClear();
    stores.calls.save(contractCall('CA0001'));
    stores.chats.save({ id: 'chat-1', schema: 1, session: contractCall('chat-1').session, resumeHash: 'a'.repeat(64), createdAtMs: 0, lastActivityMs: 0, auditTail: [] });
    stores.tokens.mint('CA0001');
    expect(fs.fsyncSync).toHaveBeenCalledTimes(6);
    expect(stores.calls.load('CA0001')).toEqual(contractCall('CA0001'));
  });
});
