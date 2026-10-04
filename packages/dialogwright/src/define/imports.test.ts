import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withShortTmp } from '../testing/shortTmp';

/**
 * The modules a script imports on their own (an app's migration script, a tool of its own) load in a
 * fresh process, first, through tsx: no import cycle leaves one reading a binding before it is set
 * (problems.ts once reached the schemas, whose policy schema reads problems.ts back). Inside vitest
 * the modules are already loaded in another order, so only a child process sees it.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));
const PACKAGE_DIR = join(SRC, '..');
const MODULES = ['define/load.ts', 'define/problems.ts', 'define/defineKnowledge.ts', 'kb/folder.ts', 'kb/approval.ts', 'kb/hash.ts', 'kb/rules.ts'];

describe('a module imported first, on its own', () => {
  it.each(MODULES)('%s loads', (module) => {
    const url = pathToFileURL(join(SRC, module)).href;
    const run = spawnSync(join(PACKAGE_DIR, 'node_modules', '.bin', 'tsx'), ['-e', `import(${JSON.stringify(url)}).then((m) => console.log('loaded', Object.keys(m).length > 0), (e) => { console.log('failed', e.message); process.exit(1); })`], { encoding: 'utf8', env: withShortTmp(), cwd: PACKAGE_DIR });
    expect({ status: run.status, out: run.stdout.trim() }).toEqual({ status: 0, out: 'loaded true' });
  });
});
