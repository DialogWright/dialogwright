import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { COMMANDS, USAGE, main, type Io } from './cli';
import { contentHash } from '../core/app/configHash';
import { ENGINE_VERSION, REPO_ROOT, createApp, displayNameOf, markOf, nameProblem, render, templateFiles } from './createApp';

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
  'policy.matrix', 'policy.yaml', 'prompts.yaml', 'slots.yaml', 'src/app.test.ts', 'src/app.ts', 'src/cassetteTrim.ts', 'src/cli.ts', 'src/data.ts',
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
    expect(Object.keys(pkg.scripts)).toEqual(['typecheck', 'test', 'regress', 'cassette:trim', 'cli', 'serve']);
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
      for (const standalone of [false, true]) {
        for (const [file, text] of templateFiles(identity, standalone)) {
          expect(text, file).not.toMatch(banned);
          expect(text, file).not.toContain('—');
        }
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
    expect(out[0]).toBe('created my/demo: 30 files, with identity.yaml, for "Demo"');
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
    expect(out[0]).toBe('created apps/demo: 29 files, without identity.yaml, for "Demo"');
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

describe('a display name a person types: quotes, a backslash, letters of any script', () => {
  const DISPLAYS = ["Joe's Plumbing", 'Say "Hi" Repairs', 'Back\\slash & Co', 'Café Niño', '"Quoted" at the start', "Fix: it's # done"];

  it('reads back as typed from every file it lands in, in both variants and as a project of its own', async () => {
    const ts = (await import('typescript')).default;
    for (const display of DISPLAYS) {
      for (const [identity, standalone] of [[false, false], [true, false], [false, true], [true, true]] as const) {
        const dir = join(temp(), 'demo');
        createApp({ name: 'demo', dir, display, identity, standalone });
        const app = parse(readFileSync(join(dir, 'app.yaml'), 'utf8')) as { brand: { name: string }; wording: { addressee: string } };
        expect(app.brand.name, display).toBe(display);
        expect(app.wording.addressee, display).toBe(`the ${display} line`);
        const prompts = parse(readFileSync(join(dir, 'prompts.yaml'), 'utf8')) as Record<string, unknown>;
        expect(JSON.stringify(prompts), display).toContain(JSON.stringify(`Thanks for calling ${display}. I can book a service. How can I help?`).slice(1, -1));
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { description: string };
        expect(pkg.description.startsWith(`${display}: `), display).toBe(true);
        const test = readFileSync(join(dir, 'src', 'app.test.ts'), 'utf8');
        const source = ts.createSourceFile('app.test.ts', test, ts.ScriptTarget.ES2022, true);
        expect((source as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics, display).toEqual([]);
        const strings: string[] = [];
        const visit = (node: import('typescript').Node): void => {
          if (ts.isStringLiteral(node)) strings.push(node.text);
          ts.forEachChild(node, visit);
        };
        visit(source);
        expect(strings, display).toEqual(expect.arrayContaining([display, `is ${display}, in en-US`]));
      }
    }
  });

  it('keeps an ordinary name byte for byte as before, and makes a mark of letters only', () => {
    expect(render('name: {{display}}\nit(\'is {{display}}\')\n', { name: 'n', display: 'Example Water', mark: 'EW', root: '.' }, false, false, 'app.yaml')).toBe('name: Example Water\nit(\'is Example Water\')\n');
    expect(render("it('is {{display}}')", { name: 'n', display: "Joe's", mark: 'JO', root: '.' }, false, false, 'src/app.test.ts')).toBe("it('is Joe\\'s')");
    expect(render('name: {{display}}', { name: 'n', display: '"Fix" Co', mark: 'FC', root: '.' }, false, false, 'app.yaml')).toBe('name: "\\"Fix\\" Co"');
    expect(markOf('Joe\'s "Fix" Repairs')).toBe('JF');
    expect(markOf('Café Niño')).toBe('CN');
    for (const bad of ['Tab\there', 'Line\nbreak', 'Brace {x}']) expect(() => createApp({ name: 'demo', dir: join(temp(), 'demo'), display: bad })).toThrow(/control character or braces/);
  });
});

describe('dialogwright create-app --standalone: a project of its own', () => {
  const PROJECT_FILES = [
    '.claude/skills/create-app/SKILL.md', '.claude/skills/create-app/corpus.md', '.claude/skills/create-app/options.md',
    '.claude/skills/create-app/patterns.md', '.claude/skills/create-app/triage.md', '.claude/skills/create-app/worksheet.md',
    '.gitignore', ...PLAIN_FILES.filter((f) => f !== 'src/regress.ts'),
  ].sort();

  it('writes the app folder as the scaffold does, as a project on the installed package, with the skill beside it', () => {
    const dir = join(temp(), 'my-line');
    const made = createApp({ name: 'my-line', dir, standalone: true });
    expect(made).toMatchObject({ dir, packageName: 'my-line', inWorkspace: false, standalone: true });
    expect(walk(dir).map((f) => f.split('\\').join('/')).sort()).toEqual(PROJECT_FILES);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; private: boolean; dependencies: Record<string, string>; devDependencies: Record<string, string>; scripts: Record<string, string> };
    expect(pkg.name).toBe('my-line');
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies).toEqual({ dialogwright: `^${ENGINE_VERSION}` });
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(['@types/node', 'tsx', 'typescript', 'vitest']);
    // The package's commands, and the app's own launchers for what an app may extend (its server, its console).
    expect(pkg.scripts).toMatchObject({ check: 'dialogwright check', regress: 'dialogwright regress', typecheck: 'tsc --noEmit', test: 'vitest run', serve: 'tsx src/serve.ts', start: 'dialogwright start' });
    for (const line of Object.values(pkg.scripts)) {
      const command = /^dialogwright (\S+)/.exec(line)?.[1];
      if (command !== undefined) expect(COMMANDS.map(([name]) => name), line).toContain(command);
    }
    // Nothing points into this repository, and nothing is left to put in.
    for (const file of walk(dir)) {
      const text = readFileSync(join(dir, file), 'utf8');
      expect(text, file).not.toMatch(/\{\{[^}]*\}\}/);
      // The skill is the repository's, word for word but its links: it says how its commands read in a project of its own.
      if (file.startsWith('.claude')) continue;
      expect(text, file).not.toContain('packages/dialogwright');
      expect(text, file).not.toContain('pnpm --filter');
    }
    expect(readFileSync(join(dir, '.gitignore'), 'utf8').split('\n')).toEqual(expect.arrayContaining(['node_modules/', '.env', '!.env.example']));
    const tsconfig = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8')) as { extends?: string; compilerOptions: Record<string, unknown> };
    expect(tsconfig.extends).toBeUndefined();
    const base = JSON.parse(readFileSync(join(REPO_ROOT, 'tsconfig.base.json'), 'utf8')) as { compilerOptions: Record<string, unknown> };
    expect(tsconfig.compilerOptions).toEqual(Object.fromEntries(Object.entries(base.compilerOptions).filter(([key]) => key !== 'exactOptionalPropertyTypes')));
    expect(readFileSync(join(dir, 'src', 'app.test.ts'), 'utf8')).toContain('`npx dialogwright policy:matrix ${APP_DIR}`');
  });

  it('points every schema line at the installed package\'s schemas, and the skill\'s links at its guide or at GitHub', () => {
    const dir = join(temp(), 'my-line');
    createApp({ name: 'my-line', dir, standalone: true, identity: true });
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
      const first = readFileSync(join(dir, file), 'utf8').split('\n')[0]!;
      const match = /^# yaml-language-server: \$schema=node_modules\/dialogwright\/schemas\/(.+)$/.exec(first);
      expect(match, `${file}: ${first}`).not.toBeNull();
      expect(existsSync(join(REPO_ROOT, 'packages/dialogwright/schemas', match![1]!)), file).toBe(true);
    }
    const skill = join(dir, '.claude', 'skills', 'create-app');
    for (const page of readdirSync(skill)) {
      for (const [, link] of readFileSync(join(skill, page), 'utf8').matchAll(/\]\(([^)\s]+)\)/g)) {
        const path = link!.split('#')[0]!;
        if (link!.startsWith('#') || link!.startsWith('https://dialogwright.com')) continue;
        if (link!.startsWith('https://')) {
          expect(link, page).toMatch(/^https:\/\/github\.com\/DialogWright\/dialogwright\/blob\/main\//);
          expect(existsSync(join(REPO_ROOT, link!.slice('https://github.com/DialogWright/dialogwright/blob/main/'.length).split('#')[0]!)), link).toBe(true);
          continue;
        }
        const target = resolve(skill, path);
        if (target.startsWith(join(dir, 'node_modules'))) {
          // The installed package's copy of a page of this repository's docs/.
          const shipped = relative(join(dir, 'node_modules', 'dialogwright'), target);
          expect(shipped, link).toMatch(/^docs\//);
          expect(existsSync(join(REPO_ROOT, shipped)), link).toBe(true);
        } else expect(existsSync(target), `${page}: ${link}`).toBe(true);
      }
    }
  });

  it('names the dialogwright it is given (a packed package, for the adoption test), and prints the steps in the project', async () => {
    const base = temp();
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), cwd: base };
    expect(await main(['create-app', 'my-line', '--standalone', '--dialogwright', 'file:/tmp/dialogwright-0.1.0.tgz'], io)).toBe(0);
    expect(err).toEqual([]);
    expect((JSON.parse(readFileSync(join(base, 'my-line', 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies.dialogwright).toBe('file:/tmp/dialogwright-0.1.0.tgz');
    expect(out[0]).toBe(`created my-line: a project of its own, ${PROJECT_FILES.length} files, without identity.yaml, for "My Line"`);
    const text = out.join('\n');
    for (const step of ['cd my-line', 'npm install', 'npx dialogwright check', 'npm test', 'npx dialogwright regress', '.claude/skills/create-app/SKILL.md']) expect(text).toContain(step);
    expect(text).not.toContain('pnpm --filter');
    expect(await main(['create-app', 'other', '--dialogwright', '^1.0.0'], io)).toBe(2);
    expect(err.at(-1)).toContain('--dialogwright goes with --standalone');
    expect(await main(['create-app', 'my-line', '--standalone'], io)).toBe(1);
  });

  it('is always a project of its own from an installed package, and never one inside this repository', async () => {
    const base = temp();
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), cwd: base };
    // npx dialogwright create-app in a project: there is no repository to write apps/<name> into.
    expect(await main(['create-app', 'my-line', '--no-install'], { ...io, installed: true })).toBe(0);
    expect(out[0]).toMatch(/^created my-line: a project of its own/);
    expect(existsSync(join(base, 'my-line', '.gitignore'))).toBe(true);
    expect((JSON.parse(readFileSync(join(base, 'my-line', 'package.json'), 'utf8')) as { name: string }).name).toBe('my-line');
    expect(USAGE).toContain('run from an installed package (npx dialogwright create-app), it is always a project of its own');
    // --standalone run in this repository with no --dir would write <repo>/<name>: refused, with the fix.
    expect(await main(['create-app', 'my-line', '--standalone'], { ...io, cwd: REPO_ROOT })).toBe(1);
    expect(err.at(-1)).toContain('is inside the DialogWright repository');
    expect(err.at(-1)).toContain('give --dir <a folder outside the repository>');
    expect(existsSync(join(REPO_ROOT, 'my-line'))).toBe(false);
  });
});
