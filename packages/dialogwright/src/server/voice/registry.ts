import type { VoiceProvider } from './provider';
import { twilioProvider } from './twilio';

/** A carrier the engine knows: its provider, and the environment variable that holds its secret. */
interface KnownProvider {
  readonly provider: VoiceProvider;
  /** The variable VOICE_PROVIDERS makes required when it names this provider. */
  readonly secretVar: string;
  /** How the startup line names the secret (its value is never printed, only its length). */
  readonly secretLabel: string;
}

/** Every carrier the engine knows, by id, in the order the docs list them. */
const ALL: Readonly<Record<string, KnownProvider>> = {
  twilio: { provider: twilioProvider, secretVar: 'TWILIO_AUTH_TOKEN', secretLabel: 'auth token' },
};

/** The ids VOICE_PROVIDERS may name. */
export const KNOWN_VOICE_PROVIDERS: readonly string[] = Object.keys(ALL);

/** The provider the unprefixed `/voice`, `/cr-action` and `/conversation` belong to, for deployments made before providers. */
export const LEGACY_PROVIDER = 'twilio';

function known(id: string): KnownProvider {
  const k = Object.hasOwn(ALL, id) ? ALL[id] : undefined;
  if (k === undefined) throw new Error(`unknown voice provider "${id}"`);
  return k;
}

/** The environment variable that holds a provider's secret (TWILIO_AUTH_TOKEN, say). */
export function secretVarOf(id: string): string {
  return known(id).secretVar;
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
 * The enabled provider a path names (`/voice/twilio`), or the legacy provider's for the unprefixed
 * path (`/voice`) when it is enabled; null for anything else, including a provider that is not enabled.
 */
export function providerForPath(enabled: readonly VoiceProvider[], path: string, base: VoicePathBase): VoiceProvider | null {
  if (path === base) return enabled.find((p) => p.id === LEGACY_PROVIDER) ?? null;
  if (!path.startsWith(`${base}/`)) return null;
  const id = path.slice(base.length + 1);
  return enabled.find((p) => p.id === id) ?? null;
}
