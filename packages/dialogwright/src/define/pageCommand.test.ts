import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { libraryApp, LIBRARY_DIR } from './fixture/app';
import { main } from './cli';
import { workspaceRootOf } from './matrixCommand';
import { findPageFolders, loadFolderApp } from './pageCommand';

/**
 * `dialogwright policy:card`: finds each app's folder and its App, and writes the page only when it
 * changed. Run here on the folders whose cards are committed, it finds every one unchanged (a run that changed one would be a test failing elsewhere first: the
 * golden tests).
 */

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = workspaceRootOf(PACKAGE);

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), cwd }, out, err };
}

const FOLDERS = ['apps/clinic', 'packages/dialogwright/src/define/fixture', 'packages/dialogwright/src/testing/testkit'];

describe('dialogwright policy:card', () => {
  it('finds every folder with a card, and the App a folder exports', async () => {
    expect(findPageFolders(ROOT, 'POLICY.md').map((d) => relative(ROOT, d))).toEqual(FOLDERS);
    expect(await loadFolderApp(LIBRARY_DIR)).toBe(libraryApp);
  });

  it('writes nothing when every card is what the app generates', async () => {
    const card = io(PACKAGE);
    expect(await main(['policy:card', 'src/define/fixture', 'apps/clinic'], card.io)).toBe(0);
    expect(card.out).toEqual(['src/define/fixture/POLICY.md: unchanged', '../../apps/clinic/POLICY.md: unchanged']);
  });

  it('with no folder, writes again each card the workspace has', async () => {
    const run = io(ROOT);
    expect(await main(['policy:card'], run.io)).toBe(0);
    expect(run.out).toEqual(FOLDERS.map((d) => `${d}/POLICY.md: unchanged`));
  });

  it('refuses an option, and says which folder it cannot use', async () => {
    const bad = io(PACKAGE);
    expect(await main(['policy:card', '--update'], bad.io)).toBe(2);
    expect(bad.err[0]).toContain('--update is not an option');
    const none = io(PACKAGE);
    expect(await main(['policy:card', 'src/define/__fixtures__/valid'], none.io)).toBe(1);
    expect(none.err[0]).toMatch(/no module \(.*\) exports an App$/);
  });
});
