import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig, describeConfig, consoleExposure, publicBase, recognitionFor } from './config';
import { defaultTimeZone } from '../run/clock';

/** A Telnyx public key as Telnyx shows it: 32 bytes, base64. Made up; nothing signs with it. */
const TELNYX_KEY = Buffer.alloc(32, 7).toString('base64');

const base = { PUBLIC_HOST: 'demo.ngrok.app', TWILIO_AUTH_TOKEN: 'tok', HANDOFF_NUMBER: '+15551234567' };

/** The paths CONSOLE_LOCAL_ONLY guards once an app's two chats are mounted (localOnly.ts localOnlyPaths). */
const CONSOLE_PATHS = ['/dashboard', '/staff', '/portal'];

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
      'TELNYX_VOICE must be a Telnyx voice name like Telnyx.Ultra.Callie, got "en-US-Neural2-F"',
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
