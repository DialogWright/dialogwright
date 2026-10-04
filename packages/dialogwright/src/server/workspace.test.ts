import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseApp, findApp, WORKSPACE_ROOT, workspaceApps } from './workspace';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A workspace in a temp folder: `apps/<name>` for each app, and a package that is not an app. */
function workspace(names: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'workspace-'));
  dirs.push(root);
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n  - "apps/*"\n');
  for (const n of names) {
    mkdirSync(join(root, 'apps', n), { recursive: true });
    writeFileSync(join(root, 'apps', n, 'package.json'), JSON.stringify({ name: `@example/${n}`, scripts: { serve: 'tsx src/serve.ts' } }));
    writeFileSync(join(root, 'apps', n, 'app.yaml'), `id: ${n}\n`);
  }
  mkdirSync(join(root, 'packages', 'engine'), { recursive: true });
  writeFileSync(join(root, 'packages', 'engine', 'package.json'), JSON.stringify({ name: 'engine', scripts: {} }));
  return root;
}

describe('the workspace apps', () => {
  it("are this repository's example apps", () => {
    expect(workspaceApps(WORKSPACE_ROOT).map((a) => a.folder)).toEqual(expect.arrayContaining(['apps/clinic', 'apps/utility']));
    expect(workspaceApps(WORKSPACE_ROOT).find((a) => a.folder === 'apps/clinic')?.name).toBe('@dialogwright/example-clinic');
  });

  it('are found by package name, folder name, folder from the root, or a path', () => {
    const root = workspace(['alpha', 'beta']);
    const apps = workspaceApps(root);
    expect(apps.map((a) => a.name)).toEqual(['@example/alpha', '@example/beta']);
    for (const filter of ['@example/beta', 'beta', 'apps/beta', 'apps/beta/', join(root, 'apps/beta')]) expect(findApp(apps, filter, root)?.name, filter).toBe('@example/beta');
    expect(findApp(apps, './beta', join(root, 'apps'))?.name).toBe('@example/beta');
    expect(findApp(apps, 'gamma', root)).toBeNull();
  });

  it('choose the one named, the only one, the one the command ran in, or the only one with a .env', () => {
    const root = workspace(['alpha', 'beta']);
    const apps = workspaceApps(root);
    expect(chooseApp(apps, 'beta', root, 'start')).toEqual({ app: apps[1] });
    expect(chooseApp(apps, 'gamma', root, 'start')).toEqual({ error: 'no app "gamma" in this workspace (apps: alpha, beta)' });
    expect(chooseApp(apps, undefined, root, 'start')).toEqual({ error: 'which app? pnpm start --app <name> (apps: alpha, beta)' });
    expect(chooseApp(apps, undefined, join(root, 'apps', 'alpha', 'src'), 'start')).toEqual({ app: apps[0] });
    writeFileSync(join(root, 'apps', 'beta', '.env'), 'PORT=3000\n');
    expect(chooseApp(apps, undefined, root, 'start')).toEqual({ app: apps[1] });
    expect(chooseApp(apps.slice(0, 1), undefined, root, 'start')).toEqual({ app: apps[0] });
    expect(chooseApp([], undefined, root, 'start')).toEqual({ error: 'no app in this workspace yet: make one with pnpm create-app <name>' });
  });
});
