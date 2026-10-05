import { describe, expect, it } from 'vitest';
import { carrierEventName } from './adapter';
import { describeConfig, loadConfig } from './config';

describe('carrier events', () => {
  it('names a typed message the relay wire does not know, and nothing else', () => {
    expect(carrierEventName(JSON.stringify({ type: 'agentSpeaking', value: true }))).toBe('agentSpeaking');
    expect(carrierEventName(JSON.stringify({ type: 'prompt', voicePrompt: 'x' }))).toBeNull();
    expect(carrierEventName('not json')).toBeNull();
    expect(carrierEventName(JSON.stringify({ kind: 'x' }))).toBeNull();
  });
  it('reads TELNYX_EVENTS, refusing a stream Telnyx does not name', () => {
    const base = { PUBLIC_HOST: 'voice.example.com', HANDOFF_NUMBER: '+15555550100', VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY: 'MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=' };
    expect(loadConfig({ ...base, TELNYX_EVENTS: 'speaker-events tokens-played' }).telnyxEvents).toBe('speaker-events tokens-played');
    expect(loadConfig(base).telnyxEvents).toBeNull();
    expect(() => loadConfig({ ...base, TELNYX_EVENTS: 'everything' })).toThrow('TELNYX_EVENTS must name event streams from speaker-events, tokens-played, got "everything"');
  });
  it('reads RESAY_CUT_LINES and RESAY_MIN_FRACTION, on and 0.35 unless set, and says them at startup', () => {
    const base = { PUBLIC_HOST: 'voice.example.com', HANDOFF_NUMBER: '+15555550100', VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY: 'MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=' };
    expect(loadConfig(base)).toMatchObject({ resayCutLines: true, resayMinFraction: 0.35 });
    expect(loadConfig({ ...base, RESAY_CUT_LINES: 'OFF', RESAY_MIN_FRACTION: '0.5' })).toMatchObject({ resayCutLines: false, resayMinFraction: 0.5 });
    expect(loadConfig({ ...base, RESAY_MIN_FRACTION: '0.05' }).resayMinFraction).toBe(0.05);
    expect(loadConfig({ ...base, RESAY_MIN_FRACTION: '0.95' }).resayMinFraction).toBe(0.95);
    expect(() => loadConfig({ ...base, RESAY_CUT_LINES: 'yes' })).toThrow('RESAY_CUT_LINES must be on or off, got "yes"');
    for (const bad of ['0.04', '0.96', '1', 'half']) {
      expect(() => loadConfig({ ...base, RESAY_MIN_FRACTION: bad })).toThrow(`RESAY_MIN_FRACTION must be a fraction from 0.05 to 0.95, got "${bad}"`);
    }
    // Said where a carrier that reports its playback is answered, with whether its events are asked for.
    expect(describeConfig(loadConfig({ ...base, TELNYX_EVENTS: 'speaker-events tokens-played' }))).toContain('cut lines said again (under 0.35 of the estimate)');
    expect(describeConfig(loadConfig(base))).toContain('cut lines said again (under 0.35 of the estimate; inactive without TELNYX_EVENTS)');
    expect(describeConfig(loadConfig({ ...base, RESAY_CUT_LINES: 'off' }))).toContain('cut lines not said again');
    const twilio = { PUBLIC_HOST: 'voice.example.com', HANDOFF_NUMBER: '+15555550100', TWILIO_AUTH_TOKEN: 'x'.repeat(32) };
    expect(describeConfig(loadConfig(twilio))).not.toContain('cut lines');
  });
});
