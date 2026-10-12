import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from './index';
import { loadConfig } from './config';
import { FakeRelay } from '../testing/fakeRelay';
import { useTestkit } from '../testing/apps';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { loadCorpus } from '../jev/corpus';
import { defaultCorpusFile } from '../run/fixtures';
import type { JevClient } from '../jev/types';

/**
 * A trace that cannot be written never fails a turn, on one machine too (the maintainer's decision,
 * 8b2's review): the trace file and the frame log turned into folders mid-call (so every append to
 * them fails), the call goes on as it would, the failure is logged once and counted on /health, and
 * the audit (the record) is still written.
 */

useTestkit();

let stub: JevClient;
beforeAll(() => {
  stub = new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: 0.9, fallback: new HeuristicStubClient() });
}, 60_000);

let running: RunningServer | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('a trace write that fails on one machine', () => {
  it('never fails the turn: the call goes on, the failure is logged once and counted on /health, the audit is written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-fail-'));
    dirs.push(dir);
    const logs: string[] = [];
    running = await startServer(loadConfig({
      PUBLIC_HOST: 'localhost', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567', PORT: '0', SIGNATURE_CHECK: 'off', TODAY_OVERRIDE: '2026-09-18',
      TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, NO_INPUT_MS: '0',
    }), { host: '127.0.0.1', client: stub, log: (l) => logs.push(l) });
    const base = `http://127.0.0.1:${running.port}`;
    // While the disk works, /health is as it was.
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, sessions: 0, retained: 0 });
    const relay = await FakeRelay.connect(`ws://127.0.0.1:${running.port}/conversation?token=${running.tokens.mint('CA1')}`);
    relay.setup('CA1');
    await relay.waitForTexts(1);
    // Every append to the call's trace and frame log fails from here on.
    for (const f of ['CA1.jsonl', 'CA1.frames.jsonl']) {
      rmSync(join(dir, 'traces', f));
      mkdirSync(join(dir, 'traces', f));
    }
    relay.prompt('can you deliver tomorrow morning');
    await relay.waitForTexts(3);
    relay.prompt('five five five zero one two three four');
    // The turns ran as they would: the caller is asked for the birth date, not "say that again".
    expect((await relay.waitForTexts(4)).at(-1)).toBe("And what's your date of birth?");
    relay.close();
    const health = await (await fetch(`${base}/health`)).json() as { traces?: { failures: number; dropped: number } };
    expect(health.traces!.failures).toBeGreaterThan(1);
    expect(logs.filter((l) => l.startsWith('traces: ') && l.includes('could not be written'))).toHaveLength(1);
    expect(logs.some((l) => l.includes('turn failed'))).toBe(false);
    const audit = readFileSync(join(dir, 'audit', '2026-10-11.jsonl'.replace('2026-10-11', new Date().toISOString().slice(0, 10))), 'utf8');
    expect(audit).toContain('"type":"gate"');
  }, 20_000);
});
