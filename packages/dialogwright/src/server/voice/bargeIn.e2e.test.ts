import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from '../index';
import { loadConfig } from '../config';
import { FakeRelay } from '../../testing/fakeRelay';
import type { JevClient } from '../../jev/types';
import { useTestkit } from '../../testing/apps';
import { defaultCorpusFile } from '../../run/fixtures';

useTestkit();

/**
 * BARGE_IN over a real server and socket: the start document each carrier is given carries the mode as
 * the relay element's `interruptible`, and the lines sent on the socket do not claim to be interruptible
 * by speech when the mode does not let speech interrupt.
 */

const TELNYX_PUBLIC_KEY = Buffer.alloc(32, 7).toString('base64');
const CALL_ID = 'CAbargeinexamplecallidfortestsonly01';

let running: RunningServer | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let client: JevClient | null = null;
beforeAll(async () => {
  const { FixtureStubClient } = await import('../../jev/fixtureStub');
  const { HeuristicStubClient } = await import('../../jev/heuristicStub');
  const { loadCorpus } = await import('../../jev/corpus');
  client = new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: 0.9, fallback: new HeuristicStubClient() });
}, 60_000);

/** A call on a server answering `provider` with `env` on top: the start document it was given, and the lines up to the greeting's. */
async function startCall(provider: 'telnyx' | 'twilio', env: Record<string, string>): Promise<{ document: string; texts: Record<string, unknown>[] }> {
  const traceDir = mkdtempSync(join(tmpdir(), 'bargein-'));
  const audioDir = mkdtempSync(join(tmpdir(), 'audio-'));
  dirs.push(traceDir, audioDir);
  const config = loadConfig({
    PUBLIC_HOST: 'localhost',
    VOICE_PROVIDERS: provider,
    SIGNATURE_CHECK: 'off',
    ...(provider === 'telnyx' ? { TELNYX_PUBLIC_KEY } : { TWILIO_AUTH_TOKEN: 'x'.repeat(32) }),
    HANDOFF_NUMBER: '+15551234567',
    PORT: '0',
    TODAY_OVERRIDE: '2026-09-18',
    TRACE_DIR: traceDir,
    AUDIT_DIR: join(traceDir, 'audit'),
    AUDIO_DIR: audioDir,
    ...env,
  });
  running = await startServer(config, { host: '127.0.0.1', client: client!, log: () => undefined });
  const res = await fetch(`http://127.0.0.1:${running.port}/voice/${provider}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ CallSid: CALL_ID, From: '+15555550110', To: '+15555550111' }).toString(),
  });
  const document = await res.text();
  const token = /token=([0-9a-f]{32})/.exec(document)![1]!;
  const relay = await FakeRelay.connect(`ws://127.0.0.1:${running.port}/conversation/${provider}?token=${token}`);
  if (provider === 'telnyx') {
    relay.send({
      type: 'setup', from: null, to: null, direction: null, callControlId: CALL_ID, callSid: '5e9fcc12-0000-4000-8000-000000000000',
      callStatus: 'active', customParameters: {}, sessionId: '05ff737c-0000-4000-8000-000000000000',
    });
  } else {
    relay.setup(CALL_ID);
  }
  await relay.waitForTexts(1);
  await running.store.get(CALL_ID)?.tail;
  return { document, texts: relay.received.filter((m) => m.type === 'text') };
}

describe.each(['twilio', 'telnyx'] as const)('BARGE_IN on %s', (provider) => {
  it('is any by default: the document says any, and a line the app lets the caller talk over says interruptible', async () => {
    const { document, texts } = await startCall(provider, {});
    expect(document).toContain('interruptible="any"');
    expect(texts.some((m) => m.interruptible === true)).toBe(true);
  });

  it('speech: the document says speech, and the lines keep their own flag', async () => {
    const { document, texts } = await startCall(provider, { BARGE_IN: 'speech' });
    expect(document).toContain('interruptible="speech"');
    expect(document).not.toContain('interruptible="any"');
    expect(texts.some((m) => m.interruptible === true)).toBe(true);
  });

  it.each(['none', 'dtmf'] as const)('%s: the document says so, and no line claims to be interruptible', async (mode) => {
    const { document, texts } = await startCall(provider, { BARGE_IN: mode });
    expect(document).toContain(`interruptible="${mode}"`);
    expect(document).not.toContain('interruptible="any"');
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.every((m) => m.interruptible === false)).toBe(true);
  });
});
