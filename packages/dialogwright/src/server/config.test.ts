import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig, describeConfig, consoleExposure, publicBase, recognitionFor, startParametersFrom } from './config';
import { defaultTimeZone } from '../run/clock';

/** A Telnyx public key as Telnyx shows it: 32 bytes, base64. Made up; nothing signs with it. */
const TELNYX_KEY = Buffer.alloc(32, 7).toString('base64');

const base = { PUBLIC_HOST: 'demo.ngrok.app', TWILIO_AUTH_TOKEN: 'tok', HANDOFF_NUMBER: '+15551234567' };

/** The paths CONSOLE_LOCAL_ONLY guards once an app's two chats are mounted (localOnly.ts localOnlyPaths). */
const CONSOLE_PATHS = ['/dashboard', '/staff', '/portal'];

describe('AUDIT_STORE and TRACE_STORE', () => {
  it('are unset by default, and the config and its startup line are then as they always were', () => {
    const c = loadConfig(base);
    expect('auditStore' in c).toBe(false);
    expect('traceStore' in c).toBe(false);
    expect('serverId' in c).toBe(false);
    expect(describeConfig(c)).toContain('  traces traces  audit audit  ');
  });

  it('take postgres://... and s3://<bucket>/<prefix> with the S3_ variables, and the startup line says neither password nor key', () => {
    const c = loadConfig({
      ...base, AUDIT_STORE: 'postgres://audit:pa55word@db.example:5432/records', SESSION_STORE_TIMEOUT_MS: '3000',
      TRACE_STORE: 's3://call-traces/prod', S3_ACCESS_KEY_ID: 'AKIDEXAMPLEONLY', S3_SECRET_ACCESS_KEY: 'very-secret-key', S3_REGION: 'auto', S3_ENDPOINT: 'https://acct.r2.example.com',
      SERVER_ID: 'web-1',
    });
    expect(c.auditStore).toEqual({ kind: 'postgres', url: 'postgres://audit:pa55word@db.example:5432/records', timeoutMs: 3000 });
    expect(c.traceStore).toMatchObject({ kind: 's3', bucket: 'call-traces', prefix: 'prod/', region: 'auto', endpoint: 'https://acct.r2.example.com', forcePathStyle: false });
    expect(c.serverId).toBe('web-1');
    const line = describeConfig(c);
    expect(line).toContain('traces s3://call-traces/prod/ at acct.r2.example.com (auto)');
    expect(line).toContain('audit postgres://audit:***@db.example:5432/records');
    for (const secret of ['pa55word', 'very-secret-key', 'AKIDEXAMPLEONLY']) expect(line).not.toContain(secret);
  });

  it('refuse a malformed one at startup, naming the variable and never its secret', () => {
    expect(() => loadConfig({ ...base, AUDIT_STORE: 'mysql://u:pa55word@h/d' })).toThrow('AUDIT_STORE must be postgres://... (or unset, for day files in AUDIT_DIR), got "mysql://u:***@h/d"');
    expect(() => loadConfig({ ...base, TRACE_STORE: 's3://call-traces/p', S3_ACCESS_KEY_ID: 'id' })).toThrow('TRACE_STORE=s3://... needs S3_SECRET_ACCESS_KEY');
    expect(() => loadConfig({ ...base, TRACE_STORE: '/var/traces' })).toThrow('TRACE_STORE must be s3://<bucket>/<prefix>');
  });
});

describe('SESSION_STORE', () => {
  it('is memory unless it says otherwise, and the config is then as it always was', () => {
    expect('sessionStore' in loadConfig(base)).toBe(false);
    expect('sessionStore' in loadConfig({ ...base, SESSION_STORE: 'memory' })).toBe(false);
    expect('sessionStore' in loadConfig({ ...base, SESSION_STORE: ' MEMORY ' })).toBe(false);
    expect(describeConfig(loadConfig(base))).not.toContain('sessions');
  });

  it('takes file:<dir>, a folder as given (a relative one is from where the server runs), and says so at startup', () => {
    expect(loadConfig({ ...base, SESSION_STORE: 'file:/var/lib/ivr/sessions' }).sessionStore).toEqual({ kind: 'file', dir: '/var/lib/ivr/sessions', fsync: false, restartPauseS: 5 });
    expect(loadConfig({ ...base, SESSION_STORE: 'file:sessions' }).sessionStore).toMatchObject({ kind: 'file', dir: 'sessions' });
    expect(describeConfig(loadConfig({ ...base, SESSION_STORE: 'file:sessions' }))).toContain('sessions file:sessions');
  });

  it('takes RESTART_PAUSE_S (default 5, 0 for none, at most 60) and SESSION_FSYNC (default off), and says them at startup', () => {
    const file = { ...base, SESSION_STORE: 'file:sessions' };
    expect(loadConfig({ ...file, RESTART_PAUSE_S: '0' }).sessionStore).toMatchObject({ restartPauseS: 0 });
    expect(loadConfig({ ...file, RESTART_PAUSE_S: '12', SESSION_FSYNC: 'on' }).sessionStore).toMatchObject({ restartPauseS: 12, fsync: true });
    expect(describeConfig(loadConfig(file))).toContain('sessions file:sessions (restart pause 5 s)');
    expect(describeConfig(loadConfig({ ...file, RESTART_PAUSE_S: '0', SESSION_FSYNC: 'on' }))).toContain('sessions file:sessions (restart pause off, fsync on)');
    expect(() => loadConfig({ ...file, RESTART_PAUSE_S: '61' })).toThrow('RESTART_PAUSE_S must be a whole number of seconds from 0 to 60, got "61"');
    expect(() => loadConfig({ ...file, RESTART_PAUSE_S: '2.5' })).toThrow('RESTART_PAUSE_S must be a non-negative integer, got "2.5"');
    expect(() => loadConfig({ ...file, SESSION_FSYNC: 'yes' })).toThrow('SESSION_FSYNC must be on or off, got "yes"');
    // Checked with the memory store too, so a typo is found before the store is switched on.
    expect(() => loadConfig({ ...base, SESSION_FSYNC: 'yes' })).toThrow('SESSION_FSYNC must be on or off, got "yes"');
    expect('sessionStore' in loadConfig({ ...base, RESTART_PAUSE_S: '3', SESSION_FSYNC: 'on' })).toBe(false);
  });

  it('refuses anything else, saying what it takes, and never a password it was given', () => {
    expect(() => loadConfig({ ...base, SESSION_STORE: 'file:' })).toThrow('SESSION_STORE must be memory, file:<dir> or postgres://..., got "file:"');
    expect(() => loadConfig({ ...base, SESSION_STORE: 'redis://localhost:6379' })).toThrow('SESSION_STORE must be memory, file:<dir> or postgres://..., got "redis://localhost:6379"');
    expect(() => loadConfig({ ...base, SESSION_STORE: 'postgress://dw:s3cret@db.example/dw' })).toThrow('SESSION_STORE must be memory, file:<dir> or postgres://..., got "postgress://dw:***@db.example/dw"');
  });

  it('takes postgres:// and postgresql://, with CALL_LEASE_MS (default 5000) and SERVER_ID, and says it at startup without its password', () => {
    const url = 'postgres://dialogwright:s3cret@db.example:5432/dialogwright';
    expect(loadConfig({ ...base, SESSION_STORE: url }).sessionStore).toEqual({ kind: 'postgres', url, restartPauseS: 5, leaseMs: 5000, timeoutMs: 2000 });
    expect(loadConfig({ ...base, SESSION_STORE: 'postgresql://db.example/dw', CALL_LEASE_MS: '8000', SERVER_ID: 'web-1', RESTART_PAUSE_S: '0', SESSION_STORE_TIMEOUT_MS: '1500' }).sessionStore)
      .toEqual({ kind: 'postgres', url: 'postgresql://db.example/dw', restartPauseS: 0, leaseMs: 8000, timeoutMs: 1500, serverId: 'web-1' });
    expect(() => loadConfig({ ...base, SESSION_STORE: url, SESSION_STORE_TIMEOUT_MS: '50' })).toThrow('SESSION_STORE_TIMEOUT_MS must be a whole number of milliseconds from 100 to 30000, got "50"');
    const said = describeConfig(loadConfig({ ...base, SESSION_STORE: url, SERVER_ID: 'web-1' }));
    expect(said).toContain('sessions postgres://dialogwright:***@db.example:5432/dialogwright (restart pause 5 s, lease 5000 ms, timeout 2000 ms, server web-1)');
    expect(said).not.toContain('s3cret');
    expect(() => loadConfig({ ...base, SESSION_STORE: url, CALL_LEASE_MS: '100' })).toThrow('CALL_LEASE_MS must be a whole number of milliseconds from 500 to 60000, got "100"');
    expect(() => loadConfig({ ...base, SESSION_STORE: url, SERVER_ID: 'web 1' })).toThrow('SERVER_ID must be 1 to 40 letters, digits, dots, dashes or underscores, got "web 1"');
    // Checked with any store, as SESSION_FSYNC is.
    expect(() => loadConfig({ ...base, CALL_LEASE_MS: 'soon' })).toThrow('CALL_LEASE_MS must be a non-negative integer, got "soon"');
    expect('sessionStore' in loadConfig({ ...base, CALL_LEASE_MS: '9000', SERVER_ID: 'web-1' })).toBe(false);
  });
});

describe('RESUMED_AFTER_MS', () => {
  it('is 1500 unless set, 0 to 60000, and said at startup with a durable store only', () => {
    expect(loadConfig(base).resumedAfterMs).toBe(1500);
    expect(loadConfig({ ...base, RESUMED_AFTER_MS: '0' }).resumedAfterMs).toBe(0);
    expect(loadConfig({ ...base, RESUMED_AFTER_MS: '3000' }).resumedAfterMs).toBe(3000);
    expect(() => loadConfig({ ...base, RESUMED_AFTER_MS: '60001' })).toThrow('RESUMED_AFTER_MS must be a whole number of milliseconds from 0 to 60000, got "60001"');
    expect(() => loadConfig({ ...base, RESUMED_AFTER_MS: 'soon' })).toThrow('RESUMED_AFTER_MS must be a non-negative integer, got "soon"');
    expect(describeConfig(loadConfig(base))).not.toContain('resumed line');
    expect(describeConfig(loadConfig({ ...base, SESSION_STORE: 'file:sessions' }))).toContain('resumed line after 1500 ms of silence');
    expect(describeConfig(loadConfig({ ...base, SESSION_STORE: 'file:sessions', RESUMED_AFTER_MS: '0' }))).toContain('resumed line always');
  });
});

describe('RELAY_PING_MS', () => {
  it('is off unless set, and the config is then as it always was; set, from one to 120 seconds, said at startup', () => {
    expect('relayPingMs' in loadConfig(base)).toBe(false);
    expect('relayPingMs' in loadConfig({ ...base, RELAY_PING_MS: '0' })).toBe(false);
    expect(describeConfig(loadConfig(base))).not.toContain('relay ping');
    expect(loadConfig({ ...base, RELAY_PING_MS: '15000' }).relayPingMs).toBe(15000);
    expect(describeConfig(loadConfig({ ...base, RELAY_PING_MS: '15000' }))).toContain('relay ping every 15000 ms');
    expect(() => loadConfig({ ...base, RELAY_PING_MS: '500' })).toThrow('RELAY_PING_MS must be 0 (off) or a whole number of milliseconds from 1000 to 120000, got "500"');
  });
});

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      port: 3000, publicHost: 'demo.ngrok.app', jevClient: 'stub', todayOverride: null,
      traceDir: 'traces', auditDir: 'audit', signatureCheck: true, reconnectLimit: 2, sessionTtlMs: 1_800_000,
      sessionMaxAgeMs: 7_200_000, timezone: defaultTimeZone(), noInputMs: 7000,
    });
  });

  it('names the first missing required variable', () => {
    expect(() => loadConfig({ TWILIO_AUTH_TOKEN: 'x', HANDOFF_NUMBER: '+1' })).toThrow('missing required environment variable PUBLIC_HOST');
  });

  it('requires the api key only for the jev client', () => {
    expect(() => loadConfig({ ...base, JEV_CLIENT: 'jev' })).toThrow('TYPESAFE_API_KEY');
    expect(loadConfig({ ...base, JEV_CLIENT: 'jev', TYPESAFE_API_KEY: 'k' }).jevClient).toBe('jev');
    expect(() => loadConfig({ ...base, JEV_CLIENT: 'other' })).toThrow('JEV_CLIENT');
  });

  it('resolves the model\'s provider for the jev client only, and names the key variable it needs', () => {
    expect(loadConfig(base).jevProvider).toBeNull();
    expect(loadConfig({ ...base, JEV_CLIENT: 'jev', TYPESAFE_API_KEY: 'test-key' }).jevProvider).toMatchObject({ provider: 'typesafe', model: 'jev-1.13.0', official: true });
    expect(() => loadConfig({ ...base, JEV_CLIENT: 'jev', JEV_PROVIDER: 'openrouter', TYPESAFE_API_KEY: 'test-key' })).toThrow('missing required environment variable OPENROUTER_API_KEY (JEV_PROVIDER=openrouter)');
    expect(() => loadConfig({ ...base, JEV_CLIENT: 'jev', JEV_PROVIDER: 'nope' })).toThrow(/JEV_PROVIDER must be typesafe, openrouter, vercel or custom/);
    const custom = loadConfig({ ...base, JEV_CLIENT: 'jev', JEV_PROVIDER: 'custom', JEV_BASE_URL: 'http://127.0.0.1:8080', JEV_MODEL: 'open-jev-7b' });
    expect(custom.jevProvider).toMatchObject({ provider: 'custom', model: 'open-jev-7b', apiKey: null, official: false });
  });

  it('describes the provider\'s key by its length, never its value (the model is named at startup, server/index.ts)', () => {
    const text = describeConfig(loadConfig({ ...base, JEV_CLIENT: 'jev', JEV_PROVIDER: 'vercel', AI_GATEWAY_API_KEY: 'test-gateway-key' }));
    expect(text).toContain('api key set (16 chars)');
    expect(text).not.toContain('test-gateway-key');
  });

  it('parses numbers and flags', () => {
    const c = loadConfig({ ...base, PORT: '4100', SIGNATURE_CHECK: 'off', RECONNECT_LIMIT: '1', TODAY_OVERRIDE: '2026-09-18' });
    expect(c.port).toBe(4100);
    expect(c.signatureCheck).toBe(false);
    expect(c.reconnectLimit).toBe(1);
    expect(c.todayOverride).toBe('2026-09-18');
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow('PORT');
    expect(() => loadConfig({ ...base, TODAY_OVERRIDE: 'yesterday' })).toThrow('TODAY_OVERRIDE');
  });

  it('masks secrets in the description, prefix included', () => {
    const text = describeConfig(loadConfig({ ...base, TWILIO_AUTH_TOKEN: 'supersecret' }));
    expect(text).not.toContain('supersecret');
    // Not even the first characters: the length alone says whether the variable is set.
    expect(text).not.toContain('su');
    expect(text).toContain('auth token set (11 chars)');
    expect(text).toContain('api key unset');
    expect(text).toContain('demo.ngrok.app');
  });

  it('takes an IANA zone and rejects anything Intl does not know', () => {
    expect(loadConfig({ ...base, TIMEZONE: 'America/Los_Angeles' }).timezone).toBe('America/Los_Angeles');
    expect(() => loadConfig({ ...base, TIMEZONE: 'Pacific Time' })).toThrow(
      'TIMEZONE must be an IANA zone like America/Los_Angeles, got "Pacific Time"',
    );
    // Blank falls back to the host zone rather than failing.
    expect(loadConfig({ ...base, TIMEZONE: '  ' }).timezone).toBe(defaultTimeZone());
  });

  it('parses the session lifetimes', () => {
    const c = loadConfig({ ...base, SESSION_TTL_MS: '5000', SESSION_MAX_AGE_MS: '9000' });
    expect(c.sessionTtlMs).toBe(5000);
    expect(c.sessionMaxAgeMs).toBe(9000);
    expect(() => loadConfig({ ...base, SESSION_MAX_AGE_MS: '-1' })).toThrow('SESSION_MAX_AGE_MS');
  });

  it('rejects a PORT outside 0..65535', () => {
    expect(() => loadConfig({ ...base, PORT: '70000' })).toThrow(/between 0 and 65535/);
  });

  it('rejects a HANDOFF_NUMBER that is not E.164', () => {
    expect(() => loadConfig({ ...base, HANDOFF_NUMBER: 'cell' })).toThrow(/E\.164/);
  });

  it('defaults the audio dir and takes an optional TTS voice as a provider and voice pair', () => {
    expect(loadConfig(base)).toMatchObject({ audioDir: 'assets/audio', ttsProvider: null, ttsVoice: null });
    expect(loadConfig({ ...base, AUDIO_DIR: '/tmp/a', TTS_PROVIDER: 'Google', TTS_VOICE: 'en-US-Neural2-F' })).toMatchObject({ audioDir: '/tmp/a', ttsProvider: 'Google', ttsVoice: 'en-US-Neural2-F' });
    expect(() => loadConfig({ ...base, TTS_VOICE: 'x' })).toThrow(/TTS_PROVIDER and TTS_VOICE/);
  });

  it('requires TTS_PROVIDER to be one ConversationRelay actually offers, and requires TTS_VOICE alongside it', () => {
    expect(() => loadConfig({ ...base, TTS_PROVIDER: 'Polly', TTS_VOICE: 'x' })).toThrow('TTS_PROVIDER must be one of Google, Amazon, ElevenLabs, got "Polly"');
    // Symmetric to TTS_VOICE alone (already covered above): a provider with no voice is just as incomplete.
    expect(() => loadConfig({ ...base, TTS_PROVIDER: 'Google' })).toThrow(/TTS_PROVIDER and TTS_VOICE/);
  });

  it('describes the tts setting as default or as the configured provider and voice', () => {
    expect(describeConfig(loadConfig(base))).toContain('tts default');
    expect(describeConfig(loadConfig({ ...base, TTS_PROVIDER: 'Google', TTS_VOICE: 'en-US-Neural2-F' }))).toContain('tts Google en-US-Neural2-F');
  });

  it('defaults the no-input wait to seven seconds, takes 0 as off, and rejects a negative one', () => {
    expect(loadConfig(base).noInputMs).toBe(7000);
    expect(loadConfig({ ...base, NO_INPUT_MS: '250' }).noInputMs).toBe(250);
    expect(loadConfig({ ...base, NO_INPUT_MS: '0' }).noInputMs).toBe(0);
    expect(() => loadConfig({ ...base, NO_INPUT_MS: '-1' })).toThrow('NO_INPUT_MS');
    expect(() => loadConfig({ ...base, NO_INPUT_MS: 'soon' })).toThrow('NO_INPUT_MS');
  });

  it('describes the no-input wait, and says off when it is disabled', () => {
    expect(describeConfig(loadConfig(base))).toContain('no-input 7000 ms');
    expect(describeConfig(loadConfig({ ...base, NO_INPUT_MS: '0' }))).toContain('no-input off');
  });

  it('reads NO_INPUT_AFTER_SPEECH_MS, 2500 unless set, and says it where a carrier reports the caller speaking', () => {
    expect(loadConfig(base).noInputAfterSpeechMs).toBe(2500);
    expect(loadConfig({ ...base, NO_INPUT_AFTER_SPEECH_MS: '1200' }).noInputAfterSpeechMs).toBe(1200);
    expect(loadConfig({ ...base, NO_INPUT_AFTER_SPEECH_MS: '0' }).noInputAfterSpeechMs).toBe(0);
    expect(() => loadConfig({ ...base, NO_INPUT_AFTER_SPEECH_MS: '-1' })).toThrow('NO_INPUT_AFTER_SPEECH_MS must be a non-negative integer, got "-1"');
    expect(() => loadConfig({ ...base, NO_INPUT_AFTER_SPEECH_MS: 'soon' })).toThrow('NO_INPUT_AFTER_SPEECH_MS');
    // Twilio reports no caller speaking (its partial prompts end the wait instead): nothing to say there.
    expect(describeConfig(loadConfig(base))).not.toContain('no-input after speech');
    const telnyx = { ...base, VOICE_PROVIDERS: 'twilio,telnyx', TELNYX_PUBLIC_KEY: 'MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=' };
    expect(describeConfig(loadConfig(telnyx))).toContain('no-input after speech 2500 ms');
    expect(describeConfig(loadConfig({ ...telnyx, NO_INPUT_MS: '0' }))).not.toContain('no-input after speech');
  });

  it('takes the dashboard switch, defaults it on, and rejects anything else', () => {
    expect(loadConfig(base).dashboard).toBe(true);
    expect(loadConfig({ ...base, DASHBOARD: 'on' }).dashboard).toBe(true);
    expect(loadConfig({ ...base, DASHBOARD: 'off' }).dashboard).toBe(false);
    expect(() => loadConfig({ ...base, DASHBOARD: 'yes' })).toThrow('DASHBOARD must be on or off, got "yes"');
  });

  it('takes the clips switch, defaults it off, and rejects anything else', () => {
    expect(loadConfig(base).clips).toBe(false);
    expect(loadConfig({ ...base, CLIPS: 'on' }).clips).toBe(true);
    expect(loadConfig({ ...base, CLIPS: 'ON' }).clips).toBe(true);
    expect(() => loadConfig({ ...base, CLIPS: 'no' })).toThrow('CLIPS must be on or off, got "no"');
    expect(describeConfig(loadConfig(base))).toContain('clips OFF (all TTS)');
    expect(describeConfig(loadConfig({ ...base, CLIPS: 'on' }))).toContain('clips on');
  });

  it('takes the Jev timeout, defaults it to the core threshold, and rejects a non-positive value', () => {
    expect(loadConfig(base).jevTimeoutMs).toBe(1500);
    expect(loadConfig({ ...base, JEV_TIMEOUT_MS: '2500' }).jevTimeoutMs).toBe(2500);
    expect(() => loadConfig({ ...base, JEV_TIMEOUT_MS: '0' })).toThrow('JEV_TIMEOUT_MS must be a positive number');
    expect(describeConfig(loadConfig({ ...base, JEV_TIMEOUT_MS: '2500' }))).toContain('jev timeout 2500 ms');
  });

  it('takes SCREEN_MODE, inline by default, and rejects anything but inline or separate', () => {
    expect(loadConfig(base).screen).toBe('inline');
    expect(loadConfig({ ...base, SCREEN_MODE: 'separate' }).screen).toBe('separate');
    expect(() => loadConfig({ ...base, SCREEN_MODE: 'both' })).toThrow('SCREEN_MODE must be inline or separate, got "both"');
    expect(describeConfig(loadConfig(base))).toContain('screen inline');
  });

  it('describes the dashboard switch', () => {
    expect(describeConfig(loadConfig(base))).toContain('dashboard on');
    expect(describeConfig(loadConfig({ ...base, DASHBOARD: 'off' }))).toContain('dashboard OFF');
  });

  it('takes an optional Anthropic key and the handoff summary switch, on by default', () => {
    expect(loadConfig(base)).toMatchObject({ anthropicApiKey: null, handoffSummary: true });
    expect(loadConfig({ ...base, ANTHROPIC_API_KEY: 'sk-ant-x' }).anthropicApiKey).toBe('sk-ant-x');
    expect(loadConfig({ ...base, HANDOFF_SUMMARY: 'off' }).handoffSummary).toBe(false);
    expect(() => loadConfig({ ...base, HANDOFF_SUMMARY: 'nope' })).toThrow('HANDOFF_SUMMARY must be on or off, got "nope"');
  });

  it('describes the handoff summary switch and masks the Anthropic key', () => {
    const text = describeConfig(loadConfig({ ...base, ANTHROPIC_API_KEY: 'sk-ant-secret' }));
    expect(text).not.toContain('sk-ant-secret');
    expect(text).toContain('anthropic key set (13 chars)');
    expect(text).toContain('handoff note on');
    expect(describeConfig(loadConfig(base))).toContain('handoff note on (no key: none generated)');
    expect(describeConfig(loadConfig({ ...base, HANDOFF_SUMMARY: 'off' }))).toContain('handoff note OFF');
  });

  it('rejects a PUBLIC_HOST with a path, query, or port', () => {
    expect(() => loadConfig({ ...base, PUBLIC_HOST: 'demo.ngrok.app/foo' })).toThrow(/bare hostname/);
    expect(loadConfig({ ...base, PUBLIC_HOST: 'https://demo.ngrok.app/' }).publicHost).toBe('demo.ngrok.app');
  });

  it('keeps the console and chat local only by default, and says which at startup', () => {
    const local = loadConfig(base);
    expect(local.consoleLocalOnly).toBe(true);
    expect(describeConfig(local)).toContain('console local only');
    expect(consoleExposure(local, CONSOLE_PATHS)).toMatch(/^console: \/dashboard, \/staff and \/portal local only \(http:\/\/localhost:\d+\); 404 through the tunnel on /);
    const open = loadConfig({ ...base, CONSOLE_LOCAL_ONLY: 'off' });
    expect(open.consoleLocalOnly).toBe(false);
    expect(describeConfig(open)).toContain('console PUBLIC');
    expect(consoleExposure(open, CONSOLE_PATHS)).toMatch(/PUBLIC on https:\/\/.+ \(CONSOLE_LOCAL_ONLY=off\)$/);
    expect(() => loadConfig({ ...base, CONSOLE_LOCAL_ONLY: 'maybe' })).toThrow('CONSOLE_LOCAL_ONLY must be on or off, got "maybe"');
  });

  it('names this machine\'s address, not https://localhost, on a laptop (PUBLIC_HOST=localhost)', () => {
    const laptop = loadConfig({ ...base, PUBLIC_HOST: 'localhost', PORT: '3000' });
    expect(consoleExposure(laptop, CONSOLE_PATHS)).toBe('console: /dashboard, /staff and /portal local only (http://localhost:3000); 404 through any tunnel');
    expect(consoleExposure(loadConfig({ ...base, PUBLIC_HOST: 'localhost', PORT: '3000', CONSOLE_LOCAL_ONLY: 'off' }))).toBe('console: /dashboard on http://localhost:3000, and PUBLIC through any tunnel to it (CONSOLE_LOCAL_ONLY=off)');
    expect(publicBase(laptop, 3000)).toBe('http://localhost:3000');
    expect(publicBase({ publicHost: '127.0.0.1' }, 3000)).toBe('http://localhost:3000');
    expect(publicBase(loadConfig(base), 3000)).toBe(`https://${loadConfig(base).publicHost}`);
  });
});

describe('voice providers', () => {
  it('defaults to Twilio and needs only its token', () => {
    const c = loadConfig({ ...base });
    expect(c.voiceProviders).toEqual(['twilio']);
    expect(c.providerSecrets).toEqual({ twilio: base.TWILIO_AUTH_TOKEN });
    expect(c.twilioAuthToken).toBe(base.TWILIO_AUTH_TOKEN);
  });

  it('reads a comma list, trimmed, lower-cased and without repeats', () => {
    expect(loadConfig({ ...base, VOICE_PROVIDERS: ' Twilio , twilio' }).voiceProviders).toEqual(['twilio']);
  });

  it('names the missing secret of an enabled provider, and why it is needed', () => {
    const { TWILIO_AUTH_TOKEN: _t, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow('missing required environment variable TWILIO_AUTH_TOKEN (VOICE_PROVIDERS includes twilio)');
    expect(() => loadConfig({ ...rest, TWILIO_AUTH_TOKEN: '  ' })).toThrow('missing required environment variable TWILIO_AUTH_TOKEN (VOICE_PROVIDERS includes twilio)');
  });

  it('refuses an unknown provider and an empty list', () => {
    expect(() => loadConfig({ ...base, VOICE_PROVIDERS: 'twilio,acme' })).toThrow('VOICE_PROVIDERS must name providers from twilio, telnyx, got "acme"');
    expect(() => loadConfig({ ...base, VOICE_PROVIDERS: ' ' })).toThrow('VOICE_PROVIDERS must name at least one provider');
    expect(() => loadConfig({ ...base, VOICE_PROVIDERS: ',' })).toThrow('VOICE_PROVIDERS must name at least one provider');
  });

  it('describes the providers, and each secret by its length only', () => {
    const text = describeConfig(loadConfig(base));
    expect(text).toContain('voice providers twilio');
    expect(text).toContain('auth token set (3 chars)');
  });

  it('enables Telnyx alone, without a Twilio token', () => {
    const { TWILIO_AUTH_TOKEN: _t, ...rest } = base;
    const c = loadConfig({ ...rest, VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY: TELNYX_KEY });
    expect(c.voiceProviders).toEqual(['telnyx']);
    expect(c.providerSecrets).toEqual({ telnyx: TELNYX_KEY });
    expect(c.twilioAuthToken).toBe('');
  });

  it('enables both, in the order given', () => {
    const c = loadConfig({ ...base, VOICE_PROVIDERS: 'telnyx,twilio', TELNYX_PUBLIC_KEY: TELNYX_KEY });
    expect(c.voiceProviders).toEqual(['telnyx', 'twilio']);
    expect(Object.keys(c.providerSecrets).sort()).toEqual(['telnyx', 'twilio']);
    const text = describeConfig(c);
    expect(text).toContain('voice providers telnyx, twilio');
    expect(text).toContain(`telnyx public key set (${TELNYX_KEY.length} chars)`);
    expect(text).not.toContain(TELNYX_KEY);
  });

  it('names the missing Telnyx key', () => {
    expect(() => loadConfig({ ...base, VOICE_PROVIDERS: 'twilio,telnyx' })).toThrow('missing required environment variable TELNYX_PUBLIC_KEY (VOICE_PROVIDERS includes telnyx)');
  });

  it('takes an optional Telnyx voice of its own, never the Twilio TTS_VOICE', () => {
    const both = { ...base, VOICE_PROVIDERS: 'twilio,telnyx', TELNYX_PUBLIC_KEY: TELNYX_KEY, TTS_PROVIDER: 'Google', TTS_VOICE: 'en-US-Neural2-F' };
    expect(loadConfig(both).telnyxVoice).toBeNull();
    expect(loadConfig({ ...both, TELNYX_VOICE: ' Telnyx.Ultra.Callie ' })).toMatchObject({ telnyxVoice: 'Telnyx.Ultra.Callie', ttsProvider: 'Google', ttsVoice: 'en-US-Neural2-F' });
    expect(loadConfig({ ...both, TELNYX_VOICE: 'AWS.Polly.Joanna-Neural' }).telnyxVoice).toBe('AWS.Polly.Joanna-Neural');
  });

  it('refuses a Telnyx voice that is not named the way Telnyx names one (its engine, a dot, the voice)', () => {
    const telnyx = { ...base, VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY: TELNYX_KEY };
    expect(() => loadConfig({ ...telnyx, TELNYX_VOICE: 'en-US-Neural2-F' })).toThrow(
      'TELNYX_VOICE must be a Telnyx voice name like Telnyx.NaturalHD.astra, got "en-US-Neural2-F"',
    );
    expect(() => loadConfig({ ...telnyx, TELNYX_VOICE: 'Telnyx.Ultra Callie' })).toThrow(/TELNYX_VOICE must be a Telnyx voice name/);
  });

  it('describes the Telnyx voice when Telnyx is enabled, and the Twilio voice as before', () => {
    const both = { ...base, VOICE_PROVIDERS: 'twilio,telnyx', TELNYX_PUBLIC_KEY: TELNYX_KEY };
    expect(describeConfig(loadConfig(both))).toContain('telnyx voice default');
    const text = describeConfig(loadConfig({ ...both, TTS_PROVIDER: 'Google', TTS_VOICE: 'en-US-Neural2-F', TELNYX_VOICE: 'Telnyx.Ultra.Callie' }));
    expect(text).toContain('tts Google en-US-Neural2-F');
    expect(text).toContain('telnyx voice Telnyx.Ultra.Callie');
    expect(describeConfig(loadConfig({ ...base, TELNYX_VOICE: 'Telnyx.Ultra.Callie' }))).not.toContain('telnyx voice');
  });

  it('defaults Twilio\'s recognizer to Deepgram flux, and Telnyx\'s to Telnyx\'s own', () => {
    const c = loadConfig({ ...base, VOICE_PROVIDERS: 'twilio,telnyx', TELNYX_PUBLIC_KEY: TELNYX_KEY });
    expect(c).toMatchObject({ twilioTranscriptionProvider: 'Deepgram', twilioSpeechModel: 'flux', telnyxTranscriptionProvider: null });
    expect(recognitionFor(c, 'twilio')).toEqual({ provider: 'Deepgram', model: 'flux' });
    expect(recognitionFor(c, 'telnyx')).toEqual({});
    // Empty is unset, as for every other optional variable.
    expect(loadConfig({ ...base, TWILIO_TRANSCRIPTION_PROVIDER: ' ', TWILIO_SPEECH_MODEL: '' })).toMatchObject({ twilioTranscriptionProvider: 'Deepgram', twilioSpeechModel: 'flux' });
  });

  it('takes each carrier\'s recognizer from its own variables, and never gives Twilio\'s to Telnyx', () => {
    const c = loadConfig({
      ...base, VOICE_PROVIDERS: 'twilio,telnyx', TELNYX_PUBLIC_KEY: TELNYX_KEY,
      TWILIO_TRANSCRIPTION_PROVIDER: ' Google ', TWILIO_SPEECH_MODEL: 'telephony', TELNYX_TRANSCRIPTION_PROVIDER: 'deepgram',
    });
    expect(recognitionFor(c, 'twilio')).toEqual({ provider: 'Google', model: 'telephony' });
    expect(recognitionFor(c, 'telnyx')).toEqual({ provider: 'deepgram' });
    expect(recognitionFor(loadConfig({ ...base, TWILIO_SPEECH_MODEL: 'nova-3-general' }), 'twilio')).toEqual({ provider: 'Deepgram', model: 'nova-3-general' });
  });

  it('drops the flux default when Twilio\'s recognizer is another provider: flux is Deepgram\'s', () => {
    const c = loadConfig({ ...base, TWILIO_TRANSCRIPTION_PROVIDER: 'Google' });
    expect(c.twilioSpeechModel).toBeNull();
    expect(recognitionFor(c, 'twilio')).toEqual({ provider: 'Google' });
  });

  it('refuses a recognizer setting that is not a plain name', () => {
    expect(() => loadConfig({ ...base, TWILIO_TRANSCRIPTION_PROVIDER: 'Deep gram' })).toThrow(
      'TWILIO_TRANSCRIPTION_PROVIDER must be a name of letters, digits, dots, hyphens and underscores, like Deepgram, got "Deep gram"',
    );
    expect(() => loadConfig({ ...base, TWILIO_SPEECH_MODEL: 'flux"/>' })).toThrow(/TWILIO_SPEECH_MODEL must be a name of letters.*like nova-3-general, got "flux"\/>"/);
    expect(() => loadConfig({ ...base, TELNYX_TRANSCRIPTION_PROVIDER: '-x' })).toThrow(/TELNYX_TRANSCRIPTION_PROVIDER must be a name/);
  });

  it('describes each enabled carrier\'s recognizer', () => {
    expect(describeConfig(loadConfig(base))).toContain('twilio recognition Deepgram flux');
    expect(describeConfig(loadConfig({ ...base, TWILIO_TRANSCRIPTION_PROVIDER: 'Google' }))).toContain('twilio recognition Google (its default model)');
    const telnyx = { ...base, VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY: TELNYX_KEY };
    expect(describeConfig(loadConfig(telnyx))).toContain('telnyx recognition default');
    expect(describeConfig(loadConfig(telnyx))).not.toContain('twilio recognition');
    expect(describeConfig(loadConfig({ ...telnyx, TELNYX_TRANSCRIPTION_PROVIDER: 'google' }))).toContain('telnyx recognition google');
  });

  it('refuses a Telnyx key that is not a base64 Ed25519 public key', () => {
    expect(() => loadConfig({ ...base, VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY: 'not-a-key' })).toThrow(
      "TELNYX_PUBLIC_KEY must be the account's base64 Ed25519 public key",
    );
  });
});


describe('the widget file (WIDGET)', () => {
  it('is off by default, and off leaves the config without it', () => {
    expect(loadConfig(base).widget).toBeUndefined();
    expect(loadConfig({ ...base, WIDGET: 'off', WIDGET_FILE: '/nowhere/widget.js' }).widget).toBeUndefined();
    expect(describeConfig(loadConfig(base))).not.toContain('widget');
  });

  it('on, serves the file it names, which must exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'widget-'));
    const file = join(dir, 'dialogwright-widget.js');
    writeFileSync(file, '/* widget */');
    const c = loadConfig({ ...base, WIDGET: 'on', WIDGET_FILE: file });
    expect(c.widget).toEqual({ file });
    expect(describeConfig(c)).toContain(`widget on (${file})`);
    expect(() => loadConfig({ ...base, WIDGET: 'on', WIDGET_FILE: join(dir, 'missing.js') })).toThrow(
      `WIDGET_FILE does not exist: ${join(dir, 'missing.js')} (build it with pnpm --filter @dialogwright/widget build)`,
    );
    // A directory is not a file to serve.
    expect(() => loadConfig({ ...base, WIDGET: 'on', WIDGET_FILE: dir })).toThrow(`WIDGET_FILE does not exist: ${dir}`);
    rmSync(dir, { recursive: true, force: true });
  });

  it('on, defaults to the built bundle in the app\'s node_modules, resolved from where the server runs', () => {
    const expected = resolve('node_modules/@dialogwright/widget/dist/dialogwright-widget.js');
    expect(() => loadConfig({ ...base, WIDGET: 'on' })).toThrow(`WIDGET_FILE does not exist: ${expected}`);
  });

  it('says what is wrong, in the usual words', () => {
    expect(() => loadConfig({ ...base, WIDGET: 'yes' })).toThrow('WIDGET must be on or off, got "yes"');
  });
});

describe('startParametersFrom (app.yaml startParameters)', () => {
  it('reads each from the variable it names, and none for an app without them', () => {
    expect(startParametersFrom({ startParameters: { line: 'env.LINE', site: 'env.SITE' } }, { LINE: 'support-east', SITE: 'north' })).toEqual({ line: 'support-east', site: 'north' });
    expect(startParametersFrom({}, { LINE: 'x' })).toEqual({});
    expect(startParametersFrom(undefined, {})).toEqual({});
  });

  it('refuses an unset or empty variable, and one longer than a custom parameter takes, with the fix', () => {
    expect(() => startParametersFrom({ startParameters: { line: 'env.LINE' } }, {})).toThrow('set LINE in the app\'s .env, or delete "line" from startParameters');
    expect(() => startParametersFrom({ startParameters: { line: 'env.LINE' } }, { LINE: ' ' })).toThrow('LINE, which is not set');
    expect(() => startParametersFrom({ startParameters: { line: 'env.LINE' } }, { LINE: 'x'.repeat(501) })).toThrow('a custom parameter is at most 500');
    expect(() => startParametersFrom({ startParameters: { line: 'env.LINE' } }, { LINE: 'east\nwest' })).toThrow('LINE (app.yaml\'s startParameters "line") has a control character');
  });
});

describe("the carriers' rates a minute (CARRIER_RATE_PER_MIN_<CARRIER>), for the console's Insights", () => {
  it('unset by default: no rate, and Insights shows no carrier cost', () => {
    expect(loadConfig(base).carrierRates).toBeUndefined();
    expect(describeConfig(loadConfig(base))).not.toContain('carrier rates');
  });

  it('each carrier set on its own, in dollars a minute, said at start', () => {
    const c = loadConfig({ ...base, CARRIER_RATE_PER_MIN_TWILIO: '0.014' });
    expect(c.carrierRates).toEqual({ twilio: 0.014 });
    expect(loadConfig({ ...base, CARRIER_RATE_PER_MIN_TWILIO: '0.014', CARRIER_RATE_PER_MIN_TELNYX: ' 0.007 ' }).carrierRates).toEqual({ twilio: 0.014, telnyx: 0.007 });
    expect(loadConfig({ ...base, CARRIER_RATE_PER_MIN_TELNYX: '0' }).carrierRates).toEqual({ telnyx: 0 });
    expect(describeConfig(c)).toContain('carrier rates twilio $0.014/min');
  });

  it('refuses a rate that is not a plain number of dollars from 0 to 100, naming the variable', () => {
    for (const bad of ['-0.01', 'abc', '1e-2', '$0.01', '101', '0.01/min']) {
      expect(() => loadConfig({ ...base, CARRIER_RATE_PER_MIN_TWILIO: bad }), bad).toThrow(`CARRIER_RATE_PER_MIN_TWILIO must be the carrier's charge a minute in dollars, a number from 0 to 100 (like 0.014), got "${bad}"`);
    }
    expect(() => loadConfig({ ...base, CARRIER_RATE_PER_MIN_TELNYX: 'x' })).toThrow('CARRIER_RATE_PER_MIN_TELNYX must be');
  });
});

describe("the console's daily figures' own retention (FIGURES_RETENTION_DAYS)", () => {
  it('unset by default (kept); a whole number of days above 0 when set, said at start', () => {
    expect(loadConfig(base).figuresRetentionDays).toBeUndefined();
    expect(describeConfig(loadConfig(base))).not.toContain('console figures');
    const c = loadConfig({ ...base, FIGURES_RETENTION_DAYS: '400' });
    expect(c.figuresRetentionDays).toBe(400);
    expect(describeConfig(c)).toContain('console figures kept 400 days');
    expect(() => loadConfig({ ...base, FIGURES_RETENTION_DAYS: '0' })).toThrow('FIGURES_RETENTION_DAYS must be a positive whole number of days, got "0"');
    expect(() => loadConfig({ ...base, FIGURES_RETENTION_DAYS: 'a year' })).toThrow('FIGURES_RETENTION_DAYS');
  });
});
