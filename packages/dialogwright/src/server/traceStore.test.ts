import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from './index';
import { loadConfig, type Env } from './config';
import { FakeRelay } from '../testing/fakeRelay';
import { FakeS3 } from '../testing/fakeS3';
import { useTestkit } from '../testing/apps';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { loadCorpus } from '../jev/corpus';
import { defaultCorpusFile } from '../run/fixtures';
import type { JevClient } from '../jev/types';
import { traceReaderOf } from '../trace/store';
import { replayFrameLines } from '../harness-text/replay';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { demoTools } from '../core/tools';

/**
 * TRACE_STORE=s3://...: a server writes each call's trace and frame log as segments on S3-compatible
 * storage (here an in-process store that checks every signature) and nothing in TRACE_DIR; the
 * console lists and replays the call from the store; replay runs the joined frame log; a store that
 * fails never stops a call, and /health counts it. Unset, nothing of it runs (every other test).
 */

useTestkit();

const KEYS = { accessKeyId: 'AKIDSERVERTRACES', secretAccessKey: 'a-secret-only-the-fake-store-knows' };
const ACCOUNT_ID = 'five five five zero one two three four';

let stub: JevClient;
beforeAll(() => {
  stub = new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: 0.9, fallback: new HeuristicStubClient() });
}, 60_000);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot(extra: Env = {}): Promise<{ server: RunningServer; s3: FakeS3; dir: string; logs: string[]; env: Env }> {
  const s3 = await FakeS3.start({ bucket: 'call-traces', region: 'us-east-1', credentials: KEYS });
  cleanups.push(() => s3.close());
  const dir = mkdtempSync(join(tmpdir(), 'trace-store-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const logs: string[] = [];
  const env: Env = {
    PUBLIC_HOST: 'localhost', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567', PORT: '0', SIGNATURE_CHECK: 'off', TODAY_OVERRIDE: '2026-09-18',
    TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, NO_INPUT_MS: '0',
    TRACE_STORE: 's3://call-traces/prod/traces', S3_ENDPOINT: s3.endpoint, S3_REGION: 'us-east-1', S3_ACCESS_KEY_ID: KEYS.accessKeyId, S3_SECRET_ACCESS_KEY: KEYS.secretAccessKey, S3_FORCE_PATH_STYLE: 'on',
    SERVER_ID: 'web-1',
    ...extra,
  };
  const server = await startServer(loadConfig(env), { host: '127.0.0.1', client: stub, log: (l) => logs.push(l) });
  cleanups.push(() => server.close().catch(() => {}));
  return { server, s3, dir, logs, env };
}

async function call(server: RunningServer, callSid: string): Promise<FakeRelay> {
  const relay = await FakeRelay.connect(`ws://127.0.0.1:${server.port}/conversation?token=${server.tokens.mint(callSid)}`);
  cleanups.push(() => relay.close());
  relay.setup(callSid);
  await relay.waitForTexts(1);
  relay.prompt('can you deliver tomorrow morning');
  await relay.waitForTexts(3);
  relay.prompt(ACCOUNT_ID);
  await relay.waitForTexts(4);
  return relay;
}

describe('TRACE_STORE=s3://... on a server', () => {
  it("writes the call's trace and frame log as this server's segments, nothing in TRACE_DIR, and the console reads them from the store", async () => {
    const { server, s3, dir, logs, env } = await boot();
    expect(logs.some((l) => l.startsWith(`traces: s3://call-traces/prod/traces/ at 127.0.0.1:${s3.port} (us-east-1), written as segments by this server (web-1-`))).toBe(true);
    await call(server, 'CA0000000000000000000000000000s3a');
    await server.close();
    const keys = [...s3.objects.keys()];
    expect(keys.length).toBeGreaterThan(1);
    expect(keys.every((k) => /^prod\/traces\/CA0000000000000000000000000000s3a\/\d{6}-\d{6}-\d{13}-web-1-[0-9a-f]{8}-\d{6}\.(trace|frames)\.jsonl$/.test(k))).toBe(true);
    expect(existsSync(join(dir, 'traces')) ? readdirSync(join(dir, 'traces')) : []).toEqual([]);
    // No key in any line said.
    expect(logs.join('\n')).not.toContain(KEYS.secretAccessKey);

    const reader = traceReaderOf('s3://call-traces/prod/traces', env)!;
    const joined = (await reader.read('CA0000000000000000000000000000s3a'))!;
    expect(joined.trace.map((l) => (JSON.parse(l) as { turnIndex: number }).turnIndex)).toEqual([1, 2, 3]);

    // The console, on another server reading the same store.
    const again = await boot({ S3_ENDPOINT: s3.endpoint, SERVER_ID: 'web-2' });
    const base = `http://127.0.0.1:${again.server.port}`;
    const list = await (await fetch(`${base}/dashboard/traces`)).json() as { callSid: string; turns: number; startedAt: string }[];
    expect(list).toEqual([expect.objectContaining({ callSid: 'CA0000000000000000000000000000s3a', turns: 3 })]);
    const replay = await (await fetch(`${base}/dashboard/traces/CA0000000000000000000000000000s3a`)).json() as { records: { turnIndex: number; spokenText: string }[]; frames: { dir: string }[] };
    expect(replay.records.map((r) => r.turnIndex)).toEqual([1, 2, 3]);
    expect(replay.records.at(-1)!.spokenText).toBe("And what's your date of birth?");
    expect(replay.frames.some((f) => f.dir === 'in')).toBe(true);
    expect((await fetch(`${base}/dashboard/traces/CAnone`)).status).toBe(404);

    // Replay runs the joined frame log, as it runs a frame-log file.
    const lines = (await reader.frameLog('CA0000000000000000000000000000s3a'))!;
    const r = await replayFrameLines(lines, [], { client: stub, thresholds: DEFAULT_THRESHOLDS, todayIso: '2026-09-18', tools: demoTools(), trace: null });
    expect(r.records.map((x) => x.turnIndex)).toEqual([1, 2, 3]);
  }, 30_000);

  it('a store that fails never stops the call: the failure is logged without a key and counted on /health, and the segments land once it answers', async () => {
    const { server, s3, logs, env } = await boot();
    s3.fail(3);
    const relay = await call(server, 'CA0000000000000000000000000000s3b');
    relay.prompt('april twelfth nineteen eighty five');
    await relay.waitForTexts(7);
    const health = await (await fetch(`http://127.0.0.1:${server.port}/health`)).json() as { traces: { failures: number; dropped: number } };
    expect(health.traces.failures).toBeGreaterThan(0);
    expect(health.traces.dropped).toBe(0);
    expect(logs.filter((l) => l.includes('could not be written to s3://call-traces/prod/traces/'))).toHaveLength(1);
    expect(logs.join('\n')).not.toContain(KEYS.secretAccessKey);
    await server.close();
    const joined = (await traceReaderOf('s3://call-traces/prod/traces', env)!.read('CA0000000000000000000000000000s3b'))!;
    expect(joined.trace.map((l) => (JSON.parse(l) as { turnIndex: number }).turnIndex)).toEqual([1, 2, 3, 4]);
  }, 30_000);
});
