import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from './index';
import { loadConfig, type Env } from './config';
import { computeTwilioSignature } from './signature';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import type { App } from '../core/app/types';
import { routedApp } from '../testing/routed/app';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { fakeTextProvider } from '../texts/record';
import type { IncomingText, TextContext } from '../texts/types';

/**
 * Texts that come in (`POST /messages/twilio`): Twilio's signature checked as the voice webhook's is,
 * refused when invalid; the message's fields, its media by their URLs, handed to the app's onText with
 * the server's sender; Twilio answered with an empty response; the message and each text sent recorded in
 * the app's audit, numbers by their last four. The routed fixture app is given an onText that forwards
 * what comes in to a desk; the sender is a fake: no test reaches Twilio.
 */

const TOKEN = 'authtok';
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
afterEach(async () => {
  await running?.close();
  running = null;
  received.length = 0;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const APP_ENV: Env = { MAIN_LINE: '+15555550201', AFTER_HOURS_DESK: '+15555550202', VIP_DESK: '+15555550203', SPANISH_LINE: '+15555550312' };

async function start(env: Env = {}): Promise<{ base: string; audit: string; provider: ReturnType<typeof fakeTextProvider> }> {
  const dir = mkdtempSync(join(tmpdir(), 'messages-'));
  dirs.push(dir);
  const server: Env = { PUBLIC_HOST: 'localhost', TWILIO_AUTH_TOKEN: TOKEN, HANDOFF_NUMBER: '+15551234567', PORT: '0', TODAY_OVERRIDE: '2026-09-18', TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, NO_INPUT_MS: '0', DASHBOARD: 'off' };
  const provider = fakeTextProvider();
  running = await startServer(loadConfig(server), {
    host: '127.0.0.1', client: new HeuristicStubClient({ todayIso: '2026-09-18' }), log: () => {}, textProvider: provider,
    env: { ...server, ...APP_ENV, TEXT_FROM: '+15555550100', TWILIO_ACCOUNT_SID: `AC${'2'.repeat(32)}`, DESK_PHONE: DESK, ...env },
  });
  return { base: `http://127.0.0.1:${running.port}`, audit: join(dir, 'audit'), provider };
}

/** A message posted as Twilio posts it, signed with the account's token (or not). */
async function post(base: string, params: Record<string, string>, sign: string | null = TOKEN): Promise<{ status: number; text: string; type: string | null }> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (sign !== null) headers['x-twilio-signature'] = computeTwilioSignature('https://localhost/messages/twilio', params, sign);
  const res = await fetch(`${base}/messages/twilio`, { method: 'POST', headers, body: new URLSearchParams(params).toString() });
  return { status: res.status, text: await res.text(), type: res.headers.get('content-type') };
}

/** Every audit row written so far, in order. */
function auditRows(dir: string): { type: string; callId: string; channel: string; detail: Record<string, unknown> }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as never));
}

const PHOTO = { MessageSid: 'SM00000000000000000000000000000001', From: '+15555550177', To: '+15555550201', Body: 'here it is', NumMedia: '2', MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1', MediaContentType0: 'image/jpeg', MediaUrl1: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME2', MediaContentType1: 'image/png' };

describe('POST /messages/twilio', () => {
  it('a signed message reaches the app\'s hook with its media URLs, Twilio gets an empty answer, and the app\'s forward carries the URLs', async () => {
    const { base, audit, provider } = await start();
    const r = await post(base, PHOTO);
    expect(r).toEqual({ status: 200, text: '<?xml version="1.0" encoding="UTF-8"?><Response/>', type: 'text/xml' });
    await vi.waitFor(() => expect(provider.sent).toHaveLength(1));
    expect(received[0]!.m).toEqual({
      id: PHOTO.MessageSid, from: '+15555550177', to: '+15555550201', body: 'here it is', provider: 'twilio',
      media: [{ url: PHOTO.MediaUrl0, contentType: 'image/jpeg' }, { url: PHOTO.MediaUrl1, contentType: 'image/png' }],
    });
    // The app's own settings (ctx.env) and its systems reach the hook.
    expect(received[0]!.ctx.env('DESK_PHONE')).toBe(DESK);
    expect(received[0]!.ctx.sys).toBeDefined();
    expect(provider.sent[0]).toEqual({ from: '+15555550100', to: DESK, body: 'From ...0177: here it is', media: [PHOTO.MediaUrl0, PHOTO.MediaUrl1] });
    // Recorded: the message under its id on the sms channel, then the forward; no number whole, no words, no URL.
    await vi.waitFor(() => expect(auditRows(audit).map((x) => x.type)).toEqual(['text_received', 'text_sent']));
    const rows = auditRows(audit);
    expect(rows[0]).toMatchObject({ callId: PHOTO.MessageSid, channel: 'sms', detail: { number: '...0177', bodyLength: 10, media: 2, id: PHOTO.MessageSid, status: 'received', provider: 'twilio' } });
    expect(rows[1]).toMatchObject({ callId: PHOTO.MessageSid, channel: 'sms', detail: { number: '...0190', bodyLength: 24, media: 2, id: 'SMfake1', status: 'queued' } });
    const all = JSON.stringify(rows);
    for (const secret of ['5555550177', '5555550190', 'here it is', 'ME1']) expect(all).not.toContain(secret);
  });

  it('a bad signature is refused, and nothing reaches the app', async () => {
    const { base, provider } = await start();
    expect((await post(base, PHOTO, 'wrong')).status).toBe(403);
    expect((await post(base, PHOTO, null)).status).toBe(403);
    expect(received).toEqual([]);
    expect(provider.sent).toEqual([]);
  });

  it('a post that names no message is a 400', async () => {
    const { base } = await start();
    expect((await post(base, { From: '+15555550177', Body: 'hi' })).status).toBe(400);
  });

  it('with no sender (TEXT_FROM unset), the message is still recorded and handed to the app, which has none to send with', async () => {
    const { base, audit, provider } = await start({ TEXT_FROM: '' });
    expect((await post(base, PHOTO)).status).toBe(200);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]!.ctx.texts).toBeUndefined();
    expect(provider.sent).toEqual([]);
    await vi.waitFor(() => expect(auditRows(audit).map((x) => x.type)).toEqual(['text_received']));
  });
});
