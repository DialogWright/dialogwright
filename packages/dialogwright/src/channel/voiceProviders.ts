/**
 * The phone carriers the engine has a voice provider for (src/server/voice/registry.ts), by id. A
 * plain list, so an app's YAML (voice.locales.<tag>.voices) is checked against it without loading
 * any server code; the registry is typed by it, so the two cannot drift apart.
 */
export const VOICE_PROVIDER_IDS = ['twilio', 'telnyx'] as const;

export type VoiceProviderId = (typeof VOICE_PROVIDER_IDS)[number];

/**
 * Who may talk over a line the agent is saying, as the relay element's `interruptible` takes it: `any`
 * (speech or a keypress), `speech` only, `dtmf` (a keypress) only, or `none`.
 */
export const RELAY_BARGE_IN_MODES = ['any', 'speech', 'dtmf', 'none'] as const;

export type RelayBargeIn = (typeof RELAY_BARGE_IN_MODES)[number];

/**
 * BARGE_IN: one of the relay element's own modes (RELAY_BARGE_IN_MODES), or `server`: the relay element
 * says `none`, and the server does the barge-in itself, from the carrier's reports of the caller speaking,
 * stopping the playback when the caller has spoken over a line for BARGE_IN_MIN_SPEECH_MS (server/adapter.ts).
 * It needs a carrier that reports the caller and the agent speaking and can have its playback stopped
 * (VoiceProvider.reportsSpeaking, stopPlayback); config.ts refuses it for any other.
 */
export const BARGE_IN_MODES = [...RELAY_BARGE_IN_MODES, 'server'] as const;

export type BargeIn = (typeof BARGE_IN_MODES)[number];

/** The relay element's `interruptible` for a BARGE_IN: its own, or `none` for `server`, whose barge-in is the server's. */
export function relayBargeIn(mode: BargeIn): RelayBargeIn {
  return mode === 'server' ? 'none' : mode;
}

/**
 * The relay element's barge-in values each carrier takes. Twilio's ConversationRelay `interruptible`
 * takes none, dtmf, speech and any (true and false are older aliases of any and none); Telnyx's
 * `<ConversationRelay>` takes the same four (its reference lists none, any, speech, dtmf, with true
 * and false as aliases). A carrier added later that takes fewer lists only those, and a BARGE_IN it
 * does not take is refused at startup (bargeInRefusal) instead of being ignored.
 */
export const BARGE_IN_SUPPORT: Readonly<Record<VoiceProviderId, readonly RelayBargeIn[]>> = {
  twilio: RELAY_BARGE_IN_MODES,
  telnyx: RELAY_BARGE_IN_MODES,
};

/**
 * The message for the first enabled carrier whose relay element does not take `mode` (for `server`, the
 * `none` it is sent); null when every one does. `support` is the table to read, BARGE_IN_SUPPORT unless a
 * test gives another. What `server` needs besides is the carriers' own (server/voice/registry.ts
 * serverBargeInRefusal).
 */
export function bargeInRefusal(mode: BargeIn, ids: readonly string[], support: Readonly<Record<string, readonly RelayBargeIn[]>> = BARGE_IN_SUPPORT): string | null {
  const relay = relayBargeIn(mode);
  for (const id of ids) {
    const takes = Object.hasOwn(support, id) ? support[id]! : RELAY_BARGE_IN_MODES;
    if (!takes.includes(relay)) {
      const sent = relay === mode ? '' : ` (its relay element is sent interruptible="${relay}")`;
      return `BARGE_IN=${mode}${sent} is not supported by the voice provider ${id} (it takes ${takes.join(', ')}); use one of those, or take ${id} out of VOICE_PROVIDERS`;
    }
  }
  return null;
}

/**
 * BARGE_IN_MIN_SPEECH_MS unless set: with BARGE_IN=server, how long the caller must be heard speaking over
 * a line before its playback is stopped. Telnyx reported blips of 0.12 to 0.24 s with no transcript after
 * them (noise the recognizer dropped) on a live call (2026-10-05); 0.4 s is past those and past a cough or
 * an "mm", and stops a caller who talks over a line within about half a second.
 */
export const DEFAULT_BARGE_IN_MIN_SPEECH_MS = 400;

/**
 * SPEECH_GAP_MS unless set: on a carrier that reports the caller speaking, the longest pause in their speech
 * that still counts as the same stretch of it. A carrier reports a sentence as many short bursts (Telnyx sent
 * clientSpeaking on and off twelve times over one 5.5 s sentence, with pauses of about 0.15 s), so a stretch
 * runs across pauses this short; a longer pause ends it. BARGE_IN=server sums the caller's speech over a line
 * across them, and a caller who came back in at once after a reply (continueWithinMs) is followed across them.
 */
export const DEFAULT_SPEECH_GAP_MS = 300;

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

/**
 * NO_INPUT_AFTER_SPEECH_MS unless set: on a carrier that reports the caller's voice (Telnyx's clientSpeaking,
 * VoiceProvider.readEvent), how long after the caller stops speaking the no-input wait gives the carrier's
 * transcript to arrive before a silence turn may run, when the wait would otherwise have run out sooner.
 * Telnyx's transcript came about a second after the last report of the caller speaking on a live call
 * (2026-10-05); 2.5 s covers that with room, and is short enough after a cough with no transcript.
 */
export const DEFAULT_NO_INPUT_AFTER_SPEECH_MS = 2_500;
