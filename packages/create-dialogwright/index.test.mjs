import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// The thin package: it hands the name and the options to `dialogwright create-app --standalone`.
// `pnpm adopt:test` runs it packed and installed, then the project it writes.
const here = fileURLToPath(new URL('.', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'create-dialogwright-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
// As npm create runs it: INIT_CWD is where it was run, which the project is written in.
const run = (args) => spawnSync(process.execPath, [join(here, 'index.mjs'), ...args], { encoding: 'utf8', cwd: scratch, env: { ...process.env, INIT_CWD: scratch } });

describe('npm create dialogwright', () => {
  it('writes a project of its own with dialogwright\'s scaffold, passing the options on', () => {
    const r = run(['my-line', '--identity', '--display', 'Example Plumbing', '--dialogwright', 'file:../dialogwright.tgz']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('created my-line: a project of its own');
    expect(r.stdout).toContain('for "Example Plumbing"');
    const pkg = JSON.parse(readFileSync(join(scratch, 'my-line', 'package.json'), 'utf8'));
    expect(pkg.dependencies).toEqual({ dialogwright: 'file:../dialogwright.tgz' });
    for (const file of ['identity.yaml', '.gitignore', 'CLAUDE.md', '.claude/skills/create-app/SKILL.md']) expect(existsSync(join(scratch, 'my-line', file)), file).toBe(true);
  }, 60_000);

  it('says how to use it when given no name, and refuses a bad one as the scaffold does', () => {
    const none = run([]);
    expect(none.status).toBe(2);
    expect(none.stdout).toContain('usage: npm create dialogwright@latest <name> -- [--identity] [--display "<business name>"] [--dir <path>]');
    const bad = run(['Not A Name']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('is not a valid app name');
  }, 60_000);
});
