import { z } from 'zod';
import type { Action } from '../actions';

/**
 * The web chat wire: our own JSON, one message per WebSocket frame, versioned by `start.v`. The
 * widget speaks it, and so may any client a site writes; it is a public contract, so a change that
 * a client would notice is a new version.
 *
 * Client to server: `start` (v, locale?, token?, resume?), `text` (text), `sign_in` (token), `ping`.
 * Server to client: `ready` (session, resume, locale), `say` (text, lang), `transfer` (reason), `end`,
 * `signed_in` (level), `error` (code, message), `pong`.
 *
 * The server never sends what the core keeps for a person taking over (a transfer's collected slots,
 * what was completed and queued): a site learns only that the session was handed over, and why.
 */
export const CHAT_PROTOCOL_VERSION = 1;
/** The longest message a person may type in one turn (as an app's own chat takes: server/chatHttp.ts). */
export const CHAT_TEXT_MAX = 500;
/** The longest sign-in token taken; an identity provider's ID token is a few kilobytes at most. */
export const CHAT_TOKEN_MAX = 8192;
/** A language tag, as a client asks for one: letters, then subtags of letters and digits. Only ever compared (core/locale.ts matchLocale). */
const LOCALE_TAG = /^[A-Za-z]{2,8}([-_][A-Za-z0-9]{1,8})*$/;
/** A resume token, as `ready` gives one: 16 random bytes in hex. */
const RESUME_TOKEN = /^[0-9a-f]{32}$/;

const clientMessage = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('start'),
    v: z.literal(CHAT_PROTOCOL_VERSION),
    locale: z.string().max(35).regex(LOCALE_TAG).optional(),
    token: z.string().min(1).max(CHAT_TOKEN_MAX).optional(),
    resume: z.string().regex(RESUME_TOKEN).optional(),
  }),
  z.strictObject({ type: z.literal('text'), text: z.string().min(1).max(CHAT_TEXT_MAX) }),
  z.strictObject({ type: z.literal('sign_in'), token: z.string().min(1).max(CHAT_TOKEN_MAX) }),
  z.strictObject({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof clientMessage>;

export type ChatErrorCode = 'bad_message' | 'too_long' | 'not_allowed' | 'sign_in_failed' | 'session_unknown' | 'server_error';

export type ServerMessage =
  | { type: 'ready'; session: string; resume: string; locale: string }
  | { type: 'say'; text: string; lang: string }
  | { type: 'transfer'; reason: string }
  | { type: 'end' }
  | { type: 'signed_in'; level: number }
  | { type: 'error'; code: ChatErrorCode; message: string }
  | { type: 'pong' };

export type ParsedClientMessage = { ok: true; message: ClientMessage } | { ok: false; code: ChatErrorCode; message: string };

/**
 * One client message, or why it is not one. The reason names the field and the rule, never the
 * value (a token in a malformed message must not come back in an error, or reach a log).
 */
export function parseClientMessage(raw: string): ParsedClientMessage {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'bad_message', message: 'a message is one JSON object' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return { ok: false, code: 'bad_message', message: 'a message is one JSON object' };
  const o = json as { type?: unknown; text?: unknown };
  // Said apart from a malformed message: a person who typed too much is told so, and is not counted against.
  if (o.type === 'text' && typeof o.text === 'string' && o.text.length > CHAT_TEXT_MAX) {
    return { ok: false, code: 'too_long', message: `a message is at most ${CHAT_TEXT_MAX} characters` };
  }
  const r = clientMessage.safeParse(json);
  if (r.success) return { ok: true, message: r.data };
  const issue = r.error.issues[0];
  const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'message';
  const why = issue?.code === 'unrecognized_keys' ? 'has a field the protocol does not have'
    : issue?.code === 'invalid_union' || where === 'type' ? 'is not a type the protocol has (start, text, sign_in, ping)'
    : where === 'v' ? `must be ${CHAT_PROTOCOL_VERSION}, the protocol version this server speaks`
    : 'is not what the protocol takes';
  return { ok: false, code: 'bad_message', message: `${where} ${why}` };
}

export function serializeServerMessage(m: ServerMessage): string {
  return JSON.stringify(m);
}

/**
 * What a chat shows for the core's actions: a line's words, a transfer's reason, the end. A chat
 * session runs without recorded clips (its render context is unset), so a line is all words; a clip
 * part, should one come, is left out rather than sent as a URL. `defaultLang` is the language of a
 * line that names none (every line of an app without locales): the app's default locale.
 * set_language and send_digits are a phone's and show nothing.
 */
export function actionsToChatMessages(actions: readonly Action[], defaultLang: string): ServerMessage[] {
  return actions.flatMap((a): ServerMessage[] => {
    switch (a.type) {
      case 'say': {
        const text = a.parts.flatMap((p) => ('text' in p ? [p.text] : [])).join(' ').trim();
        return text === '' ? [] : [{ type: 'say', text, lang: a.lang ?? defaultLang }];
      }
      case 'transfer':
        return [{ type: 'transfer', reason: a.reason }];
      case 'end':
        return [{ type: 'end' }];
      case 'set_language':
      case 'send_digits':
        return [];
    }
  });
}
