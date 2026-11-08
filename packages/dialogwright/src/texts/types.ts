/**
 * Texts (SMS and MMS): a capability the server gives an app's code, neutral to any app
 * (docs/designs/2026-11-08-texting.md; the guide's 13.17). The engine sends and receives; whether a text
 * is sent at all, to whom and in what words is the app's: a text to a caller goes through a tool, which
 * the gate holds to the app's policy (business.yaml's `when` for an agent-mode app's consent), and a text
 * that comes in is handed to the app's own hook (AppCode.onText).
 *
 * - **Sending.** A tool (ToolContext.texts) and the incoming hook (TextContext.texts) send with
 *   `texts.send({ to, body, media? })`, absent where the server has no sender (TEXT_FROM unset): an app
 *   then prints what it would have sent, as before. Each text is recorded in the audit (`text_sent`: the
 *   number by its last four, the body by its length, the media by their count, the provider's message id
 *   and status) and, on a call, in the turn's trace (TraceRecord.texts).
 * - **Receiving.** `POST /messages/<provider>` (Twilio's today), its signature checked as the voice
 *   webhook's is; the number texted picks the app, as a call's number does under a host. The message is
 *   recorded (`text_received`: from by its last four, the media by their count; no media is fetched) and
 *   handed to App.onText. The engine answers the provider with nothing to send (no auto-reply).
 *
 * A provider is one adapter (TextProvider): Twilio's Messages API by fetch (texts/twilio.ts) today; a
 * Telnyx one is a second adapter of the same shape, chosen by a setting when it is added.
 */

/** A text an app sends: the number (E.164, or ten digits read as +1), the words, and media to attach by URL. */
export interface OutgoingText {
  /** The number it goes to: E.164 ("+15555550177"), or ten digits of a North American number ("5555550177"). */
  readonly to: string;
  /** The words, as the app wrote them (a fixed line: an app never sends a generated one to a caller). */
  readonly body: string;
  /**
   * Media to attach, by public URL (an MMS): the provider fetches each; the engine downloads nothing. A
   * photo a caller texted in is forwarded by passing its URL (IncomingText.media) here.
   */
  readonly media?: readonly string[];
  /**
   * The write's key (ToolContext.idempotencyKey): a text sent again with the same key on this server is
   * not sent twice; the first receipt is returned, marked `repeat`. Absent, every send is sent.
   */
  readonly key?: string;
}

/** What a provider said of a text it took: its message id and its status ("queued", "accepted"), or `failed`. */
export interface TextReceipt {
  /** The provider's message id ("SM..."), null where it took none (a failure before it answered). */
  readonly id: string | null;
  /** The provider's status as it answered, or `failed`. */
  readonly status: string;
  /** Why it failed, safe to record (the provider's error code and message, never a key or the body). */
  readonly error?: string;
  /** The text was sent before under the same key (OutgoingText.key), and not sent again. */
  readonly repeat?: true;
}

/** A provider's adapter: it sends one text from a number, and never throws (a failure is a receipt with `failed`). */
export interface TextProvider {
  /** The provider's id ("twilio"), as the audit and the log name it. */
  readonly id: string;
  send(text: OutgoingText & { readonly from: string }): Promise<TextReceipt>;
}

/** What an app's code sends with: the server's provider, from the app's number, each text recorded. */
export interface Texts {
  send(text: OutgoingText): Promise<TextReceipt>;
}

/** A medium a text came with: the provider's URL for it, and its content type ("image/jpeg"). */
export interface IncomingMedia {
  readonly url: string;
  readonly contentType: string;
}

/** A text that came in, as the provider's webhook gave it. */
export interface IncomingText {
  /** The provider's message id ("SM..."). */
  readonly id: string;
  /** The number it came from (E.164), whole: the app's code decides what it keeps of it. */
  readonly from: string;
  /** The number it was sent to (E.164): the business's, which picked the app. */
  readonly to: string;
  /** The words, as sent ("" for a photo alone). */
  readonly body: string;
  /** The media it came with, by the provider's URL, in order; the engine fetches none. */
  readonly media: readonly IncomingMedia[];
  /** The provider's id ("twilio"). */
  readonly provider: string;
}

/** What App.onText is given beside the message: the sender, the app's settings and its systems. */
export interface TextContext {
  /** The sender, from the app's number; absent where the server has none (TEXT_FROM unset). */
  readonly texts?: Texts;
  /** One of the app's own settings, by name (as AppContext.env). */
  env(name: string): string | undefined;
  /**
   * The app's systems (App.systems' `sys`), the same the server's calls use, so a request a call made can
   * be found by the number it texts from. The app's own code reads them; no tool runs and the gate is not
   * asked, as nothing here is done for a caller on a call.
   */
  readonly sys: unknown;
  /** The time, ms since the epoch. */
  readonly nowMs: number;
}

/** A text as it is recorded (the audit's text_sent and text_received, TraceRecord.texts): no number whole, no words. */
export interface TextRecord {
  readonly direction: 'sent' | 'received';
  /** The other party's number by its last four ("...0177"). */
  readonly number: string;
  /** The body's length, in characters. */
  readonly bodyLength: number;
  /** How many media it carried. */
  readonly media: number;
  /** The provider's message id, null where there is none. */
  readonly id: string | null;
  /** The provider's status ("queued", "received"), or `failed`. */
  readonly status: string;
  /** Why a send failed, as the receipt says it. */
  readonly error?: string;
  /** A send not made again for its key (OutgoingText.key). */
  readonly repeat?: true;
  readonly provider: string;
}
