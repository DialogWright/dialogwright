import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, type Io } from './cli';
import { loadAppFolder } from './load';

/** `dialogwright check` with a host file (host.yaml: several apps on one server). */

const FIXTURE = fileURLToPath(new URL('../testing/host/host.yaml', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function check(args: string[], cwd: string): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const io: Io = { out: (l) => out.push(l), err: (l) => out.push(l), cwd };
  return { code: await main(['check', ...args], io), out };
}

describe('dialogwright check with a host file', () => {
  it('checks the host file named, and each app it lists, as its own', async () => {
    const { code, out } = await check([FIXTURE], dirname(FIXTURE));
    expect(code).toBe(0);
    expect(out).toEqual([`${FIXTURE}: ok`, '../callback: ok', '../routed: ok']);
  }, 60_000);

  it('finds host.yaml beside the apps, and says its problems with their fixes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-check-'));
    dirs.push(root);
    mkdirSync(join(root, 'apps'));
    writeFileSync(join(root, 'host.yaml'), 'apps: [apps/missing]\nnumbers:\n  - { number: env.LINE, app: missing }\n');
    const { code, out } = await check([], root);
    expect(code).toBe(1);
    expect(out[0]).toMatch(/^host\.yaml:1:8  apps\[0\]  the app folder apps\/missing does not exist .*->  write the path/);
    expect(out.at(-1)).toBe('2 problems in host.yaml');
  });

  it('lets host.yaml sit in an app\'s own folder, as in a project of its own, whose folder is its app\'s', () => {
    const root = mkdtempSync(join(tmpdir(), 'host-own-'));
    dirs.push(root);
    cpSync(join(dirname(FIXTURE), '..', 'callback'), root, { recursive: true, filter: (src) => !src.endsWith('.ts') });
    writeFileSync(join(root, 'host.yaml'), 'apps: [.]\n');
    expect(loadAppFolder(root).problems.filter((p) => p.file === 'host.yaml')).toEqual([]);
    writeFileSync(join(root, 'hosts.yaml'), 'apps: [.]\n');
    expect(loadAppFolder(root).problems.map((p) => p.file)).toContain('hosts.yaml');
  });
});
