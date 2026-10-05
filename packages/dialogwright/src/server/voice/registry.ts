import type { SetupFrame } from '../../channel/relay/frames';
import type { PlaybackEvent, VoiceProvider } from './provider';
import { twilioProvider } from './twilio';
import { telnyxProvider } from './telnyx';
import { telnyxPublicKey } from './telnyxSignature';
import { VOICE_PROVIDER_IDS, type VoiceProviderId } from '../../channel/voiceProviders';

/** A carrier the engine knows: its provider, and the environment variable that holds its secret. */
interface KnownProvider {
  readonly provider: VoiceProvider;
  /** The variable VOICE_PROVIDERS makes required when it names this provider. */
  readonly secretVar: string;
  /** How the startup line names the secret (its value is never printed, only its length). */
  readonly secretLabel: string;
  /** Throws, with the message config shows, when the secret cannot be what the provider needs; absent when any value may be. */
  readonly checkSecret?: (value: string) => void;
}

/** Every carrier the engine knows, by id, in the order the docs list them. */
const ALL: Readonly<Record<VoiceProviderId, KnownProvider>> = {
  twilio: { provider: twilioProvider, secretVar: 'TWILIO_AUTH_TOKEN', secretLabel: 'auth token' },
  telnyx: {
    provider: telnyxProvider,
    secretVar: 'TELNYX_PUBLIC_KEY',
    secretLabel: 'telnyx public key',
    checkSecret: (value) => {
      try {
        telnyxPublicKey(value);
      } catch {
        throw new Error("TELNYX_PUBLIC_KEY must be the account's base64 Ed25519 public key");
      }
    },
  },
};

/** The ids VOICE_PROVIDERS may name. */
export const KNOWN_VOICE_PROVIDERS: readonly string[] = VOICE_PROVIDER_IDS;

/** The provider the unprefixed `/voice`, `/cr-action` and `/conversation` belong to, for deployments made before providers. */
export const LEGACY_PROVIDER = 'twilio';

function known(id: string): KnownProvider {
  const k = Object.hasOwn(ALL, id) ? ALL[id as VoiceProviderId] : undefined;
  if (k === undefined) throw new Error(`unknown voice provider "${id}"`);
  return k;
}

/** The environment variable that holds a provider's secret (TWILIO_AUTH_TOKEN, say). */
export function secretVarOf(id: string): string {
  return known(id).secretVar;
}

/** Refuses a secret that cannot be what the provider needs (a key that does not parse, say), at startup. */
export function checkSecretOf(id: string, value: string): void {
  known(id).checkSecret?.(value);
}

/** How the startup line names a provider's secret. */
export function secretLabelOf(id: string): string {
  return known(id).secretLabel;
}

/** The enabled providers, in VOICE_PROVIDERS order. */
export function voiceProviders(ids: readonly string[]): VoiceProvider[] {
  return ids.map((id) => known(id).provider);
}

/** The path families a voice provider answers on, each `<base>/<id>` and, for the legacy provider, `<base>` alone. */
export type VoicePathBase = '/voice' | '/cr-action' | '/conversation';

/**
 * The id of the enabled provider a path names (`/voice/twilio`), or the legacy provider's for the
 * unprefixed path (`/voice`) when it is enabled; null for anything else, including a provider that
 * is not enabled, a deeper path and a different case.
 */
export function providerIdForPath(enabled: readonly string[], path: string, base: VoicePathBase): string | null {
  if (path === base) return enabled.includes(LEGACY_PROVIDER) ? LEGACY_PROVIDER : null;
  if (!path.startsWith(`${base}/`)) return null;
  const id = path.slice(base.length + 1);
  return enabled.includes(id) ? id : null;
}

/** The enabled provider a path names, as providerIdForPath reads it. */
export function providerForPath(enabled: readonly VoiceProvider[], path: string, base: VoicePathBase): VoiceProvider | null {
  const id = providerIdForPath(enabled.map((p) => p.id), path, base);
  return enabled.find((p) => p.id === id) ?? null;
}

/** The call id a carrier's setup frame names, the one its webhooks and the relay token use. */
export function setupCallIdOf(providerId: string, setup: SetupFrame): string {
  const p = Object.hasOwn(ALL, providerId) ? ALL[providerId as keyof typeof ALL] : undefined;
  return p?.provider.setupCallId?.(setup) ?? setup.callSid;
}

/** Which of a turn's text frames carry `last: true` on this carrier (VoiceProvider.textLast). */
export function textLastOf(providerId: string | undefined): 'each' | 'final' {
  const id = providerId ?? LEGACY_PROVIDER;
  const p = Object.hasOwn(ALL, id) ? ALL[id as keyof typeof ALL] : undefined;
  return p?.provider.textLast ?? 'each';
}

/** Whether a carrier drops the lines it has not yet said when `end` comes (VoiceProvider.endDropsSpeech). */
export function endDropsSpeechOf(providerId: string | undefined): boolean {
  return providerOf(providerId)?.endDropsSpeech === true;
}

/** The provider by id, or undefined for one the engine does not know. */
function providerOf(providerId: string | undefined): VoiceProvider | undefined {
  const id = providerId ?? LEGACY_PROVIDER;
  return Object.hasOwn(ALL, id) ? ALL[id as keyof typeof ALL].provider : undefined;
}

/** Whether a carrier reports its playback (VoiceProvider.readEvent), so a line it cuts short can be found. */
export function readsPlaybackEvents(providerId: string | undefined): boolean {
  return providerOf(providerId)?.readEvent !== undefined;
}

/** A carrier's own socket message as a PlaybackEvent (VoiceProvider.readEvent); null for a carrier that reads none. */
export function playbackEventOf(providerId: string | undefined, message: unknown): PlaybackEvent | null {
  return providerOf(providerId)?.readEvent?.(message) ?? null;
}

/** Whether a carrier reports the caller and the agent speaking as they happen (VoiceProvider.reportsSpeaking). */
export function reportsSpeakingOf(providerId: string | undefined): boolean {
  return providerOf(providerId)?.reportsSpeaking === true;
}

/** How the server stops a carrier's playback (VoiceProvider.stopPlayback); null when it cannot. */
export function stopPlaybackOf(providerId: string | undefined): 'silent-clip' | null {
  return providerOf(providerId)?.stopPlayback ?? null;
}

/**
 * The message for the first enabled carrier BARGE_IN=server cannot work on: one that does not report the
 * caller speaking (the server would never hear them), or that has no way to have its playback stopped;
 * null when every one can. The carrier's own barge-in is the way on such a carrier.
 */
export function serverBargeInRefusal(ids: readonly string[]): string | null {
  for (const id of ids) {
    const lacks = [
      ...(reportsSpeakingOf(id) ? [] : ['does not report the caller and the agent speaking']),
      ...(stopPlaybackOf(id) !== null ? [] : ['has no way for the server to stop its playback']),
    ];
    if (lacks.length > 0) {
      return `BARGE_IN=server needs a voice provider that reports the caller speaking and whose playback the server can stop; ${id} ${lacks.join(' and ')}. Use the carrier's own barge-in there (BARGE_IN=any, speech, dtmf or none), or take ${id} out of VOICE_PROVIDERS`;
    }
  }
  return null;
}
