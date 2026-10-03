import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { libraryApp, LIBRARY_DIR } from './fixture/app';
import { main } from './cli';
import { findMatrixFolders, loadMatrixApp, workspaceRootOf } from './matrixCommand';

/**
 * `dialogwright policy:matrix`: finds each app's folder and its App, and writes policy.matrix only
 * when it changed. Run here on the folders whose matrix is committed, it finds every one unchanged
 * (a run that changed one would be a test failing elsewhere first: the golden tests).
 */

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = join(PACKAGE, '..', '..');

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), cwd }, out, err };
}

describe('dialogwright policy:matrix', () => {
  it('finds the workspace, every folder with a policy.matrix, and the App a folder exports', async () => {
    expect(workspaceRootOf(PACKAGE)).toBe(ROOT);
    expect(findMatrixFolders(ROOT).map((d) => relative(ROOT, d))).toEqual(['apps/clinic', 'packages/dialogwright/src/define/fixture', 'packages/dialogwright/src/testing/testkit']);
    expect(await loadMatrixApp(LIBRARY_DIR)).toBe(libraryApp);
  });

  it('writes nothing when every matrix is what the gate decides', async () => {
    const run = io(PACKAGE);
    expect(await main(['policy:matrix', 'src/define/fixture', 'apps/clinic'], run.io)).toBe(0);
    expect(run.out).toEqual(['src/define/fixture/policy.matrix: unchanged', '../../apps/clinic/policy.matrix: unchanged']);
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
