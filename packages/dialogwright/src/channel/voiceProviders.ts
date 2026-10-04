/**
 * The phone carriers the engine has a voice provider for (src/server/voice/registry.ts), by id. A
 * plain list, so an app's YAML (voice.locales.<tag>.voices) is checked against it without loading
 * any server code; the registry is typed by it, so the two cannot drift apart.
 */
export const VOICE_PROVIDER_IDS = ['twilio', 'telnyx'] as const;

export type VoiceProviderId = (typeof VOICE_PROVIDER_IDS)[number];

/**
 * Twilio ConversationRelay's documented TTS providers (Twilio docs, <ConversationRelay> ttsProvider):
 * what TTS_PROVIDER, and a Twilio voice written as { voice, provider } in app.yaml, may name.
 */
export const TWILIO_TTS_PROVIDERS = ['Google', 'Amazon', 'ElevenLabs'] as const;

/**
 * A speech recognizer's provider or model name, as a carrier's start document takes it (Twilio's
 * `transcriptionProvider` and `speechModel`, Telnyx's `transcriptionProvider`): letters, digits,
 * dots, hyphens and underscores, starting with a letter or digit ("Deepgram", "nova-3-general").
 */
export const RECOGNIZER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
