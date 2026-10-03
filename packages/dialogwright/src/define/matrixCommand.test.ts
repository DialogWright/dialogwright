import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { workspaceCopy, type WorkspaceCopy } from './__fixtures__/workspaceCopy';
import { libraryApp, LIBRARY_DIR } from './fixture/app';
import { main } from './cli';
import { findMatrixFolders, loadMatrixApp, workspaceRootOf } from './matrixCommand';

/**
 * `dialogwright policy:matrix`: finds each app's folder and its App, and writes policy.matrix only
 * when it changed. Run here on a scratch copy of the folders whose matrix is committed
 * (./__fixtures__/workspaceCopy.ts), it finds every one unchanged (a matrix that changed would be a
 * golden test failing first). The command writes only the copy: no test writes a committed matrix.
 */

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = join(PACKAGE, '..', '..');

const FOLDERS = ['apps/clinic', 'packages/dialogwright/src/define/fixture', 'packages/dialogwright/src/testing/testkit'];

const copies: WorkspaceCopy[] = [];
afterEach(() => {
  for (const copy of copies.splice(0)) copy.remove();
});

function scratch(): { root: string; pkg: string } {
  const copy = workspaceCopy(ROOT, FOLDERS);
  copies.push(copy);
  return { root: copy.root, pkg: join(copy.root, 'packages', 'dialogwright') };
}

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), cwd }, out, err };
}

describe('dialogwright policy:matrix', () => {
  it('finds the workspace, every folder with a policy.matrix, and the App a folder exports', async () => {
    expect(workspaceRootOf(PACKAGE)).toBe(ROOT);
    expect(findMatrixFolders(ROOT).map((d) => relative(ROOT, d))).toEqual(FOLDERS);
    expect(await loadMatrixApp(LIBRARY_DIR)).toBe(libraryApp);
  });

  it('writes nothing when every matrix is what the gate decides', async () => {
    const { pkg } = scratch();
    const run = io(pkg);
    expect(await main(['policy:matrix', 'src/define/fixture', 'apps/clinic'], run.io)).toBe(0);
    expect(run.out).toEqual(['src/define/fixture/policy.matrix: unchanged', '../../apps/clinic/policy.matrix: unchanged']);
  });

  it('with no folder, writes again each matrix the workspace has, and only the one that changed', async () => {
    const { root } = scratch();
    const stale = join(root, 'apps/clinic/policy.matrix');
    writeFileSync(stale, 'stale\n');
    const run = io(root);
    expect(await main(['policy:matrix'], run.io)).toBe(0);
    expect(run.out).toEqual(FOLDERS.map((d) => (d === 'apps/clinic' ? expect.stringMatching(/^wrote apps\/clinic\/policy\.matrix \(\d+ lines\)/) : `${d}/policy.matrix: unchanged`)));
    expect(readFileSync(stale, 'utf8')).toBe(readFileSync(join(ROOT, 'apps/clinic/policy.matrix'), 'utf8'));
  });

  it('refuses an option, and says which folder it cannot use', async () => {
    const bad = io(PACKAGE);
    expect(await main(['policy:matrix', '--update'], bad.io)).toBe(2);
    expect(bad.err[0]).toContain('--update is not an option');
    const none = io(PACKAGE);
    expect(await main(['policy:matrix', 'src/define/__fixtures__/valid'], none.io)).toBe(1);
    expect(none.err[0]).toMatch(/no module \(.*\) exports an App$/);
  });
});
