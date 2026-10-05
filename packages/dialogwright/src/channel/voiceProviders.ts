/**
 * The phone carriers the engine has a voice provider for (src/server/voice/registry.ts), by id. A
 * plain list, so an app's YAML (voice.locales.<tag>.voices) is checked against it without loading
 * any server code; the registry is typed by it, so the two cannot drift apart.
 */
export const VOICE_PROVIDER_IDS = ['twilio', 'telnyx'] as const;

export type VoiceProviderId = (typeof VOICE_PROVIDER_IDS)[number];

/**
 * Who may talk over a line the agent is saying (BARGE_IN), as the relay element's `interruptible`
 * takes it: `any` (speech or a keypress), `speech` only, `dtmf` (a keypress) only, or `none`.
 */
export const BARGE_IN_MODES = ['any', 'speech', 'dtmf', 'none'] as const;

export type BargeIn = (typeof BARGE_IN_MODES)[number];

/**
 * The barge-in values each carrier's relay element takes. Twilio's ConversationRelay `interruptible`
 * takes none, dtmf, speech and any (true and false are older aliases of any and none); Telnyx's
 * `<ConversationRelay>` takes the same four (its reference lists none, any, speech, dtmf, with true
 * and false as aliases). A carrier added later that takes fewer lists only those, and a BARGE_IN it
 * does not take is refused at startup (bargeInRefusal) instead of being ignored.
 */
export const BARGE_IN_SUPPORT: Readonly<Record<VoiceProviderId, readonly BargeIn[]>> = {
  twilio: BARGE_IN_MODES,
  telnyx: BARGE_IN_MODES,
};

/**
 * The message for the first enabled carrier that does not take `mode`; null when every one does.
 * `support` is the table to read, BARGE_IN_SUPPORT unless a test gives another.
 */
export function bargeInRefusal(mode: BargeIn, ids: readonly string[], support: Readonly<Record<string, readonly BargeIn[]>> = BARGE_IN_SUPPORT): string | null {
  for (const id of ids) {
    const takes = Object.hasOwn(support, id) ? support[id]! : BARGE_IN_MODES;
    if (!takes.includes(mode)) {
      return `BARGE_IN=${mode} is not supported by the voice provider ${id} (it takes ${takes.join(', ')}); use one of those, or take ${id} out of VOICE_PROVIDERS`;
    }
  }
  return null;
}

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

/**
 * END_AFTER_PLAYBACK: whether a turn that ends the call holds its `end` frame until the lines before it
 * have played (server/adapter.ts). `auto` (the default) holds it on a carrier that drops what it has not
 * yet said when `end` comes (VoiceProvider.endDropsSpeech: Telnyx); `on` on every carrier; `off` on none,
 * the lines and the `end` sent together.
 */
export const END_AFTER_PLAYBACK_MODES = ['auto', 'on', 'off'] as const;
export type EndAfterPlayback = (typeof END_AFTER_PLAYBACK_MODES)[number];

/** END_PLAYBACK_MAX_MS unless set: the longest an `end` is held, whatever the lines are estimated to take. */
export const DEFAULT_END_PLAYBACK_MAX_MS = 15_000;

/**
 * On a call whose carrier reports its playback, how long past the lines' estimate (playbackEstimateMs)
 * the `end` waits for the report that they finished before it goes anyway: the estimate is rough, and a
 * report that never comes must not hold a call open.
 */
export const END_PLAYBACK_MARGIN_MS = 2_000;

/**
 * On a call whose carrier reports nothing of its playback, what is added to the lines' estimate before
 * the `end` goes: the carrier's time to begin speaking a line it has just been sent.
 */
export const END_PLAYBACK_LEAD_MS = 500;
