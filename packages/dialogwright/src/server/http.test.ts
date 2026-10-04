import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as signEd25519 } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clipName, createRequestHandler, decideActionTwiml, type HttpDeps } from './http';
import { loadConfig } from './config';
import { computeTwilioSignature } from './signature';
import { SessionStore } from './sessions';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { TraceWriter } from '../trace/writer';
import { DashboardBus } from './dashboard/bus';
import { validateRoutes, type AppRoute } from './appRoutes';
import { VOICE_RELAY } from '../channel/caps';
import { useTestkit } from '../testing/apps';
import type { App } from '../core/app/types';
import { libraryApp } from '../define/fixture/app';

useTestkit();

const TOKEN = 'authtok';
let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function deps(overrides: Record<string, string> = {}, audioDir?: string): HttpDeps & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'http-'));
  const config = loadConfig({
    PUBLIC_HOST: 'demo.ngrok.app',
    TWILIO_AUTH_TOKEN: TOKEN,
    HANDOFF_NUMBER: '+15551234567',
    RECONNECT_LIMIT: '1',
    AUDIO_DIR: audioDir ?? dir,
    CHAT: 'off',
    ...overrides,
  });
  const store = new SessionStore((callSid) => ({
    session: newSession(callSid, 0, VOICE_RELAY),
    opts: { client: new HeuristicStubClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18' },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`)),
  }), 60_000);
  return { config, store, tokens: new CallTokens(60_000), hints: 'depot, parcel', log: () => {}, dir };
}

async function listen(d: HttpDeps): Promise<string> {
  server = createServer(createRequestHandler(d));
  // On 127.0.0.1, the address the tests dial: on every address the operating system may hand out a port
  // another process holds on 127.0.0.1 alone, and the request would reach that process (index.ts ServerOverrides.host).
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return `http://127.0.0.1:${port}`;
}

async function post(base: string, path: string, params: Record<string, string>, sign = true, host = 'demo.ngrok.app') {
  const body = new URLSearchParams(params).toString();
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (sign) headers['x-twilio-signature'] = computeTwilioSignature(`https://${host}${path}`, params, TOKEN);
  const res = await fetch(base + path, { method: 'POST', headers, body });
  return { status: res.status, text: await res.text() };
}

async function get(base: string, path: string) {
  const res = await fetch(base + path);
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: Buffer.from(await res.arrayBuffer()) };
}

async function head(base: string, path: string) {
  const res = await fetch(base + path, { method: 'HEAD' });
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: Buffer.from(await res.arrayBuffer()) };
}

describe('http routes', () => {
  it('serves health, counting live sessions apart from ended ones still retained', async () => {
    const d = deps();
    const base = await listen(d);
    expect(await (await fetch(base + '/health')).json()).toEqual({ ok: true, sessions: 0, retained: 0 });
    const sock = { send: () => {}, close: () => {} };
    d.store.create('CA1', sock);
    d.store.create('CA2', sock);
    expect(await (await fetch(base + '/health')).json()).toEqual({ ok: true, sessions: 2, retained: 0 });
    d.store.end('CA2');
    const res = await fetch(base + '/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessions: 1, retained: 1 });
  });

  it('answers /voice with connect TwiML and a token bound to the call', async () => {
    const d = deps();
    const base = await listen(d);
    const r = await post(base, '/voice', { CallSid: 'CA1', From: '+1', To: '+2' });
    expect(r.status).toBe(200);
    const token = /token=([0-9a-f]{32})/.exec(r.text)?.[1];
    expect(token).toBeDefined();
    expect(d.tokens.verify(token!, 'CA1', 'twilio')).toBe(true);
    expect(r.text).toContain('hints="depot, parcel"');
  });

  it('logs a /voice call with the caller number masked to its last four', async () => {
    const lines: string[] = [];
    const base = await listen({ ...deps(), log: (l) => lines.push(l) });
    await post(base, '/voice', { CallSid: 'CA1', From: '+15555550199', To: '+2' });
    expect(lines).toContain('/voice CA1 from …0199');
    expect(lines.join('\n')).not.toContain('5555550199');
  });

  it('masks the caller number in the raw frame log for the /cr-action webhook, at write time', async () => {
    const d = deps();
    const base = await listen(d);
    const sock = { send: () => {}, close: () => {} };
    d.store.create('CA1', sock);
    await post(base, '/cr-action', {
      CallSid: 'CA1', CallStatus: 'completed', SessionStatus: 'completed',
      From: '+15555550199', To: '+15555550100', Caller: '+15555550199', Called: '+15555550100',
    });
    const line = readFileSync(join(d.dir, 'CA1.frames.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { dir: string; msg: Record<string, unknown> }).find((l) => l.dir === 'http');
    expect(line?.msg).toMatchObject({ route: '/cr-action', From: '…0199', To: '…0100', Caller: '…0199', Called: '…0100' });
    expect(JSON.stringify(line)).not.toContain('5555550199');
  });

  it('rejects a missing or bad signature', async () => {
    const base = await listen(deps());
    expect((await post(base, '/voice', { CallSid: 'CA1' }, false)).status).toBe(403);
    expect((await post(base, '/cr-action', { CallSid: 'CA1' }, true, 'other.host')).status).toBe(403);
  });

  it('honors SIGNATURE_CHECK=off', async () => {
    const base = await listen(deps({ SIGNATURE_CHECK: 'off' }));
    expect((await post(base, '/voice', { CallSid: 'CA1' }, false)).status).toBe(200);
  });

  it('returns 404 elsewhere', async () => {
    const base = await listen(deps());
    expect((await fetch(base + '/nope')).status).toBe(404);
  });

  it('returns 413 for an oversized body', async () => {
    const base = await listen(deps());
    const big = 'x'.repeat(70 * 1024);
    const r = await post(base, '/voice', { CallSid: 'CA1', Big: big });
    expect(r.status).toBe(413);
  });

  it('returns 400 for /voice without CallSid', async () => {
    const base = await listen(deps());
    const r = await post(base, '/voice', { From: '+1' });
    expect(r.status).toBe(400);
  });

  it('answers HEAD /health', async () => {
    const base = await listen(deps());
    const res = await fetch(base + '/health', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('serves audio clips with the right type and cache headers, and nothing else under /audio', async () => {
    const audioDir = mkdtempSync(join(tmpdir(), 'audio-'));
    const base = await listen(deps({}, audioDir));
    const get_ = (path: string) => get(base, path);
    const head_ = (path: string) => head(base, path);
    writeFileSync(join(audioDir, 'greeting.0.wav'), Buffer.from('RIFFdata'));
    writeFileSync(join(audioDir, 'Loud.0.WAV'), Buffer.from('RIFFloud'));
    const ok = await get_('/audio/greeting.0.wav');
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('audio/wav');
    expect(ok.headers['cache-control']).toBe('public, max-age=86400');
    expect(ok.body.toString()).toBe('RIFFdata');
    // No Twilio signature header is sent, and /audio still answers 200: this route is not gated
    // by the signature check that /voice and /cr-action apply.
    const headRes = await head_('/audio/greeting.0.wav');
    expect(headRes.status).toBe(200);
    expect(headRes.headers['content-length']).toBe(String(Buffer.byteLength('RIFFdata')));
    expect(headRes.body.length).toBe(0);
    expect((await get_('/audio/Loud.0.WAV')).headers['content-type']).toBe('audio/wav');
    expect((await get_('/audio/missing.wav')).status).toBe(404);
    expect((await get_('/audio/notes.txt')).status).toBe(404);
    // fetch's URL parser collapses a literal `../` before the request is even sent, so these
    // traversal attempts are shaped to survive that normalization and actually reach the
    // server: an escaped `/` inside what would otherwise be a `..` segment.
    expect((await get_('/audio/..%2fpackage.json')).status).toBe(404);
    expect((await get_('/audio/%2e%2e%2fetc%2fpasswd')).status).toBe(404);
    expect((await get_('/audio/sub%2fclip.wav')).status).toBe(404);
    expect((await get_('/audio/%E0%A4%A')).status).toBe(404);
  });

  it('serves a clip when the request carries a content-hash query string', async () => {
    const audioDir = mkdtempSync(join(tmpdir(), 'audio-'));
    const base = await listen(deps({}, audioDir));
    writeFileSync(join(audioDir, 'greeting.0.wav'), Buffer.from('RIFFdata'));
    const res = await get(base, '/audio/greeting.0.wav?v=abc1234567');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
    expect(res.body.toString()).toBe('RIFFdata');
  });
});

describe('routes by voice provider', () => {
  it('answers /voice/twilio at the provider\'s own paths and the legacy /voice at the old ones', async () => {
    const d = deps();
    const base = await listen(d);
    const a = await post(base, '/voice/twilio', { CallSid: 'CA1', From: '+15555550100' });
    expect(a.status).toBe(200);
    expect(a.text).toContain('url="wss://demo.ngrok.app/conversation/twilio?token=');
    expect(a.text).toContain('<Connect action="https://demo.ngrok.app/cr-action/twilio">');
    const token = /token=([0-9a-f]{32})/.exec(a.text)![1]!;
    expect(d.tokens.verify(token, 'CA1', 'twilio')).toBe(true);
    const b = await post(base, '/voice', { CallSid: 'CA2', From: '+15555550100' });
    expect(b.text).toContain('url="wss://demo.ngrok.app/conversation?token=');
    expect(b.text).toContain('<Connect action="https://demo.ngrok.app/cr-action">');
  });

  it('checks the signature over the provider\'s own path, and logs the call by its path', async () => {
    const lines: string[] = [];
    const base = await listen({ ...deps(), log: (l) => lines.push(l) });
    expect((await post(base, '/voice/twilio', { CallSid: 'CA1' }, false)).status).toBe(403);
    expect((await post(base, '/voice/twilio', { CallSid: 'CA1', From: '+15555550199' })).status).toBe(200);
    expect(lines).toContain('/voice/twilio: signature rejected');
    expect(lines).toContain('/voice/twilio CA1 from …0199');
    expect((await post(base, '/voice/twilio', { From: '+15555550199' })).status).toBe(400);
  });

  it('is 404 for a provider that is not enabled or not known, and for a GET', async () => {
    const base = await listen(deps());
    expect((await post(base, '/voice/telnyx', { CallSid: 'x' })).status).toBe(404);
    expect((await post(base, '/cr-action/acme', { CallSid: 'x' })).status).toBe(404);
    expect((await post(base, '/voice/twilio/extra', { CallSid: 'x' })).status).toBe(404);
    expect((await fetch(base + '/voice/twilio')).status).toBe(404);
  });

  it('reconnects through /cr-action/twilio to the provider\'s socket, and through /cr-action to the legacy one', async () => {
    const d = deps();
    const base = await listen(d);
    d.store.create('CA1', { send: () => {}, close: () => {} });
    const r = await post(base, '/cr-action/twilio', { CallSid: 'CA1', CallStatus: 'in-progress', SessionStatus: 'failed' });
    expect(r.status).toBe(200);
    expect(r.text).toContain('url="wss://demo.ngrok.app/conversation/twilio?token=');
    d.store.create('CA2', { send: () => {}, close: () => {} });
    const legacy = await post(base, '/cr-action', { CallSid: 'CA2', CallStatus: 'in-progress', SessionStatus: 'failed' });
    expect(legacy.text).toContain('url="wss://demo.ngrok.app/conversation?token=');
  });

  it('ends a call through /cr-action/twilio and logs the webhook under its own route', async () => {
    const d = deps();
    const base = await listen(d);
    d.store.create('CA1', { send: () => {}, close: () => {} });
    const r = await post(base, '/cr-action/twilio', { CallSid: 'CA1', HandoffData: '{"reasonCode":"completed"}', From: '+15555550199' });
    expect(r.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    const line = readFileSync(join(d.dir, 'CA1.frames.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { dir: string; msg: Record<string, unknown> }).find((l) => l.dir === 'http');
    expect(line?.msg).toMatchObject({ route: '/cr-action/twilio', From: '…0199' });
  });

  it('answers a legacy /cr-action that names no call by hanging up, as it always has', async () => {
    const base = await listen(deps());
    const r = await post(base, '/cr-action', { CallStatus: 'completed' });
    expect(r.status).toBe(200);
    expect(r.text).toContain('<Hangup/>');
  });

  it('decides a legacy /cr-action that names no call on its fields, byte for byte as before providers', async () => {
    const lines: string[] = [];
    const base = await listen({ ...deps(), log: (l) => lines.push(l) });
    const dial = await post(base, '/cr-action', { HandoffData: '{"reasonCode":"billing"}' });
    expect(dial.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Dial>+15551234567</Dial></Response>');
    await post(base, '/cr-action', { CallStatus: 'completed', SessionStatus: 'ended' });
    expect(lines).toContain('/cr-action ? ended -> hangup:ended');
  });

  it('refuses every signature when a provider has no secret, rather than checking against an empty key', async () => {
    const d = deps();
    const base = await listen({ ...d, config: { ...d.config, providerSecrets: {} } });
    const body = new URLSearchParams({ CallSid: 'CA1' }).toString();
    const forged = computeTwilioSignature('https://demo.ngrok.app/voice/twilio', { CallSid: 'CA1' }, '');
    const res = await fetch(base + '/voice/twilio', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': forged }, body });
    expect(res.status).toBe(403);
  });
});

/** The library fixture (en-US and es) with a voice block that names its languages, voices and a Spanish number. */
const SPANISH_NUMBER = '+15555550142';
const bilingual: App = {
  ...libraryApp,
  voice: {
    ...libraryApp.voice,
    numbers: { [SPANISH_NUMBER]: 'es' },
    locales: {
      'en-US': { voices: { twilio: 'en-US-Journey-O', telnyx: 'Telnyx.Ultra.Callie' } },
      es: {
        tts: 'es-US', transcription: 'es-MX', voices: { twilio: 'es-US-Journey-F', telnyx: 'Telnyx.Ultra.Asher' }, hints: ['renovar', 'reserva'],
        recognition: { twilio: { provider: 'Google', model: 'telephony' }, telnyx: { provider: 'google' } },
      },
    },
  },
};

describe('a call\'s languages (voice.numbers, voice.locales)', () => {
  it('starts a call to the listed number in its locale, with every language the call may switch to', async () => {
    const base = await listen({ ...deps({ TTS_PROVIDER: 'Google', TTS_VOICE: 'en-US-Neural2-F' }), app: bilingual });
    const r = await post(base, '/voice/twilio', { CallSid: 'CA1', From: '+15555550100', To: SPANISH_NUMBER });
    expect(r.text).toContain(
      'hints="renovar, reserva, zero, oh, one, two, three, four, five, six, seven, eight, nine, double" ' +
        'ttsLanguage="es-US" transcriptionLanguage="es-MX">' +
        '<Language code="en-US" ttsProvider="Google" voice="en-US-Journey-O" transcriptionProvider="Deepgram" speechModel="flux"/>' +
        '<Language code="es-US" ttsProvider="Google" voice="es-US-Journey-F" transcriptionProvider="Google" speechModel="telephony"/>' +
        '<Parameter name="locale" value="es"/></ConversationRelay>',
    );
    // The languages' voices and recognizers differ, so the relay element names none for either to inherit.
    expect(r.text).toContain(`" partialPrompts="true"`);
    expect(r.text).not.toContain('" transcriptionProvider="Deepgram" speechModel="flux" partialPrompts');
    // The legacy /voice names the same languages.
    expect((await post(base, '/voice', { CallSid: 'CA2', To: SPANISH_NUMBER })).text).toContain('<Parameter name="locale" value="es"/>');
  });

  it('starts any other call in the default locale, with the app\'s voice for it and the app\'s hints', async () => {
    const base = await listen({ ...deps({ TTS_PROVIDER: 'Google', TTS_VOICE: 'en-US-Neural2-F' }), app: bilingual });
    for (const params of [{ CallSid: 'CA1', To: '+15555550100' }, { CallSid: 'CA2' }] as Array<Record<string, string>>) {
      const r = await post(base, '/voice/twilio', params);
      expect(r.text).toContain('hints="depot, parcel" ttsLanguage="en-US" transcriptionLanguage="en-US"><Language code="en-US" ttsProvider="Google" voice="en-US-Journey-O" ');
      expect(r.text).toContain('<Parameter name="locale" value="en-US"/>');
      expect(r.text).not.toContain('en-US-Neural2-F');
    }
  });

  it('gives the default locale the deployment\'s voice when the app names none, and another locale the carrier\'s default', async () => {
    const app: App = { ...libraryApp, voice: { ...libraryApp.voice, numbers: { [SPANISH_NUMBER]: 'es' } } };
    const base = await listen({ ...deps({ TTS_PROVIDER: 'Google', TTS_VOICE: 'en-US-Neural2-F' }), app });
    const en = await post(base, '/voice/twilio', { CallSid: 'CA1' });
    const languages = '<Language code="en-US" ttsProvider="Google" voice="en-US-Neural2-F" transcriptionProvider="Deepgram" speechModel="flux"/><Language code="es"/>';
    expect(en.text).toContain(`ttsLanguage="en-US" transcriptionLanguage="en-US">${languages}<Parameter name="locale" value="en-US"/>`);
    const es = await post(base, '/voice/twilio', { CallSid: 'CA2', To: SPANISH_NUMBER });
    expect(es.text).toContain(`hints="depot, parcel" ttsLanguage="es" transcriptionLanguage="es">${languages}<Parameter name="locale" value="es"/>`);
  });

  it('writes a one-locale en-US app\'s documents byte for byte as an app without locales, on every path', async () => {
    const oneLocale: App = { ...libraryApp, locales: { default: 'en-US', prompts: {} } };
    const before = await listen(deps({ TTS_PROVIDER: 'Google', TTS_VOICE: 'en-US-Neural2-F' }));
    const without = await Promise.all(['/voice/twilio', '/voice'].map(async (path) => (await post(before, path, { CallSid: 'CA1', To: SPANISH_NUMBER })).text.replace(/token=[0-9a-f]+/, '')));
    await new Promise<void>((r) => server!.close(() => r()));
    const after = await listen({ ...deps({ TTS_PROVIDER: 'Google', TTS_VOICE: 'en-US-Neural2-F' }), app: oneLocale });
    const withApp = await Promise.all(['/voice/twilio', '/voice'].map(async (path) => (await post(after, path, { CallSid: 'CA1', To: SPANISH_NUMBER })).text.replace(/token=[0-9a-f]+/, '')));
    expect(withApp).toEqual(without);
    expect(withApp[0]).not.toContain('Language');
  });

  it('gives the default locale the deployment\'s recognizer, another locale the carrier\'s default, and the app\'s wherever it names one', async () => {
    const env = { TWILIO_TRANSCRIPTION_PROVIDER: 'Deepgram', TWILIO_SPEECH_MODEL: 'nova-3-general' };
    const app: App = { ...libraryApp, voice: { ...libraryApp.voice, numbers: { [SPANISH_NUMBER]: 'es' } } };
    const base = await listen({ ...deps(env), app });
    expect((await post(base, '/voice/twilio', { CallSid: 'CA1', To: SPANISH_NUMBER })).text).toContain(
      'transcriptionLanguage="es"><Language code="en-US" transcriptionProvider="Deepgram" speechModel="nova-3-general"/><Language code="es"/>',
    );
    await new Promise<void>((r) => server!.close(() => r()));
    // An app that gives its default locale `{}` asks for the carrier's default there too.
    const own: App = { ...app, voice: { ...app.voice, locales: { 'en-US': { recognition: { twilio: {} } }, es: { recognition: { twilio: { model: 'nova-2-general' } } } } } };
    const again = await listen({ ...deps(env), app: own });
    const doc = (await post(again, '/voice/twilio', { CallSid: 'CA2' })).text;
    expect(doc).toContain('transcriptionLanguage="en-US"><Language code="en-US"/><Language code="es" speechModel="nova-2-general"/>');
    expect(doc).not.toContain('transcriptionProvider=');
  });

  it('names a one-locale app\'s language, voice and recognizer on the relay element when its default is not en-US', async () => {
    const spanishOnly: App = { ...libraryApp, locales: { default: 'es', prompts: {} } };
    const base = await listen({ ...deps({ TTS_PROVIDER: 'Google', TTS_VOICE: 'es-US-Neural2-A', TWILIO_SPEECH_MODEL: 'nova-3-general' }), app: spanishOnly });
    const r = await post(base, '/voice/twilio', { CallSid: 'CA1' });
    expect(r.text).toContain('" transcriptionProvider="Deepgram" speechModel="nova-3-general" partialPrompts="true"');
    expect(r.text).toContain('ttsLanguage="es" transcriptionLanguage="es" ttsProvider="Google" voice="es-US-Neural2-A"><Language code="es"/><Parameter name="locale" value="es"/></ConversationRelay>');
  });

  it('keeps a one-locale en-US app\'s documents those of an app without locales with the recognizer set, and names it', async () => {
    const env = { TWILIO_TRANSCRIPTION_PROVIDER: 'Google', TWILIO_SPEECH_MODEL: 'telephony' };
    const oneLocale: App = { ...libraryApp, locales: { default: 'en-US', prompts: {} } };
    const before = await listen(deps(env));
    const without = (await post(before, '/voice/twilio', { CallSid: 'CA1' })).text.replace(/token=[0-9a-f]+/, '');
    await new Promise<void>((r) => server!.close(() => r()));
    const after = await listen({ ...deps(env), app: oneLocale });
    const withApp = (await post(after, '/voice/twilio', { CallSid: 'CA1' })).text.replace(/token=[0-9a-f]+/, '');
    expect(withApp).toBe(without);
    expect(withApp).toContain('" transcriptionProvider="Google" speechModel="telephony" partialPrompts="true"');
  });

  it('writes a Twilio voice that names its provider with that provider, whatever the deployment\'s TTS_PROVIDER', async () => {
    const app: App = {
      ...libraryApp,
      voice: {
        ...libraryApp.voice,
        locales: {
          'en-US': { voices: { twilio: 'en-US-Journey-O' } },
          es: { tts: 'es-US', voices: { twilio: { voice: 'es-US-Neural2-A', provider: 'Google' }, telnyx: 'Telnyx.Ultra.Asher' } },
        },
      },
    };
    // No TTS_PROVIDER: the name alone has no provider (Twilio's default), the named one has its own.
    const plain = await listen({ ...deps(), app });
    expect((await post(plain, '/voice/twilio', { CallSid: 'CA1' })).text).toContain(
      '<Language code="en-US" voice="en-US-Journey-O" transcriptionProvider="Deepgram" speechModel="flux"/><Language code="es-US" ttsProvider="Google" voice="es-US-Neural2-A"/>',
    );
    await new Promise<void>((r) => server!.close(() => r()));
    // TTS_PROVIDER=Amazon: the name alone takes the deployment's provider, as before; the named one keeps Google.
    const amazon = await listen({ ...deps({ TTS_PROVIDER: 'Amazon', TTS_VOICE: 'Joanna-Neural' }), app });
    expect((await post(amazon, '/voice/twilio', { CallSid: 'CA2' })).text).toContain(
      '<Language code="en-US" ttsProvider="Amazon" voice="en-US-Journey-O" transcriptionProvider="Deepgram" speechModel="flux"/><Language code="es-US" ttsProvider="Google" voice="es-US-Neural2-A"/>',
    );
  });

  it('reconnects a call in the language it is in now, not the one it started in', async () => {
    const d = { ...deps(), app: bilingual };
    const base = await listen(d);
    d.store.create('CA1', { send: () => {}, close: () => {} }).session.locale = 'es';
    const r = await post(base, '/cr-action/twilio', { CallSid: 'CA1', To: '+15555550100', CallStatus: 'in-progress', SessionStatus: 'failed' });
    expect(r.text).toContain(
      'ttsLanguage="es-US" transcriptionLanguage="es-MX"><Language code="en-US" voice="en-US-Journey-O" transcriptionProvider="Deepgram" speechModel="flux"/>' +
        '<Language code="es-US" voice="es-US-Journey-F" transcriptionProvider="Google" speechModel="telephony"/>',
    );
    expect(r.text).toContain('<Parameter name="locale" value="es"/>');
  });
});

describe('Telnyx webhooks', () => {
  // A key pair made here: Telnyx signs with the private half, the server is configured with the public one.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const TELNYX_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

  async function postTelnyx(base: string, path: string, body: string, opts: { sign?: boolean; type?: string; at?: number } = {}) {
    const ts = String(opts.at ?? Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = { 'content-type': opts.type ?? 'application/x-www-form-urlencoded' };
    if (opts.sign !== false) {
      headers['telnyx-timestamp'] = ts;
      headers['telnyx-signature-ed25519'] = signEd25519(null, Buffer.from(`${ts}|${body}`), privateKey).toString('base64');
    }
    const res = await fetch(base + path, { method: 'POST', headers, body });
    return { status: res.status, text: await res.text(), type: res.headers.get('content-type') };
  }

  it('answers a signed /voice/telnyx with TeXML at its own socket path', async () => {
    const d = deps({ VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY });
    const base = await listen(d);
    const r = await postTelnyx(base, '/voice/telnyx', 'CallSid=v2%3Aabc&From=%2B15555550100');
    expect(r.status).toBe(200);
    expect(r.type).toBe('text/xml');
    expect(r.text).toContain('url="wss://demo.ngrok.app/conversation/telnyx?token=');
    expect(r.text).toContain('<Connect action="https://demo.ngrok.app/cr-action/telnyx">');
    const token = /token=([0-9a-f]{32})/.exec(r.text)![1]!;
    expect(d.tokens.verify(token, 'v2:abc', 'telnyx')).toBe(true);
  });

  it('reads a JSON webhook too', async () => {
    const d = deps({ VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY });
    const base = await listen(d);
    const r = await postTelnyx(base, '/voice/telnyx', JSON.stringify({ call_control_id: 'v2:json', from: '+15555550100' }), { type: 'application/json' });
    expect(r.status).toBe(200);
    expect(d.tokens.verify(/token=([0-9a-f]{32})/.exec(r.text)![1]!, 'v2:json', 'telnyx')).toBe(true);
  });

  it('refuses an unsigned, a stale and a Twilio-signed webhook', async () => {
    const base = await listen(deps({ VOICE_PROVIDERS: 'twilio,telnyx', TELNYX_PUBLIC_KEY }));
    expect((await postTelnyx(base, '/voice/telnyx', 'CallSid=v2%3Aabc', { sign: false })).status).toBe(403);
    expect((await postTelnyx(base, '/voice/telnyx', 'CallSid=v2%3Aabc', { at: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(403);
    expect((await post(base, '/voice/telnyx', { CallSid: 'v2:abc' })).status).toBe(403);
    // And the other way round: Twilio's paths still want Twilio's signature.
    expect((await postTelnyx(base, '/voice/twilio', 'CallSid=CA1')).status).toBe(403);
    expect((await post(base, '/voice/twilio', { CallSid: 'CA1' })).status).toBe(200);
  });

  it('ends a Telnyx call through /cr-action/telnyx with the end frame\'s data', async () => {
    const d = deps({ VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY });
    const base = await listen(d);
    d.store.create('v2:abc', { send: () => {}, close: () => {} });
    const done = await postTelnyx(base, '/cr-action/telnyx', 'CallSid=v2%3Aabc&HandoffData=%7B%22reasonCode%22%3A%22completed%22%7D');
    expect(done.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(d.store.get('v2:abc')?.ended).toBe(true);
    const dial = await postTelnyx(base, '/cr-action/telnyx', JSON.stringify({ CallSid: 'v2:def', handoffData: '{"reasonCode":"billing"}' }), { type: 'application/json' });
    expect(dial.text).toContain('<Dial>+15551234567</Dial>');
  });

  it('reconnects a live Telnyx call to its own socket', async () => {
    const d = deps({ VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY });
    const base = await listen(d);
    d.store.create('v2:abc', { send: () => {}, close: () => {} });
    const r = await postTelnyx(base, '/cr-action/telnyx', 'CallSid=v2%3Aabc&CallStatus=in-progress&SessionStatus=failed');
    expect(r.text).toContain('url="wss://demo.ngrok.app/conversation/telnyx?token=');
  });

  it('gives each carrier only its own voice when a deployment answers on both', async () => {
    const d = deps({
      VOICE_PROVIDERS: 'twilio,telnyx', TELNYX_PUBLIC_KEY,
      TTS_PROVIDER: 'Google', TTS_VOICE: 'en-US-Neural2-F', TELNYX_VOICE: 'Telnyx.Ultra.Callie',
    });
    const base = await listen(d);
    const telnyx = await postTelnyx(base, '/voice/telnyx', 'CallSid=v2%3Aabc');
    expect(telnyx.text).toContain(' voice="Telnyx.Ultra.Callie"/>');
    expect(telnyx.text).not.toContain('en-US-Neural2-F');
    expect(telnyx.text).not.toContain('ttsProvider=');
    for (const path of ['/voice/twilio', '/voice']) {
      const twilio = await post(base, path, { CallSid: 'CA1' });
      expect(twilio.text, path).toContain(' ttsProvider="Google" voice="en-US-Neural2-F"/>');
      expect(twilio.text, path).not.toContain('Telnyx.Ultra.Callie');
    }
    // A reconnect keeps the carrier's own voice too.
    d.store.create('v2:abc', { send: () => {}, close: () => {} });
    const again = await postTelnyx(base, '/cr-action/telnyx', 'CallSid=v2%3Aabc&CallStatus=in-progress&SessionStatus=failed');
    expect(again.text).toContain(' voice="Telnyx.Ultra.Callie"/>');
    expect(again.text).not.toContain('en-US-Neural2-F');
  });

  it('starts a Telnyx call in the locale of the number called, with the app\'s Telnyx voices', async () => {
    const base = await listen({ ...deps({ VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY, TELNYX_VOICE: 'Telnyx.NaturalHD.astra' }), app: bilingual });
    const r = await postTelnyx(base, '/voice/telnyx', `CallSid=v2%3Aabc&To=${encodeURIComponent(SPANISH_NUMBER)}`);
    expect(r.text).toContain(
      'language="es-US"><Language code="en-US" voice="Telnyx.Ultra.Callie"/><Language code="es-US" voice="Telnyx.Ultra.Asher" transcriptionProvider="google"/>' +
        '<Parameter name="locale" value="es"/></ConversationRelay>',
    );
    expect(r.text).not.toContain('ttsProvider=');
    expect(r.text).not.toContain('astra');
  });

  it('sends Telnyx no voice when only the Twilio voice is set', async () => {
    const base = await listen(deps({ VOICE_PROVIDERS: 'twilio,telnyx', TELNYX_PUBLIC_KEY, TTS_PROVIDER: 'Google', TTS_VOICE: 'en-US-Neural2-F' }));
    const r = await postTelnyx(base, '/voice/telnyx', 'CallSid=v2%3Aabc');
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('voice=');
  });

  it('leaves the legacy Twilio paths unanswered when Twilio is not enabled', async () => {
    const base = await listen(deps({ VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY }));
    expect((await post(base, '/voice', { CallSid: 'CA1' })).status).toBe(404);
    expect((await post(base, '/cr-action', { CallSid: 'CA1' })).status).toBe(404);
    expect((await post(base, '/voice/twilio', { CallSid: 'CA1' })).status).toBe(404);
  });
});

/** A raw request, so the test controls every header, `Host` included. */
function raw(base: string, method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const url = new URL(base + path);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('CONSOLE_LOCAL_ONLY', () => {
  // A stand-in chat, mounted local-only as an app's chat is: answers every /chat route it is handed,
  // so a 404 can only come from the guard.
  const fakeChat: AppRoute = {
    label: 'chat', path: '/chat', localOnly: true,
    handle: async (_req, res, path) => {
      if (!path.startsWith('/chat')) return false;
      res.writeHead(200);
      res.end('chat');
      return true;
    },
  };
  const tunnelled: Array<[string, Record<string, string>]> = [
    ['x-forwarded-for', { 'x-forwarded-for': '203.0.113.9' }],
    ['x-forwarded-proto', { 'x-forwarded-proto': 'https' }],
    ['an ngrok header', { 'ngrok-skip-browser-warning': '1' }],
    ['the public Host', { host: 'demo.ngrok.app' }],
  ];

  it.each(tunnelled)('answers 404 on the console and chat to a request with %s', async (_label, headers) => {
    const d = { ...deps(), bus: new DashboardBus(), routes: [fakeChat] };
    const base = await listen(d);
    for (const [method, path] of [['GET', '/dashboard'], ['GET', '/dashboard/traces'], ['GET', '/chat'], ['POST', '/chat/login'], ['POST', '/chat/turn']] as const) {
      expect((await raw(base, method, path, headers)).status, `${method} ${path}`).toBe(404);
    }
  });

  it('hands a route only the paths that are its own, and the guard calls the same paths its own', async () => {
    const handed: string[] = [];
    const chat: AppRoute = { ...fakeChat, handle: async (_req, res, path) => { handed.push(path); res.writeHead(200); res.end('chat'); return true; } };
    const d = { ...deps(), bus: new DashboardBus(), routes: [chat] };
    const base = await listen(d);
    const tunnel = { 'x-forwarded-for': '203.0.113.9' };
    // Its own: the path itself and anything under it, kept off the tunnel by the guard.
    for (const path of ['/chat', '/chat/', '/chat/login', '/chat?x=1']) {
      expect((await raw(base, 'GET', path, tunnel)).status, `tunnel ${path}`).toBe(404);
      expect((await raw(base, 'GET', path)).body, `direct ${path}`).toBe('chat');
    }
    expect(handed.sort()).toEqual(['/chat', '/chat', '/chat/', '/chat/login']);
    // Not its own: never handed to it, with or without the tunnel, so it cannot answer them.
    handed.length = 0;
    for (const path of ['/chatX', '/chat2/turn', '/%63hat', '/%63hat/login', '//chat', '/CHAT', '/portal/../chat', '/chat%2fturn']) {
      expect((await raw(base, 'GET', path, tunnel)).status, `tunnel ${path}`).toBe(404);
      expect((await raw(base, 'GET', path)).status, `direct ${path}`).toBe(404);
    }
    expect(handed).toEqual([]);
  });

  it('keeps odd spellings of the console off the tunnel or off the console', async () => {
    const d = { ...deps(), bus: new DashboardBus(), routes: [fakeChat] };
    const base = await listen(d);
    const tunnel = { 'x-forwarded-for': '203.0.113.9' };
    // Under /dashboard by name: guarded. Not under it by name: not the console, whatever a decoder might make of it.
    for (const path of ['/dashboard/', '/dashboard/../chat', '/dashboardX', '/%64ashboard', '/portal/../dashboard']) {
      const r = await raw(base, 'GET', path, tunnel);
      expect(r.status, path).toBe(404);
      expect(r.body, path).not.toContain('<html');
    }
    expect((await raw(base, 'GET', '/dashboardX')).status).toBe(404);
  });

  it('serves the console and chat to a direct localhost request', async () => {
    const d = { ...deps(), bus: new DashboardBus(), routes: [fakeChat] };
    const base = await listen(d);
    expect((await raw(base, 'GET', '/dashboard')).status).toBe(200);
    expect((await raw(base, 'GET', '/dashboard/view.js')).status).toBe(200);
    expect(await raw(base, 'GET', '/chat')).toEqual({ status: 200, body: 'chat' });
    expect(await raw(base, 'POST', '/chat/login')).toEqual({ status: 200, body: 'chat' });
  });

  it('serves the console and chat on a laptop (PUBLIC_HOST=localhost) to a request naming this machine', async () => {
    const d = { ...deps({ PUBLIC_HOST: 'localhost' }), bus: new DashboardBus(), routes: [fakeChat] };
    const base = await listen(d);
    const port = new URL(base).port;
    for (const host of [`localhost:${port}`, 'localhost', `127.0.0.1:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) {
      expect((await raw(base, 'GET', '/dashboard', { host })).status, host).toBe(200);
      expect(await raw(base, 'GET', '/chat', { host }), host).toEqual({ status: 200, body: 'chat' });
    }
  });

  it.each([
    ...tunnelled.filter(([label]) => label !== 'the public Host').map(([label, headers]): [string, Record<string, string>] => [label, { host: 'localhost:3000', ...headers }]),
    ['a tunnel\'s own Host, with no header added', { host: 'demo.ngrok.app' }],
    ['another site\'s name pointed at this machine', { host: 'www.example.com' }],
  ] as Array<[string, Record<string, string>]>)('answers 404 on a laptop (PUBLIC_HOST=localhost) to a request with %s', async (_label, headers) => {
    const d = { ...deps({ PUBLIC_HOST: 'localhost' }), bus: new DashboardBus(), routes: [fakeChat] };
    const base = await listen(d);
    for (const path of ['/dashboard', '/chat']) expect((await raw(base, 'GET', path, headers)).status, path).toBe(404);
  });

  it('serves the console through the tunnel with CONSOLE_LOCAL_ONLY=off', async () => {
    const d = { ...deps({ CONSOLE_LOCAL_ONLY: 'off' }), bus: new DashboardBus(), routes: [fakeChat] };
    const base = await listen(d);
    const headers = { host: 'demo.ngrok.app', 'x-forwarded-for': '203.0.113.9' };
    expect((await raw(base, 'GET', '/dashboard', headers)).status).toBe(200);
    expect((await raw(base, 'GET', '/chat', headers)).status).toBe(200);
  });

  it('leaves the Twilio webhooks and clips reachable through the tunnel', async () => {
    const d = { ...deps(), bus: new DashboardBus(), routes: [fakeChat] };
    const base = await listen(d);
    const r = await post(base, '/voice', { CallSid: 'CA1', From: '+1', To: '+2' });
    expect(r.status).toBe(200);
    const params = { CallSid: 'CA1', CallStatus: 'completed' };
    const body = new URLSearchParams(params).toString();
    const res = await fetch(base + '/cr-action', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': '203.0.113.9',
        'x-forwarded-proto': 'https',
        'x-twilio-signature': computeTwilioSignature('https://demo.ngrok.app/cr-action', params, TOKEN),
      },
      body,
    });
    expect(res.status).toBe(200);
    // A clip that does not exist is a 404 from the clip route, not the guard: the route still runs.
    writeFileSync(join(d.dir, 'greeting.wav'), Buffer.from('RIFF'));
    expect((await raw(base, 'GET', '/audio/greeting.wav', { host: 'demo.ngrok.app', 'x-forwarded-for': '203.0.113.9' })).status).toBe(200);
  });
});

describe('app route paths', () => {
  const route = (path: string, label = 'r'): AppRoute => ({ label, path, localOnly: false, handle: async () => false });

  it('accepts lowercase letters, digits and hyphens in segments', () => {
    expect(() => validateRoutes([route('/chat'), route('/portal-2'), route('/portal/help-1')])).not.toThrow();
  });

  it.each(['chat', '/', '/chat/', '/Chat', '/chat x', '/chat.html', '/%63hat', '/chat/../x', '/a//b', '/chat?x', '/chat_x', ''])('refuses the path %j', (path) => {
    expect(() => validateRoutes([route(path, 'odd')])).toThrow(/app route "odd": path .* must be/);
  });

  it('refuses a path on or under one the engine serves, and routes that overlap', () => {
    for (const path of ['/dashboard', '/dashboard/x', '/health', '/audio', '/voice', '/cr-action', '/conversation']) {
      expect(() => validateRoutes([route(path)]), path).toThrow(/overlaps/);
    }
    expect(() => validateRoutes([route('/chat', 'a'), route('/chat/more', 'b')])).toThrow(/overlaps route "a"/);
    expect(() => validateRoutes([route('/chat/more', 'a'), route('/chat', 'b')])).toThrow(/overlaps route "a"/);
    expect(() => validateRoutes([route('/chat', 'a'), route('/chatty', 'b')])).not.toThrow();
  });

  it('the request handler refuses bad routes at mount, not at the first request', () => {
    expect(() => createRequestHandler({ ...deps(), routes: [route('/Bad')] })).toThrow(/must be/);
  });
});

describe('clipName', () => {
  it('decodes a well-formed clip name and rejects traversal, wrong extensions, and bad percent-encoding', () => {
    expect(clipName('greeting.0.wav')).toBe('greeting.0.wav');
    expect(clipName('Loud.0.WAV')).toBe('Loud.0.WAV');
    expect(clipName('..%2fpackage.json')).toBeNull();
    expect(clipName('%2e%2e%2fetc%2fpasswd')).toBeNull();
    expect(clipName('sub%2fclip.wav')).toBeNull();
    expect(clipName('notes.txt')).toBeNull();
    expect(clipName('%E0%A4%A')).toBeNull();
  });
});

describe('decideActionTwiml', () => {
  it('hangs up on completed, dials on any other handoff reason, and revokes the token', () => {
    const d = deps();
    d.tokens.mint('CA1');
    expect(decideActionTwiml(d, { CallSid: 'CA1', HandoffData: '{"reasonCode":"completed"}' }).twiml).toContain('<Hangup/>');
    expect(d.tokens.verify('x', 'CA1', 'twilio')).toBe(false);
    expect(decideActionTwiml(d, { CallSid: 'CA2', HandoffData: '{"reasonCode":"live-agent"}' }).twiml).toContain('<Dial>+15551234567</Dial>');
    expect(decideActionTwiml(d, { CallSid: 'CA3', HandoffData: 'not json' }).twiml).toContain('<Dial>');
  });

  it('decides on the reason code alone, whatever else the handoff data carries', () => {
    const d = deps();
    // The end frame also reports completed forms, the unstarted queue and the slots the call
    // collected; those ride through to Twilio untouched and must not change the decision here.
    const data = '{"reasonCode":"billing","completed":["reschedule"],"queued":["cancel"],"slots":{"accountId":"5550 5678"}}';
    const r = decideActionTwiml(d, { CallSid: 'CA1', HandoffData: data });
    expect(r.twiml).toContain('<Dial>+15551234567</Dial>');
    expect(r.note).toBe('dial:billing');
  });

  it('reconnects a live call up to the limit, then apologizes and dials', () => {
    const d = deps();
    d.store.create('CA1', { send: () => {}, close: () => {} });
    const first = decideActionTwiml(d, { CallSid: 'CA1', CallStatus: 'in-progress', SessionStatus: 'failed' });
    expect(first.twiml).toContain('<ConversationRelay');
    const token = /token=([0-9a-f]{32})/.exec(first.twiml)![1]!;
    expect(d.tokens.verify(token, 'CA1', 'twilio')).toBe(true);
    expect(d.store.get('CA1')?.reconnects).toBe(1);
    const second = decideActionTwiml(d, { CallSid: 'CA1', CallStatus: 'in-progress', SessionStatus: 'failed' });
    expect(second.twiml).toContain('<Say>');
    expect(second.twiml).toContain('<Dial>+15551234567</Dial>');
    expect(d.store.get('CA1')?.ended).toBe(true);
  });

  it('hangs up for an unknown or finished call', () => {
    const d = deps();
    expect(decideActionTwiml(d, { CallSid: 'CA9', CallStatus: 'completed' }).twiml).toContain('<Hangup/>');
    d.store.create('CA1', { send: () => {}, close: () => {} });
    d.store.end('CA1');
    expect(decideActionTwiml(d, { CallSid: 'CA1', CallStatus: 'in-progress' }).twiml).toContain('<Hangup/>');
  });

  it('hangs up when the caller hung up', () => {
    const d = deps();
    d.store.create('CA1', { send: () => {}, close: () => {} });
    const token = d.tokens.mint('CA1');
    const result = decideActionTwiml(d, { CallSid: 'CA1', CallStatus: 'completed', SessionStatus: 'completed' });
    expect(result.twiml).toContain('<Hangup/>');
    expect(d.store.get('CA1')?.ended).toBe(true);
    expect(d.tokens.verify(token, 'CA1', 'twilio')).toBe(false);
  });

  it('treats empty HandoffData as absent', () => {
    const d = deps();
    d.store.create('CA1', { send: () => {}, close: () => {} });
    const result = decideActionTwiml(d, { CallSid: 'CA1', HandoffData: '', CallStatus: 'in-progress', SessionStatus: 'failed' });
    expect(result.twiml).toContain('<ConversationRelay');
    expect(result.twiml).not.toContain('<Dial>');
  });
});

describe('the widget file (WIDGET=on)', () => {
  function widgetFile(body: string): string {
    const file = join(mkdtempSync(join(tmpdir(), 'widget-')), 'dialogwright-widget.js');
    writeFileSync(file, body);
    return file;
  }

  it('serves the built widget at /widget.js, uncached, read afresh each time', async () => {
    const file = widgetFile('window.DialogWright = 1;');
    const base = await listen(deps({ WIDGET: 'on', WIDGET_FILE: file }));
    const r = await get(base, '/widget.js');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-cache');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.body.toString()).toBe('window.DialogWright = 1;');
    const h = await head(base, '/widget.js');
    expect(h.status).toBe(200);
    expect(h.headers['content-length']).toBe(String(Buffer.byteLength('window.DialogWright = 1;')));
    expect(h.body.length).toBe(0);
    // A rebuild on the laptop is served without a restart.
    writeFileSync(file, 'window.DialogWright = 2;');
    expect((await get(base, '/widget.js')).body.toString()).toBe('window.DialogWright = 2;');
    expect((await get(base, '/widget.js?v=2')).status).toBe(200);
    expect((await get(base, '/widget.jsx')).status).toBe(404);
  });

  it('is 404 when off, as any other path is', async () => {
    const base = await listen(deps());
    expect((await get(base, '/widget.js')).status).toBe(404);
  });

  it('is 404, and says why in the log, when the file has gone since the server started', async () => {
    const file = widgetFile('x');
    const lines: string[] = [];
    const base = await listen({ ...deps({ WIDGET: 'on', WIDGET_FILE: file }), log: (l) => lines.push(l) });
    rmSync(file);
    expect((await get(base, '/widget.js')).status).toBe(404);
    expect(lines.some((l) => l.startsWith(`widget: could not read ${file}`))).toBe(true);
  });

  it('is a public script: served through the tunnel too, with the console kept local only', async () => {
    const base = await listen({ ...deps({ WIDGET: 'on', WIDGET_FILE: widgetFile('x') }), bus: new DashboardBus() });
    const tunnel = { host: 'demo.ngrok.app', 'x-forwarded-for': '203.0.113.9' };
    expect(await raw(base, 'GET', '/widget.js', tunnel)).toEqual({ status: 200, body: 'x' });
    expect((await raw(base, 'GET', '/dashboard', tunnel)).status).toBe(404);
  });

  it('answers only GET and HEAD', async () => {
    const base = await listen(deps({ WIDGET: 'on', WIDGET_FILE: widgetFile('x') }));
    expect((await fetch(base + '/widget.js', { method: 'POST', body: 'x' })).status).toBe(404);
  });
});
