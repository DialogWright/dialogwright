/**
 * The phone carriers the engine has a voice provider for (src/server/voice/registry.ts), by id. A
 * plain list, so an app's YAML (voice.locales.<tag>.voices) is checked against it without loading
 * any server code; the registry is typed by it, so the two cannot drift apart.
 */
export const VOICE_PROVIDER_IDS = ['twilio', 'telnyx'] as const;

export type VoiceProviderId = (typeof VOICE_PROVIDER_IDS)[number];
