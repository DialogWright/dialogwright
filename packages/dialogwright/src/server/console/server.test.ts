import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from '../index';
import { loadConfig } from '../config';
import { useTestkit } from '../../testing/apps';
import { LINK_KEY_HEADER, type LinkFile } from './auth';
import type { SqlClient } from '../stores/sql';
import { PGlite } from '@electric-sql/pglite';
import { pgliteSql } from '../stores/pgliteSql';
import { verifyPostgresAudit } from '../../audit/postgres';

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

/** A connection that, while `down` is set, fails every question (a database that stops answering, then comes back). */
function downable(sql: SqlClient): SqlClient & { down: boolean } {
  const d = { ...sql, down: false } as SqlClient & { down: boolean };
  d.query = (text, params) => (d.down ? Promise.reject(new Error('the database is down')) : sql.query(text, params));
  d.transaction = (fn) => (d.down ? Promise.reject(new Error('the database is down')) : sql.transaction(fn));
  return d;
}

describe('startServer with CONSOLE_AUTH=token and AUDIT_STORE=postgres', () => {
  const DB_URL = 'postgres://dialogwright:not-a-password@db.invalid:5432/dialogwright';

  /** A POST to the sign-in through the tunnel. */
  async function signInWith(port: number, code: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/dashboard/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '203.0.113.9', origin: 'https://demo.example.net', host: 'demo.example.net' },
      body: `code=${code}`,
    });
  }

  it('the access log goes to the database: the link made, the sign-in, the live feed; one the database cannot take is not served', async () => {
    const db = await PGlite.create();
    try {
      const sql = downable(pgliteSql(db));
      const { dir, config: c } = config({ CONSOLE_AUTH: 'token', AUDIT_STORE: DB_URL });
      const lines: string[] = [];
      running = await startServer(c, { host: '127.0.0.1', log: (l) => lines.push(l), auditSql: sql });
      expect(lines).toContain('audit: postgres://dialogwright:***@db.invalid:5432/dialogwright (shared: a hash chain per call, each anchored into a chain per day; pnpm audit:verify reads it)');
      const link = JSON.parse(readFileSync(join(dir, '.console-link', 'link.json'), 'utf8')) as LinkFile;
      const signedIn = await signInWith(running.port, new URL(link.url!).searchParams.get('code')!);
      expect(signedIn.status).toBe(303);
      const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!;
      const feed = new AbortController();
      const live = await fetch(`http://127.0.0.1:${running.port}/dashboard/events`, { headers: { cookie, 'x-forwarded-for': '203.0.113.9', host: 'demo.example.net' }, signal: feed.signal });
      expect(live.status).toBe(200);
      feed.abort();
      const events = (await db.query<{ chain: string; body: string }>('SELECT chain, body FROM dw_audit_entries ORDER BY chain, seq')).rows.map((r) => ({ chain: r.chain, ...(JSON.parse(r.body) as { type: string; callId: string; channel: string; detail: { event: string } }) }));
      expect(events.map((e) => [e.chain.replace(/\d{4}-\d{2}-\d{2}$/, 'DAY'), e.type, e.callId, e.channel, e.detail.event])).toEqual([
        ['console@DAY', 'console_access', 'console', 'console', 'link_made'],
        ['console@DAY', 'console_access', 'console', 'console', 'sign_in'],
        ['console@DAY', 'console_access', 'console', 'console', 'live'],
      ]);
      expect(existsSync(join(dir, 'audit'))).toBe(false);
      expect((await verifyPostgresAudit(db)).breaks).toEqual([]);
      // A second browser signs in with a link made by console:link (the key in the link file).
      const minted = await fetch(`http://127.0.0.1:${running.port}/dashboard/link`, { method: 'POST', headers: { [LINK_KEY_HEADER]: link.key } });
      expect(minted.status).toBe(200);
      const second = await signInWith(running.port, new URL((await minted.json() as { url: string }).url).searchParams.get('code')!);
      const cookie2 = second.headers.get('set-cookie')!.split(';')[0]!;
      // The database stops answering.
      sql.down = true;
      const watch = () => fetch(`http://127.0.0.1:${running!.port}/dashboard/events`, { headers: { cookie: cookie2, 'x-forwarded-for': '203.0.113.9', host: 'demo.example.net' } });
      // A feed it cannot record is not opened, and the browser's retry is not served either while it cannot be.
      for (let i = 0; i < 2; i++) {
        const refusedFeed = await watch();
        expect(refusedFeed.status).toBe(503);
        expect(await refusedFeed.text()).toBe('the access could not be recorded');
      }
      // A sign-in it cannot record is not made.
      const refused = await signInWith(running.port, 'f'.repeat(64));
      expect(refused.status).toBe(500);
      expect(refused.headers.get('set-cookie')).toBeNull();
      // Nor a link: console:link fails, and no link is written to the file.
      const notMinted = await fetch(`http://127.0.0.1:${running.port}/dashboard/link`, { method: 'POST', headers: { [LINK_KEY_HEADER]: link.key } });
      expect(notMinted.status).toBe(500);
      expect((JSON.parse(readFileSync(join(dir, '.console-link', 'link.json'), 'utf8')) as LinkFile).url).toBeNull();
      // The database is back: the retry is served, and recorded once.
      sql.down = false;
      const ac = new AbortController();
      const served = await fetch(`http://127.0.0.1:${running.port}/dashboard/events`, { headers: { cookie: cookie2, 'x-forwarded-for': '203.0.113.9', host: 'demo.example.net' }, signal: ac.signal });
      expect(served.status).toBe(200);
      ac.abort();
      const lives = (await db.query<{ body: string }>('SELECT body FROM dw_audit_entries')).rows.filter((r) => r.body.includes('"event":"live"'));
      expect(lives).toHaveLength(2);
      await running.close();
      running = null;
    } finally {
      await db.close();
    }
  });
});
