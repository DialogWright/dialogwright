import { describe, expect, it } from 'vitest';
import { describeConfig, loadConfig } from './config';
import { BARGE_IN_SUPPORT, bargeInRefusal, relayBargeIn } from '../channel/voiceProviders';
import { reportsSpeakingOf, serverBargeInRefusal, stopPlaybackOf } from './voice/registry';

const base = { PUBLIC_HOST: 'demo.example.app', TWILIO_AUTH_TOKEN: 'tok', HANDOFF_NUMBER: '+15551234567' };

describe('BARGE_IN', () => {
  it('is any unless it says otherwise, and takes speech, dtmf and none in any case', () => {
    expect(loadConfig(base).bargeIn).toBe('any');
    expect(loadConfig({ ...base, BARGE_IN: '' }).bargeIn).toBe('any');
    for (const mode of ['any', 'speech', 'dtmf', 'none'] as const) {
      expect(loadConfig({ ...base, BARGE_IN: mode }).bargeIn).toBe(mode);
    }
    expect(loadConfig({ ...base, BARGE_IN: ' DTMF ' }).bargeIn).toBe('dtmf');
  });

  it('refuses any other value, naming the ones it takes', () => {
    for (const bad of ['off', 'true', 'both']) {
      expect(() => loadConfig({ ...base, BARGE_IN: bad })).toThrow(`BARGE_IN must be any, speech, dtmf, none or server, got "${bad}"`);
    }
  });

  it('is said at startup', () => {
    expect(describeConfig(loadConfig(base))).toContain('barge-in any');
    expect(describeConfig(loadConfig({ ...base, BARGE_IN: 'none' }))).toContain('barge-in none');
  });

  it('is accepted by both carriers the engine has, for every value', () => {
    for (const id of ['twilio', 'telnyx']) expect(BARGE_IN_SUPPORT[id as 'twilio' | 'telnyx']).toEqual(['any', 'speech', 'dtmf', 'none']);
    const both = { ...base, VOICE_PROVIDERS: 'twilio,telnyx', TELNYX_PUBLIC_KEY: Buffer.alloc(32, 7).toString('base64') };
    expect(loadConfig({ ...both, BARGE_IN: 'dtmf' }).bargeIn).toBe('dtmf');
  });
});

describe('BARGE_IN=server', () => {
  const TELNYX_PUBLIC_KEY = Buffer.alloc(32, 7).toString('base64');
  const telnyx = { PUBLIC_HOST: 'demo.example.app', HANDOFF_NUMBER: '+15551234567', VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY, TELNYX_EVENTS: 'speaker-events tokens-played' };

  it('is taken on Telnyx with its speaker events, with BARGE_IN_MIN_SPEECH_MS 400 and SPEECH_GAP_MS 300 unless set', () => {
    const c = loadConfig({ ...telnyx, BARGE_IN: 'server' });
    expect(c.bargeIn).toBe('server');
    expect(c.bargeInMinSpeechMs).toBe(400);
    expect(c.speechGapMs).toBe(300);
    expect(loadConfig({ ...telnyx, BARGE_IN: 'SERVER', TELNYX_EVENTS: 'speaker-events' }).bargeIn).toBe('server');
    const set = loadConfig({ ...telnyx, BARGE_IN: 'server', BARGE_IN_MIN_SPEECH_MS: '600', SPEECH_GAP_MS: '250' });
    expect([set.bargeInMinSpeechMs, set.speechGapMs]).toEqual([600, 250]);
  });

  it('sends the relay element interruptible none: the barge-in is the server\'s', () => {
    expect(relayBargeIn('server')).toBe('none');
    for (const mode of ['any', 'speech', 'dtmf', 'none'] as const) expect(relayBargeIn(mode)).toBe(mode);
  });

  it('is refused on Telnyx without speaker-events, which is how it hears the caller', () => {
    for (const events of [{}, { TELNYX_EVENTS: 'tokens-played' }]) {
      const { TELNYX_EVENTS: _e, ...rest } = telnyx;
      expect(() => loadConfig({ ...rest, ...events, BARGE_IN: 'server' })).toThrow(
        'BARGE_IN=server needs Telnyx to report the caller speaking: add speaker-events to TELNYX_EVENTS (TELNYX_EVENTS="speaker-events tokens-played")',
      );
    }
  });

  it('is refused on Twilio, which reports no caller speaking and whose playback the server cannot stop', () => {
    const message = 'BARGE_IN=server needs a voice provider that reports the caller speaking and whose playback the server can stop; twilio does not report the caller and the agent speaking and has no way for the server to stop its playback. Use the carrier\'s own barge-in there (BARGE_IN=any, speech, dtmf or none), or take twilio out of VOICE_PROVIDERS';
    expect(() => loadConfig({ ...base, BARGE_IN: 'server' })).toThrow(message);
    expect(() => loadConfig({ ...telnyx, VOICE_PROVIDERS: 'telnyx,twilio', TWILIO_AUTH_TOKEN: 'tok', BARGE_IN: 'server' })).toThrow(message);
    expect(serverBargeInRefusal(['telnyx'])).toBeNull();
  });

  it('reads the carriers\' capabilities: Telnyx reports speaking and stops with a silent clip; Twilio neither', () => {
    expect([reportsSpeakingOf('telnyx'), stopPlaybackOf('telnyx')]).toEqual([true, 'silent-clip']);
    expect([reportsSpeakingOf('twilio'), stopPlaybackOf('twilio')]).toEqual([false, null]);
    expect([reportsSpeakingOf('nonesuch'), stopPlaybackOf('nonesuch')]).toEqual([false, null]);
  });

  it('refuses a minimum or a gap out of range, whatever BARGE_IN is', () => {
    for (const bad of ['49', '5001', '-1', 'soon']) expect(() => loadConfig({ ...base, BARGE_IN_MIN_SPEECH_MS: bad })).toThrow(/BARGE_IN_MIN_SPEECH_MS must be/);
    for (const bad of ['2001', '-1', 'x']) expect(() => loadConfig({ ...base, SPEECH_GAP_MS: bad })).toThrow(/SPEECH_GAP_MS must be/);
    expect(loadConfig({ ...base, SPEECH_GAP_MS: '0' }).speechGapMs).toBe(0);
  });

  it('is said at startup, with the minimum; the speech gap where a carrier reports the caller speaking', () => {
    const line = describeConfig(loadConfig({ ...telnyx, BARGE_IN: 'server' }));
    expect(line).toContain("barge-in server (a line stops after 400 ms of the caller's speech)");
    expect(line).toContain('speech gap 300 ms');
    expect(describeConfig(loadConfig(base))).not.toContain('speech gap');
  });
});

describe('a carrier that does not take a barge-in value', () => {
  const support = { twilio: ['any', 'speech', 'dtmf', 'none'], telnyx: ['any', 'none'] } as const;

  it('is named with the value, so the config is refused rather than the setting ignored', () => {
    expect(bargeInRefusal('speech', ['twilio', 'telnyx'], support)).toBe(
      'BARGE_IN=speech is not supported by the voice provider telnyx (it takes any, none); use one of those, or take telnyx out of VOICE_PROVIDERS',
    );
    expect(bargeInRefusal('none', ['twilio', 'telnyx'], support)).toBeNull();
    expect(bargeInRefusal('speech', ['twilio'], support)).toBeNull();
    // server sends the relay element none, so a carrier that takes none takes it as far as its element goes.
    expect(bargeInRefusal('server', ['twilio', 'telnyx'], support)).toBeNull();
    expect(bargeInRefusal('server', ['telnyx'], { telnyx: ['any'] })).toBe(
      'BARGE_IN=server (its relay element is sent interruptible="none") is not supported by the voice provider telnyx (it takes any); use one of those, or take telnyx out of VOICE_PROVIDERS',
    );
  });
});
