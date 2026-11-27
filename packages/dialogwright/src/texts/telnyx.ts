import { createHash } from 'node:crypto';
import { e164, scrubbed } from './twilio';
import type { IncomingMedia, IncomingText, OutgoingText, TextProvider, TextReceipt } from './types';

/**
 * Telnyx's texts: sending through its Messaging API v2 by fetch (no SDK), and reading the events of its
 * messaging webhook. The webhook's signature is checked by the server exactly as the voice webhooks' is
 * (server/voice/telnyxSignature.ts: Ed25519 over `<timestamp>|<body>`, TELNYX_PUBLIC_KEY, five minutes
 * either way), before anything here reads it.
 *
 * Read from developers.telnyx.com on 2026-11-26: "Send a message" (POST /v2/messages), "Receiving
 * webhooks" (message.received, message.sent, message.finalized) and "Send & receive MMS".
 *
 * Where it differs from Twilio's (texts/twilio.ts):
 * - The body is JSON (`from`, `to`, `text`, `media_urls`), the key a bearer token; there is no account id.
 * - `messaging_profile_id` is not sent: Telnyx needs it only to send from a number pool or an alphanumeric
 *   sender, and a text here is sent from one number (TEXT_FROM), which is already on its messaging profile.
 * - Telnyx keeps idempotency itself: an `Idempotency-Key` header, held across the whole account for 24
 *   hours, its successes replayed. An app's key (OutgoingText.key) is promised only for its own server, and
 *   two servers, two apps or a restarted one may use the same key for another text; so the header is a hash
 *   of the text itself (telnyxIdempotencyKey: the number it is sent from, the number it goes to, the app's
 *   key and its content, words and media), never the key alone, and holds no word of it (Telnyx asks that
 *   no sensitive data be in the key, and takes only letters, digits, `-` and `_`). The same text sent again
 *   after a restart, when this server's own keys (record.ts TextKeys) are gone, is still sent once (a replay
 *   is marked `repeat`); anything else is another key, and never taken for it.
 * - A keyed send's idempotency answers (developers.telnyx.com, "Send a message") are what they mean, never
 *   a plain failure where the text went: a 409 (10036, a request with this key still in progress) and a 503
 *   (10016, the key could not be held; Telnyx says to send again with it) are asked once more with the same
 *   key after TELNYX_RETRY_AFTER_MS; a 409 still is `pending` (the first is being sent), a 503 still is
 *   `failed` (not sent); a 422 (the key reused with another request) is `duplicate`, a text Telnyx took
 *   before under this key, not sent again. Without a key none is asked again: nothing would hold a second ask
 *   to one text.
 * - `text` is left out of a photo with no words: Telnyx takes it only non-empty (Twilio takes an empty
 *   Body with media).
 * - Media are under 1 MB in all (Telnyx's send API; the carriers' own limits are lower, 600 KB the safe
 *   figure, and a messaging profile with MMS transcoding on has Telnyx resize them, "MMS transcoding"; Twilio
 *   takes 5 MB and resizes images itself). Over it, Telnyx refuses the text, either as it is sent (the
 *   receipt `failed`) or after it took it (its delivery failed, a status the engine does not read: the
 *   receipt stays `queued`). The engine resizes nothing.
 * - The id is a UUID (Twilio's an `SM...`), the status the first recipient's (`queued`, as Twilio's).
 * - Telnyx publishes no figure for its rate limits: a text it holds for one is queued, not refused
 *   (`wait_seconds`); the sender's own limits (TEXT_LIMIT_*) hold as for Twilio.
 */

/** The Messaging API's base. */
export const TELNYX_API = 'https://api.telnyx.com';

/** How long a send may take before it is a failure, ms. */
export const TELNYX_SEND_TIMEOUT_MS = 10000;

/** How long a keyed send Telnyx answered 409 or 503 waits before it is asked once more with the same key, ms. */
export const TELNYX_RETRY_AFTER_MS = 1000;

/** What the Telnyx sender needs: the API key, and (for a test) the fetch it asks with. */
export interface TelnyxTextOptions {
  readonly apiKey: string;
  /** The fetch it sends with; a test passes its own. Default the global fetch. */
  readonly fetch?: typeof fetch;
  /** The API's base, for a test; default TELNYX_API. */
  readonly base?: string;
  readonly timeoutMs?: number;
  /** The wait before a 409 or 503 is asked again, for a test; default TELNYX_RETRY_AFTER_MS. */
  readonly retryAfterMs?: number;
}

/**
 * A keyed text's Idempotency-Key as Telnyx holds it, account-wide: the SHA-256 in hex of the number it is
 * sent from and the number it goes to (each in E.164), the app's key, its words and its media URLs in order.
 * The same text sent again has the same; any other text another, so no two servers or apps on one account,
 * nor a server restarted, take one text for another. No word of any of them is sent.
 */
export function telnyxIdempotencyKey(text: OutgoingText & { readonly from: string; readonly key: string }): string {
  return createHash('sha256').update(JSON.stringify(['text', e164(text.from), e164(text.to), text.key, text.body, [...(text.media ?? [])]]), 'utf8').digest('hex');
}

/** The first error of a Telnyx error body, or nothing. */
function firstError(body: unknown): { code?: unknown; title?: unknown; detail?: unknown } {
  const errors = typeof body === 'object' && body !== null ? (body as { errors?: unknown }).errors : undefined;
  return Array.isArray(errors) && typeof errors[0] === 'object' && errors[0] !== null ? (errors[0] as { code?: unknown; title?: unknown; detail?: unknown }) : {};
}

/** A Telnyx error's code ("10036"), or "" where it gave none. */
function errorCode(body: unknown): string {
  const { code } = firstError(body);
  return typeof code === 'string' || typeof code === 'number' ? scrubbed(String(code)).slice(0, 20) : '';
}

/** A Telnyx error's code and words, safe to record: never the body, the numbers or a key. */
function errorOf(status: number, body: unknown, apiKey: string): string {
  const first = firstError(body);
  const code = errorCode(body) !== '' ? ` ${errorCode(body)}` : '';
  const words = [first.title, first.detail].filter((w): w is string => typeof w === 'string' && w !== '').join(': ');
  const safe = scrubbed(words.split(apiKey).join('[key]')).slice(0, 200);
  return `HTTP ${status}${code}${safe !== '' ? `: ${safe}` : ''}`;
}

/** The Telnyx sender (TextProvider): one POST to /v2/messages a text, never throwing. */
export function telnyxTextProvider(o: TelnyxTextOptions): TextProvider {
  const send = o.fetch ?? fetch;
  const url = `${o.base ?? TELNYX_API}/v2/messages`;
  const timeoutMs = o.timeoutMs ?? TELNYX_SEND_TIMEOUT_MS;
  return {
    id: 'telnyx',
    async send(text: OutgoingText & { readonly from: string }): Promise<TextReceipt> {
      const media = text.media ?? [];
      // A photo with no words has no `text`: Telnyx takes it only non-empty.
      const words = text.body === '' && media.length > 0 ? {} : { text: text.body };
      const body = JSON.stringify({ from: e164(text.from), to: e164(text.to), ...words, ...(media.length > 0 ? { media_urls: [...media] } : {}) });
      const headers: Record<string, string> = { authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json', accept: 'application/json' };
      const keyed = text.key !== undefined;
      if (text.key !== undefined) headers['idempotency-key'] = telnyxIdempotencyKey({ ...text, key: text.key });
      let answer = await ask(body, headers);
      if (keyed && (answer.status === 409 || answer.status === 503)) {
        await new Promise((r) => setTimeout(r, o.retryAfterMs ?? TELNYX_RETRY_AFTER_MS));
        answer = await ask(body, headers);
      }
      if ('failed' in answer) return answer.failed;
      if (answer.ok) {
        const data = typeof answer.body === 'object' && answer.body !== null ? ((answer.body as { data?: unknown }).data as { id?: unknown; to?: unknown } | undefined) : undefined;
        const to = Array.isArray(data?.to) ? (data.to[0] as { status?: unknown } | undefined) : undefined;
        const receipt: TextReceipt = { id: typeof data?.id === 'string' ? data.id : null, status: typeof to?.status === 'string' ? to.status : 'accepted' };
        return answer.replayed ? { ...receipt, repeat: true } : receipt;
      }
      const code = errorCode(answer.body);
      const head = `HTTP ${answer.status}${code !== '' ? ` ${code}` : ''}`;
      if (keyed && answer.status === 409) return { id: null, status: 'pending', error: `${head}: Telnyx is still sending a text with this key; not sent again` };
      if (keyed && answer.status === 503) return { id: null, status: 'failed', error: `${head}: Telnyx could not hold the text to its key, and did not send it; send it again with the same key` };
      if (keyed && answer.status === 422) return { id: null, status: 'duplicate', error: `${head}: Telnyx took another request with this key in the last 24 hours; this one was not sent` };
      return { id: null, status: 'failed', error: errorOf(answer.status, answer.body, o.apiKey) };
    },
  };

  /** One POST: Telnyx's answer (its status, its body, whether it was a replay), or the failed receipt of a send that got none. */
  async function ask(body: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number; body: unknown; replayed: boolean } | { failed: TextReceipt; status: 0 }> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const res = await send(url, { method: 'POST', headers, body, signal: abort.signal });
      let answer: unknown = null;
      try {
        answer = await res.json();
      } catch {
        answer = null;
      }
      return { ok: res.ok, status: res.status, body: answer, replayed: res.headers.get('idempotent-replayed') === 'true' };
    } catch (err) {
      return { failed: { id: null, status: 'failed', error: abort.signal.aborted ? `no answer in ${timeoutMs} ms` : (err instanceof Error ? err.name : 'error') }, status: 0 };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The most media one message carries (Telnyx's limit, as Twilio's). */
const MAX_MEDIA = 10;

/**
 * Where Telnyx keeps a message's media: a URL anywhere else is not handed on. Telnyx's pages show its
 * inbound media at this host (media.telnyx.com, read 2026-11-26) without saying it is the only one; a photo
 * at another host is dropped and counted (`mediaDropped`), never handed on, so a host Telnyx uses that this
 * does not name shows as dropped photos on the first live text, not as a photo let through.
 */
export const TELNYX_MEDIA_PREFIX = 'https://media.telnyx.com/';

/** What a messaging webhook said: a text that came in, or the status of one sent (message.sent, message.finalized). */
export type TelnyxMessageEvent =
  | { readonly kind: 'received'; readonly message: IncomingText; readonly mediaDropped: number }
  | { readonly kind: 'status'; readonly event: string; readonly id: string | null; readonly status: string | null };

const record = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * A Telnyx messaging webhook's body (JSON, `{ data: { event_type, payload } }`) as an event: a
 * `message.received` as an IncomingText (payload.id, payload.from.phone_number, the first of payload.to,
 * payload.text, payload.media's url and content_type) with how many media URLs were dropped for not being
 * Telnyx's own (TELNYX_MEDIA_PREFIX); any other `message.*` event a status; null for anything else, or a
 * received message that names no id or no sender.
 */
export function parseTelnyxMessage(body: unknown): TelnyxMessageEvent | null {
  const data = record(record(body)?.data);
  const event = str(data?.event_type);
  const payload = record(data?.payload);
  if (event === null || payload === null || !event.startsWith('message.')) return null;
  const to = Array.isArray(payload.to) ? payload.to.map(record) : [];
  if (event !== 'message.received') return { kind: 'status', event, id: str(payload.id), status: str(to[0]?.status) };
  const id = str(payload.id) ?? '';
  const from = str(record(payload.from)?.phone_number) ?? '';
  if (id === '' || from === '') return null;
  const media: IncomingMedia[] = [];
  let mediaDropped = 0;
  for (const m of (Array.isArray(payload.media) ? payload.media : []).slice(0, MAX_MEDIA)) {
    const url = str(record(m)?.url);
    if (url === null || !url.startsWith(TELNYX_MEDIA_PREFIX)) {
      mediaDropped += 1;
      continue;
    }
    media.push({ url, contentType: str(record(m)?.content_type) ?? '' });
  }
  return { kind: 'received', message: { id, from, to: str(to[0]?.phone_number) ?? '', body: str(payload.text) ?? '', media, provider: 'telnyx' }, mediaDropped };
}
