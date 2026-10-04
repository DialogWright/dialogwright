import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from '../index';
import { loadConfig } from '../config';
import { useTestkit } from '../../testing/apps';
import type { LinkFile } from './auth';

useTestkit();

let running: RunningServer | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function config(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'console-server-'));
  dirs.push(dir);
  return {
    dir,
    config: loadConfig({
      PUBLIC_HOST: 'demo.example.net', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567', PORT: '0', SIGNATURE_CHECK: 'off',
      TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, ...extra,
    }),
  };
}

describe('startServer with CONSOLE_AUTH=token', () => {
  it('writes the first link to the link file when it listens, logs only a short hash of its code, and audits it', async () => {
    const { dir, config: c } = config({ CONSOLE_AUTH: 'token' });
    const lines: string[] = [];
    running = await startServer(c, { host: '127.0.0.1', log: (l) => lines.push(l) });
    const file = join(dir, '.console-link', 'link.json');
    const link = JSON.parse(readFileSync(file, 'utf8')) as LinkFile;
    expect(link.port).toBe(running.port);
    expect(link.url).toMatch(/^https:\/\/demo\.example\.net\/dashboard\/login\?code=[0-9a-f]{64}$/);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    const code = new URL(link.url!).searchParams.get('code')!;
    const log = lines.join('\n');
    expect(log).not.toContain(code);
    expect(log).not.toContain(link.key);
    expect(log).toContain(`console: a sign-in link (code ${createHash('sha256').update(code).digest('hex').slice(0, 8)}…`);
    expect(log).toContain(`is in ${file}`);
    expect(log).toContain('console: /dashboard behind sign-in on https://demo.example.net/dashboard (CONSOLE_AUTH=token)');
    const audit = readdirSync(join(dir, 'audit')).map((f) => readFileSync(join(dir, 'audit', f), 'utf8')).join('');
    expect(audit).toContain('"type":"console_access"');
    expect(audit).toContain('"event":"link_made"');
    expect(audit).not.toContain(code);
    // Through the tunnel the console asks for sign-in.
    const res = await fetch(`http://127.0.0.1:${running.port}/dashboard`, { headers: { 'x-forwarded-for': '203.0.113.9' }, redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/dashboard/login');
  });

  it('removes the link file when it closes: its key dies with the process', async () => {
    const { dir, config: c } = config({ CONSOLE_AUTH: 'token' });
    running = await startServer(c, { host: '127.0.0.1', log: () => {} });
    const file = join(dir, '.console-link', 'link.json');
    expect(existsSync(file)).toBe(true);
    await running.close();
    running = null;
    expect(existsSync(file)).toBe(false);
  });

  it('writes no link file and no console_access with CONSOLE_AUTH=local', async () => {
    const { dir, config: c } = config();
    running = await startServer(c, { host: '127.0.0.1', log: () => {} });
    expect(existsSync(join(dir, '.console-link'))).toBe(false);
    const res = await fetch(`http://127.0.0.1:${running.port}/dashboard`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(res.status).toBe(404);
  });
});
