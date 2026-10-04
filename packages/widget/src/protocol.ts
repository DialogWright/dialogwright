/**
 * The chat wire as the widget speaks it: a copy of the message types in the engine's
 * packages/dialogwright/src/channel/chat/protocol.ts, types only (no zod), so the bundle carries no
 * validator and no engine code. client.test.ts holds the copy to the engine's types, so it cannot drift.
 */

/** The protocol version a `start` names. */
export const CHAT_PROTOCOL_VERSION = 1;
/** The longest message a person may type in one turn; the server refuses longer with `too_long`. */
export const CHAT_TEXT_MAX = 500;

/** A language tag as `start.locale` takes one (the engine's LOCALE_TAG, at most 35 characters): a start with any other is refused. */
export function isLocaleTag(tag: string): boolean {
  return tag.length <= 35 && /^[A-Za-z]{2,8}([-_][A-Za-z0-9]{1,8})*$/.test(tag);
}

export type ClientMessage =
  | { type: 'start'; v: 1; locale?: string; token?: string; resume?: string }
  | { type: 'text'; text: string }
  | { type: 'sign_in'; token: string }
  | { type: 'ping' };

/**
 * Why the server refused a message. `busy`: the server holds as many chats as it may (on a start; it
 * then closes the socket), or too many messages are waiting for their reply. `session_unknown`: the
 * chat a resume names has ended (the server then starts a new one).
 */
export type ChatErrorCode = 'bad_message' | 'too_long' | 'not_allowed' | 'sign_in_failed' | 'session_unknown' | 'busy' | 'server_error';

export type ServerMessage =
  | { type: 'ready'; session: string; resume: string; locale: string }
  | { type: 'say'; text: string; lang: string }
  | { type: 'transfer'; reason: string }
  | { type: 'end' }
  | { type: 'signed_in'; level: number }
  | { type: 'error'; code: ChatErrorCode; message: string }
  | { type: 'pong' };
