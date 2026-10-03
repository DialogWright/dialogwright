import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { main } from './cli';

/**
 * End to end: scaffold an app into a temporary folder (never under apps/), link it to this
 * repository's engine and tools the way `pnpm install` would, and run what the README tells the
 * developer to run: `dialogwright check`, the type check, the app's own tests and its stub
 * regression. Each must pass with nothing changed. Slow (it starts four processes per variant), so
 * it is two cases: the plain app and the one with identity.
 */
const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const tool = (...parts: string[]): string => realpathSync(join(PACKAGE_DIR, 'node_modules', ...parts));

/** What `pnpm install` would link into the new app: the engine, and the tools its scripts run. */
function link(app: string): void {
  mkdirSync(join(app, 'node_modules', '@types'), { recursive: true });
  symlinkSync(PACKAGE_DIR, join(app, 'node_modules', 'dialogwright'));
  for (const name of ['tsx', 'typescript', 'vitest']) symlinkSync(tool(name), join(app, 'node_modules', name));
  symlinkSync(tool('@types', 'node'), join(app, 'node_modules', '@types', 'node'));
}

/** Runs a node script in `cwd`, outside this test run's own vitest, and returns what it printed. */
function node(cwd: string, script: string, args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')));
  try {
    return execFileSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    throw new Error(`${script.split('/').slice(-3).join('/')} ${args.join(' ')} failed in ${cwd}:\n${stdout ?? ''}${stderr ?? ''}`, { cause: error });
  }
}

describe('a scaffolded app, end to end', () => {
  it.each([
    { name: 'plain-demo', identity: false },
    { name: 'identity-demo', identity: true },
  ])('$name passes check, typecheck, its tests and its stub regression as created', async ({ name, identity }) => {
    const base = mkdtempSync(join(tmpdir(), 'dialogwright-scaffold-'));
    scratch.push(base);
    const app = join(base, name);
    const out: string[] = [];
    const code = await main(['create-app', name, '--dir', app, '--no-install', ...(identity ? ['--identity'] : [])], { out: (l) => out.push(l), err: (l) => out.push(l), cwd: base });
    expect(code, out.join('\n')).toBe(0);
    expect(existsSync(join(app, 'identity.yaml'))).toBe(identity);
    link(app);

    // `pnpm check` is this command, run for the one folder.
    expect(node(PACKAGE_DIR, tool('tsx', 'dist', 'cli.mjs'), ['src/define/cli.ts', 'check', app]).trim()).toBe(`${app}: ok`);
    // `pnpm --filter ... typecheck`: no output, exit 0.
    expect(node(app, tool('typescript', 'bin', 'tsc'), ['--noEmit'])).toBe('');
    // `pnpm --filter ... test`
    const tests = node(app, tool('vitest', 'vitest.mjs'), ['run']);
    expect(tests).toMatch(/Test Files\s+2 passed/);
    // `pnpm --filter ... regress`: the baseline that shipped, no changes.
    const regress = node(app, tool('tsx', 'dist', 'cli.mjs'), ['src/regress.ts']);
    expect(regress).toContain('no changes');
    expect(regress).toMatch(/scenarios\s+3\/3 pass expectation,\s+3\/3 match expected/);
  }, 240_000);
});
