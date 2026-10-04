// @vitest-environment happy-dom
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

/** The size budget for the script a site loads, gzipped. */
const BUDGET_BYTES = 15 * 1024;
// Paths from strings: under happy-dom, URL is the page's, not Node's.
const src = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(src);

/** What only tests use: never part of what a site loads. */
const TEST_ONLY = (f: string) => f.endsWith('.test.ts') || f === 'testServer.ts';

describe('the widget bundle', () => {
  it('builds, stays under its size budget gzipped, and carries no server, test or Node code', { timeout: 30_000 }, () => {
    // Built here, so the test never reads a stale bundle (and CI needs no build step of its own).
    execFileSync(process.execPath, ['build.mjs'], { cwd: pkg });
    for (const file of ['dialogwright-widget.js', 'dialogwright-widget.mjs']) {
      const js = readFileSync(join(pkg, 'dist', file));
      expect(gzipSync(js).length, `${file} gzipped`).toBeLessThan(BUDGET_BYTES);
      const text = js.toString('utf8');
      for (const banned of ['startServer', 'testkit', 'node:', 'require(', 'zod', 'WebSocketServer', 'vitest', 'happy-dom']) expect(text, `${file}: ${banned}`).not.toContain(banned);
    }
  });

  it('mounts itself from the script tag that loads it, and gives the page DialogWright.mount', () => {
    execFileSync(process.execPath, ['build.mjs'], { cwd: pkg });
    const js = readFileSync(join(pkg, 'dist', 'dialogwright-widget.js'), 'utf8');
    const script = document.createElement('script');
    script.dataset.endpoint = 'wss://chat.example.com/chat';
    script.dataset.title = 'Help';
    // The classic script as a page runs it: document.currentScript is its own tag while it runs.
    Object.defineProperty(document, 'currentScript', { value: script, configurable: true });
    try {
      new Function(js)();
    } finally {
      Object.defineProperty(document, 'currentScript', { value: null, configurable: true });
    }
    const host = document.querySelector('dialogwright-chat');
    expect(host!.shadowRoot!.querySelector('h2')!.textContent).toBe('Help');
    expect(typeof window.DialogWright?.mount).toBe('function');
    expect(typeof window.DialogWright?.createChatClient).toBe('function');
    host!.remove();
  });

  it('is built from the widget\'s own modules only: no package import outside its tests', () => {
    let seen = 0;
    for (const f of readdirSync(src).filter((f) => f.endsWith('.ts') && !TEST_ONLY(f))) {
      const code = readFileSync(join(src, f), 'utf8');
      const specifiers = [
        ...code.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm),
        ...code.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
        ...code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g),
      ].map((m) => m[1]!);
      seen += specifiers.length;
      expect(specifiers.filter((s) => !s.startsWith('./')), f).toEqual([]);
    }
    // The pattern finds imports at all (ui.ts and index.ts have several).
    expect(seen).toBeGreaterThan(5);
  });

  it('has no runtime dependencies', () => {
    const json = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(json.dependencies).toBeUndefined();
    expect(json.peerDependencies).toBeUndefined();
  });
});
