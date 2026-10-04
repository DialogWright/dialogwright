/**
 * A phone carrier that runs a text relay (ConversationRelay or a compatible one) in front of the
 * engine. Everything carrier-specific is here: proving a webhook came from the carrier, the document
 * that starts the relay and the ones that end the call, and reading the carrier's callback. The
 * socket frames themselves are the shared relay wire (src/channel/relay), which every provider of
 * this kind speaks. A new carrier is a new VoiceProvider and its conformance fixtures
 * (src/testing/voiceConformance.ts); nothing in the core changes.
 */

import type { Recognition } from '../../core/app/types';

/** A webhook as it arrived: its path with query, headers lower-cased, and the raw body. */
export interface WebhookRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly rawBody: string;
  /** Seconds since the epoch, for a provider whose signature is timed. */
  readonly nowSec: number;
}

/** A carrier's webhook, read into the engine's terms. Fields a carrier does not send are absent. */
export interface CallbackParams {
  /** The carrier's id for the call (Twilio's CallSid; Telnyx's CallSid on TeXML, or call_control_id). */
  readonly callId: string;
  readonly from?: string;
  readonly to?: string;
  /** The call's status in the carrier's words; `in-progress` is the one value the engine tests for. */
  readonly callStatus?: string;
  /** The relay session's status on the action callback (`completed` when it ended normally). */
  readonly sessionStatus?: string;
  /** The `end` frame's handoffData, as the carrier hands it back on the action callback. */
  readonly handoffData?: string;
  /** Everything the carrier sent, for the frame log (redacted before it is written). */
  readonly raw: Readonly<Record<string, string>>;
}

/** What the start document needs. */
export interface StartDocumentOptions {
  readonly publicHost: string;
  readonly token: string;
  readonly hints: string;
  /**
   * The carrier's own voice for the spoken prompts (config.ts voiceFor), never another carrier's; a
   * provider decides which of the two it uses (Telnyx's voice names carry their TTS provider).
   */
  readonly ttsProvider?: string;
  readonly voice?: string;
  /**
   * The carrier's own speech recognizer (config.ts recognitionFor), for a document that names no
   * language. Absent, Twilio's is Deepgram flux, as it was before the recognizer could be set, and
   * Telnyx's is its own default.
   */
  readonly recognition?: Recognition;
  /**
   * The language the call starts in, for an app that names its languages (server/http.ts
   * connectOptions); absent, the document names none and the carrier speaks its default (en-US), as
   * before languages. When present, `voice`, `ttsProvider` and `recognition` above are not used:
   * each language carries its own (xml.ts placeLanguages says where they are written), and a
   * language with none of its own gets the carrier's default, never another language's.
   */
  readonly language?: RelayLanguage;
  /** Every language the call may switch to (set_language), each with its voice; absent or empty, none named. */
  readonly languages?: readonly RelayLanguage[];
  /** Custom parameters the relay hands back on its setup frame; `locale` is the one the engine reads (SessionStart.locale). */
  readonly parameters?: Readonly<Record<string, string>>;
}

/** One language as a start document names it: what the voice speaks, what is heard, and the voice. */
export interface RelayLanguage {
  /** The language the voice speaks, a language tag: what a text frame's `lang` names (Say.lang). */
  readonly tts: string;
  /** The language speech is recognized in, a language tag. */
  readonly transcription: string;
  /** The voice, in the carrier's own names; absent for the carrier's default voice for this language. */
  readonly voice?: string;
  /** The voice's TTS provider, for a carrier that names it apart from the voice (Twilio's TTS_PROVIDER). */
  readonly ttsProvider?: string;
  /** The speech recognizer for this language; absent or empty, the carrier's default for it. */
  readonly recognition?: Recognition;
}

export interface VoiceProvider {
  /** Lower-case id used in paths (`/voice/<id>`) and VOICE_PROVIDERS. */
  readonly id: string;
  /** Whether the webhook is the carrier's own. `secret` is the carrier's key from config. */
  verify(req: WebhookRequest, secret: string, publicHost: string): boolean;
  /** The webhook body read into the engine's terms; null when it names no call. */
  parse(req: WebhookRequest): CallbackParams | null;
  /** The document that connects the call to the relay at `wss://<host>/conversation/<id>?token=`. */
  startDocument(o: StartDocumentOptions): string;
  dialDocument(number: string): string;
  hangupDocument(): string;
  /** Said when the relay cannot be reconnected, before the call goes to a person. */
  apologizeAndDialDocument(number: string): string;
  /** The response content type of every document. */
  readonly contentType: string;
}
