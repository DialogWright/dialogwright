import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { startServer, type RunningServer } from '../../server/index';
import { loadConfig, type Env } from '../../server/config';
import { pgliteSql, type PgliteSql } from '../../server/stores/pgliteSql';
import { traceReaderOf } from '../../trace/store';
import type { JevClient } from '../../jev/types';
import { FakeS3 } from '../fakeS3';
import { startBalancer } from './balancer';
import { MULTI_SERVER_ENV, MULTI_SERVERS, type Stack } from './driver';

/**
 * The two-server stack in this process: two servers of the registered app on two ports, sharing one
 * PGlite (SESSION_STORE and AUDIT_STORE) and one fake S3 store (TRACE_STORE), behind a balancer that
 * sends each webhook and socket to the servers up and not draining in turn (round robin, as the compose
 * stack's HAProxy does: no stickiness). The servers run with the compose stack's settings
 * (MULTI_SERVER_ENV). A kill is a crash as the in-process test makes one (the database cut, then the
 * sockets and the listener closed, with no drain); a stop is the drain then the close, as a SIGTERM runs
 * them (server/index.ts main).
 */

/** A placeholder of the right shape: the servers are given PGlite in its place (ServerOverrides.sessionSql). */
const PLACEHOLDER_URL = 'postgres://dialogwright:not-a-password@db.invalid:5432/dialogwright';
const BUCKET = 'call-traces';

export interface InProcessOptions {
  /** Settings over MULTI_SERVER_ENV (a shorter DRAIN_MS, say). */
  env?: Env;
  /** The decision model's client; left out, each server builds its own (JEV_CLIENT, the stub by default). */
  client?: JevClient;
  /** Where each server's log lines go besides its own record (MULTI_SERVERS_DEBUG=1 prints them). */
  log?: (server: string, line: string) => void;
}

interface Node {
  name: string;
  server: RunningServer;
  sql: PgliteSql;
  down: boolean;
}

export interface InProcessStack extends Stack {
  /** A server as it runs now. */
  server(name: string): RunningServer;
  close(): Promise<void>;
}

export async function inProcessStack(o: InProcessOptions = {}): Promise<InProcessStack> {
  const db = await PGlite.create();
  const keys = { accessKeyId: `AKID${randomBytes(6).toString('hex').toUpperCase()}`, secretAccessKey: randomBytes(20).toString('hex') };
  const s3 = await FakeS3.start({ bucket: BUCKET, region: 'us-east-1', credentials: keys });
  const dir = mkdtempSync(join(tmpdir(), 'multi-'));
  const s3Env: Env = { S3_ENDPOINT: s3.endpoint, S3_ACCESS_KEY_ID: keys.accessKeyId, S3_SECRET_ACCESS_KEY: keys.secretAccessKey };
  const telnyxKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const nodes = new Map<string, Node>();
  const logs = new Map<string, string[]>();

  async function boot(name: string): Promise<Node> {
    const sql = pgliteSql(db);
    const env: Env = {
      ...MULTI_SERVER_ENV,
      ...s3Env,
      PORT: '0',
      SERVER_ID: name,
      SESSION_STORE: PLACEHOLDER_URL,
      AUDIT_STORE: PLACEHOLDER_URL,
      TWILIO_AUTH_TOKEN: randomBytes(16).toString('hex'),
      TELNYX_PUBLIC_KEY: telnyxKey,
      // Nothing should land here (the records are shared); a test looks.
      TRACE_DIR: join(dir, name, 'traces'),
      AUDIT_DIR: join(dir, name, 'audit'),
      AUDIO_DIR: join(dir, name),
      ...o.env,
    };
    const lines = logs.get(name) ?? [];
    logs.set(name, lines);
    const log = (line: string): void => {
      lines.push(line);
      o.log?.(name, line);
    };
    const server = await startServer(loadConfig(env), { host: '127.0.0.1', log, sessionSql: sql, auditSql: sql, ...(o.client ? { client: o.client } : {}) });
    const node: Node = { name, server, sql, down: false };
    nodes.set(name, node);
    return node;
  }

  const nodeOf = (name: string): Node => {
    const n = nodes.get(name);
    if (!n) throw new Error(`no server ${name}`);
    return n;
  };
  for (const name of MULTI_SERVERS) await boot(name);
  let turn = 0;
  const lb = await startBalancer(() => {
    const up = MULTI_SERVERS.map((n) => nodes.get(n)).filter((n): n is Node => n !== undefined && !n.down && n.server.ready);
    if (up.length === 0) return undefined;
    return up[turn++ % up.length]!.server.port;
  });
  const sql = pgliteSql(db);
  const traces = traceReaderOf(MULTI_SERVER_ENV.TRACE_STORE!, { ...MULTI_SERVER_ENV, ...s3Env })!;

  return {
    lb: { base: lb.base, ws: lb.ws },
    servers: MULTI_SERVERS,
    direct: (name) => `http://127.0.0.1:${nodeOf(name).server.port}`,
    sql,
    traces,
    server: (name) => nodeOf(name).server,
    async kill(name) {
      const n = nodeOf(name);
      n.down = true;
      n.sql.cut();
      await n.server.close();
    },
    async stop(name) {
      const n = nodeOf(name);
      // As a SIGTERM runs them (server/index.ts main): unready first (DRAIN_UNREADY_MS), then the drain.
      await n.server.unready();
      await n.server.drain();
      n.down = true;
      await n.server.close();
    },
    async start(name) {
      const n = nodeOf(name);
      if (!n.down) throw new Error(`${name} is still up`);
      await boot(name);
    },
    logs: async (name) => (logs.get(name) ?? []).join('\n'),
    async close() {
      for (const n of nodes.values()) if (!n.down) await n.server.close().catch(() => {});
      await lb.close();
      await s3.close();
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
