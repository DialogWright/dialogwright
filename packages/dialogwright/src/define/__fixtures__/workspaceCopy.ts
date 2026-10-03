import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { MATRIX_APP_MODULES } from '../matrixCommand';

/**
 * A scratch copy of the workspace, for the tests of the commands that write a file beside an app's
 * policy.yaml (policy:matrix, policy:card, app:diagram). A command run on the real folders writes
 * every page that changed, so a test run on them could rewrite a committed golden. Run on this copy
 * instead, it writes only the copy: no test writes a committed file.
 *
 * The copy has the workspace's pnpm-workspace.yaml and, for each folder named (relative to the
 * workspace's root), the folder's own files (its YAML, its pages, its policy.matrix; not its code or
 * its JSON, not its subfolders) and, where the folder's module is, one that re-exports it. The App
 * the command loads is the real one; the files it reads and writes are the copies.
 */
export interface WorkspaceCopy {
  /** The copy's root, with pnpm-workspace.yaml. */
  readonly root: string;
  /** Deletes the copy. */
  remove(): void;
}

/** The files not copied: code, and its package.json and tsconfig.json (whose `extends` would not resolve from the copy). */
const CODE = /\.(m?[jt]s|json)$/;

export function workspaceCopy(workspaceRoot: string, folders: readonly string[]): WorkspaceCopy {
  const root = mkdtempSync(join(tmpdir(), 'dialogwright-workspace-'));
  copyFileSync(join(workspaceRoot, 'pnpm-workspace.yaml'), join(root, 'pnpm-workspace.yaml'));
  for (const folder of folders) {
    const from = resolve(workspaceRoot, folder);
    const to = join(root, folder);
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.isFile() && !CODE.test(entry.name)) copyFileSync(join(from, entry.name), join(to, entry.name));
    }
    const module = MATRIX_APP_MODULES.find((path) => existsSync(join(from, path)));
    if (module === undefined) throw new Error(`${from}: no module (${MATRIX_APP_MODULES.join(', ')}) exports an App`);
    mkdirSync(dirname(join(to, module)), { recursive: true });
    writeFileSync(join(to, module), `export * from ${JSON.stringify(join(from, module))};\n`);
  }
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}
