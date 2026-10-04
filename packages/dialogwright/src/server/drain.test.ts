import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer, type RunningServer } from './index';
import { loadConfig } from './config';
import { FakeRelay } from '../testing/fakeRelay';
import { useTestkit } from '../testing/apps';
import { HeuristicStubClient } from '../jev/heuristicStub';

/**
 * Readiness and the drain (index.ts RunningServer.drain): what a stopping server still takes, what it
 * sends elsewhere, and when it is done waiting.
 */

useTestkit();

let running: RunningServer | null = null;
const dirs: string[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'drain-'));
  dirs.push(dir);
  const config = loadConfig({
    PUBLIC_HOST: 'localhost',
    TWILIO_AUTH_TOKEN: 't',
    HANDOFF_NUMBER: '+15551234567',
    PORT: '0',
    SIGNATURE_CHECK: 'off',
    TODAY_OVERRIDE: '2026-09-18',
    TRACE_DIR: dir,
    AUDIT_DIR: join(dir, 'audit'),
    AUDIO_DIR: dir,
    ...extra,
  });
  const logs: string[] = [];
  running = await startServer(config, { host: '127.0.0.1', client: new HeuristicStubClient(), log: (l) => logs.push(l) });
  const base = `http://127.0.0.1:${running.port}`;
  return { base, logs, ws: `ws://127.0.0.1:${running.port}` };
}

async function call(ws: string, callSid = 'CA1'): Promise<FakeRelay> {
  const relay = await FakeRelay.connect(`${ws}/conversation?token=${running!.tokens.mint(callSid)}`);
  relay.setup(callSid);
  await relay.waitForTexts(1);
  return relay;
}

const form = (params: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(params).toString(),
});

const hangup = (base: string, callSid: string) =>
  fetch(`${base}/cr-action`, form({ CallSid: callSid, CallStatus: 'completed', SessionStatus: 'completed' }));

/** The carrier's action callback for a call whose relay socket has closed while the call is still up. */
const callback = (base: string, callSid: string) =>
  fetch(`${base}/cr-action`, form({ CallSid: callSid, CallStatus: 'in-progress', SessionStatus: 'failed' })).then((r) => r.text());

/** How long a promise takes to settle, or null if it has not within `ms`. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<number | null> {
  const t0 = Date.now();
  const won = await Promise.race([p.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), ms))]);
  return won ? Date.now() - t0 : null;
}

describe('readiness', () => {
  it('is ready once listening, and not while draining; health says it is draining', async () => {
    const { base } = await start({ DRAIN_MS: '5000' });
    const ready = await fetch(`${base}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ready: true });
    expect(running!.draining).toBe(false);

    const relay = await call(`ws://127.0.0.1:${running!.port}`);
    const drained = running!.drain();
    expect(running!.draining).toBe(true);
    const during = await fetch(`${base}/ready`);
    expect(during.status).toBe(503);
    expect(await during.json()).toEqual({ ready: false, draining: true });
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, sessions: 1, retained: 0, draining: true });
    expect((await fetch(`${base}/ready`, { method: 'HEAD' })).status).toBe(503);
    await hangup(base, 'CA1');
    await drained;
    relay.close();
  });

  it('counts live chats in health when the chat is on', async () => {
    const { base } = await start({ CHAT: 'on', CHAT_ALLOWED_ORIGINS: '*' });
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, sessions: 0, retained: 0, chat: 0 });
  });
});

describe('the drain', () => {
  it('sends a new call to the handoff number rather than starting it', async () => {
    const { base, logs } = await start({ DRAIN_MS: '5000' });
    const relay = await call(`ws://127.0.0.1:${running!.port}`);
    const drained = running!.drain();
    for (const path of ['/voice', '/voice/twilio']) {
      const res = await fetch(`${base}${path}`, form({ CallSid: `CA-new${path.length}`, From: '+15555550100', To: '+15555550199' }));
      const doc = await res.text();
      expect(res.status).toBe(200);
      expect(doc).toContain('<Dial>+15551234567</Dial>');
      expect(doc).not.toContain('ConversationRelay');
    }
    expect(logs.filter((l) => l.includes('draining: new call sent to handoff'))).toHaveLength(2);
    await hangup(base, 'CA1');
    await drained;
    relay.close();
  });

  it("still runs a live call's turns, and its reconnect, and ends early when the last call ends", async () => {
    const { base, logs } = await start({ DRAIN_MS: '20000' });
    const relay = await call(`ws://127.0.0.1:${running!.port}`);
    const drained = running!.drain();
    relay.prompt('where is my parcel');
    await relay.waitForTexts(2);
    // A reconnect is the carrier's action callback for a call this server holds: still answered.
    const reconnect = await (await fetch(`${base}/cr-action`, form({ CallSid: 'CA1', CallStatus: 'in-progress', SessionStatus: 'failed' }))).text();
    expect(reconnect).toContain('<ConversationRelay');
    expect(await settlesWithin(drained, 300)).toBeNull();
    await hangup(base, 'CA1');
    const took = await settlesWithin(drained, 2000);
    expect(took).not.toBeNull();
    expect(logs).toContain('drained: no calls or chats left');
    relay.close();
  });

  it('closes at once with DRAIN_MS=0, and puts the caller through to a person when the carrier calls back', async () => {
    const { base, logs } = await start({ DRAIN_MS: '0' });
    const relay = await call(`ws://127.0.0.1:${running!.port}`);
    const drained = running!.drain();
    expect((await relay.closed).code).toBe(1001);
    const doc = await callback(base, 'CA1');
    expect(doc).toContain('<Dial>+15551234567</Dial>');
    expect(doc).not.toContain('ConversationRelay');
    expect(await settlesWithin(drained, 500)).not.toBeNull();
    expect(logs).not.toContain('drain: no callback for 1 call; closing');
  });

  it('closes what is still live with 1001 when DRAIN_MS has passed, so the carrier calls back, and hands that callback to a person', async () => {
    const { base, logs } = await start({ DRAIN_MS: '300' });
    const relay = await call(`ws://127.0.0.1:${running!.port}`);
    const t0 = Date.now();
    const drained = running!.drain();
    expect((await relay.closed).code).toBe(1001);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(logs.some((l) => l.startsWith('drain: 300 ms passed with 1 call and 0 chats live'))).toBe(true);
    // Not a reconnect: this server is about to close, so a reconnect would reach nothing.
    const doc = await callback(base, 'CA1');
    expect(doc).toContain('<Dial>+15551234567</Dial>');
    expect(doc).not.toContain('<ConversationRelay');
    expect(await settlesWithin(drained, 1000)).not.toBeNull();
  });

  it('closes anyway when the carrier does not call back within a few seconds', async () => {
    const { logs } = await start({ DRAIN_MS: '0' });
    await call(`ws://127.0.0.1:${running!.port}`);
    const took = await settlesWithin(running!.drain(), 6000);
    expect(took).not.toBeNull();
    expect(took!).toBeGreaterThanOrEqual(2500);
    expect(logs).toContain('drain: no callback for 1 call; closing');
  }, 10_000);

  it('takes a waiting time of its own over DRAIN_MS', async () => {
    const { base } = await start({ DRAIN_MS: '30000' });
    const relay = await call(`ws://127.0.0.1:${running!.port}`);
    const drained = running!.drain(50);
    expect((await relay.closed).code).toBe(1001);
    await callback(base, 'CA1');
    expect(await settlesWithin(drained, 2000)).not.toBeNull();
  });

  it('refuses a new chat as busy, and still takes a resume', async () => {
    const { ws } = await start({ CHAT: 'on', CHAT_ALLOWED_ORIGINS: '*', DRAIN_MS: '300' });
    const open = (): Promise<{ socket: WebSocket; messages: Record<string, unknown>[]; closed: Promise<number> }> =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(`${ws}/chat`, { origin: 'http://localhost:3000' });
        sockets.push(socket);
        const messages: Record<string, unknown>[] = [];
        socket.on('message', (d) => messages.push(JSON.parse(d.toString()) as Record<string, unknown>));
        const closed = new Promise<number>((r) => socket.on('close', (code) => r(code)));
        socket.once('open', () => resolve({ socket, messages, closed }));
        socket.once('error', reject);
      });
    const until = async (messages: Record<string, unknown>[], type: string) => {
      for (let i = 0; i < 200 && !messages.some((m) => m.type === type); i++) await new Promise((r) => setTimeout(r, 10));
      return messages.find((m) => m.type === type)!;
    };
    const first = await open();
    first.socket.send(JSON.stringify({ type: 'start', v: 1 }));
    const ready = await until(first.messages, 'ready');
    first.socket.close();
    await first.closed;

    const drained = running!.drain();
    const fresh = await open();
    fresh.socket.send(JSON.stringify({ type: 'start', v: 1 }));
    expect(await until(fresh.messages, 'error')).toMatchObject({ type: 'error', code: 'busy' });
    expect(await fresh.closed).toBe(1013);

    const back = await open();
    back.socket.send(JSON.stringify({ type: 'start', v: 1, resume: ready.resume }));
    expect(await until(back.messages, 'ready')).toMatchObject({ type: 'ready', session: ready.session });
    await drained;
  });
});
