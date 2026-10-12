import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostFileOf, resolveHostFile } from './host';
import { formatProblem } from './problems';

const FIXTURE = fileURLToPath(new URL('../testing/host/host.yaml', import.meta.url));
const TESTING = realpathSync(fileURLToPath(new URL('../testing', import.meta.url)));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A folder with a host.yaml and two tiny app folders (app.yaml with an id is all the reading needs). */
function project(host: string, apps: Record<string, string> = { one: 'one', two: 'two' }): string {
  const dir = mkdtempSync(join(tmpdir(), 'host-'));
  dirs.push(dir);
  for (const [folder, id] of Object.entries(apps)) {
    mkdirSync(join(dir, 'apps', folder), { recursive: true });
    writeFileSync(join(dir, 'apps', folder, 'app.yaml'), `id: ${id}\n`);
  }
  writeFileSync(join(dir, 'host.yaml'), host);
  return dir;
}

const problemsOf = (dir: string): string[] => resolveHostFile(join(dir, 'host.yaml')).problems.map(formatProblem);

describe('resolveHostFile', () => {
  it('reads the fixture: its two apps by folder, their own settings files, the numbers and the default', () => {
    const { host, problems } = resolveHostFile(FIXTURE);
    expect(problems).toEqual([]);
    expect(host!.apps.map((a) => [a.label, a.id, a.dir, a.envFile, a.envNamed])).toEqual([
      ['../callback', 'callback', join(TESTING, 'callback'), join(TESTING, 'host', 'callback.env'), true],
      ['../routed', 'routed', join(TESTING, 'routed'), join(TESTING, 'host', 'routed.env'), true],
    ]);
    expect(host!.numbers).toEqual([
      { variable: 'CALLBACK_LINE', app: 'callback' },
      { variable: 'SERVICE_LINE', app: 'routed' },
      { variable: 'SERVICE_LINE_ES', app: 'routed' },
    ]);
    expect(host!.defaultApp).toBe('callback');
  });

  it('takes the first app as the default when the file names none, and an app\'s own .env as its settings file', () => {
    const dir = project('apps: [apps/one, apps/two]\n');
    const { host } = resolveHostFile(join(dir, 'host.yaml'));
    expect(host!.defaultApp).toBe('one');
    expect(host!.apps[0]!.envFile).toBe(join(realpathSync(dir), 'apps', 'one', '.env'));
    expect(host!.apps[0]!.envNamed).toBe(false);
  });

  it('finds an app installed as a package in node_modules', () => {
    const dir = project('apps: [{ package: "@acme/repairs-line" }]\n', {});
    const pkg = join(dir, 'node_modules', '@acme', 'repairs-line');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), '{"name":"@acme/repairs-line"}');
    writeFileSync(join(pkg, 'app.yaml'), 'id: repairs\n');
    const { host, problems } = resolveHostFile(join(dir, 'host.yaml'));
    expect(problems).toEqual([]);
    expect(host!.apps[0]).toMatchObject({ label: '@acme/repairs-line', id: 'repairs', dir: realpathSync(pkg) });
  });

  it('says what is wrong, at its line, with the fix: a folder missing, an app listed twice, an unknown app id, a number listed twice, a default that is no app', () => {
    const dir = project([
      'apps:',
      '  - apps/one',
      '  - apps/missing',
      '  - { folder: apps/again }',
      'numbers:',
      '  - { number: env.ONE_LINE, app: one }',
      '  - { number: env.ONE_LINE, app: one }',
      '  - { number: env.OTHER_LINE, app: nobody }',
      'default: elsewhere',
      '',
    ].join('\n'), { one: 'one', again: 'one' });
    expect(problemsOf(dir)).toEqual([
      expect.stringMatching(/^.*host\.yaml:3:5  apps\[1\]  the app folder apps\/missing does not exist .*->  write the path of the app's folder/),
      expect.stringMatching(/host\.yaml:4:15  apps\[2\]\.folder  apps\/again is the app "one", which apps\/one is too  ->  list each app once/),
      expect.stringMatching(/host\.yaml:7:15  numbers\[1\]\.number  env\.ONE_LINE is listed twice \(numbers\[0\] lists it too\)  ->  list each number once/),
      expect.stringMatching(/host\.yaml:8:36  numbers\[2\]\.app  "nobody" is not an app this file lists \(apps: one\)  ->  write the id of one of the apps/),
      expect.stringMatching(/host\.yaml:9:10  default  "elsewhere" is not an app this file lists \(apps: one\)/),
    ]);
  });

  it('holds the file to its schema: a number written in YAML, an absolute folder, no apps', () => {
    expect(problemsOf(project('apps: []\n'))).toEqual([expect.stringMatching(/apps  .*lists no app/)]);
    expect(problemsOf(project('apps: [/srv/apps/one]\n'))).toEqual([expect.stringMatching(/apps\[0\]  .*absolute path/)]);
    expect(problemsOf(project('apps: [apps/one]\nnumbers:\n  - { number: "+15555550100", app: one }\n'))).toEqual([expect.stringMatching(/numbers\[0\]\.number  .*is not an environment variable/)]);
  });

  it('says a named settings file that is not there', () => {
    expect(problemsOf(project('apps: [{ folder: apps/one, env: one.env }]\n'))).toEqual([expect.stringMatching(/apps\[0\]\.env  the settings file one\.env does not exist/)]);
  });
});

describe('hostFileOf', () => {
  it('is --host, else HOST_FILE, else host.yaml beside the apps, else none', () => {
    const dir = project('apps: [apps/one]\n');
    expect(hostFileOf('h.yaml', {}, '/work', dir)).toBe('/work/h.yaml');
    expect(hostFileOf(undefined, { HOST_FILE: 'deploy/host.yaml' }, '/work', dir)).toBe('/work/deploy/host.yaml');
    expect(hostFileOf(undefined, {}, '/work', dir)).toBe(join(dir, 'host.yaml'));
    expect(hostFileOf(undefined, {}, '/work', join(dir, 'apps'))).toBeNull();
  });
});
