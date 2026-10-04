import { readFileSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'vitest';
import { runVoiceProviderConformance, type FrameFixture, type WebhookFixture } from '../../testing/voiceConformance';
import { computeTwilioSignature, twilioProvider } from './twilio';
import { telnyxProvider } from './telnyx';
import { formFields } from './xml';

/** The carrier's frames, one JSON object per line, each noting its source. */
const frames = (id: string): FrameFixture[] =>
  readFileSync(new URL(`./__fixtures__/${id}/frames.jsonl`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FrameFixture);

const hooks = (id: string): { voice: WebhookFixture; action: WebhookFixture; alternatives?: WebhookFixture[] } =>
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
