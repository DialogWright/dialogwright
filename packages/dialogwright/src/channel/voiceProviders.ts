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

/**
 * NO_INPUT_AFTER_SPEECH_MS unless set: on a carrier that reports the caller's voice (Telnyx's clientSpeaking,
 * VoiceProvider.readEvent), how long after the caller stops speaking the no-input wait gives the carrier's
 * transcript to arrive before a silence turn may run, when the wait would otherwise have run out sooner.
 * Telnyx's transcript came about a second after the last report of the caller speaking on a live call
 * (2026-10-05); 2.5 s covers that with room, and is short enough after a cough with no transcript.
 */
export const DEFAULT_NO_INPUT_AFTER_SPEECH_MS = 2_500;

/**
 * KEY_WAIT_MS unless set: after a key pressed at an offer that takes a yes or a no only (the consent to
 * text for the whole call too), how long the server waits for the next key before the keys are taken
 * as one answer (core/turn.ts keyBurstPending): a 1 alone is a yes, a 2 alone a no, a number keyed in
 * full neither. Two seconds is the usual inter-digit wait of a phone menu: long enough between the
 * keys of a number keyed by hand, short enough that a caller who pressed 1 is not left waiting.
 */
export const DEFAULT_KEY_WAIT_MS = 2_000;

/**
 * RESUME_AFTER_PAUSE_MS unless set: on a carrier that reports the caller's voice, the longest pause in a
 * caller's speech that still leaves them not finished (server/adapter.ts, a caller who came back in). A
 * recognizer ends a prompt at a short pause (Telnyx's about 0.8 s after the caller stops), and a caller
 * pausing for a second or two in the middle of an address or a number is normal: on a live call
 * (2026-10-05) the caller came back in 1.68 s after they stopped, and their address was split in two. A
 * pause this long or shorter, before they come back in or while they go on, keeps it one utterance.
 */
export const DEFAULT_RESUME_AFTER_PAUSE_MS = 2_000;

/**
 * RESUME_INTO_REPLY_MS unless set: on a carrier that reports the caller's voice, the latest after the reply
 * to their last prompt went out that a caller coming back in is still taken as not finished. An answer to
 * the reply cannot start before the caller has heard some of it (Telnyx begins playing a line about 65 ms
 * after it is sent, and a question takes seconds); on live calls (2026-10-05) callers came back in 24 ms
 * and 696 ms after the reply went out.
 */
export const DEFAULT_RESUME_INTO_REPLY_MS = 1_000;

/**
 * SPURIOUS_INTERRUPT_WINDOW_MS unless set: on a carrier that reports the caller's voice, how recently
 * before a carrier's `interrupt` the caller must have been heard (starting or stopping speaking) for it to
 * be their barge-in (server/adapter.ts, a spurious interrupt). Telnyx's interrupt came 0.30 s after the
 * caller was heard starting on a live call (2026-10-05), and its endpointing ends a prompt about 0.8 s
 * after the caller stops: 700 ms covers the first with room, and is shorter than the gap a reply to a
 * final prompt always leaves after the caller stopped, so a carrier's barge-in on the reply with no new
 * speech is not taken as the caller's.
 */
export const DEFAULT_SPURIOUS_INTERRUPT_WINDOW_MS = 700;

/**
 * INCOMPLETE_WAIT_MS unless set: on a carrier that reports the caller's voice, the longest the reply to a
 * final prompt the model reads as unfinished is held for the caller to go on (server/adapter.ts, a reply
 * held). On live Telnyx calls (2026-10-05) callers who had not finished came back in 24 ms, 518 ms and
 * 696 ms after the reply to their fragment went out (0.23 s to 0.89 s after its prompt came): 1000 ms
 * covers them, and is RESUME_INTO_REPLY_MS's default, past which a caller is taken as answering the reply
 * anyway.
 */
export const DEFAULT_INCOMPLETE_WAIT_MS = 1_000;
