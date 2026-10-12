import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { startServer, type RunningServer } from './index';
import { loadConfig } from './config';
import { pgliteSql } from './stores/pgliteSql';
import { FakeRelay } from '../testing/fakeRelay';
import { useTestkit } from '../testing/apps';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { loadCorpus } from '../jev/corpus';
import { defaultCorpusFile } from '../run/fixtures';
import type { JevClient } from '../jev/types';
import type { PublishedEvent } from './dashboard/bus';
import { verifyPostgresAudit } from '../audit/postgres';

/**
 * AUDIT_STORE=postgres on one server: a hangup's audit entry reaches the console before its end, as on
 * one machine, though the database has it a moment later; and the call's chain verifies.
 */

useTestkit();

let stub: JevClient;
beforeAll(() => {
  stub = new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: 0.9, fallback: new HeuristicStubClient() });
}, 60_000);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe('AUDIT_STORE=postgres on a server', () => {
  it("a hangup's call_ended is on the console before the call's end, as on one machine", async () => {
    const db = await PGlite.create();
    cleanups.push(() => db.close());
    const dir = mkdtempSync(join(tmpdir(), 'audit-store-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const server: RunningServer = await startServer(loadConfig({
      PUBLIC_HOST: 'localhost', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567', PORT: '0', SIGNATURE_CHECK: 'off', TODAY_OVERRIDE: '2026-09-18',
      TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, NO_INPUT_MS: '0',
      AUDIT_STORE: 'postgres://dialogwright:not-a-password@db.invalid:5432/dialogwright',
    }), { host: '127.0.0.1', client: stub, log: () => {}, auditSql: pgliteSql(db) });
    cleanups.push(() => server.close());
    const events: PublishedEvent[] = [];
    server.bus!.subscribe((e) => events.push(e));
    const relay = await FakeRelay.connect(`ws://127.0.0.1:${server.port}/conversation?token=${server.tokens.mint('CA1')}`);
    cleanups.push(() => relay.close());
    relay.setup('CA1');
    await relay.waitForTexts(1);
    const res = await fetch(`http://127.0.0.1:${server.port}/cr-action/twilio`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ CallSid: 'CA1', CallStatus: 'completed' }).toString(),
    });
    expect(await res.text()).toContain('<Hangup/>');
    const deadline = Date.now() + 3000;
    while (!events.some((e) => e.type === 'ended') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    const tail = events.filter((e) => e.type === 'audit' || e.type === 'ended').slice(-2);
    expect(tail.map((e) => e.type)).toEqual(['audit', 'ended']);
    expect((tail[0] as Extract<PublishedEvent, { type: 'audit' }>).entries.map((x) => x.type)).toEqual(['call_ended']);
    expect((await verifyPostgresAudit(db)).breaks).toEqual([]);
  }, 20_000);
});
