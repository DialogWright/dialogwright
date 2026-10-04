import { describe, expect, it } from 'vitest';
import { KNOWN_VOICE_PROVIDERS, providerForPath, secretVarOf, voiceProviders } from './registry';
import { socketProvider } from '../ws';

describe('the voice provider registry', () => {
  it('knows Twilio and Telnyx, each with its secret variable', () => {
    expect(KNOWN_VOICE_PROVIDERS).toContain('twilio');
    expect(secretVarOf('twilio')).toBe('TWILIO_AUTH_TOKEN');
    expect(secretVarOf('telnyx')).toBe('TELNYX_PUBLIC_KEY');
    expect(() => secretVarOf('acme')).toThrow('unknown voice provider "acme"');
    expect(() => secretVarOf('__proto__')).toThrow('unknown voice provider "__proto__"');
  });

  it('finds the enabled provider a webhook path names, and Twilio\'s for the legacy path', () => {
    const enabled = voiceProviders(['twilio']);
    expect(providerForPath(enabled, '/voice/twilio', '/voice')?.id).toBe('twilio');
    expect(providerForPath(enabled, '/voice', '/voice')?.id).toBe('twilio');
    expect(providerForPath(enabled, '/cr-action/twilio', '/cr-action')?.id).toBe('twilio');
    expect(providerForPath(enabled, '/voice/telnyx', '/voice')).toBeNull();
    expect(providerForPath(enabled, '/voicemail', '/voice')).toBeNull();
    expect(providerForPath(enabled, '/voice/twilio/x', '/voice')).toBeNull();
    expect(providerForPath(enabled, '/voice/', '/voice')).toBeNull();
    expect(providerForPath(enabled, '/voice/TWILIO', '/voice')).toBeNull();
    expect(providerForPath(enabled, '/voice/__proto__', '/voice')).toBeNull();
    expect(providerForPath(enabled, '/voice/constructor', '/voice')).toBeNull();
    expect(providerForPath([], '/voice', '/voice')).toBeNull();
  });

  it('finds the provider a socket path names', () => {
    expect(socketProvider('/conversation', ['twilio'])).toBe('twilio');
    expect(socketProvider('/conversation/twilio', ['twilio'])).toBe('twilio');
    expect(socketProvider('/conversation/telnyx', ['twilio'])).toBeNull();
    expect(socketProvider('/conversations', ['twilio'])).toBeNull();
    expect(socketProvider('/conversation/', ['twilio'])).toBeNull();
    expect(socketProvider('/conversation/Twilio', ['twilio'])).toBeNull();
    expect(socketProvider('/conversation/__proto__', ['twilio'])).toBeNull();
    expect(socketProvider('/conversation', ['telnyx'])).toBeNull();
  });
});
