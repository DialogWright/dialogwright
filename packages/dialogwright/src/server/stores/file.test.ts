import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStoreContract, contractCall, contractChat } from '../../testing/storeContract';
import { FileCallStateStore, FileTokens, openFileStores, storeFileStem, writeAtomic } from './file';
import { tokenHash } from './types';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'store-'));
  dirs.push(d);
  return d;
}

/** The folder the last `make` used, so `reopen` opens the same one. */
let last = '';
runStoreContract('file', (ctx) => {
  last = join(temp(), 'sessions');
  return openFileStores(last, { tokenTtlMs: ctx.tokenTtlMs, now: ctx.now });
}, { describe, it, reopen: (ctx) => openFileStores(last, { tokenTtlMs: ctx.tokenTtlMs, now: ctx.now }) });

const mode = (p: string): number => statSync(p).mode & 0o777;

describe('the file stores', () => {
  it('make their folder and calls/ and chats/ mode 700, and write every file mode 600', () => {
    const dir = join(temp(), 'sessions');
    const s = openFileStores(dir, { tokenTtlMs: 60_000 });
    s.calls.save(contractCall('CA0001'));
    s.chats.save(contractChat('chat-1', 'r'.repeat(32)));
    s.tokens.mint('CA0001', 'twilio');
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, 'calls'))).toBe(0o700);
    expect(mode(join(dir, 'chats'))).toBe(0o700);
    const files = [join(dir, 'tokens.json'), ...readdirSync(join(dir, 'calls')).map((f) => join(dir, 'calls', f)), ...readdirSync(join(dir, 'chats')).map((f) => join(dir, 'chats', f))];
    expect(files).toHaveLength(3);
    for (const f of files) expect(mode(f)).toBe(0o600);
  });

  it('keep a folder that was there as it was, but make calls/ and chats/ 700 even when they were not, and say so', () => {
    const dir = temp();
    chmodSync(dir, 0o755);
    mkdirSync(join(dir, 'calls'), { mode: 0o755 });
    chmodSync(join(dir, 'calls'), 0o755);
    const logs: string[] = [];
    openFileStores(dir, { tokenTtlMs: 60_000, log: (l) => logs.push(l) });
    expect(mode(dir)).toBe(0o755);
    expect(mode(join(dir, 'calls'))).toBe(0o700);
    expect(logs).toEqual([`sessions: WARNING: ${dir} can be read by others than its owner; calls/ and chats/ in it cannot (mode 700)`]);
  });

  it('keep a token only as its hash, and a resume token only as its hash', () => {
    const dir = join(temp(), 'sessions');
    const s = openFileStores(dir, { tokenTtlMs: 60_000 });
    const token = s.tokens.mint('CA0001', 'twilio');
    const resume = 'e'.repeat(32);
    s.chats.save(contractChat('chat-1', resume));
    const everything = [join(dir, 'tokens.json'), ...readdirSync(join(dir, 'chats')).map((f) => join(dir, 'chats', f))].map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(resume);
    expect(everything).toContain(tokenHash(token));
    expect(JSON.parse(readFileSync(join(dir, 'tokens.json'), 'utf8'))).toEqual({ v: 1, tokens: [{ callId: 'CA0001', hash: tokenHash(token), provider: 'twilio', expiresAt: expect.any(Number) }] });
  });

  it('name a file by its id\'s safe characters and a hash, so ids that differ in other characters never share one', () => {
    expect(storeFileStem('v2:abc/../x')).toMatch(/^v2_abc____x-[0-9a-f]{16}$/);
    expect(storeFileStem('v2:abc')).not.toBe(storeFileStem('v2_abc'));
    expect(storeFileStem('x'.repeat(300))).toHaveLength(40 + 1 + 16);
  });

  it('write through a temporary file renamed over the old one, and leave no temporary file behind', () => {
    const dir = temp();
    const file = join(dir, 'one.json');
    writeAtomic(file, '{"a":1}');
    writeAtomic(file, '{"a":2}');
    expect(readFileSync(file, 'utf8')).toBe('{"a":2}');
    expect(readdirSync(dir)).toEqual(['one.json']);
  });

  it('leave the last whole save when a write fails, and remove the temporary file', () => {
    const dir = temp();
    const file = join(dir, 'one.json');
    writeAtomic(file, '{"a":1}');
    // A folder where the file should be: the rename fails after the temporary file was written.
    const blocked = join(dir, 'blocked.json');
    mkdirSync(blocked);
    writeFileSync(join(blocked, 'x'), '');
    expect(() => writeAtomic(blocked, '{"a":2}')).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}');
    expect(readdirSync(dir).sort()).toEqual(['blocked.json', 'one.json']);
  });

  it('sweep the temporary files a process that stopped mid-write left', () => {
    const dir = join(temp(), 'sessions');
    openFileStores(dir, { tokenTtlMs: 60_000 });
    writeFileSync(join(dir, 'calls', 'CA-abc.json.123.ffff.tmp'), '{"half":');
    writeFileSync(join(dir, 'tokens.json.123.ffff.tmp'), '{"half":');
    openFileStores(dir, { tokenTtlMs: 60_000 });
    expect(readdirSync(join(dir, 'calls'))).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(['calls', 'chats']);
  });

  it('skip a file that is not JSON or not a call, logging it once, and never throw', () => {
    const dir = temp();
    const logs: string[] = [];
    const calls = new FileCallStateStore(dir, (l) => logs.push(l));
    calls.save(contractCall('CA0001'));
    calls.save(contractCall('CA0002'));
    const file = join(dir, `${storeFileStem('CA0001')}.json`);
    writeFileSync(file, '{"callId": "CA0001", "trunc');
    writeFileSync(join(dir, `${storeFileStem('CA0003')}.json`), JSON.stringify({ callId: 'CA0003' }));
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    expect(calls.load('CA0001')).toBeNull();
    expect(calls.list()).toEqual(['CA0002']);
    expect(calls.list()).toEqual(['CA0002']);
    expect(logs).toEqual([
      `sessions: skipped ${file}: not JSON (not a call this store wrote; left as it is)`,
      `sessions: skipped ${join(dir, `${storeFileStem('CA0003')}.json`)}: no provider (not a call this store wrote; left as it is)`,
    ]);
    expect(existsSync(file)).toBe(true);
  });

  it('start with no tokens when tokens.json is unreadable, and say so', () => {
    const dir = temp();
    writeFileSync(join(dir, 'tokens.json'), '[1,2');
    const logs: string[] = [];
    const tokens = new FileTokens(join(dir, 'tokens.json'), 60_000, Date.now, (l) => logs.push(l));
    expect(tokens.has('a'.repeat(32), 'twilio')).toBe(false);
    expect(logs).toEqual([`sessions: skipped ${join(dir, 'tokens.json')}: not JSON (the relay tokens start empty)`]);
    // The next mint writes a good file over it.
    const t = tokens.mint('CA0001');
    expect(new FileTokens(join(dir, 'tokens.json'), 60_000).verify(t, 'CA0001', 'twilio')).toBe(true);
  });

  it('drop the tokens that expired while the server was down as it opens', () => {
    const dir = temp();
    let now = 1_000_000;
    const tokens = new FileTokens(join(dir, 'tokens.json'), 60_000, () => now);
    tokens.mint('CA0001');
    now += 60_001;
    const again = new FileTokens(join(dir, 'tokens.json'), 60_000, () => now);
    again.mint('CA0002');
    expect(JSON.parse(readFileSync(join(dir, 'tokens.json'), 'utf8')).tokens.map((t: { callId: string }) => t.callId)).toEqual(['CA0002']);
  });
});
