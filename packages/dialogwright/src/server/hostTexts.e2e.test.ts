import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, SERVER_RECORDS, type RunningServer } from './index';
import { loadConfig } from './config';
import { loadHost, type HostRouting } from './host';
import { useTestkit } from '../testing/apps';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { fakeTextProvider } from '../texts/record';
import type { IncomingText } from '../texts/types';

/**
 * Texts that come in to a host (the design's call 46), over the host fixture (the callback and routed
 * fixture apps): a text is routed by each app's TEXT_FROM first, then by host.yaml's `numbers`; a text to a
 * number no app texts from or is reached by is recorded in the server's own audit (`_server`) and handed to
 * no app, never to the default. And the webhook exists only where some app takes texts or sends them.
 */

useTestkit();

const FIXTURE = fileURLToPath(new URL('../testing/host/host.yaml', import.meta.url));
const NUMBERS = { CALLBACK_LINE: '+15555550300', SERVICE_LINE: '+15555550311', SERVICE_LINE_ES: '+15555550312' };
/** The routed app's own number to text from: not one host.yaml lists. */
const ROUTED_TEXTS = '+15555550399';
const SID = `AC${'3'.repeat(32)}`;

let base: HostRouting;
beforeAll(async () => {
  base = await loadHost(FIXTURE, { ...NUMBERS });
}, 60_000);

let running: RunningServer | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The host with each app taking texts in (its onText noting what reached it), the routed app sending from its own number. */
function withTexts(got: { app: string; m: IncomingText }[]): HostRouting {
  return {
    ...base,
    apps: base.apps.map((a) => ({
      ...a,
      app: { ...a.app, onText: (m: IncomingText) => void got.push({ app: a.id, m }) },
      ...(a.id === 'routed' ? { env: { ...a.env, TEXT_FROM: ROUTED_TEXTS, TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: 't' } } : {}),
    })),
  };
}

async function start(apps: HostRouting): Promise<{ url: string; audit: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'host-texts-'));
  dirs.push(dir);
  const config = loadConfig({ PUBLIC_HOST: 'localhost', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567', PORT: '0', SIGNATURE_CHECK: 'off', TODAY_OVERRIDE: '2026-09-18', TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, NO_INPUT_MS: '0', DASHBOARD: 'off' });
  running = await startServer(config, { host: '127.0.0.1', apps, client: new HeuristicStubClient({ todayIso: '2026-09-18' }), log: () => {}, textProvider: fakeTextProvider() });
  return { url: `http://127.0.0.1:${running.port}`, audit: join(dir, 'audit') };
}

const text = (url: string, id: string, to: string) => fetch(`${url}/messages/twilio`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ MessageSid: id, From: '+15555550177', To: to, Body: 'hi' }).toString() });

/** The audit rows in one folder. */
function rows(dir: string): { type: string; callId: string; detail: Record<string, unknown> }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as never));
}

describe('a text that comes in to a host', () => {
  it('reaches the app that texts from the number, then the app host.yaml lists it for; any other is recorded under _server and handed to none', async () => {
    const got: { app: string; m: IncomingText }[] = [];
    const { url, audit } = await start(withTexts(got));
    expect((await text(url, 'SM1', ROUTED_TEXTS)).status).toBe(200);
    expect((await text(url, 'SM2', NUMBERS.CALLBACK_LINE)).status).toBe(200);
    expect((await text(url, 'SM3', NUMBERS.SERVICE_LINE)).status).toBe(200);
    expect((await text(url, 'SM4', '+15555550398')).status).toBe(200);
    await vi.waitFor(() => expect(rows(join(audit, SERVER_RECORDS)).map((r) => r.callId)).toEqual(['SM4']));
    await vi.waitFor(() => expect(got).toHaveLength(3));
    expect(got.map((g) => [g.app, g.m.id])).toEqual([['routed', 'SM1'], ['callback', 'SM2'], ['routed', 'SM3']]);
    // Never the default (callback) for a number no app is reached by.
    expect(rows(join(audit, SERVER_RECORDS))[0]).toMatchObject({ type: 'text_received', detail: { unrouted: true, number: '...0177' } });
    expect(rows(join(audit, 'routed')).filter((r) => r.type === 'text_received').map((r) => r.callId)).toEqual(['SM1', 'SM3']);
    expect(rows(join(audit, 'callback')).filter((r) => r.type === 'text_received').map((r) => r.callId)).toEqual(['SM2']);
  });

  it('has no webhook where no app takes texts in or sends them', async () => {
    const { url } = await start(base);
    expect((await text(url, 'SM5', NUMBERS.CALLBACK_LINE)).status).toBe(404);
  });
});
