import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../define/createApp';
import { loadConfig } from '../../server/config';
import { MULTI_PORTS, MULTI_SECRETS } from './compose';
import { MULTI_SERVER_ENV, MULTI_SERVERS, scriptFromScenario } from './driver';

/**
 * The container image and the compose stack, read as files: what can be held without Docker (the
 * takeover itself is driver.test.ts in this process, and `pnpm multi:test` under Docker). The image's
 * rules (a pinned base, a non-root user, /ready as the health check, the server under an init, no key
 * in it), the .dockerignore against what git tracks, the compose file's settings against the driver's
 * and the server's own loader, the balancer's, and the workflow's triggers.
 */

const read = (...p: string[]): string => readFileSync(join(REPO_ROOT, ...p), 'utf8');
const DOCKERFILES = {
  'the repository\'s image (Dockerfile)': read('Dockerfile'),
  'a project\'s image (templates/standalone/Dockerfile)': read('packages', 'dialogwright', 'templates', 'standalone', 'Dockerfile'),
};

/** The instructions of a Dockerfile, a line continued with `\` joined, comments left out. */
function instructions(text: string): { op: string; rest: string }[] {
  return text.replace(/\\\n/g, ' ').split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => ({ op: l.split(/\s+/)[0]!.toUpperCase(), rest: l.slice(l.split(/\s+/)[0]!.length).trim() }));
}

describe('the images\' Dockerfiles', () => {
  for (const [what, text] of Object.entries(DOCKERFILES)) {
    describe(what, () => {
      const ins = instructions(text);
      const lastFrom = ins.map((i) => i.op).lastIndexOf('FROM');
      const final = ins.slice(lastFrom);

      it('builds from Node 22, pinned by version and digest, in every stage', () => {
        const base = /^ARG NODE_IMAGE=(node:22\.\d+\.\d+-[a-z]+-slim@sha256:[0-9a-f]{64})$/m.exec(text);
        expect(base, 'ARG NODE_IMAGE=node:22.x.y-<debian>-slim@sha256:<digest>').not.toBeNull();
        const froms = ins.filter((i) => i.op === 'FROM');
        expect(froms.length).toBeGreaterThanOrEqual(2);
        for (const f of froms) expect(f.rest).toMatch(/^\$\{NODE_IMAGE\} AS [a-z]+$/);
      });

      it('runs as a non-root user, health-checks /ready, and starts node itself under tini so a SIGTERM drains it', () => {
        expect(final.filter((i) => i.op === 'USER').map((i) => i.rest)).toEqual(['node']);
        const health = final.find((i) => i.op === 'HEALTHCHECK');
        expect(health?.rest).toMatch(/^--interval=\S+ --timeout=\S+ --start-period=\S+ --retries=\d+\s+CMD \[.*\/ready/);
        expect(final.find((i) => i.op === 'STOPSIGNAL')?.rest).toBe('SIGTERM');
        expect(final.find((i) => i.op === 'ENTRYPOINT')?.rest).toBe('["/usr/bin/tini", "--"]');
        expect(final.find((i) => i.op === 'CMD')?.rest).toBe('["node", "--import", "tsx", "src/serve.ts"]');
        expect(final.some((i) => i.op === 'RUN' && i.rest.includes('install --yes --no-install-recommends tini'))).toBe(true);
      });

      it('bakes in no key, password or settings file', () => {
        for (const i of ins.filter((x) => x.op === 'ARG' || x.op === 'ENV')) expect(i.rest, `${i.op} ${i.rest}`).not.toMatch(/KEY|SECRET|TOKEN|PASSWORD|AUTH/i);
        for (const i of ins.filter((x) => x.op === 'COPY')) expect(i.rest).not.toMatch(/\.env\b/);
        expect(text).not.toMatch(/ENV_FILE/);
      });
    });
  }

  it('installs with the pnpm package.json names, from the lockfile, offline and frozen', () => {
    const pkg = JSON.parse(read('package.json')) as { packageManager: string };
    const text = DOCKERFILES['the repository\'s image (Dockerfile)'];
    expect(`pnpm@${/^ARG PNPM_VERSION=(.+)$/m.exec(text)?.[1]}`).toBe(pkg.packageManager);
    expect(text).toContain('RUN pnpm fetch');
    expect(text).toContain('RUN pnpm install --offline --frozen-lockfile');
  });
});

/**
 * Docker's .dockerignore, read as Docker reads it: each line a pattern from the context's root (`*`
 * within a name, `**` across folders, `!` taking a path back), the last that matches deciding, a pattern
 * that matches a folder excluding all under it.
 */
function dockerIgnored(lines: readonly string[]): (path: string) => boolean {
  const rules = lines.map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#')).map((l) => {
    const keep = l.startsWith('!');
    const pattern = (keep ? l.slice(1) : l).replace(/^\/+|\/+$/g, '');
    const source = pattern.split('/').map((seg) => (seg === '**' ? '(?:.*)' : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))).join('/').replace(/\(\?:\.\*\)\//g, '(?:.*/)?');
    return { keep, re: new RegExp(`^${source}(?:/.*)?$`) };
  });
  return (path) => {
    let ignored = false;
    for (const r of rules) if (r.re.test(path)) ignored = !r.keep;
    return ignored;
  };
}

describe('the repository\'s .dockerignore', () => {
  const ignored = dockerIgnored(read('.dockerignore').split('\n'));
  const tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

  it('keeps every file the image runs: the lockfile, each package and app, their sources, fixtures and settings examples', () => {
    const needed = tracked.filter((f) => /^(packages|apps)\//.test(f) || ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'tsconfig.base.json'].includes(f));
    expect(needed.length).toBeGreaterThan(500);
    expect(needed.filter(ignored)).toEqual([]);
    expect(ignored('apps/clinic/.env.example')).toBe(false);
  });

  it('keeps out settings files, installed packages, builds and what a server writes, wherever they are', () => {
    for (const path of ['.env', 'apps/clinic/.env', 'apps/clinic/.env.local', 'node_modules/x/index.js', 'apps/clinic/node_modules/dialogwright/package.json',
      'packages/dialogwright/dist/index.js', 'traces/c.jsonl', 'apps/clinic/traces/c.jsonl', 'apps/clinic/audit/2026-09-18.jsonl', 'apps/clinic/sessions/calls/c.json',
      'apps/clinic/.console-link/link.json', 'server.log', 'deploy/compose/logs/app-a.log', '.git/HEAD']) {
      expect(ignored(path), path).toBe(true);
    }
    // The engine's own audit and trace code is source, not records.
    expect(ignored('packages/dialogwright/src/audit/postgres.ts')).toBe(false);
  });
});

describe('the compose stack', () => {
  const compose = parse(read('deploy', 'compose', 'docker-compose.yml'), { merge: true }) as {
    services: Record<string, { image?: string; build?: { context: string; dockerfile: string; args?: Record<string, string> }; environment?: Record<string, string>; ports?: string[]; stop_grace_period?: string; depends_on?: Record<string, { condition: string }> }>;
  };
  const services = compose.services;

  it('has Postgres, the S3-compatible store and its bucket, two servers of the app, and the balancer, each image pinned by digest', () => {
    expect(Object.keys(services).sort()).toEqual(['app-a', 'app-b', 'lb', 'postgres', 's3', 's3-bucket']);
    for (const [name, s] of Object.entries(services)) {
      if ((MULTI_SERVERS as readonly string[]).includes(name)) continue;
      expect(s.image, name).toMatch(/^[a-z0-9/-]+:[0-9][\w.-]*@sha256:[0-9a-f]{64}$/);
    }
    // One image for both servers, built once (by app-a), never pulled.
    expect(services['app-a']!.build).toEqual({ context: '../..', dockerfile: 'Dockerfile', args: { APP: '${APP:-clinic}' } });
    expect(services['app-b']!.build).toBeUndefined();
    expect((services['app-b'] as { pull_policy?: string }).pull_policy).toBe('never');
    for (const name of MULTI_SERVERS) {
      expect(services[name]!.image).toBe('dialogwright-multi-app:${APP:-clinic}');
      expect(services[name]!.depends_on).toEqual({ postgres: { condition: 'service_healthy' }, 's3-bucket': { condition: 'service_completed_successfully' } });
    }
  });

  it('runs each server with the driver\'s settings (MULTI_SERVER_ENV), the shared stores, the run\'s secrets and its own name, which the server loads', () => {
    for (const name of MULTI_SERVERS) {
      const env = services[name]!.environment!;
      for (const [k, v] of Object.entries(MULTI_SERVER_ENV)) expect(env[k], `${name} ${k}`).toBe(v);
      const own = Object.keys(env).filter((k) => !(k in MULTI_SERVER_ENV)).sort();
      expect(own).toEqual(['AUDIT_STORE', 'PORT', 'S3_ACCESS_KEY_ID', 'S3_ENDPOINT', 'S3_SECRET_ACCESS_KEY', 'SERVER_ID', 'SESSION_STORE', 'TELNYX_PUBLIC_KEY', 'TWILIO_AUTH_TOKEN']);
      expect(env.SERVER_ID).toBe(name);
      expect(env.SESSION_STORE).toBe(env.AUDIT_STORE);
      // Every secret comes from the run, and compose refuses to start without it.
      const secrets = Object.values(env).flatMap((v) => [...v.matchAll(/\$\{([A-Z_]+)(:\?[^}]*)?\}/g)].map((m) => [m[1], m[2]]));
      for (const [variable, required] of secrets) {
        expect(MULTI_SECRETS as readonly string[]).toContain(variable);
        expect(required, variable).toMatch(/^:\?/);
      }
      // As the container gets them, with this run's values: the server's own loader takes them.
      const given = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.replace(/\$\{MULTI_TELNYX_PUBLIC_KEY[^}]*\}/, 'MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=').replace(/\$\{[A-Z_]+[^}]*\}/g, 'run0value')]));
      expect(() => loadConfig(given)).not.toThrow();
    }
    // Longer than the drain, so a stop lets it end by itself.
    expect(Number(/^(\d+)s$/.exec(services['app-a']!.stop_grace_period!)?.[1]) * 1000).toBeGreaterThan(Number(MULTI_SERVER_ENV.DRAIN_MS) + 5000);
  });

  it('publishes every port on 127.0.0.1 only, on the ports the driver reaches by default', () => {
    const published = Object.values(services).flatMap((s) => s.ports ?? []);
    for (const p of published) expect(p).toMatch(/^127\.0\.0\.1:\$\{MULTI_[A-Z0-9_]+_PORT:-\d+\}:\d+$/);
    const defaults = Object.fromEntries(published.map((p) => /\$\{(MULTI_[A-Z0-9_]+_PORT):-(\d+)\}/.exec(p)!).map((m) => [m[1], Number(m[2])]));
    expect(defaults).toEqual(MULTI_PORTS);
  });

  it('balances as a deployment should: /ready checked, round robin with no stickiness, WebSockets kept open past the longest call', () => {
    const cfg = read('deploy', 'compose', 'haproxy.cfg');
    expect(cfg).toMatch(/^\s*balance roundrobin$/m);
    expect(cfg).toMatch(/^\s*http-check send meth GET uri \/ready$/m);
    expect(cfg).toMatch(/^\s*http-check expect status 200$/m);
    expect(cfg).toMatch(/^\s*timeout tunnel \d+h$/m);
    expect(cfg).not.toMatch(/^\s*(cookie|stick|hash-type|balance source)/m);
    for (const name of MULTI_SERVERS) expect(cfg).toMatch(new RegExp(`^\\s*server ${name} ${name}:3000$`, 'm'));
  });

  it('places the clinic\'s cancellation, the call pnpm multi:test makes by default', () => {
    const script = read('scripts', 'multi-test.mjs');
    const defaults = /const DEFAULTS = \{ app: '([a-z-]+)', scenario: '([a-z-]+)', goAfter: '(\d+)' \}/.exec(script)!;
    expect(defaults).not.toBeNull();
    const call = scriptFromScenario(join(REPO_ROOT, 'apps', defaults[1]!), defaults[2]!, Number(defaults[3]));
    expect(call.says.length).toBeGreaterThan(call.goAfter);
  });
});

describe('pnpm multi:test', () => {
  it('stops at once with what to do when there is no Docker', () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-docker-'));
    try {
      const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'multi-test.mjs')], { env: { PATH: empty, HOME: empty }, encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('pnpm multi:test needs Docker with Compose (`docker compose`), and it is not available here');
      expect(r.stderr).toContain('pnpm multi:test --in-process');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('runs weekly and by hand only, never on a push or a pull request, within a time limit, keeping the stack\'s logs when it fails', () => {
    const wf = parse(read('.github', 'workflows', 'multi.yml')) as { on: Record<string, unknown>; jobs: Record<string, { 'timeout-minutes': number; steps: { uses?: string; run?: string; if?: string; with?: Record<string, unknown> }[] }> };
    expect(Object.keys(wf.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    const job = Object.values(wf.jobs)[0]!;
    expect(job['timeout-minutes']).toBeLessThanOrEqual(60);
    expect(job.steps.map((s) => s.run).filter(Boolean)).toEqual(['pnpm install --frozen-lockfile', 'pnpm multi:test']);
    for (const s of job.steps.filter((x) => x.uses)) expect(s.uses).toMatch(/^[\w/-]+@[0-9a-f]{40}$/);
    const upload = job.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.if).toBe('failure()');
    expect(upload?.with?.path).toBe('deploy/compose/logs/');
  });
});
