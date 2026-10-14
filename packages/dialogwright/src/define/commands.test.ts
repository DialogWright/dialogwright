import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { COMMANDS, helpText, main } from './cli';
import { DOCTOR_USAGE } from '../server/doctor';
import { START_USAGE } from '../server/start';
import { SERVICE_USAGE } from '../server/serviceFile';
import { LINK_USAGE } from '../server/console/linkCli';
import { REGRESS_USAGE } from '../harness-text/regressCommand';
import { SHORT_TMP, withShortTmp } from '../testing/shortTmp';

/**
 * One command line (Phase 10a): every command an app's author runs is a subcommand of `dialogwright`,
 * and the repository's root scripts run that same entry, so a project of its own (`npx dialogwright
 * <command>`) and this repository (`pnpm <command>`) run one implementation.
 */

const PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const scripts = (dir: string): Record<string, string> => (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
const names = new Set(COMMANDS.map(([name]) => name));
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), cwd: PACKAGE_DIR }, out, err };
}

/** What console.log printed while `run` ran (the commands that run an app print through it). */
async function logged(run: () => Promise<number>): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
  const code = await run();
  return { code, lines };
}

describe('dialogwright: one command line', () => {
  it('lists every command with help, and the root scripts and the package scripts run the one entry with a command it has', async () => {
    const { io: cli, out } = io();
    expect(await main(['help'], cli)).toBe(0);
    expect(out).toEqual([helpText()]);
    for (const name of names) expect(helpText(), name).toMatch(new RegExp(`^  ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`, 'm'));
    const viaEntry = (line: string): string | null => /src\/define\/cli\.ts (\S+)/.exec(line)?.[1] ?? null;
    const rootCommands = Object.values(scripts(ROOT)).map(viaEntry).filter((c): c is string => c !== null);
    const packageCommands = Object.values(scripts(PACKAGE_DIR)).map(viaEntry).filter((c): c is string => c !== null);
    expect(rootCommands.sort()).toEqual(['audit:verify', 'configure', 'console:link', 'diagnose', 'fallback', 'render:bakeoff', 'serve', 'service', 'start']);
    for (const command of [...rootCommands, ...packageCommands]) expect(names, command).toContain(command);
    // The root's other engine scripts go through the package's, which run the entry.
    for (const [script, line] of Object.entries(scripts(ROOT))) {
      if (line.startsWith('pnpm --filter dialogwright ')) expect(viaEntry(scripts(PACKAGE_DIR)[script] ?? ''), script).toBe(script);
    }
  });

  it('hands the commands that run an app to their own modules, each answering a command line it does not understand with its usage', async () => {
    for (const [command, usage] of [['diagnose', DOCTOR_USAGE], ['start', START_USAGE], ['service', SERVICE_USAGE], ['console:link', LINK_USAGE]] as const) {
      const r = await logged(() => main([command, '--bogus'], io().io));
      expect(r.code, command).toBe(2);
      expect(r.lines, command).toEqual([usage]);
    }
    const fallback = await logged(() => main(['fallback', '--bogus'], io().io));
    expect(fallback.code).toBe(2);
    const dir = mkdtempSync(join(SHORT_TMP, 'dialogwright-verify-'));
    scratch.push(dir);
    const verify = await logged(() => main(['audit:verify', join(dir, 'none')], io().io));
    expect(verify).toEqual({ code: 0, lines: [`no audit files in ${join(dir, 'none')}`] });
  });

  it('regress: refuses a folder with no app.yaml, and with no folder one it is not in', async () => {
    const dir = mkdtempSync(join(SHORT_TMP, 'dialogwright-regress-'));
    scratch.push(dir);
    const named = io();
    expect(await main(['regress', dir], named.io)).toBe(2);
    expect(named.err[0]).toContain('is not an app folder');
    expect(named.err[0]).toContain(REGRESS_USAGE);
    const here = io();
    expect(await main(['regress', '--client', 'stub'], { ...here.io, invokedFrom: dir })).toBe(2);
    expect(here.err[0]).toContain('is not in an app folder');
  });

  it('regress: runs an app folder\'s regression as the folder\'s own launcher does, from the folder or inside it', async () => {
    // A scaffolded app, linked to this package as an install would (createApp.e2e.test.ts does the same).
    const base = mkdtempSync(join(SHORT_TMP, 'dialogwright-regress-app-'));
    scratch.push(base);
    const app = join(base, 'regress-demo');
    expect(await main(['create-app', 'regress-demo', '--dir', app, '--no-install'], { ...io().io, cwd: base })).toBe(0);
    mkdirSync(join(app, 'node_modules'));
    symlinkSync(PACKAGE_DIR, join(app, 'node_modules', 'dialogwright'));
    const scenario = ['--scenario', 'book-happy'];
    const env = withShortTmp();
    const launcher = spawnSync(join(PACKAGE_DIR, 'node_modules', '.bin', 'tsx'), ['src/regress.ts', ...scenario], { encoding: 'utf8', env, cwd: app });
    expect(launcher.status, launcher.stderr).toBe(0);
    expect(launcher.stdout).toContain('book-happy');
    const bin = join(PACKAGE_DIR, 'bin', 'dialogwright.mjs');
    const named = spawnSync(process.execPath, [bin, 'regress', app, ...scenario], { encoding: 'utf8', env, cwd: PACKAGE_DIR });
    expect({ status: named.status, stdout: named.stdout }).toEqual({ status: 0, stdout: launcher.stdout });
    const inside = join(app, 'src');
    const found = spawnSync(process.execPath, [bin, 'regress', ...scenario], { encoding: 'utf8', env: { ...env, INIT_CWD: inside }, cwd: inside });
    expect({ status: found.status, stdout: found.stdout }).toEqual({ status: 0, stdout: launcher.stdout });
    // A bare check inside the app's folder (outside any workspace) checks that app, as regress finds it.
    const checked = io();
    expect(await main(['check'], { ...checked.io, cwd: inside })).toBe(0);
    expect(checked.out).toEqual(['..: ok']);
  }, 60_000);
});

describe('a project of its own: its folder is its app', () => {
  it('the project is found from where the command runs, and start runs its serve script with npm', async () => {
    const { commandHints, projectRoot, runCommand, serveCommand, workspaceApps } = await import('../server/workspace');
    const { renderService } = await import('../server/serviceFile');
    const root = mkdtempSync(join(SHORT_TMP, 'dialogwright-project-'));
    scratch.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'my-line', scripts: { serve: 'tsx src/serve.ts' } }));
    writeFileSync(join(root, 'app.yaml'), 'id: my-line\n');
    mkdirSync(join(root, 'src'));
    expect(projectRoot(join(root, 'src'), false)).toBe(root);
    // Run from this repository, the engine finds the repository's apps, as before.
    expect(projectRoot(join(root, 'src'), true)).not.toBe(root);
    const apps = workspaceApps(root);
    expect(apps).toEqual([{ name: 'my-line', dir: root, folder: '.' }]);
    expect(serveCommand(apps[0]!, root)).toEqual({ command: 'npm', args: ['run', '--silent', 'serve'], cwd: root });
    // The hints a command prints name the commands as the project runs them.
    expect([commandHints(apps[0]!, root).command('start'), commandHints(apps[0]!, root).script('cli')]).toEqual(['npx dialogwright start', 'npm run cli --']);
    expect(runCommand(root)).toBe('npx dialogwright');
    const service = renderService({ kind: 'systemd', label: 'l', app: 'my-line', root, envFile: '/e', pnpm: '/bin/pnpm', path: '/bin', logDir: '/l', stopSeconds: 40, project: true });
    expect(service.split('\n')[0]).toBe('# Written by npx dialogwright service: the DialogWright app my-line, run from its project with its settings file.');
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
    expect(serveCommand(apps[0]!, root)).toEqual({ command: 'pnpm', args: ['--filter', 'my-line', 'serve'], cwd: root });
    expect(runCommand(root)).toBe('pnpm');
    expect([commandHints(apps[0]!, root).command('start'), commandHints(apps[0]!, root).script('cli')]).toEqual([`pnpm start --app ${basename(root)}`, 'pnpm --filter my-line cli']);
  });

  it('a project inside an unrelated pnpm workspace is still its own app; one of the workspace\'s packages is the workspace\'s', async () => {
    const { projectRoot } = await import('../server/workspace');
    const outer = mkdtempSync(join(SHORT_TMP, 'dialogwright-outer-'));
    scratch.push(outer);
    writeFileSync(join(outer, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
    for (const dir of [join(outer, 'elsewhere', 'my-line'), join(outer, 'apps', 'member')]) {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { serve: 'tsx src/serve.ts' } }));
      writeFileSync(join(dir, 'app.yaml'), 'id: x\n');
    }
    expect(projectRoot(join(outer, 'elsewhere', 'my-line', 'src'), false)).toBe(join(outer, 'elsewhere', 'my-line'));
    expect(projectRoot(join(outer, 'apps', 'member', 'src'), false)).toBe(outer);
    expect(projectRoot(join(outer, 'elsewhere'), false)).toBe(outer);
  });
});
