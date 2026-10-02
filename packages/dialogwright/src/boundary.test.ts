import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, normalize } from 'node:path';

/**
 * The engine directories. Everything else under src/ is an app (src/apps/*) or test infrastructure
 * (src/testing, which registers the default app for vitest). An engine file never reaches into an
 * app; apps are registered by the launchers inside them (src/apps/<app>/serve.ts and the like).
 */
const ENGINE = ['core', 'gate', 'run', 'channel', 'server', 'jev', 'audit', 'trace', 'handoff', 'prompts', 'harness-text', 'define', 'slots'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|js)$/.test(p) && !p.endsWith('.test.ts') ? [p] : [];
  });
}

/** The engine's files, tests included. */
const engineAll = () => ENGINE.flatMap((d) => allFiles(join('src', d)));

describe('engine/app boundary', () => {
  it('lists only engine directories that exist', () => {
    const dirs = readdirSync('src').filter((d) => statSync(join('src', d)).isDirectory());
    for (const d of ENGINE) expect(dirs).toContain(d);
    // every top-level directory is an engine directory, test infrastructure, or (in the app's repo, not in the export) the apps
    const others = dirs.filter((d) => !ENGINE.includes(d)).sort();
    expect(others).toContain('testing');
    expect(others.filter((d) => d !== 'apps' && d !== 'testing')).toEqual([]);
  });

  it('the files directly under src/ are the package entry and the cross-cutting tests', () => {
    const top = readdirSync('src').filter((f) => statSync(join('src', f)).isFile()).sort();
    expect(top).toEqual(['boundary.test.ts', 'index.test.ts', 'index.ts', 'smoke.test.ts']);
  });

  it('no file in an engine directory or src/testing, tests included, imports an app', () => {
    const scope = [...engineAll(), ...allFiles('src/testing'), 'src/index.ts', 'src/index.test.ts'];
    expect(scope.length).toBeGreaterThan(100);
    const offenders = scope.filter((f) => importsApp(f, readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no engine file registers an app', () => {
    const offenders = ENGINE.flatMap((d) => files(join('src', d))).filter((f) => new RegExp(`\\bregister${'Har'}${'bor'}\\b`).test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the detector catches each import form', () => {
    for (const src of [
      `import { x } from '../apps/example';`,
      `export { x } from '../apps/example/index';`,
      `const m = await import('../apps/example');`,
      `import '../apps/example';`,
      `const m = require('../apps');`,
    ]) expect(importsApp('src/core/x.ts', src), src).toBe(true);
    expect(importsApp('src/testing/testkit/x.ts', `import { x } from '../../apps/example';`)).toBe(true);
    expect(importsApp('src/core/x.ts', `import { x } from '../core/apps';`)).toBe(false);
    expect(importsApp('src/core/x.ts', `import { x } from './apps';`)).toBe(false);
    expect(importsApp('src/core/x.ts', `import { x } from 'apps/example';`)).toBe(false);
  });
});

/**
 * Twilio ConversationRelay's wire format (frames, parse/serialize, the mappings to and from the
 * engine's channel model) lives in src/channel/relay/. The core speaks SessionEvent and Action; the
 * voice adapter, the frame-log replay and test infrastructure speak the wire.
 */
const RELAY = 'src/channel/relay';

/** Files outside the relay that may import it, each with why (src/server/ws.ts carries sockets and imports none of it). A path ending in / is a directory. */
const RELAY_USERS: Record<string, string> = {
  'src/server/adapter.ts': 'the voice adapter: parses the wire in, serializes it out, maps frames to events and actions to frames',
  'src/harness-text/replay.ts': 'replays a recorded frame log: parses wire frames and maps them to events',
  'src/testing/': 'test infrastructure (FakeRelay, frame helpers) speaks the wire to the adapter',
  // The two justified exceptions: neither is the adapter, each reads or prints the wire's own content.
  'src/trace/read.ts': 'upgrades v1 trace records, whose events and frames were wire frames, to the channel model',
  'src/harness-text/print.ts': 'prints the handoffData string the wire carries, through endFrame',
};

/** `from '…'`, `import '…'`, `import('…')`, `require('…')`: the specifier of every relative import. */
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.\.?\/[^'"]*)['"]/g;

function importsOf(src: string): string[] {
  return [...src.matchAll(IMPORT_SPECIFIER)].map((m) => m[1]!);
}

/** Whether `file` (a repo-relative path) imports something under src/apps (a relative import resolved against the file). */
function importsApp(file: string, src: string): boolean {
  return importsOf(src).some((spec) => {
    const target = normalize(join(dirname(file), spec));
    return target === 'src/apps' || target.startsWith('src/apps/');
  });
}

/** Whether `file` (a repo-relative path) imports something inside the relay. */
function importsRelay(file: string, src: string): boolean {
  return importsOf(src).some((spec) => {
    const target = normalize(join(dirname(file), spec));
    return target === RELAY || target.startsWith(`${RELAY}/`);
  });
}

function allowedRelayUser(file: string): boolean {
  if (file.startsWith(`${RELAY}/`)) return true;
  return Object.keys(RELAY_USERS).some((a) => (a.endsWith('/') ? file.startsWith(a) : file === a));
}

describe('relay boundary', () => {
  it('only the relay and its listed users import src/channel/relay', () => {
    const offenders = files('src').filter((f) => !allowedRelayUser(f) && importsRelay(f, readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('in particular the core, run, prompts, trace, gate and jev never do, apart from the trace upgrade', () => {
    const core = ['core', 'run', 'prompts', 'trace', 'gate', 'jev'].flatMap((d) => files(join('src', d)));
    const importers = core.filter((f) => importsRelay(f, readFileSync(f, 'utf8')));
    expect(importers).toEqual(['src/trace/read.ts']);
  });

  it('lists only users that exist, each with a reason', () => {
    for (const [path, reason] of Object.entries(RELAY_USERS)) {
      expect(reason.length, path).toBeGreaterThan(10);
      if (path.endsWith('/')) expect(statSync(path).isDirectory(), path).toBe(true);
      else expect(statSync(path).isFile(), path).toBe(true);
    }
  });

  it('the detector resolves relative paths and catches each import form', () => {
    expect(importsRelay('src/server/x.ts', `import { a } from '../channel/relay/map';`)).toBe(true);
    expect(importsRelay('src/prompts/x.ts', `export { a } from '../channel/relay/frames';`)).toBe(true);
    expect(importsRelay('src/trace/x.ts', `const m = await import('../channel/relay/wire');`)).toBe(true);
    expect(importsRelay('src/apps/example/x.ts', `import '../../channel/relay/wire';`)).toBe(true);
    expect(importsRelay('src/channel/x.ts', `import { a } from './relay/map';`)).toBe(true);
    expect(importsRelay('src/channel/events.ts', `import { a } from './actions';`)).toBe(false);
    expect(importsRelay('src/server/x.ts', `import { a } from '../channel/events';`)).toBe(false);
    expect(importsRelay('src/channel/relay/map.ts', `import { a } from '../events';`)).toBe(false);
  });
});

/** Every file under src, tests too: a layering shortcut in a test is still a shortcut. */
function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return allFiles(p);
    return /\.(ts|js)$/.test(p) ? [p] : [];
  });
}

/**
 * The specifier of every import statement or dynamic import that is not relative (a package, a node
 * builtin, or an alias). Static imports are read at the start of a line, so prose that says "from 'x'"
 * is not one.
 */
const STATIC_IMPORT = /^\s*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g;

function bareSpecifiers(src: string): string[] {
  return [...src.matchAll(STATIC_IMPORT), ...src.matchAll(DYNAMIC_IMPORT)].map((m) => (m[1] ?? m[2])!).filter((spec) => !spec.startsWith('.'));
}

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const PACKAGES = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]);

/** A specifier that is neither a node builtin nor an installed package: an alias into src (`@/…`, `src/…`, `~/…`, a bare directory name), or an absolute path. */
function isSrcAlias(spec: string): boolean {
  if (spec.startsWith('node:') || builtinModules.includes(spec.split('/')[0]!)) return false;
  const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
  return !PACKAGES.has(pkg);
}

function aliasImports(src: string): string[] {
  return bareSpecifiers(src).filter(isSrcAlias);
}

describe('import specifiers', () => {
  it('every import that reaches into src is relative (no paths alias, no src/ prefix)', () => {
    // This file is left out: its detector tests quote the forms they catch.
    const offenders = allFiles('src').filter((f) => f !== 'src/boundary.test.ts').flatMap((f) => aliasImports(readFileSync(f, 'utf8')).map((spec) => `${f}: ${spec}`));
    expect(offenders).toEqual([]);
  });

  it('the detector catches aliases and lets packages and builtins through', () => {
    for (const spec of ['@/core/turn', 'src/core/turn', '~/core/turn', 'core/turn', '/Users/x/src/core/turn', '@app/x']) {
      expect(aliasImports(`import { a } from '${spec}';`), spec).toEqual([spec]);
    }
    expect(aliasImports(`const m = await import('@/core/turn');`)).toEqual(['@/core/turn']);
    expect(aliasImports(`import {\n  a,\n  b,\n} from 'src/core/turn';`)).toEqual(['src/core/turn']);
    expect(aliasImports(`import '@/side-effect';`)).toEqual(['@/side-effect']);
    expect(aliasImports(`export * from '@/core/turn';`)).toEqual(['@/core/turn']);
    expect(aliasImports(`// the text from 'the caller' is masked`)).toEqual([]);
    for (const spec of ['node:path', 'node:fs/promises', 'fs', 'vitest', 'undici', '@typesafe-ai/sdk', '@typesafe-ai/sdk/x']) {
      expect(aliasImports(`import { a } from '${spec}';`), spec).toEqual([]);
    }
    expect(aliasImports(`import { a } from '../core/turn';`)).toEqual([]);
  });
});

/**
 * The engine's inner layers (core, run, prompts, gate, jev, and the slot library, conformance kit
 * included) sit below the server, the test infrastructure and the text harness: they never import them.
 */
const INNER = ['core', 'run', 'prompts', 'gate', 'jev', 'slots'];
const OUTER = ['src/server', 'src/testing', 'src/harness-text'];

function importsOuter(file: string, src: string): string[] {
  return importsOf(src).map((spec) => normalize(join(dirname(file), spec))).filter((t) => OUTER.some((o) => t === o || t.startsWith(`${o}/`)));
}

describe('layering', () => {
  it('core, run, prompts, gate, jev and slots never import src/server, src/testing or src/harness-text', () => {
    const offenders = INNER.flatMap((d) => files(join('src', d))).flatMap((f) => importsOuter(f, readFileSync(f, 'utf8')).map((t) => `${f}: ${t}`));
    expect(offenders).toEqual([]);
  });

  it('the detector resolves relative paths into the outer layers', () => {
    expect(importsOuter('src/core/x.ts', `import { a } from '../server/chat';`)).toEqual(['src/server/chat']);
    expect(importsOuter('src/run/x.ts', `import '../testing/fakeRelay';`)).toEqual(['src/testing/fakeRelay']);
    expect(importsOuter('src/gate/x.ts', `export { a } from '../harness-text/runner';`)).toEqual(['src/harness-text/runner']);
    expect(importsOuter('src/core/x.ts', `import { a } from '../channel/events';`)).toEqual([]);
  });
});

/**
 * What the engine must not carry: real phone numbers and references to internal planning documents.
 * The scan covers every file under the engine directories and src/testing: sources, tests, scripts,
 * pages, json, snapshots and notes. The patterns are built in pieces so this file does not trip a
 * plain grep for them (it is excluded from the scan).
 */
const join2 = (...parts: string[]) => parts.join('');
const PRIVATE_DATA = new RegExp(
  [
    join2('\\+1(?!', '555)\\d{10}'),
    join2('spec ', '§'),
    join2('docs/', 'superpowers'),
    join2('build', '-record'),
    join2('qa', '-prep'),
  ].join('|'),
);

/** Files the scan skips, each with why. The scanning file is left out by construction. */
const PRIVATE_ALLOW: Record<string, string> = {
  'src/server/signature.test.ts': "Twilio's published signature test vector (two numbers outside the 555 range), not anyone's number",
};

/** Every file the scan covers, whatever its extension (the engine directories and src/testing). */
function scanFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? scanFiles(p) : [p];
  });
}
const SCANNED = [...ENGINE.map((d) => join('src', d)), 'src/testing'].flatMap(scanFiles).filter((f) => f !== 'src/boundary.test.ts');
const hits = (re: RegExp, allow: Record<string, string>) => SCANNED.filter((f) => !(f in allow) && re.test(readFileSync(f, 'utf8')));

describe('the engine carries no private data', () => {
  it('scans sources, tests and data files alike', () => {
    for (const ext of ['.ts', '.test.ts', '.js', '.html', '.json', '.snap']) expect(SCANNED.some((f) => f.endsWith(ext)), ext).toBe(true);
  });

  it('no file carries a real phone number or a reference to internal planning documents, apart from the listed ones', () => {
    expect(hits(PRIVATE_DATA, PRIVATE_ALLOW)).toEqual([]);
  });

  it('each allow-list entry exists, has a reason, and really contains what it is allowed', () => {
    for (const [path, reason] of Object.entries(PRIVATE_ALLOW)) {
      expect(reason.length, path).toBeGreaterThan(10);
      expect(PRIVATE_DATA.test(readFileSync(path, 'utf8')), `${path} no longer needs its allowance`).toBe(true);
    }
  });

  it('the pattern matches what it should and nothing near it', () => {
    const data = [join2('+1', '2345678901'), join2('spec ', '§4'), join2('docs/', 'superpowers/plans'), join2('build', '-record'), join2('qa', '-prep')];
    for (const d of data) expect(PRIVATE_DATA.test(d), d).toBe(true);
    for (const d of ['+15555550100', '+1555', '555-0100', 'specification']) expect(PRIVATE_DATA.test(d), d).toBe(false);
  });
});
