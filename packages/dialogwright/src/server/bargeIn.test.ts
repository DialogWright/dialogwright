import { describe, expect, it } from 'vitest';
import { describeConfig, loadConfig } from './config';
import { BARGE_IN_SUPPORT, bargeInOfCarrier, bargeInRefusal } from '../channel/voiceProviders';

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

describe('BARGE_IN_TWILIO and BARGE_IN_TELNYX', () => {
  const both = { ...base, VOICE_PROVIDERS: 'twilio,telnyx', TELNYX_PUBLIC_KEY: Buffer.alloc(32, 7).toString('base64') };

  it('are unset unless set: BARGE_IN applies to every carrier, as before', () => {
    expect(loadConfig(both).bargeInByCarrier).toBeUndefined();
    expect(loadConfig({ ...both, BARGE_IN_TELNYX: '', BARGE_IN_TWILIO: ' ' }).bargeInByCarrier).toBeUndefined();
    expect(bargeInOfCarrier('telnyx', loadConfig({ ...both, BARGE_IN: 'speech' }).bargeIn, undefined)).toBe('speech');
    expect(bargeInOfCarrier('telnyx', undefined, undefined)).toBe('any');
  });

  it('override BARGE_IN for their carrier alone, in any case', () => {
    const c = loadConfig({ ...both, BARGE_IN: 'speech', BARGE_IN_TELNYX: ' NONE ' });
    expect(c.bargeIn).toBe('speech');
    expect(c.bargeInByCarrier).toEqual({ telnyx: 'none' });
    expect(bargeInOfCarrier('telnyx', c.bargeIn, c.bargeInByCarrier)).toBe('none');
    expect(bargeInOfCarrier('twilio', c.bargeIn, c.bargeInByCarrier)).toBe('speech');
    expect(bargeInOfCarrier(undefined, c.bargeIn, c.bargeInByCarrier)).toBe('speech');
    expect(loadConfig({ ...both, BARGE_IN_TWILIO: 'dtmf', BARGE_IN_TELNYX: 'any' }).bargeInByCarrier).toEqual({ twilio: 'dtmf', telnyx: 'any' });
  });

  it('refuse any other value, naming the variable', () => {
    expect(() => loadConfig({ ...both, BARGE_IN_TELNYX: 'off' })).toThrow('BARGE_IN_TELNYX must be any, speech, dtmf or none, got "off"');
    expect(() => loadConfig({ ...both, BARGE_IN_TWILIO: 'true' })).toThrow('BARGE_IN_TWILIO must be any, speech, dtmf or none, got "true"');
    // A carrier not listed: its variable is still checked for its value.
    expect(() => loadConfig({ ...base, BARGE_IN_TELNYX: 'both' })).toThrow('BARGE_IN_TELNYX must be');
  });

  it('are said at startup beside BARGE_IN, for the carriers listed', () => {
    expect(describeConfig(loadConfig({ ...both, BARGE_IN_TELNYX: 'none' }))).toContain('barge-in any (telnyx none)');
    expect(describeConfig(loadConfig({ ...base, BARGE_IN_TELNYX: 'none' }))).toContain('barge-in any ');
    expect(describeConfig(loadConfig({ ...base, BARGE_IN_TELNYX: 'none' }))).not.toContain('telnyx none');
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
    // A carrier's own variable is named as itself.
    expect(bargeInRefusal('dtmf', ['telnyx'], support, 'BARGE_IN_TELNYX')).toBe(
      'BARGE_IN_TELNYX=dtmf is not supported by the voice provider telnyx (it takes any, none); use one of those, or take telnyx out of VOICE_PROVIDERS',
    );
  });
});
