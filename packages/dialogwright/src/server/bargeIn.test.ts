import { describe, expect, it } from 'vitest';
import { describeConfig, loadConfig } from './config';
import { BARGE_IN_SUPPORT, bargeInRefusal } from '../channel/voiceProviders';

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
      expect(() => loadConfig({ ...base, BARGE_IN: bad })).toThrow(`BARGE_IN must be any, speech, dtmf or none, got "${bad}"`);
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

describe('a carrier that does not take a barge-in value', () => {
  const support = { twilio: ['any', 'speech', 'dtmf', 'none'], telnyx: ['any', 'none'] } as const;

  it('is named with the value, so the config is refused rather than the setting ignored', () => {
    expect(bargeInRefusal('speech', ['twilio', 'telnyx'], support)).toBe(
      'BARGE_IN=speech is not supported by the voice provider telnyx (it takes any, none); use one of those, or take telnyx out of VOICE_PROVIDERS',
    );
    expect(bargeInRefusal('none', ['twilio', 'telnyx'], support)).toBeNull();
    expect(bargeInRefusal('speech', ['twilio'], support)).toBeNull();
  });
});
