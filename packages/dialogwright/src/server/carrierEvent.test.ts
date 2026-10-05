import { describe, expect, it } from 'vitest';
import { carrierEventName } from './adapter';
import { loadConfig } from './config';

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
});
