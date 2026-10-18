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

/** The most keys a start's `context` may have, and the longest value: a start with more is refused. */
export const CHAT_CONTEXT_KEYS = 50;
export const CHAT_CONTEXT_VALUE_MAX = 500;
/** The most the whole context may take, as UTF-8 bytes of its JSON (the engine's CHAT_CONTEXT_BYTES), so a start fits the socket's frame. */
export const CHAT_CONTEXT_BYTES = 6 * 1024;
/** A context key as the engine takes one (its CONTEXT_KEY): letters, digits, underscores, hyphens and dots, at most 64. */
const CONTEXT_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

/**
 * The page's context as a start may carry it (the data an app's callData reads as chat.<key>): each
 * string under a key the engine takes, the first CHAT_CONTEXT_KEYS of them, as long as the whole stays
 * within CHAT_CONTEXT_BYTES; anything else is left out, with a warning, so the start is never refused
 * for it (a start too big for the socket would close it, and the widget would try again for ever).
 * Undefined when nothing is left.
 */
export function contextOf(raw: unknown, warn: (m: string) => void): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warn('DialogWright widget: context must be an object of strings, like {"page":"/orders"}; sending none');
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= CHAT_CONTEXT_KEYS) {
      warn(`DialogWright widget: context has more than ${CHAT_CONTEXT_KEYS} keys; the rest are left out`);
      break;
    }
    if (!CONTEXT_KEY.test(key) || typeof value !== 'string' || value.length > CHAT_CONTEXT_VALUE_MAX) {
      warn(`DialogWright widget: context "${key}" is left out: a key of letters, digits, underscores, hyphens and dots, and a string of at most ${CHAT_CONTEXT_VALUE_MAX} characters`);
      continue;
    }
    if (new TextEncoder().encode(JSON.stringify({ ...out, [key]: value })).length > CHAT_CONTEXT_BYTES) {
      warn(`DialogWright widget: context "${key}" is left out: the context may take at most ${CHAT_CONTEXT_BYTES} bytes in all`);
      continue;
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export type ClientMessage =
  | { type: 'start'; v: 1; locale?: string; token?: string; resume?: string; context?: Record<string, string> }
  | { type: 'text'; text: string }
  | { type: 'sign_in'; token: string }
  | { type: 'ping' }
  /** The person ends the chat; the server answers `end`. */
  | { type: 'end' };

/**
 * Why the server refused a message. `busy`: the server holds as many chats as it may (on a start; it
 * then closes the socket), or too many messages are waiting for their reply. `session_unknown`: the
 * chat a resume names has ended (the server then starts a new one).
 */
export type ChatErrorCode = 'bad_message' | 'too_long' | 'not_allowed' | 'sign_in_failed' | 'session_unknown' | 'busy' | 'server_error';

/** A run of a formatted line's words (a `say`'s `rich`): plain text, bold, italic or both; or a line break. Never markup. */
export type ChatInline = { text: string; bold?: true; italic?: true } | { break: true };
/** A block of a formatted line: a paragraph of runs, or a list whose items are runs (numbered where `ordered`). */
export type ChatBlock = { type: 'paragraph'; content: ChatInline[] } | { type: 'list'; ordered: boolean; items: ChatInline[][] };

export type ServerMessage =
  | { type: 'ready'; session: string; resume: string; locale: string }
  /**
   * A line. `rich`: the same words formatted, for a line the app gives a chat version; absent otherwise, and
   * `text` always carries the words. `replies`: answers to offer as buttons, each the words a tap sends as `text`.
   */
  | { type: 'say'; text: string; lang: string; rich?: ChatBlock[]; replies?: string[] }
  /**
   * The chat goes to a person, for `reason`. `data`: what the app's transfer sends a chat (app.yaml's
   * transfer.send.chat), for the page's own handover; absent unless the app writes it. `slots` (with
   * `unconfirmed`): the collected slots, only where app.yaml's handoff.data.chat says send.
   */
  | { type: 'transfer'; reason: string; data?: Record<string, string>; slots?: Record<string, string>; unconfirmed?: string[] }
  | { type: 'end' }
  | { type: 'signed_in'; level: number }
  | { type: 'error'; code: ChatErrorCode; message: string }
  | { type: 'pong' };
