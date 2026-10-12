import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { startServer, type RunningServer } from './index';
import { loadConfig, type Env } from './config';
import { loadHost, type HostRouting } from './host';
import { pgliteSql, type PgliteSql } from './stores/pgliteSql';
import { FakeRelay } from '../testing/fakeRelay';
import { FakeS3 } from '../testing/fakeS3';
import { startBalancer } from '../testing/multi/balancer';
import { useTestkit } from '../testing/apps';
import { verifyPostgresAudit } from '../audit/postgres';
import type { AuditEntry } from '../audit/types';
import { HOST_APP_PARAMETER } from '../channel/callData';

/**
 * Several apps on many servers (host.yaml with Phase 8b's shared stores): two servers run the same host
 * on one Postgres (PGlite here), with the audit in it and the traces on one S3 store, behind a balancer.
 * A call to the service line runs on A, which dies; the carrier's reconnect reaches B, which takes the
 * call over in the app it was in (the routed app, not the default), and its records stay that app's:
 * its trace under the store's prefix for the app, its audit entries naming it.
 */

useTestkit();

const FIXTURE = fileURLToPath(new URL('../testing/host/host.yaml', import.meta.url));
const NUMBERS = { CALLBACK_LINE: '+15555550300', SERVICE_LINE: '+15555550311', SERVICE_LINE_ES: '+15555550312' };
const OPEN = Date.parse('2026-09-18T15:00:00Z');
const ROUTED_GREETING = 'Thanks for calling Example Service Line. I can take a report of a problem, or check on a request. How can I help?';
const TELNYX_KEY = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const PLACEHOLDER_URL = 'postgres://dialogwright:not-a-password@db.invalid:5432/dialogwright';
const S3_KEYS = { accessKeyId: 'AKIDHOSTMANY', secretAccessKey: 'a-secret-only-the-fake-store-knows' };
const LEASE_MS = 600;

let host: HostRouting;
beforeAll(async () => {
  host = await loadHost(FIXTURE, { ...NUMBERS });
}, 60_000);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Node {
  server: RunningServer;
  sql: PgliteSql;
  logs: string[];
  down: boolean;
}

async function boot(name: string, db: PGlite, s3: FakeS3, extra: Env): Promise<Node> {
  const dir = mkdtempSync(join(tmpdir(), 'host-many-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const sql = pgliteSql(db);
  const logs: string[] = [];
  const config = loadConfig({
    PUBLIC_HOST: 'localhost', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567', PORT: '0', SIGNATURE_CHECK: 'off',
    TODAY_OVERRIDE: '2026-09-18', TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, NO_INPUT_MS: '0',
    JEV_CLIENT: 'stub',
    SESSION_STORE: PLACEHOLDER_URL, CALL_LEASE_MS: String(LEASE_MS), SERVER_ID: name, AUDIT_STORE: PLACEHOLDER_URL,
    TRACE_STORE: 's3://call-traces/many', S3_ENDPOINT: s3.endpoint, S3_REGION: 'us-east-1', S3_ACCESS_KEY_ID: S3_KEYS.accessKeyId, S3_SECRET_ACCESS_KEY: S3_KEYS.secretAccessKey, S3_FORCE_PATH_STYLE: 'on',
    ...extra,
  });
  // Each app's own client (JEV_CLIENT=stub: its corpus, its heuristics), as a server builds them.
  const server = await startServer(config, { host: '127.0.0.1', apps: host, log: (l) => logs.push(l), now: () => OPEN, sessionSql: sql, auditSql: sql });
  cleanups.push(() => server.close().catch(() => {}));
  return { server, sql, logs, down: false };
}

const form = (params: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });

function startOf(doc: string, ws: string): { url: string; parameters: Record<string, string> } {
  const m = /url="wss:\/\/localhost(\/conversation\/[a-z]+)\?token=([0-9a-f]{32})"/.exec(doc);
  if (!m) throw new Error(`not a start document: ${doc}`);
  return { url: `${ws}${m[1]}?token=${m[2]}`, parameters: Object.fromEntries([...doc.matchAll(/<Parameter name="([^"]+)" value="([^"]*)"\/>/g)].map((p) => [p[1]!, p[2]!])) };
}

describe('a host on two servers sharing one Postgres', () => {
  for (const carrier of ['twilio', 'telnyx'] as const) {
    it(`${carrier}: a call to the service line taken over after its server dies stays in its app, and its records stay that app's`, async () => {
      const db = await PGlite.create();
      cleanups.push(() => db.close());
      const s3 = await FakeS3.start({ bucket: 'call-traces', region: 'us-east-1', credentials: S3_KEYS });
      cleanups.push(() => s3.close());
      const env: Env = carrier === 'telnyx' ? { VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY: TELNYX_KEY } : {};
      const a = await boot('a', db, s3, env);
      const b = await boot('b', db, s3, env);
      const lb = await startBalancer(() => [a, b].find((n) => !n.down)?.server.port);
      cleanups.push(() => lb.close());
      const callSid = carrier === 'telnyx' ? 'v3:host-many-servers' : 'CA000000000000000000000000hostmany';
      const relays: FakeRelay[] = [];
      cleanups.push(() => relays.forEach((r) => r.close()));

      const first = startOf(await (await fetch(`${lb.base}/voice/${carrier}`, form({ CallSid: callSid, From: '+15555550110', To: NUMBERS.SERVICE_LINE, CallStatus: 'ringing' }))).text(), lb.ws);
      const relay = await FakeRelay.connect(first.url);
      relays.push(relay);
      relay.setup(callSid, 'VX-before', { to: carrier === 'telnyx' ? null : NUMBERS.SERVICE_LINE, customParameters: first.parameters });
      expect((await relay.waitForTexts(1))[0]).toBe(ROUTED_GREETING);
      expect(a.server.store.get(callSid)!.session.appId).toBe('routed');
      await a.server.store.settled();

      // A dies: its database cut, its sockets and listener closed with no drain.
      a.down = true;
      a.sql.cut();
      await a.server.close();
      // The carrier's callback reaches B, which loads the call from the store and answers in its app.
      const doc = await (await fetch(`${lb.base}/cr-action/${carrier}`, form({ CallSid: callSid, CallStatus: 'in-progress', SessionStatus: 'failed' }))).text();
      const again = startOf(doc, lb.ws);
      expect(again.parameters[HOST_APP_PARAMETER]).toBe('routed');
      // Its socket, with the setup carrying no number at all: B takes the call over, in its app.
      const after = await FakeRelay.connect(again.url);
      relays.push(after);
      after.setup(callSid, 'VX-after', { to: null, customParameters: {} });
      expect((await after.waitForTexts(1, LEASE_MS * 4))[0]).toContain(ROUTED_GREETING);
      expect(b.server.store.get(callSid)!.session.appId).toBe('routed');
      // The call goes on in its app on B: a report filed with routed's own systems, its gate routed's.
      for (const line of ["I'd like to report a problem", 'nothing is working at all', 'no, no one is at risk', 'yes, file it']) {
        const n = after.texts().length;
        after.prompt(line);
        await after.waitFor(() => after.texts().length > n, 4000);
        await new Promise((r) => setTimeout(r, 30));
      }
      expect(after.texts().join(' ')).toContain('Your report number is P201');
      await b.server.store.settled();
      after.close();
      await b.server.close();

      // Its trace, under the store's prefix for the app, from both servers; nothing under the default's.
      const keys = [...s3.objects.keys()].filter((k) => k.includes(`/${callSid.replace(/[^A-Za-z0-9_-]/g, '_')}/`));
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((k) => k.startsWith('many/routed/'))).toBe(true);
      // Its audit chain in the database, verified, every entry naming the app.
      expect((await verifyPostgresAudit(db)).breaks).toEqual([]);
      const chain = (await db.query<{ body: string }>('SELECT body FROM dw_audit_entries')).rows.map((r) => JSON.parse(r.body) as AuditEntry).filter((e) => e.callId === callSid);
      expect(chain.length).toBeGreaterThan(0);
      expect(chain.every((e) => e.app === 'routed')).toBe(true);
      expect(chain.some((e) => e.type === 'gate' && e.detail.tool === 'reportProblem' && e.detail.verdict === 'ALLOW')).toBe(true);
    }, 30_000);
  }
});
