import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer, type RunningServer } from './index';
import { loadConfig } from './config';
import { useTestkit } from '../testing/apps';
import { HeuristicStubClient } from '../jev/heuristicStub';

/**
 * RELAY_PING_MS: a relay socket that does not answer a ping (one the carrier abandoned without closing
 * it) is closed by the next, so its call is let go; one that answers, as RFC 6455 has every endpoint
 * do, stays open. Off by default.
 */

useTestkit();

const servers: RunningServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(extra: Record<string, string>): Promise<{ server: RunningServer; token: () => string }> {
  const dir = mkdtempSync(join(tmpdir(), 'ping-'));
  dirs.push(dir);
  const server = await startServer(loadConfig({
    PUBLIC_HOST: 'localhost', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567', PORT: '0', SIGNATURE_CHECK: 'off',
    TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, NO_INPUT_MS: '0', ...extra,
  }), { host: '127.0.0.1', client: new HeuristicStubClient(), log: () => {} });
  servers.push(server);
  return { server, token: () => server.tokens.mint('CA1', 'twilio') };
}

function open(port: number, token: string, autoPong: boolean): Promise<{ ws: WebSocket; closed: Promise<number>; pinged: () => number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/conversation/twilio?token=${token}`, { autoPong });
    let pings = 0;
    ws.on('ping', () => (pings += 1));
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    ws.once('open', () => resolve({ ws, closed, pinged: () => pings }));
    ws.once('error', reject);
  });
}

describe('RELAY_PING_MS', () => {
  it('closes a relay socket that missed a ping, and keeps one that answers', async () => {
    const { server, token } = await boot({ RELAY_PING_MS: '1000' });
    const silent = await open(server.port, token(), false);
    const answering = await open(server.port, server.tokens.mint('CA2', 'twilio'), true);
    // Pinged at one second; unanswered by two, it is closed (abnormally: terminated).
    expect(await Promise.race([silent.closed, new Promise((r) => setTimeout(() => r('open'), 3500))])).toBe(1006);
    expect(silent.pinged()).toBeGreaterThan(0);
    expect(answering.ws.readyState).toBe(WebSocket.OPEN);
    expect(answering.pinged()).toBeGreaterThan(0);
    answering.ws.close();
  }, 10_000);

  it('pings nothing by default', async () => {
    const { server, token } = await boot({});
    const c = await open(server.port, token(), false);
    await new Promise((r) => setTimeout(r, 1200));
    expect(c.pinged()).toBe(0);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  }, 10_000);
});
