import type { SetupFrame } from '../../channel/relay/frames';
import type { BargeIn } from '../../channel/voiceProviders';
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
  /** The call's status in the carrier's words, as it sent it (for the frame log and the notes). */
  readonly callStatus?: string;
  /**
   * Whether the call is still live, in the engine's terms: the provider reads it from its own
   * vocabulary (Twilio: `in-progress`; Telnyx: `active`, the relay's word, and `in-progress`,
   * TeXML's). Absent when the callback says nothing of the call's status; then decideAction
   * reconnects only a relay failure on a call the engine still holds live (server/http.ts). A
   * caller's own params without it are read as Twilio's words: live when callStatus is `in-progress`.
   */
  readonly live?: boolean;
  /** The relay session's status on the action callback (`completed` when it ended normally). */
  readonly sessionStatus?: string;
  /** The `end` frame's handoffData, as the carrier hands it back on the action callback. */
  readonly handoffData?: string;
  /** Everything the carrier sent, for the frame log (redacted before it is written). */
  readonly raw: Readonly<Record<string, string>>;
}

/** What the start document needs. */
export interface StartDocumentOptions {
  /** Optional event streams the carrier sends on the socket (Telnyx's `events` attribute); absent: none. */
  readonly events?: string;
  /**
   * Who may talk over a line the agent is saying (BARGE_IN), written as the relay element's
   * `interruptible`; absent, `any`, as it always was.
   */
  readonly bargeIn?: BargeIn;
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
  /**
   * Seconds of silence before the document connects (a `<Pause>` ahead of `<Connect>`): a planned
   * restart's handover (RESTART_PAUSE_S, server/index.ts drain), so the carrier's socket reaches the
   * restarted server rather than the one about to stop. Absent or 0, none, as before. A provider
   * that cannot pause leaves it out, and the document connects at once.
   */
  readonly pauseS?: number;
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

/**
 * What a carrier reports of its own playback and of the caller's voice, in the engine's terms, from
 * the optional events it sends on the socket (Telnyx's speaker-events and tokens-played). The adapter
 * reads them to find a line the carrier cut short (server/adapter.ts, RESAY_CUT_LINES), to hold a turn's
 * `end` until its lines have played (END_AFTER_PLAYBACK), and the caller's speaking to hold the no-input
 * wait while they talk (NO_INPUT_AFTER_SPEECH_MS): a carrier with no partial transcripts is otherwise
 * told "I didn't hear anything." over a caller still finishing a sentence.
 * - `playback started`: the carrier began speaking the agent's lines.
 * - `playback finished`: it stopped; with `text`, the line it says it played (the line as it was sent).
 * - `caller speaking`: the carrier heard the caller start (`true`) or stop (`false`) speaking.
 */
export type PlaybackEvent =
  | { readonly kind: 'playback'; readonly state: 'started' }
  | { readonly kind: 'playback'; readonly state: 'finished'; readonly text?: string }
  | { readonly kind: 'caller'; readonly speaking: boolean };

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
  /**
   * The call's id in a setup frame, the same id its webhooks carry (what the relay token is minted for).
   * Absent: the setup's `callSid`. Telnyx's setup carries the webhook's `CallSid` as `callControlId`, and a
   * different id as `callSid`.
   */
  setupCallId?(setup: SetupFrame): string;
  /**
   * The number the caller is calling from, as the setup frame carries it, or null when it carries
   * none: what the console's call_started shows masked, and what a slot that offers the caller's
   * number reads (SessionStart.callerNumber, core/callerNumber.ts, which refuses a withheld one).
   * Absent: the setup's `from`. Telnyx's setup has `from` null and the number in its custom
   * parameters, as `telnyx_call_from`.
   */
  setupCallerOf?(setup: SetupFrame): string | null;
  /**
   * The number the caller called (the DNIS), as the setup frame carries it, or null when it carries
   * none: what an app that keeps it reads (SessionStart.calledNumber, App.callerNumber `called`).
   * Absent: the setup's `to`. Telnyx's setup has `to` null and the number in its custom parameters,
   * as `telnyx_call_to`.
   */
  setupCalledOf?(setup: SetupFrame): string | null;
  /**
   * Which text frames of one turn carry `last: true`. `each` (absent): every one, as Twilio speaks them
   * all. `final`: only the turn's last text frame, the others `last: false`; a carrier that ends the
   * reply at the first `last: true` and drops what follows needs it (Telnyx, seen on a live call).
   */
  readonly textLast?: 'each' | 'final';
  /**
   * Whether the carrier, on an `end` frame, drops the lines it has been sent and not yet said. True: a
   * turn that ends the call holds its `end` until those lines have played (END_AFTER_PLAYBACK auto,
   * server/adapter.ts), or the caller never hears the goodbye or the transfer line (Telnyx, seen on a live
   * call). Absent: the carrier plays what is queued before it acts on `end`, as long as the socket stays
   * open (Twilio; the adapter keeps it open for END_CLOSE_GRACE_MS after `end`), so `end` goes with the lines.
   */
  readonly endDropsSpeech?: boolean;
  /**
   * A message of the carrier's own on the socket (one the relay wire does not know), as a PlaybackEvent,
   * or null when it is not one. Absent: the carrier reports no playback and no caller speaking (Twilio),
   * a line it cuts short cannot be found, and only transcripts (partial ones included) end the no-input wait.
   */
  readEvent?(message: unknown): PlaybackEvent | null;
}
