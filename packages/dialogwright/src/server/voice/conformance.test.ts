import { readFileSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runVoiceProviderConformance, voiceConformanceChecks, type CallDataFixture, type FrameFixture, type WebhookFixture } from '../../testing/voiceConformance';
import { computeTwilioSignature, twilioProvider } from './twilio';
import { telnyxProvider } from './telnyx';
import { formFields } from './xml';

/** The carrier's frames, one JSON object per line, each noting its source. */
const frames = (id: string): FrameFixture[] =>
  readFileSync(new URL(`./__fixtures__/${id}/frames.jsonl`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FrameFixture);

const hooks = (id: string): { voice: WebhookFixture; action: WebhookFixture; alternatives?: WebhookFixture[]; callData?: CallDataFixture } =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${id}/webhooks.json`, import.meta.url), 'utf8'));

// Twilio signs with the account's auth token; this one is made up for the test.
const TWILIO_TEST_TOKEN = 'test-token';
runVoiceProviderConformance(twilioProvider, {
  describe, it,
  frames: frames('twilio'),
  ...hooks('twilio'),
  sign: (req) => ({
    secret: TWILIO_TEST_TOKEN,
    headers: { 'x-twilio-signature': computeTwilioSignature(`https://voice.example.com${req.url}`, formFields(req.rawBody), TWILIO_TEST_TOKEN) },
  }),
});

// Telnyx signs with the account's Ed25519 private key; this pair is made here, so no key is stored.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
runVoiceProviderConformance(telnyxProvider, {
  describe, it,
  frames: frames('telnyx'),
  ...hooks('telnyx'),
  sign: (req) => ({
    secret: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    headers: {
      'telnyx-timestamp': String(req.nowSec),
      'telnyx-signature-ed25519': sign(null, Buffer.from(`${req.nowSec}|${req.rawBody}`), privateKey).toString('base64'),
    },
  }),
});

describe('the kit\'s call data check', () => {
  const check = (fx: Parameters<typeof voiceConformanceChecks>[1]) => voiceConformanceChecks(twilioProvider, fx).find((c) => c.name.startsWith('brings a custom parameter'))!;
  const base = { frames: frames('twilio'), ...hooks('twilio'), sign: () => ({ headers: {}, secret: 'x' }) };

  it('asks for a setup with a custom parameter, and a webhook field to echo', () => {
    const bare = base.frames.map((f) => (f.frame.type === 'setup' ? { ...f, frame: { ...f.frame, customParameters: {} } } : f));
    expect(() => check({ ...base, frames: bare }).run()).toThrow('no setup frame with a custom parameter in the fixtures');
    expect(() => check({ ...base, callData: { source: 'x', webhookField: 'SipHeader_X-Missing' } }).run()).toThrow('the voice webhook carries no field "SipHeader_X-Missing" to echo');
  });

  it('takes the first of each when the fixtures name none', () => {
    expect(() => check({ ...base, callData: undefined }).run()).not.toThrow();
  });
});
