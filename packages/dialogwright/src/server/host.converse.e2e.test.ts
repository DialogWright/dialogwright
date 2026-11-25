import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from './index';
import { loadConfig, type Env } from './config';
import { hostRouting, type HostedApp } from './host';
import { FakeRelay } from '../testing/fakeRelay';
import { CALLER, text, done } from '../testing/converse/chat';
import { converseFixture } from '../testing/converse/app';
import { fakeModel } from '../converse/model/fake';
import type { ConverseApp } from '../converse/app';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { callbackApp } from '../testing/callback/app';

/**
 * A host of a scripted app and a converse app, each on its own number, as a carrier reaches it: a call to each
 * number reaches its app; a converse call's answer document is interruptible by speech and, on Telnyx, has the
 * playback events on, whatever BARGE_IN and TELNYX_EVENTS say, in the business's own voice, with the noise
 * suppression any call has; a scripted call's document on the same server is the one it was; and a converse
 * call handed to a person is put through to agent.yaml's transfer number.
 */

const TELNYX_PUBLIC_KEY = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const CONVERSE_GREETING = 'Example Visits, how can I help?';
const MAIN_LINE = '+15555550101';
const VISIT_LINE = '+15555550105';
const HANDOFF_NUMBER = '+15555550199';
const TRANSFER = '+15555550177';
const VOICES = { twilio: 'en-US-Example-Voice', telnyx: 'Telnyx.NaturalHD.astra' };

const servers: RunningServer[] = [];
const relays: FakeRelay[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const r of relays.splice(0)) r.close();
  for (const s of servers.splice(0)) await s.close().catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetAppsForTest();
});

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), 'host-converse-'));
  dirs.push(d);
  return d;
}

/** The callback fixture's settings and the converse app's number, on both carriers. */
function hostEnv(dir: string, extra: Record<string, string> = {}): Env {
  return {
    PUBLIC_HOST: 'localhost', VOICE_PROVIDERS: 'twilio,telnyx', SIGNATURE_CHECK: 'off', PORT: '0', HANDOFF_NUMBER, TWILIO_AUTH_TOKEN: 't', TELNYX_PUBLIC_KEY,
    TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, DASHBOARD: 'off', JEV_CLIENT: 'stub', NO_INPUT_MS: '0',
    MAIN_LINE, PRIORITY_LINE: '+15555550102', CALLBACK_DESK: '+15555550103', SECURITY_DESK: '+15555550104', VISIT_LINE,
    ...extra,
  };
}

/** The converse fixture with the business's voices and, unless `transfer` is false, a transfer number. */
function converseWith(transfer = true, twilio: string | { voice: string; provider: 'Google' | 'Amazon' | 'ElevenLabs' } = VOICES.twilio): ConverseApp {
  const { app } = converseFixture();
  return { ...app, business: { ...app.business, persona: { ...app.business.persona, voices: { ...VOICES, twilio } }, ...(transfer ? { transfer: { number: TRANSFER } } : {}) } };
}

/** A host of the callback app (the default) and, with `converse`, a converse app on VISIT_LINE. */
async function hostOf(converse: ConverseApp | null, extra: Record<string, string> = {}, model = fakeModel([[text('Sure.'), done()], [text('Sure.'), done()]])): Promise<{ base: string }> {
  const dir = folder();
  const env = hostEnv(dir, extra);
  // The scripted app registered, as its launcher registers it.
  resetAppsForTest();
  registerApp(callbackApp);
  const scripted = { id: 'callback', app: callbackApp, env, own: [], ignored: [] };
  const hosted = converse ? [scripted, { id: converse.id, app: converse, dir: converse.dir, env, own: [], ignored: [] }] : [scripted];
  const apps = hostRouting<HostedApp>({ apps: hosted, numbers: converse ? [{ variable: 'VISIT_LINE', app: converse.id }] : [], defaultApp: 'callback', env });
  const server = await startServer(loadConfig(env), { host: '127.0.0.1', log: () => {}, env, apps, converseModel: () => model });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}` };
}

const form = (params: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(params).toString(),
});

/** The answer webhook's document for a call to `to` on `carrier`. */
async function answer(base: string, carrier: 'twilio' | 'telnyx', callId: string, to: string): Promise<string> {
  return (await fetch(`${base}/voice/${carrier}`, form({ CallSid: callId, From: CALLER, To: to, CallStatus: 'ringing' }))).text();
}

/** A document with its relay token (fresh on every answer) put as a placeholder. */
const tokenless = (doc: string): string => doc.replace(/token=[0-9a-f]{32}/g, 'token=<token>');

/** The socket a start document names, on the server under test. */
function socketUrl(doc: string, base: string): string {
  const m = /url="wss:\/\/localhost(\/conversation\/[a-z]+)\?token=([0-9a-f]{32})"/.exec(doc);
  if (!m) throw new Error(`not a start document: ${doc}`);
  return `${base.replace('http', 'ws')}${m[1]}?token=${m[2]}`;
}

/** A call answered on Twilio and its socket set up. */
async function call(base: string, callId: string, to: string): Promise<FakeRelay> {
  const relay = await FakeRelay.connect(socketUrl(await answer(base, 'twilio', callId, to), base));
  relays.push(relay);
  relay.setup(callId, `VX-${callId}`, { from: CALLER, to });
  return relay;
}

const finals = (relay: FakeRelay): string[] => relay.received.filter((m) => m.type === 'text' && m.last === true).map((m) => (m.token as string).trimEnd());

describe('a host of a scripted app and a converse app', () => {
  it('a converse app on a host takes a call on its number', async () => {
    const { base } = await hostOf(converseWith());
    const scripted = await call(base, 'CAhostscripted0000000000000000001', MAIN_LINE);
    const conversing = await call(base, 'CAhostconverse0000000000000000001', VISIT_LINE);
    await scripted.waitForTexts(1);
    await conversing.waitFor(() => finals(conversing).length >= 1);
    expect(finals(conversing)).toEqual([CONVERSE_GREETING]);
    expect(finals(scripted)).not.toContain(CONVERSE_GREETING);
    expect(scripted.received.filter((m) => m.type === 'text').length).toBeGreaterThan(0);
  }, 20_000);

  it('the answer document of a converse call is interruptible by speech, with Telnyx\'s events on', async () => {
    const settings = { BARGE_IN: 'none', TELNYX_NOISE_SUPPRESSION: 'krisp' };
    const both = await hostOf(converseWith(), settings);
    const telnyx = await answer(both.base, 'telnyx', 'v3:host-converse-telnyx-1', VISIT_LINE);
    expect(telnyx).toContain('interruptible="speech"');
    expect(telnyx).toContain('events="speaker-events tokens-played"');
    expect(telnyx).toContain('<Start><Suppression');
    expect(telnyx).toContain(`voice="${VOICES.telnyx}"`);
    expect(telnyx).not.toContain('interruptible="none"');
    const twilio = await answer(both.base, 'twilio', 'CAhostconversedoc000000000000001', VISIT_LINE);
    expect(twilio).toContain('interruptible="speech"');
    expect(twilio).toContain(`voice="${VOICES.twilio}"`);
    // Deepgram flux, Twilio's recognizer as for any call.
    expect(twilio).toContain('transcriptionProvider="Deepgram" speechModel="flux"');
    expect(twilio).not.toContain('events=');
    // A scripted call's documents on the same server are the ones a server of the scripted app alone writes.
    const alone = await hostOf(null, settings);
    for (const carrier of ['twilio', 'telnyx'] as const) {
      const id = carrier === 'telnyx' ? 'v3:host-scripted-doc-1' : 'CAhostscripteddoc000000000000001';
      const here = tokenless(await answer(both.base, carrier, id, MAIN_LINE));
      expect(here).toBe(tokenless(await answer(alone.base, carrier, id, MAIN_LINE)));
      expect(here).toContain('interruptible="none"');
      expect(here).not.toContain('events=');
    }
  }, 20_000);

  it('a converse call\'s reconnect document is interruptible by speech, with Telnyx\'s events on', async () => {
    const { base } = await hostOf(converseWith(), { BARGE_IN: 'none' });
    const callId = 'v3:host-converse-reconnect-1';
    const doc = await answer(base, 'telnyx', callId, VISIT_LINE);
    const relay = await FakeRelay.connect(socketUrl(doc, base));
    relays.push(relay);
    relay.send({
      type: 'setup', from: null, to: null, direction: null, callControlId: callId, callSid: '5e9fcc12-0000-4000-8000-000000000001',
      callStatus: 'active', customParameters: { telnyx_call_from: CALLER, telnyx_call_to: VISIT_LINE }, sessionId: '05ff737c-0000-4000-8000-000000000001',
    });
    await relay.waitFor(() => finals(relay).length >= 1);
    const again = await (await fetch(`${base}/cr-action/telnyx`, form({ CallSid: callId, CallStatus: 'in-progress', SessionStatus: 'failed' }))).text();
    expect(again).toContain('interruptible="speech"');
    expect(again).toContain('events="speaker-events tokens-played"');
    expect(again).toContain(`voice="${VOICES.telnyx}"`);
  }, 20_000);

  it('a Twilio voice with its provider is written with that provider, whatever TTS_PROVIDER says', async () => {
    const { base } = await hostOf(converseWith(true, { voice: 'Lupe-Neural', provider: 'Amazon' }), { TTS_PROVIDER: 'Google', TTS_VOICE: 'en-US-Neural2-F' });
    const doc = await answer(base, 'twilio', 'CAhostconversedoc000000000000002', VISIT_LINE);
    expect(doc).toContain('ttsProvider="Amazon"');
    expect(doc).toContain('voice="Lupe-Neural"');
    expect(doc).not.toContain('ttsProvider="Google"');
    expect(doc).not.toContain('en-US-Neural2-F');
  }, 20_000);

  it('a voice name alone keeps today\'s behaviour: the deployment\'s provider, else none', async () => {
    const withProvider = await hostOf(converseWith(), { TTS_PROVIDER: 'Google', TTS_VOICE: 'en-US-Neural2-F' });
    const doc = await answer(withProvider.base, 'twilio', 'CAhostconversedoc000000000000003', VISIT_LINE);
    expect(doc).toContain(`voice="${VOICES.twilio}"`);
    expect(doc).toContain('ttsProvider="Google"');
    const bare = await hostOf(converseWith());
    const none = await answer(bare.base, 'twilio', 'CAhostconversedoc000000000000004', VISIT_LINE);
    expect(none).toContain(`voice="${VOICES.twilio}"`);
    expect(none).not.toContain('ttsProvider=');
  }, 20_000);

  it('a converse call handed to a person is put through to agent.yaml\'s transfer number, else HANDOFF_NUMBER', async () => {
    for (const [transfer, number] of [[true, TRANSFER], [false, HANDOFF_NUMBER]] as const) {
      const { base } = await hostOf(converseWith(transfer));
      const callId = transfer ? 'CAhostconversehandoff00000000001' : 'CAhostconversehandoff00000000002';
      const relay = await call(base, callId, VISIT_LINE);
      await relay.waitFor(() => finals(relay).length >= 1);
      const doc = await (await fetch(`${base}/cr-action/twilio`, form({ CallSid: callId, CallStatus: 'in-progress', HandoffData: JSON.stringify({ reasonCode: 'handoff', completed: [] }) }))).text();
      expect(doc).toContain(`<Dial`);
      expect(doc).toContain(number);
      expect(doc).not.toContain(transfer ? HANDOFF_NUMBER : TRANSFER);
    }
  }, 20_000);

  it('lists a converse call on the console\'s Calls page as a call on its carrier, from its number, and its detail has its turns', async () => {
    const model = fakeModel([[text('Sure, Tuesday works.'), done()], [{ type: 'tool_call', id: 'c1', name: 'end_call', args: {} }, done('tool')]]);
    const { base } = await hostOf(converseWith(), { DASHBOARD: 'on' }, model);
    const callId = 'CAhostconverseconsole00000000001';
    const relay = await call(base, callId, VISIT_LINE);
    await relay.waitFor(() => finals(relay).length >= 1);
    relay.prompt('Is Tuesday free?');
    await relay.waitFor(() => finals(relay).length >= 2);
    relay.prompt('That is all, thanks.');
    await relay.waitFor((m) => m.type === 'end', 4000);
    await new Promise((r) => setTimeout(r, 100));
    const calls = (await (await fetch(`${base}/dashboard/calls`)).json()) as { rows: Record<string, unknown>[] };
    const row = calls.rows.find((r) => r.callSid === callId);
    expect(row).toMatchObject({ app: 'converse', channel: 'voice', provider: 'twilio', from: '…0123', turns: 2, ending: { kind: 'handled', text: 'handled' } });
    const replay = (await (await fetch(`${base}/dashboard/traces/${callId}?app=converse`)).json()) as { records: Record<string, unknown>[] };
    expect(replay.records.map((r) => r.kind)).toEqual(['converse', 'converse', 'converse']);
    expect(replay.records[1]).toMatchObject({ said: 'Is Tuesday free?', heard: { cutIn: false } });
    expect(JSON.stringify(calls)).not.toContain(CALLER);
  }, 20_000);
});
