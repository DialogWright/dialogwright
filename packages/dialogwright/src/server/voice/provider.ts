/**
 * A phone carrier that runs a text relay (ConversationRelay or a compatible one) in front of the
 * engine. Everything carrier-specific is here: proving a webhook came from the carrier, the document
 * that starts the relay and the ones that end the call, and reading the carrier's callback. The
 * socket frames themselves are the shared relay wire (src/channel/relay), which every provider of
 * this kind speaks. A new carrier is a new VoiceProvider and its conformance fixtures
 * (src/testing/voiceConformance.ts); nothing in the core changes.
 */

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
