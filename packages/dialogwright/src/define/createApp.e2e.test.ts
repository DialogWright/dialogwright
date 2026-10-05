import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { main } from './cli';
import { SHORT_TMP, withShortTmp } from '../testing/shortTmp';

/**
 * End to end: scaffold an app into a temporary folder (never under apps/), link it to this
 * repository's engine and tools the way `pnpm install` would, and run what the README tells the
 * developer to run: `dialogwright check`, the type check, the app's own tests (its golden tests of
 * the policy read back among them) and its stub regression, and the three commands that write the
 * read back (policy:matrix, policy:card, app:diagram), which must find every page as it shipped.
 * Each must pass with nothing changed. Slow (it starts seven processes per variant), so
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
  // TMPDIR short, since tsx opens a socket under it (../testing/shortTmp.ts).
  const env = withShortTmp({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST') && key !== 'FORCE_COLOR')), NO_COLOR: '1' });
  try {
    // Without colour codes, which a CI run turns on whatever is asked, so the output can be read as text.
    return execFileSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).replace(/\u001b\[[0-9;]*m/g, '');
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
    const base = mkdtempSync(join(SHORT_TMP, 'dialogwright-scaffold-'));
    scratch.push(base);
    const app = join(base, name);
    const out: string[] = [];
    const code = await main(['create-app', name, '--dir', app, '--no-install', ...(identity ? ['--identity'] : [])], { out: (l) => out.push(l), err: (l) => out.push(l), cwd: base });
    expect(code, out.join('\n')).toBe(0);
    expect(existsSync(join(app, 'identity.yaml'))).toBe(identity);
    link(app);

    // `pnpm check` is this command, run for the one folder.
    expect(node(PACKAGE_DIR, tool('tsx', 'dist', 'cli.mjs'), ['src/define/cli.ts', 'check', app]).trim()).toBe(`${app}: ok`);
    // The policy read back ships with the app: `pnpm policy:matrix`, `pnpm policy:card` and
    // `pnpm app:diagram` find every page already what the app generates, and change no byte.
    const pages = ['policy.matrix', 'POLICY.md', 'APP-MAP.md'];
    const before = pages.map((page) => readFileSync(join(app, page), 'utf8'));
    for (const [command, page] of [['policy:matrix', 'policy.matrix'], ['policy:card', 'POLICY.md'], ['app:diagram', 'APP-MAP.md']] as const) {
      expect(node(PACKAGE_DIR, tool('tsx', 'dist', 'cli.mjs'), ['src/define/cli.ts', command, app]).trim(), command).toMatch(new RegExp(`${page.replace('.', '\\.')}: unchanged$`));
    }
    expect(pages.map((page) => readFileSync(join(app, page), 'utf8'))).toEqual(before);
    // `pnpm --filter ... typecheck`: no output, exit 0.
    expect(node(app, tool('typescript', 'bin', 'tsc'), ['--noEmit'])).toBe('');
    // `pnpm --filter ... test`
    // Its golden tests among them: the matrix, the card and the map against what the app generates.
    const tests = node(app, tool('vitest', 'vitest.mjs'), ['run']);
    expect(tests).toMatch(/Test Files\s+2 passed/);
    expect(tests).not.toMatch(/skipped|todo/);
    // `pnpm --filter ... regress`: the baseline that shipped, no changes.
    const regress = node(app, tool('tsx', 'dist', 'cli.mjs'), ['src/regress.ts']);
    expect(regress).toContain('no changes');
    expect(regress).toMatch(/scenarios\s+4\/4 pass expectation,\s+4\/4 match expected/);
  }, 240_000);
});
