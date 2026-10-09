import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIBRARY_DIR } from './define/fixture/app';
import { linkBetween, packagePathOf, relinkMarkdown, SHIPPED } from './define/shipped';
import { withShortTmp } from './testing/shortTmp';

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
    // dialogwright/testing's conformance kits import vitest: the project's own, as a peer.
    expect(pkg.peerDependencies?.vitest).toBeDefined();
  });

  it('dialogwright: the installed bin is a node script that runs the one command line, from src/ here', () => {
    const pkg = manifest('packages/dialogwright');
    expect(pkg.bin).toEqual({ dialogwright: './src/define/cli.ts' });
    expect(pkg.publishConfig?.bin).toEqual({ dialogwright: './bin/dialogwright.mjs' });
    const bin = join(ROOT, 'packages/dialogwright/bin/dialogwright.mjs');
    expect(readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(statSync(bin).mode & 0o111, 'executable').not.toBe(0);
    const run = spawnSync(process.execPath, [bin, 'check', LIBRARY_DIR], { encoding: 'utf8', env: withShortTmp() });
    expect({ status: run.status, stdout: run.stdout }).toEqual({ status: 0, stdout: `${LIBRARY_DIR}: ok\n` });
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
