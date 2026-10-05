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
import { SILENCE_WAV } from './silence';

useTestkit();

/**
 * BARGE_IN over a real server and socket: the start document each carrier is given carries the mode as
 * the relay element's `interruptible`, and the lines sent on the socket are not marked interruptible
 * by speech when the mode does not let speech interrupt.
 */

const TELNYX_PUBLIC_KEY = Buffer.alloc(32, 7).toString('base64');
const CALL_ID = 'CAbargeinexamplecallidfortestsonly01';

let running: RunningServer | null = null;
/** The last call's relay socket, for a test that goes on with it. */
let lastRelay: FakeRelay | null = null;
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
  lastRelay = relay;
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

  it.each(['none', 'dtmf'] as const)('%s: the document says so, and no line is marked interruptible', async (mode) => {
    const { document, texts } = await startCall(provider, { BARGE_IN: mode });
    expect(document).toContain(`interruptible="${mode}"`);
    expect(document).not.toContain('interruptible="any"');
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.every((m) => m.interruptible === false)).toBe(true);
  });
});

describe('BARGE_IN=server on Telnyx', () => {
  const env = { BARGE_IN: 'server', TELNYX_EVENTS: 'speaker-events tokens-played', BARGE_IN_MIN_SPEECH_MS: '100' };

  it('gives the relay element interruptible none, and marks no line interruptible: the barge-in is the server\'s', async () => {
    const { document, texts } = await startCall('telnyx', env);
    expect(document).toContain('interruptible="none"');
    expect(document).not.toContain('interruptible="server"');
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.every((m) => m.interruptible === false)).toBe(true);
  });

  it('stops the greeting the caller talks over with a play frame of the silent clip it serves', async () => {
    await startCall('telnyx', env);
    const relay = lastRelay!;
    relay.send({ type: 'info', name: 'agentSpeaking', value: 'on' });
    relay.send({ type: 'info', name: 'clientSpeaking', value: 'on' });
    const play = await relay.waitFor((m) => m.type === 'play');
    expect(play).toEqual({ type: 'play', source: 'https://localhost/relay/silence.wav', loop: 1, preemptible: true, interruptible: false });
    relay.close();
  });
});

describe('the silent clip\'s route', () => {
  it.each(['off', 'on'])('is served with CLIPS=%s, as a cacheable WAV, to GET and HEAD', async (clips) => {
    await startCall('telnyx', { CLIPS: clips });
    const base = `http://127.0.0.1:${running!.port}`;
    const res = await fetch(`${base}/relay/silence.wav`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(res.headers.get('cache-control')).toContain('max-age=86400');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(SILENCE_WAV)).toBe(true);
    const head = await fetch(`${base}/relay/silence.wav`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(SILENCE_WAV.length));
    expect((await fetch(`${base}/relay/other.wav`)).status).toBe(404);
    lastRelay?.close();
  });
});
