import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { USAGE, main, type Io } from './cli';
import { contentHash } from '../core/app/configHash';
import { REPO_ROOT, createApp, displayNameOf, markOf, nameProblem, render, templateFiles } from './createApp';

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-create-app-'));
  scratch.push(dir);
  return dir;
}

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), base) : [relative(base, join(dir, e.name))]));
}

const PLAIN_FILES = [
  '.env.example', 'APP-MAP.md', 'CLAUDE.md', 'POLICY.md', 'README.md', 'app.yaml', 'fixtures/corpus.jsonl', 'fixtures/expected/corpus.json',
  'fixtures/expected/scenarios.json', 'fixtures/scenarios/core.json', 'forms.yaml', 'intents.yaml', 'package.json',
  'policy.matrix', 'policy.yaml', 'prompts.yaml', 'slots.yaml', 'src/app.test.ts', 'src/app.ts', 'src/cli.ts', 'src/data.ts',
  'src/fixtures.test.ts', 'src/index.ts', 'src/regress.ts', 'src/serve.ts', 'src/testing/setup.ts', 'tsconfig.json', 'vitest.config.ts',
];

describe('the app name', () => {
  it('accepts lowercase letters, digits and single hyphens, starting with a letter', () => {
    for (const name of ['demo', 'water-utility', 'app2', 'a', 'a1-b2-c3']) expect(nameProblem(name), name).toBeNull();
  });

  it('refuses everything else, saying what is allowed', () => {
    for (const name of ['', 'Demo', 'water_utility', '2fast', '-demo', 'demo-', 'a--b', 'my app', '../escape', 'demo/x', 'x'.repeat(41)]) {
      expect(nameProblem(name), name).not.toBeNull();
    }
    expect(nameProblem('Demo')).toContain('lowercase letters, digits and single hyphens');
    expect(nameProblem('')).toContain('give the app a name');
  });

  it('makes the display name and the brand mark from it', () => {
    expect(displayNameOf('water-utility')).toBe('Water Utility');
    expect(displayNameOf('demo')).toBe('Demo');
    expect(markOf('Water Utility')).toBe('WU');
    expect(markOf('Demo')).toBe('DE');
    expect(markOf('Example Power & Light')).toBe('EP');
  });
});

describe('render', () => {
  const values = { name: 'demo', display: 'Demo', mark: 'DE', root: '../..' };

  it('puts the name in, and keeps the single braces the prompts use', () => {
    expect(render('id: {{name}} ({{display}}, {{mark}}) {{root}}/x {intentLabel}', values, false)).toBe('id: demo (Demo, DE) ../../x {intentLabel}');
  });

  it('keeps identity blocks only with identity, and the others only without it', () => {
    const text = 'a\n{{#identity}}\nwith\n{{/identity}}\n{{^identity}}\nwithout\n{{/identity}}\nb {{#identity}}x{{/identity}}{{^identity}}y{{/identity}}\n';
    expect(render(text, values, true)).toBe('a\nwith\nb x\n');
    expect(render(text, values, false)).toBe('a\nwithout\nb y\n');
  });

  it('refuses a token it does not know, so a template typo is not written out', () => {
    expect(() => render('id: {{nmae}}', values, false)).toThrow('{{nmae}}');
  });
});

describe('createApp', () => {
  it('writes the template, with the name put in and nothing left over', () => {
    const dir = join(temp(), 'demo');
    const made = createApp({ name: 'demo', dir });
    expect(made.files.slice().sort()).toEqual(PLAIN_FILES);
    expect(walk(dir).sort()).toEqual(PLAIN_FILES);
    expect(made.packageName).toBe('@dialogwright/example-demo');
    expect(made.inWorkspace).toBe(false);
    for (const file of made.files) expect(readFileSync(join(dir, file), 'utf8'), file).not.toMatch(/\{\{[^}]*\}\}/);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; scripts: Record<string, string> };
    expect(pkg.name).toBe('@dialogwright/example-demo');
    expect(Object.keys(pkg.scripts)).toEqual(['typecheck', 'test', 'regress', 'cli', 'serve']);
    expect(parse(readFileSync(join(dir, 'app.yaml'), 'utf8'))).toMatchObject({
      id: 'demo', locale: 'en-US', brand: { name: 'Demo', mark: 'DE', key: 'demo' }, fixtures: { dir: 'fixtures' },
    });
    expect(existsSync(join(dir, 'identity.yaml'))).toBe(false);
  });

  it('adds identity.yaml, the two factor slots and a level 1 booking with --identity, and changes nothing else about the layout', () => {
    const dir = join(temp(), 'demo');
    const made = createApp({ name: 'demo', dir, identity: true });
    expect(made.files.slice().sort()).toEqual([...PLAIN_FILES, 'identity.yaml'].sort());
    const identity = parse(readFileSync(join(dir, 'identity.yaml'), 'utf8')) as { levels: Record<string, { factors: string[]; verify: string }> };
    expect(identity.levels['1']).toMatchObject({ factors: ['accountId', 'dob'], verify: 'verifyCustomer' });
    const slots = parse(readFileSync(join(dir, 'slots.yaml'), 'utf8')) as Record<string, { type: string }>;
    expect(Object.keys(slots)).toEqual(['service', 'accountId', 'dob']);
    const policy = parse(readFileSync(join(dir, 'policy.yaml'), 'utf8')) as { actions: Record<string, { level: number }> };
    expect(policy.actions.verifyCustomer!.level).toBe(0);
    expect(policy.actions.bookService!.level).toBe(1);
    // the append: the base's prompts, then the identity lines
    const prompts = parse(readFileSync(join(dir, 'prompts.yaml'), 'utf8')) as { prompts: Record<string, unknown> };
    expect(Object.keys(prompts.prompts)).toEqual(expect.arrayContaining(['greeting', 'service_booked', 'ask_accountId', 'ask_dob', 'identity_failed', 'handoff_identity']));
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain('`policy.yaml` and `identity.yaml` belong to compliance');
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toContain('identity.yaml   how a caller proves who they are');
  });

  it('leaves identity out of the prose when the app has none', () => {
    const dir = join(temp(), 'demo');
    createApp({ name: 'demo', dir });
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).not.toContain('identity.yaml');
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).not.toContain('identity.yaml');
  });

  it('points every schema line at a schema that exists, and the tsconfig at the repository\'s base', () => {
    const dir = join(temp(), 'deep', 'er', 'demo');
    createApp({ name: 'demo', dir, identity: true });
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
      const first = readFileSync(join(dir, file), 'utf8').split('\n')[0]!;
      const match = /^# yaml-language-server: \$schema=(.+)$/.exec(first);
      expect(match, `${file} starts with the schema line`).not.toBeNull();
      expect(existsSync(resolve(dir, match![1]!)), `${file}: ${match![1]}`).toBe(true);
    }
    const tsconfig = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8')) as { extends: string };
    expect(existsSync(resolve(dir, tsconfig.extends))).toBe(true);
    // Compared as real paths: under a symlinked folder (macOS's /tmp is /private/tmp) the same file has two spellings.
    expect(realpathSync(resolve(dir, tsconfig.extends))).toBe(realpathSync(join(REPO_ROOT, 'tsconfig.base.json')));
  });

  it('uses --display for the greeting and the console, and finds the workspace folder under apps/', () => {
    const root = temp();
    mkdirSync(join(root, 'apps'));
    const made = createApp({ name: 'water-utility', display: 'Example Water', root });
    expect(made.dir).toBe(join(root, 'apps', 'water-utility'));
    expect(made.inWorkspace).toBe(true);
    expect(readFileSync(join(made.dir, 'prompts.yaml'), 'utf8')).toContain('Thanks for calling Example Water.');
    expect(readFileSync(join(made.dir, 'app.yaml'), 'utf8')).toContain('mark: EW');
    expect(JSON.parse(readFileSync(join(made.dir, 'tsconfig.json'), 'utf8'))).toEqual({ extends: '../../tsconfig.base.json', include: ['src/**/*.ts', 'vitest.config.ts'] });
  });

  it('refuses a bad name, a bad display name, and an existing folder, writing nothing', () => {
    const base = temp();
    expect(() => createApp({ name: 'Bad Name', dir: join(base, 'x') })).toThrow('not a valid app name');
    expect(existsSync(join(base, 'x'))).toBe(false);
    expect(() => createApp({ name: 'demo', dir: join(base, 'y'), display: 'a {{name}} b' })).toThrow('braces');
    const existing = join(base, 'taken');
    mkdirSync(existing);
    writeFileSync(join(existing, 'keep.txt'), 'mine');
    expect(() => createApp({ name: 'demo', dir: existing })).toThrow('already exists');
    expect(readdirSync(existing)).toEqual(['keep.txt']);
  });

  it('ships the policy read back for any name: the pages need only the name and display put in', () => {
    // The card embeds policy.yaml's and identity.yaml's hashes, which are of the parsed content: the
    // name, the display and the folder appear only in comments there, so every scaffold of a variant
    // has the hashes the shipped card has. The end-to-end test runs the three commands on a fresh one.
    const hashes = (identity: boolean, values: Record<string, string>): string[] => {
      const files = templateFiles(identity);
      return ['policy.yaml', 'identity.yaml'].filter((f) => files.has(f)).map((f) => contentHash(parse(render(files.get(f)!, values, identity))));
    };
    for (const identity of [false, true]) {
      const card = render(templateFiles(identity).get('POLICY.md')!, { name: 'a', display: 'A', mark: 'AA', root: '..' }, identity);
      const one = hashes(identity, { name: 'demo', display: 'Demo', mark: 'DE', root: '../..' });
      expect(hashes(identity, { name: 'water-utility', display: 'Example Water & Light', mark: 'EW', root: '../../../x/y' })).toEqual(one);
      for (const hash of one) expect(card, `identity ${identity}`).toContain(`\`${hash}\``);
      for (const page of ['policy.matrix', 'POLICY.md', 'APP-MAP.md']) {
        expect(render(templateFiles(identity).get(page)!, { name: 'n', display: 'D', mark: 'DD', root: '.' }, identity).match(/\{\{|\}\}/g), page).toBeNull();
      }
    }
  });

  it('has an .env.example with names only, and no value', () => {
    const dir = join(temp(), 'demo');
    createApp({ name: 'demo', dir });
    const lines = readFileSync(join(dir, '.env.example'), 'utf8').split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line, line).toMatch(/^[A-Z_]+=$/);
  });

  it('keeps the template free of the one name and of em dashes', () => {
    // The one name the repository never carries, written in pieces so that this file keeps to the rule it checks.
    const words = ['gene' + 'sys'];
    const banned = new RegExp(`\\b(${words.join('|')})\\b`, 'i');
    for (const identity of [false, true]) {
      for (const [file, text] of templateFiles(identity)) {
        expect(text, file).not.toMatch(banned);
        expect(text, file).not.toContain('—');
      }
    }
  });
});

describe('dialogwright create-app', () => {
  it('writes the app and prints the next steps', async () => {
    const base = temp();
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(['create-app', 'demo', '--dir', 'my/demo', '--identity', '--no-install'], { out: (l) => out.push(l), err: (l) => err.push(l), cwd: base });
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(existsSync(join(base, 'my', 'demo', 'identity.yaml'))).toBe(true);
    expect(out[0]).toBe('created my/demo: 29 files, with identity.yaml, for "Demo"');
    const text = out.join('\n');
    expect(text).toContain('Next:');
    expect(text).toContain('not directly under apps/');
    // A bare pnpm check reads only apps/, so the folder is named, by its absolute path.
    expect(text).toContain(`2. pnpm check ${join(base, 'my', 'demo')}    (this folder`);
    expect(text).toContain(`running pnpm check ${join(base, 'my', 'demo')} after each change`);
    expect(text).toContain('pnpm --filter @dialogwright/example-demo test');
    expect(text).toContain('pnpm --filter @dialogwright/example-demo typecheck');
    expect(text).toContain('pnpm --filter @dialogwright/example-demo regress');
    expect(text).toContain('first baseline');
  });

  it('resolves a relative --dir from where pnpm was run (INIT_CWD), not from the package', async () => {
    const base = temp();
    const code = await main(['create-app', 'demo', '--dir', 'here', '--no-install'], { out: () => {}, err: () => {}, cwd: REPO_ROOT, invokedFrom: base });
    expect(code).toBe(0);
    expect(existsSync(join(base, 'here', 'app.yaml'))).toBe(true);
  });

  it('exits 1 for a name it refuses or a folder that exists, and writes nothing over it', async () => {
    const base = temp();
    const err: string[] = [];
    const io = { out: () => {}, err: (l: string) => err.push(l), cwd: base };
    expect(await main(['create-app', 'Bad_Name', '--dir', 'x', '--no-install'], io)).toBe(1);
    expect(err[0]).toContain('not a valid app name');
    mkdirSync(join(base, 'taken'));
    err.length = 0;
    expect(await main(['create-app', 'demo', '--dir', 'taken', '--no-install'], io)).toBe(1);
    expect(err[0]).toContain('already exists');
    expect(readdirSync(join(base, 'taken'))).toEqual([]);
  });

  it('exits 2 for a command line it does not understand, with the usage', async () => {
    const err: string[] = [];
    const io = { out: () => {}, err: (l: string) => err.push(l), cwd: temp() };
    for (const args of [[], ['a', 'b'], ['a', '--bogus'], ['a', '--dir'], ['a', '--display']]) {
      err.length = 0;
      expect(await main(['create-app', ...args], io), args.join(' ')).toBe(2);
      expect(err[0]).toContain(USAGE);
    }
  });

  it('runs pnpm install when the app is under apps/ of the workspace, and says so when it fails', async () => {
    const root = temp();
    mkdirSync(join(root, 'apps'));
    const installed: string[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(['create-app', 'demo'], { out: (l) => out.push(l), err: (l) => err.push(l), cwd: root, root, install: (at) => { installed.push(at); return 1; } });
    expect(code).toBe(0);
    expect(existsSync(join(root, 'apps', 'demo', 'app.yaml'))).toBe(true);
    expect(installed).toEqual([root]);
    expect(err[0]).toContain('pnpm install failed');
    expect(out.join('\n')).toContain('1. pnpm install');
    expect(out[0]).toBe('created apps/demo: 28 files, without identity.yaml, for "Demo"');
  });

  it('does not run pnpm install with --no-install, and skips the step when it worked', async () => {
    const root = temp();
    mkdirSync(join(root, 'apps'));
    const installed: string[] = [];
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: () => {}, cwd: root, root, install: (at: string) => { installed.push(at); return 0; } };
    expect(await main(['create-app', 'one', '--no-install'], io)).toBe(0);
    expect(installed).toEqual([]);
    expect(out.join('\n')).toContain('1. pnpm install');
    out.length = 0;
    expect(await main(['create-app', 'two'], io)).toBe(0);
    expect(installed).toEqual([root]);
    expect(out.join('\n')).not.toContain('1. pnpm install');
    expect(out.join('\n')).toContain('1. pnpm check    (every app folder');
    expect(out.join('\n')).toContain('running pnpm check after each change');
  });
});
