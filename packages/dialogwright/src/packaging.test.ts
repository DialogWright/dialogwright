import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { LIBRARY_DIR } from './define/fixture/app';
import { linkBetween, packageCopy, packagePathOf, relinkMarkdown, SHIPPED } from './define/shipped';
import { projectSkillPage } from './define/createApp';
import { SHORT_TMP, withShortTmp } from './testing/shortTmp';

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/**
 * What a project that installs the packages gets (Phase 10a): in this workspace each package.json
 * points at src/, which vitest, tsx and tsc read with no build step; `publishConfig`, which `pnpm pack`
 * and `pnpm publish` put in place of those fields, points the packed package at dist/, which
 * `pnpm -r build` writes (scripts/build-package.mjs). `pnpm adopt:test` packs, installs and runs them
 * for real; this test holds the manifests to the shape that works.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
type Manifest = {
  name: string;
  version: string;
  private?: boolean;
  bin?: Record<string, string>;
  exports?: Record<string, unknown>;
  files?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  publishConfig?: { bin?: Record<string, string>; exports?: Record<string, unknown>; main?: string; types?: string };
};
const manifest = (dir: string): Manifest => JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as Manifest;

/** The packages a project installs, by folder. */
const PUBLISHED = ['packages/dialogwright', 'packages/kb-author', 'packages/widget', 'packages/create-dialogwright'];

describe('the published packages', () => {
  it('are 0.1.0 and still private (publishing is the maintainer\'s step), and depend on each other by a range', () => {
    for (const dir of PUBLISHED) {
      const pkg = manifest(dir);
      expect(pkg.version, dir).toBe('0.1.0');
      expect(pkg.private, dir).toBe(true);
      expect(pkg.scripts?.build, `${dir}: a build script, which pnpm -r build runs`).toBeDefined();
      // workspace:^ is packed as ^0.1.0; workspace:* would pin the exact version.
      if (pkg.dependencies?.dialogwright !== undefined) expect(pkg.dependencies.dialogwright, dir).toBe('workspace:^');
    }
    expect(manifest('.').scripts?.build).toBe('pnpm -r build');
  });

  it('dialogwright: the workspace reads src/, a project reads dist/, through the same four entries and kb/onnx', () => {
    const pkg = manifest('packages/dialogwright');
    const entries: Record<string, string> = { '.': 'index', './testing': 'testing/index', './slot-kit': 'slots/kit', './policy': 'define/policyEntry', './kb/onnx': 'kb/onnx' };
    for (const [key, file] of Object.entries(entries)) {
      expect(pkg.exports?.[key], key).toBe(`./src/${file}.ts`);
      expect(pkg.publishConfig?.exports?.[key], key).toEqual({ types: `./dist/${file}.d.ts`, default: `./dist/${file}.js` });
      expect(existsSync(join(ROOT, 'packages/dialogwright/src', `${file}.ts`)), file).toBe(true);
    }
    // The per-file subpaths are internals: reachable in this workspace, not exported from a package.
    expect(pkg.exports?.['./*']).toBe('./src/*.ts');
    expect(Object.keys(pkg.publishConfig?.exports ?? {}).sort()).toEqual([...Object.keys(entries), './package.json', './schemas/*.json'].sort());
    expect(pkg.publishConfig?.main).toBe('./dist/index.js');
    expect(pkg.publishConfig?.types).toBe('./dist/index.d.ts');
    for (const folder of ['dist', 'bin', 'schemas', 'templates', 'docs', 'skills']) expect(pkg.files, folder).toContain(folder);
    // The bin loads an app's TypeScript through tsx, so tsx is a dependency, not a tool of the workspace's.
    expect(pkg.dependencies?.tsx).toBeDefined();
    expect(pkg.devDependencies?.tsx).toBeUndefined();
    // No built code imports vitest (the conformance kits take the runner's describe and it), so it is no peer.
    expect(pkg.peerDependencies?.vitest).toBeUndefined();
  });

  it('dialogwright: the installed bin is a node script that runs the one command line, from src/ here', () => {
    const pkg = manifest('packages/dialogwright');
    expect(pkg.bin).toEqual({ dialogwright: './src/define/cli.ts' });
    expect(pkg.publishConfig?.bin).toEqual({ dialogwright: './bin/dialogwright.mjs' });
    const bin = join(ROOT, 'packages/dialogwright/bin/dialogwright.mjs');
    expect(readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(statSync(bin).mode & 0o111, 'executable').not.toBe(0);
    const run = spawnSync(process.execPath, [bin, 'check', LIBRARY_DIR], { encoding: 'utf8', env: withShortTmp() });
    // The library's only warnings are its Spanish locale's speech settings (define/check.test.ts LIBRARY_SPEECH).
    expect({ status: run.status, last: run.stdout.split('\n').at(-2) }).toEqual({ status: 0, last: `${LIBRARY_DIR}: ok` });
    expect(run.stdout.split('\n').slice(0, -2).every((l) => l.startsWith('warning: app.yaml:18:1  voice  the locale es '))).toBe(true);
  }, 60_000);

  it('kb-author and the widget: dist/ with declarations, and kb-author\'s own bin', () => {
    const kb = manifest('packages/kb-author');
    expect(kb.exports).toEqual({ '.': './src/index.ts' });
    expect(kb.publishConfig?.exports?.['.']).toEqual({ types: './dist/index.d.ts', default: './dist/index.js' });
    expect(kb.publishConfig?.bin).toEqual({ 'dialogwright-kb': './dist/cli.js' });
    expect(readFileSync(join(ROOT, 'packages/kb-author/src/cli.ts'), 'utf8').startsWith('#!/usr/bin/env tsx\n'), 'the build makes it #!/usr/bin/env node').toBe(true);
    const widget = manifest('packages/widget');
    expect(widget.exports).toEqual({ '.': './src/index.ts' });
    expect(widget.publishConfig?.exports?.['.']).toEqual({ types: './dist/types/index.d.ts', default: './dist/dialogwright-widget.mjs' });
    expect(widget.publishConfig?.exports?.['./dialogwright-widget.js']).toBe('./dist/dialogwright-widget.js');
    for (const pkg of [kb, widget]) expect(pkg.files).toContain('dist');
  });
});

describe('the pages the package carries', () => {
  it('names folders and pages that exist in this repository', () => {
    for (const [repo] of SHIPPED) expect(existsSync(join(ROOT, repo)), repo).toBe(true);
    expect(packagePathOf('docs/slots/digits.md')).toBe('docs/slots/digits.md');
    expect(packagePathOf('.claude/skills/create-app/SKILL.md')).toBe('skills/create-app/SKILL.md');
    expect(packagePathOf('docs/design.md')).toBeNull();
  });

  it('re-links a page: each relative link given as a path in the repository, anchors and web links kept', () => {
    const page = 'See [the guide](../../../docs/authoring-an-app.md#appyaml), [a pattern](patterns.md#known-gaps), [here](#top) and [the site](https://dialogwright.com).';
    const seen: string[] = [];
    const out = relinkMarkdown(page, '.claude/skills/create-app/SKILL.md', (target, anchor) => {
      seen.push(`${target}${anchor}`);
      return target.startsWith('docs/') ? `X/${target}${anchor}` : null;
    });
    expect(seen).toEqual(['docs/authoring-an-app.md#appyaml', '.claude/skills/create-app/patterns.md#known-gaps']);
    expect(out).toBe('See [the guide](X/docs/authoring-an-app.md#appyaml), [a pattern](patterns.md#known-gaps), [here](#top) and [the site](https://dialogwright.com).');
    expect(linkBetween('docs', 'docs/slots/README.md')).toBe('slots/README.md');
    expect(linkBetween('skills/create-app', 'docs/authoring-an-app.md')).toBe('../../docs/authoring-an-app.md');
  });
});

describe('create-dialogwright', () => {
  it('is a thin bin over dialogwright create-app --standalone, depending on dialogwright by a range', () => {
    const pkg = manifest('packages/create-dialogwright');
    expect(pkg.bin).toEqual({ 'create-dialogwright': './index.mjs' });
    expect(pkg.dependencies).toEqual({ dialogwright: 'workspace:^' });
    expect(pkg.files).toContain('index.mjs');
    const bin = readFileSync(join(ROOT, 'packages/create-dialogwright/index.mjs'), 'utf8');
    expect(bin.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(bin).toContain("'create-app', ...args, '--standalone'");
  });
});

describe('the build\'s specifiers (scripts/build/specifiers.mjs)', () => {
  type Specifiers = {
    resolvedSpecifier(spec: string, from: string, exists: (path: string) => boolean): string | null;
    emitModule(ts: unknown, code: string, fileName: string, exists: (path: string) => boolean): { code: string; unresolved: string[] };
  };
  const load = async () => (await import(/* @vite-ignore */ new URL('../../../scripts/build/specifiers.mjs', import.meta.url).href)) as Specifiers;
  // A small source tree: src/a.ts, src/kb/index.ts, src/data.json, src/view.js.
  const files = new Set(['/p/src/a.ts', '/p/src/kb/index.ts', '/p/src/data.json', '/p/src/view.js']);
  const exists = (path: string) => files.has(path);

  it('makes a relative specifier one Node resolves, and leaves packages and named files alone', async () => {
    const { resolvedSpecifier } = await load();
    expect(resolvedSpecifier('./a', '/p/src/b.ts', exists)).toBe('./a.js');
    expect(resolvedSpecifier('./kb', '/p/src/b.ts', exists)).toBe('./kb/index.js');
    expect(resolvedSpecifier('./kb/', '/p/src/b.ts', exists)).toBe('./kb/index.js');
    expect(resolvedSpecifier('../a', '/p/src/kb/index.ts', exists)).toBe('../a.js');
    expect(resolvedSpecifier('./data.json', '/p/src/b.ts', exists)).toBe('./data.json');
    expect(resolvedSpecifier('./view.js', '/p/src/b.ts', exists)).toBe('./view.js');
    expect(resolvedSpecifier('zod', '/p/src/b.ts', exists)).toBe('zod');
    expect(resolvedSpecifier('node:fs', '/p/src/b.ts', exists)).toBe('node:fs');
    expect(resolvedSpecifier('./missing', '/p/src/b.ts', exists)).toBeNull();
  });

  it('rewrites only real specifiers: never a string, a comment or a template that looks like one', async () => {
    const { emitModule } = await load();
    const ts = (await import('typescript')).default;
    const source = [
      "import { x } from './a';",
      "export * from './kb';",
      "export { y } from './a';",
      "import data from './data.json';",
      "// import { z } from './a';",
      "const text = \"import { q } from './a'\";",
      'const tpl = `export * from \'./kb\'`;',
      "const later = await import('./kb');",
      'console.log(x, data, text, tpl, later);',
    ].join('\n');
    const { code, unresolved } = emitModule(ts, source, '/p/src/b.ts', exists);
    expect(unresolved).toEqual([]);
    expect(code).toContain("import { x } from './a.js';");
    expect(code).toContain("export * from './kb/index.js';");
    expect(code).toContain("export { y } from './a.js';");
    expect(code).toMatch(/import data from '\.\/data\.json' with \{ type: 'json' \};/);
    expect(code).toContain("// import { z } from './a';");
    expect(code).toContain("\"import { q } from './a'\"");
    expect(code).toContain("`export * from './kb'`");
    expect(code).toContain("await import('./kb/index.js')");
    expect(emitModule(ts, "import { x } from './nowhere';\nconsole.log(x);", '/p/src/b.ts', exists).unresolved).toEqual(['/p/src/b.ts: ./nowhere']);
  });
});

describe('the publish guard (scripts/publish-guard.mjs), each package\'s prepack and prepublishOnly', () => {
  const guard = fileURLToPath(new URL('../../../scripts/publish-guard.mjs', import.meta.url));
  const PNPM = 'pnpm/9.12.0 npm/? node/v22.19.0 darwin arm64';

  /** A package folder: src/ and dist/, each with a file of the given age (seconds before now). */
  function pkgDir(srcAge: number, distAge: number | null, files: string[] = ['dist']): string {
    const dir = mkdtempSync(join(SHORT_TMP, 'dialogwright-guard-'));
    scratch.push(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'guarded', files }));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'index.ts'), 'export {};\n');
    const now = Date.now() / 1000;
    utimesSync(join(dir, 'src', 'index.ts'), now - srcAge, now - srcAge);
    if (distAge !== null) {
      mkdirSync(join(dir, 'dist'));
      writeFileSync(join(dir, 'dist', 'index.js'), 'export {};\n');
      utimesSync(join(dir, 'dist', 'index.js'), now - distAge, now - distAge);
    }
    return dir;
  }
  const run = (dir: string, agent: string | undefined, args: string[] = []) => {
    const env = { ...withShortTmp(), npm_config_user_agent: agent ?? '' };
    const r = spawnSync(process.execPath, [guard, ...args], { cwd: dir, encoding: 'utf8', env });
    return { status: r.status, err: r.stderr };
  };

  it('passes a fresh build packed by pnpm', () => {
    expect(run(pkgDir(60, 10), PNPM)).toEqual({ status: 0, err: '' });
  });

  it('refuses npm, which would pack the workspace\'s fields', () => {
    const r = run(pkgDir(60, 10), 'npm/11.0.0 node/v22.19.0 darwin arm64');
    expect(r.status).toBe(1);
    expect(r.err).toContain('it runs under npm/11.0.0, not pnpm');
  });

  it('refuses a missing build, and one older than a file under src/', () => {
    expect(run(pkgDir(60, null), PNPM).err).toContain('there is no build in dist/');
    const stale = run(pkgDir(10, 60), PNPM);
    expect(stale.status).toBe(1);
    expect(stale.err).toContain('the build in dist/ is older than 1 file under src/ (src/index.ts)');
    // A package with no build (create-dialogwright) says so.
    expect(run(pkgDir(10, null), PNPM, ['--no-build']).status).toBe(0);
  });

  it('refuses a file git ignores in a folder the package\'s files names', () => {
    const dir = pkgDir(60, 10, ['dist', 'templates']);
    expect(spawnSync('git', ['init', '-q'], { cwd: dir }).status).toBe(0);
    writeFileSync(join(dir, '.gitignore'), 'dist/\n.env\n*.log\n');
    mkdirSync(join(dir, 'templates'));
    writeFileSync(join(dir, 'templates', 'app.yaml'), 'id: x\n');
    expect(run(dir, PNPM).status).toBe(0);
    writeFileSync(join(dir, 'templates', '.env'), 'KEY=x\n');
    writeFileSync(join(dir, 'templates', 'server.log'), 'x\n');
    const r = run(dir, PNPM);
    expect(r.status).toBe(1);
    expect(r.err).toContain('templates has files git ignores, which would be packed: templates/.env, templates/server.log');
  });

  it('runs before every pack and publish of the four packages', () => {
    for (const dir of PUBLISHED) {
      const scripts = manifest(dir).scripts ?? {};
      const expected = `node ../../scripts/publish-guard.mjs${dir.endsWith('create-dialogwright') ? ' --no-build' : ''}`;
      expect(scripts.prepack, dir).toBe(expected);
      expect(scripts.prepublishOnly, dir).toBe(expected);
    }
  });
});

describe('the create-app skill as the package carries it and as a project gets it', () => {
  const SKILL = join(ROOT, '.claude/skills/create-app');
  const pages = readdirSync(SKILL).filter((f) => f.endsWith('.md'));

  it('links, in the package\'s copy, only to pages the package carries or to GitHub', () => {
    for (const page of pages) {
      const copy = packageCopy(readFileSync(join(SKILL, page), 'utf8'), `.claude/skills/create-app/${page}`);
      for (const [, link] of copy.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (link!.startsWith('#') || /^https?:/.test(link!)) continue;
        // A path in the package, which must be one of the pages the package carries, made from a file of this repository.
        const inPackage = join('skills/create-app', link!.split('#')[0]!).split('\\').join('/');
        const repoPath = SHIPPED.map(([repo, pkg]) => (inPackage.startsWith(pkg) ? repo + inPackage.slice(pkg.length) : null)).find((p) => p !== null);
        expect(repoPath, `${page}: ${link}`).toBeDefined();
        expect(existsSync(join(ROOT, repoPath!)), `${page}: ${link}`).toBe(true);
      }
    }
  });

  it('gives a project the same pages whether create-app reads this repository\'s skill or the package\'s copy', () => {
    for (const page of pages) {
      const text = readFileSync(join(SKILL, page), 'utf8');
      const fromRepository = projectSkillPage(text, page, '.claude/skills/create-app');
      const fromPackage = projectSkillPage(packageCopy(text, `.claude/skills/create-app/${page}`), page, 'skills/create-app');
      expect(fromPackage, page).toBe(fromRepository);
    }
    expect(projectSkillPage('[rules](../../../CLAUDE.md) and [x](https://github.com/DialogWright/dialogwright/blob/main/CLAUDE.md)', 'SKILL.md', 'skills/create-app')).toBe('[rules](../../../CLAUDE.md) and [x](../../../CLAUDE.md)');
  });
});
