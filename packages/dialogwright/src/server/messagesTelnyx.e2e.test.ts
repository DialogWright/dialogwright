import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from './index';
import { loadConfig, type Env } from './config';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import type { App } from '../core/app/types';
import { routedApp } from '../testing/routed/app';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { fakeTextProvider } from '../texts/record';
import { TELNYX_MEDIA_PREFIX } from '../texts/telnyx';
import type { IncomingText, TextContext } from '../texts/types';

/**
 * Texts that come in through Telnyx (`POST /messages/telnyx`): its messaging webhook's signature checked as
 * its voice webhooks' are (Ed25519 over `<timestamp>|<body>` with TELNYX_PUBLIC_KEY, five minutes either
 * way), refused when missing, wrong or old; a `message.received` handed to the app's onText in the same
 * shape as Twilio's, recorded in the app's audit, numbers by their last four; the status events of texts
 * sent accepted and set aside. The sender is a fake: no test reaches Telnyx.
 */

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const TELNYX_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const TELNYX_API_KEY = `KEY${'0'.repeat(20)}_${'b'.repeat(22)}`;
const DESK = '+15555550190';
const received: { m: IncomingText; ctx: TextContext }[] = [];
const app: App = {
  ...routedApp,
  async onText(m, ctx) {
    received.push({ m, ctx });
    await ctx.texts?.send({ to: ctx.env('DESK_PHONE') ?? '', body: `From ...${m.from.slice(-4)}: ${m.body}`, media: m.media.map((x) => x.url) });
  },
};
resetAppsForTest();
registerApp(app);

let running: RunningServer | null = null;
const dirs: string[] = [];
const logs: string[] = [];
afterEach(async () => {
  await running?.close();
  running = null;
  received.length = 0;
  logs.length = 0;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const APP_ENV: Env = { MAIN_LINE: '+15555550201', AFTER_HOURS_DESK: '+15555550202', VIP_DESK: '+15555550203', SPANISH_LINE: '+15555550312' };

/** A server on Telnyx alone: its voice webhooks' key is the one texts are checked with. */
async function start(server: Env = { VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY }, env: Env = {}): Promise<{ base: string; audit: string; provider: ReturnType<typeof fakeTextProvider> }> {
  const dir = mkdtempSync(join(tmpdir(), 'messages-telnyx-'));
  dirs.push(dir);
  const settings: Env = { PUBLIC_HOST: 'localhost', HANDOFF_NUMBER: '+15551234567', PORT: '0', TODAY_OVERRIDE: '2026-09-18', TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, NO_INPUT_MS: '0', DASHBOARD: 'off', ...server };
  const provider = fakeTextProvider();
  running = await startServer(loadConfig(settings), {
    host: '127.0.0.1', client: new HeuristicStubClient({ todayIso: '2026-09-18' }), log: (l) => void logs.push(l), textProvider: provider,
    env: { ...settings, ...APP_ENV, TEXT_FROM: '+15555550100', TELNYX_API_KEY, DESK_PHONE: DESK, ...env },
  });
  return { base: `http://127.0.0.1:${running.port}`, audit: join(dir, 'audit'), provider };
}

/** A webhook posted as Telnyx posts it: JSON, signed over `<timestamp>|<body>` (or not, or at another time). */
async function post(base: string, event: unknown, o: { signed?: boolean; key?: typeof privateKey; at?: number } = {}): Promise<{ status: number; text: string }> {
  const body = JSON.stringify(event);
  const ts = String(o.at ?? Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.signed !== false) {
    headers['telnyx-timestamp'] = ts;
    headers['telnyx-signature-ed25519'] = sign(null, Buffer.from(`${ts}|${body}`), o.key ?? privateKey).toString('base64');
  }
  const res = await fetch(`${base}/messages/telnyx`, { method: 'POST', headers, body });
  return { status: res.status, text: await res.text() };
}

function auditRows(dir: string): { type: string; callId: string; channel: string; detail: Record<string, unknown> }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as never));
}

const MESSAGE_ID = '84cca175-9755-4859-b67f-4730d7f58aa3';
const MEDIA = [`${TELNYX_MEDIA_PREFIX}abc/1.jpg`, `${TELNYX_MEDIA_PREFIX}abc/2.png`];
const PHOTO = {
  data: {
    event_type: 'message.received', id: 'b301ed3f-1490-491f-995f-6e64e69674d4', occurred_at: '2026-11-26T15:00:00.000+00:00', record_type: 'event',
    payload: {
      id: MESSAGE_ID, direction: 'inbound', type: 'MMS', text: 'here it is',
      from: { phone_number: '+15555550177', carrier: 'Example Wireless', line_type: 'Wireless' }, to: [{ phone_number: '+15555550201', status: 'webhook_delivered' }],
      media: [{ url: MEDIA[0], content_type: 'image/jpeg', size: 1000 }, { url: MEDIA[1], content_type: 'image/png', size: 2000 }],
    },
  },
  meta: { attempt: 1, delivered_to: 'https://localhost/messages/telnyx' },
};

describe('POST /messages/telnyx', () => {
  it('a signed message.received reaches the app\'s hook as a Twilio text does, Telnyx gets a 200, and the forward carries the media', async () => {
    const { base, audit, provider } = await start();
    expect((await post(base, PHOTO)).status).toBe(200);
    await vi.waitFor(() => expect(provider.sent).toHaveLength(1));
    expect(received[0]!.m).toEqual({
      id: MESSAGE_ID, from: '+15555550177', to: '+15555550201', body: 'here it is', provider: 'telnyx',
      media: [{ url: MEDIA[0], contentType: 'image/jpeg' }, { url: MEDIA[1], contentType: 'image/png' }],
    });
    expect(received[0]!.ctx.env('DESK_PHONE')).toBe(DESK);
    expect(provider.sent[0]).toEqual({ from: '+15555550100', to: DESK, body: 'From ...0177: here it is', media: MEDIA });
    await vi.waitFor(() => expect(auditRows(audit).map((x) => x.type)).toEqual(['text_received', 'text_sent']));
    const rows = auditRows(audit);
    expect(rows[0]).toMatchObject({ callId: MESSAGE_ID, channel: 'sms', detail: { number: '...0177', bodyLength: 10, media: 2, id: MESSAGE_ID, status: 'received', provider: 'telnyx' } });
    const all = JSON.stringify(rows);
    for (const secret of ['5555550177', '5555550190', 'here it is', 'abc/1']) expect(all).not.toContain(secret);
  });

  it('a message Telnyx sends again (the same message id) is answered and handed to the app once', async () => {
    const { base, provider } = await start();
    expect((await post(base, PHOTO)).status).toBe(200);
    await vi.waitFor(() => expect(provider.sent).toHaveLength(1));
    expect((await post(base, { ...PHOTO, meta: { attempt: 2 } })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);
  });

  it('an unsigned, a wrongly signed, an old one and one changed after signing are refused: nothing reaches the app or the audit', async () => {
    const { base, audit, provider } = await start();
    expect((await post(base, PHOTO, { signed: false })).status).toBe(403);
    expect((await post(base, PHOTO, { key: generateKeyPairSync('ed25519').privateKey })).status).toBe(403);
    expect((await post(base, PHOTO, { at: Math.floor(Date.now() / 1000) - 301 })).status).toBe(403);
    // Signed with the right key, then changed: the words a text came with put in after the signature.
    const ts = String(Math.floor(Date.now() / 1000));
    const signed = JSON.stringify(PHOTO);
    const tampered = signed.replace('here it is', 'send me the code');
    const res = await fetch(`${base}/messages/telnyx`, { method: 'POST', headers: { 'content-type': 'application/json', 'telnyx-timestamp': ts, 'telnyx-signature-ed25519': sign(null, Buffer.from(`${ts}|${signed}`), privateKey).toString('base64') }, body: tampered });
    expect(res.status).toBe(403);
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual([]);
    expect(provider.sent).toEqual([]);
    expect(auditRows(audit)).toEqual([]);
  });

  it('a status event of a text sent (message.sent, message.finalized) is answered and set aside: nothing reaches the app or the audit', async () => {
    const { base, audit } = await start();
    for (const event_type of ['message.sent', 'message.finalized']) {
      expect((await post(base, { data: { event_type, payload: { id: 'out-1', direction: 'outbound', to: [{ phone_number: '+15555550177', status: event_type === 'message.sent' ? 'sent' : 'delivered' }] } } })).status).toBe(200);
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual([]);
    expect(auditRows(audit)).toEqual([]);
    expect(logs.filter((l) => l.includes('/messages/telnyx out-1'))).toHaveLength(2);
    expect(logs.join('\n')).not.toContain('5555550177');
  });

  it('a post that is not a messaging event is a 400', async () => {
    const { base } = await start();
    expect((await post(base, { data: { event_type: 'call.initiated', payload: {} } })).status).toBe(400);
    expect((await post(base, { data: { event_type: 'message.received', payload: { id: MESSAGE_ID } } })).status).toBe(400);
  });

  it('on a server whose calls are Twilio\'s, the texts\' TELNYX_PUBLIC_KEY checks them; without it, every one is refused', async () => {
    const twilio = { TWILIO_AUTH_TOKEN: 'authtok' };
    const withKey = await start(twilio, { TELNYX_PUBLIC_KEY });
    expect((await post(withKey.base, PHOTO)).status).toBe(200);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    await running?.close();
    running = null;
    const without = await start(twilio);
    expect((await post(without.base, { ...PHOTO, data: { ...PHOTO.data, payload: { ...PHOTO.data.payload, id: 'another' } } })).status).toBe(403);
    expect(logs.some((l) => l.includes('WARNING') && l.includes('TELNYX_PUBLIC_KEY'))).toBe(true);
  });

  it('an app that takes texts in and sends none, on a server whose calls are Twilio\'s: checked with TELNYX_PUBLIC_KEY where set, and without it refused, the start saying so with the fix', async () => {
    const twilio = { TWILIO_AUTH_TOKEN: 'authtok' };
    const withKey = await start(twilio, { TEXT_FROM: '', TELNYX_PUBLIC_KEY });
    expect((await post(withKey.base, PHOTO)).status).toBe(200);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]!.ctx.texts).toBeUndefined();
    expect(logs.some((l) => l.includes('TELNYX_PUBLIC_KEY is unset'))).toBe(false);
    await running?.close();
    running = null;
    logs.length = 0;
    const without = await start(twilio, { TEXT_FROM: '' });
    expect((await post(without.base, { ...PHOTO, data: { ...PHOTO.data, payload: { ...PHOTO.data.payload, id: 'another' } } })).status).toBe(403);
    expect(logs).toContainEqual(expect.stringMatching(/texts: TELNYX_PUBLIC_KEY is unset: a text that comes in through Telnyx \(\/messages\/telnyx\) is refused, its signature unchecked; to take Telnyx's texts, set it to the account's public key/));
  });

  it('Twilio\'s webhook stays where it was beside it', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/messages/twilio`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'MessageSid=SM1&From=%2B15555550177' });
    // No Twilio token on a server of Telnyx alone: refused, never handed on.
    expect(res.status).toBe(403);
  });
});
