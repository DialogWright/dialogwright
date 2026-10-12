import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestHandler, type HttpDeps } from './http';
import { loadConfig } from './config';
import { SessionStore } from './sessions';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { TraceWriter } from '../trace/writer';
import { VOICE_RELAY } from '../channel/caps';
import { useTestkit } from '../testing/apps';
import { DayCounters } from './dashboard/health';

/**
 * The Health page's reconnects and fallback dials today (http.ts): a fallback dial is a call the server
 * put through to a person itself (draining, past its reconnects, closing, a store it could not reach),
 * never a handoff the dialog decided, which goes to a person as the app means it to.
 */

useTestkit();

let server: Server | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function rig(): Promise<{ base: string; counters: DayCounters; store: SessionStore; draining: { on: boolean } }> {
  const dir = mkdtempSync(join(tmpdir(), 'counters-'));
  dirs.push(dir);
  const config = loadConfig({ PUBLIC_HOST: 'demo.example.net', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567', SIGNATURE_CHECK: 'off', TRACE_DIR: dir, RECONNECT_LIMIT: '1' });
  const store = new SessionStore((callSid) => ({
    session: newSession(callSid, 0, VOICE_RELAY),
    opts: { client: new HeuristicStubClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-10-12' },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`)),
  }), 60_000);
  const counters = new DayCounters(() => '2026-10-12');
  const draining = { on: false };
  const deps: HttpDeps = { config, store, tokens: new CallTokens(60_000), hints: '', log: () => {}, serverHealth: { name: 'web-1', counters }, draining: () => draining.on };
  server = createServer(createRequestHandler(deps));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, counters, store, draining };
}

const form = (params: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });

describe("today's reconnects and fallback dials", () => {
  it('a handoff the dialog decided is no fallback dial, whatever its reason; a reconnect is counted, and a call past its reconnects put through is a fallback', async () => {
    const r = await rig();
    for (const reason of ['live-agent', 'max-attempts', 'needs-human']) {
      const doc = await (await fetch(`${r.base}/cr-action/twilio`, form({ CallSid: `CA_${reason}`, CallStatus: 'in-progress', HandoffData: JSON.stringify({ reasonCode: reason }) }))).text();
      expect(doc).toContain('<Dial');
    }
    expect(r.counters.now()).toMatchObject({ reconnects: 0, fallbacks: 0 });
    r.store.create('CA_live', { send: () => {}, close: () => {} } as never, 'twilio');
    const failed = form({ CallSid: 'CA_live', CallStatus: 'in-progress', SessionStatus: 'failed' });
    expect(await (await fetch(`${r.base}/cr-action/twilio`, failed)).text()).toContain('<ConversationRelay');
    expect(r.counters.now()).toMatchObject({ reconnects: 1, fallbacks: 0 });
    // Past RECONNECT_LIMIT (1): the server puts the caller through itself.
    expect(await (await fetch(`${r.base}/cr-action/twilio`, failed)).text()).toContain('<Dial');
    expect(r.counters.now()).toMatchObject({ reconnects: 1, fallbacks: 1 });
  });

  it('a new call while the server drains is put through: a fallback dial', async () => {
    const r = await rig();
    r.draining.on = true;
    const doc = await (await fetch(`${r.base}/voice/twilio`, form({ CallSid: 'CA_new', From: '+15555550110', To: '+15555550111', CallStatus: 'ringing' }))).text();
    expect(doc).toContain('<Dial');
    expect(r.counters.now()).toMatchObject({ reconnects: 0, fallbacks: 1 });
  });
});
