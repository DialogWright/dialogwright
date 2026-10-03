import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { workspaceCopy, type WorkspaceCopy } from './__fixtures__/workspaceCopy';
import { libraryApp, LIBRARY_DIR } from './fixture/app';
import { main } from './cli';
import { workspaceRootOf } from './matrixCommand';
import { findPageFolders, loadFolderApp } from './pageCommand';

/**
 * `dialogwright policy:card` and `dialogwright app:diagram`: find each app's folder and its App,
 * and write the page only when it changed. Run here on a scratch copy of the folders whose pages are
 * committed (./__fixtures__/workspaceCopy.ts), each finds every one unchanged (a page that changed
 * would be a golden test failing first). The commands write only the copy: no test writes a
 * committed page.
 */

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = workspaceRootOf(PACKAGE);

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), cwd }, out, err };
}

const FOLDERS = ['apps/clinic', 'packages/dialogwright/src/define/fixture', 'packages/dialogwright/src/testing/testkit'];

const copies: WorkspaceCopy[] = [];
afterEach(() => {
  for (const copy of copies.splice(0)) copy.remove();
});

/** A scratch copy of the folders with pages, and its packages/dialogwright (where PACKAGE is in the workspace). */
function scratch(): { root: string; pkg: string } {
  const copy = workspaceCopy(ROOT, FOLDERS);
  copies.push(copy);
  return { root: copy.root, pkg: join(copy.root, 'packages', 'dialogwright') };
}

describe('dialogwright policy:card and app:diagram', () => {
  it('finds every folder with a page, and the App a folder exports', async () => {
    expect(findPageFolders(ROOT, 'POLICY.md').map((d) => relative(ROOT, d))).toEqual(FOLDERS);
    expect(findPageFolders(ROOT, 'APP-MAP.md').map((d) => relative(ROOT, d))).toEqual(FOLDERS);
    expect(await loadFolderApp(LIBRARY_DIR)).toBe(libraryApp);
  });

  it('writes nothing when every page is what the app generates', async () => {
    const { pkg } = scratch();
    const card = io(pkg);
    expect(await main(['policy:card', 'src/define/fixture', 'apps/clinic'], card.io)).toBe(0);
    expect(card.out).toEqual(['src/define/fixture/POLICY.md: unchanged', '../../apps/clinic/POLICY.md: unchanged']);
    const map = io(pkg);
    expect(await main(['app:diagram', 'src/define/fixture', 'apps/clinic'], map.io)).toBe(0);
    expect(map.out).toEqual(['src/define/fixture/APP-MAP.md: unchanged', '../../apps/clinic/APP-MAP.md: unchanged']);
  });

  it('with no folder, writes again each page the workspace has', async () => {
    const { root } = scratch();
    const run = io(root);
    expect(await main(['policy:card'], run.io)).toBe(0);
    expect(run.out).toEqual(FOLDERS.map((d) => `${d}/POLICY.md: unchanged`));
  });

  it('writes a page that changed, in the folder it was run on', async () => {
    const { root } = scratch();
    for (const file of ['POLICY.md', 'APP-MAP.md']) writeFileSync(join(root, 'apps/clinic', file), 'stale\n');
    const card = io(root);
    expect(await main(['policy:card', 'apps/clinic'], card.io)).toBe(0);
    expect(card.out).toEqual([expect.stringMatching(/^wrote apps\/clinic\/POLICY\.md \(\d+ lines\): review the diff before you commit it$/)]);
    const map = io(root);
    expect(await main(['app:diagram'], map.io)).toBe(0);
    expect(map.out).toEqual(FOLDERS.map((d) => (d === 'apps/clinic' ? expect.stringMatching(/^wrote apps\/clinic\/APP-MAP\.md/) : `${d}/APP-MAP.md: unchanged`)));
    for (const file of ['POLICY.md', 'APP-MAP.md']) expect(readFileSync(join(root, 'apps/clinic', file), 'utf8')).toBe(readFileSync(join(ROOT, 'apps/clinic', file), 'utf8'));
  });

  it('refuses an option, and says which folder it cannot use', async () => {
    const bad = io(PACKAGE);
    expect(await main(['policy:card', '--update'], bad.io)).toBe(2);
    expect(bad.err[0]).toContain('--update is not an option');
    const none = io(PACKAGE);
    expect(await main(['app:diagram', 'src/define/__fixtures__/valid'], none.io)).toBe(1);
    expect(none.err[0]).toMatch(/no module \(.*\) exports an App$/);
  });
});
