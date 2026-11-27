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
 * - Telnyx keeps idempotency itself (an `Idempotency-Key` header, replayed for 24 hours, successes only),
 *   so a text's key (OutgoingText.key) goes with it, hashed (Telnyx asks that no sensitive data be in the
 *   key, and takes only letters, digits, `-` and `_`): a send repeated after a restart, when this server's
 *   own keys (record.ts TextKeys) are gone, is still sent once. A replay is marked `repeat`. The same key
 *   with a different text is refused by Telnyx (HTTP 422), a failure like any other.
 * - The id is a UUID (Twilio's an `SM...`), the status the first recipient's (`queued`, as Twilio's).
 * - Telnyx publishes no figure for its rate limits: a text it holds for one is queued, not refused
 *   (`wait_seconds`); the sender's own limits (TEXT_LIMIT_*) hold as for Twilio.
 */

/** The Messaging API's base. */
export const TELNYX_API = 'https://api.telnyx.com';

/** How long a send may take before it is a failure, ms. */
export const TELNYX_SEND_TIMEOUT_MS = 10000;

/** What the Telnyx sender needs: the API key, and (for a test) the fetch it asks with. */
export interface TelnyxTextOptions {
  readonly apiKey: string;
  /** The fetch it sends with; a test passes its own. Default the global fetch. */
  readonly fetch?: typeof fetch;
  /** The API's base, for a test; default TELNYX_API. */
  readonly base?: string;
  readonly timeoutMs?: number;
}

/** A text's key as Telnyx's Idempotency-Key header takes it: its SHA-256 in hex, so no word of it is sent. */
export function telnyxIdempotencyKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** A Telnyx error's code and words, safe to record: never the body, the numbers or a key. */
function errorOf(status: number, body: unknown, apiKey: string): string {
  const errors = typeof body === 'object' && body !== null ? (body as { errors?: unknown }).errors : undefined;
  const first = Array.isArray(errors) && typeof errors[0] === 'object' && errors[0] !== null ? (errors[0] as { code?: unknown; title?: unknown; detail?: unknown }) : {};
  const code = typeof first.code === 'string' || typeof first.code === 'number' ? ` ${String(first.code)}` : '';
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
      const body = { from: e164(text.from), to: e164(text.to), text: text.body, ...(media.length > 0 ? { media_urls: [...media] } : {}) };
      const headers: Record<string, string> = { authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json', accept: 'application/json' };
      if (text.key !== undefined) headers['idempotency-key'] = telnyxIdempotencyKey(text.key);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        const res = await send(url, { method: 'POST', headers, body: JSON.stringify(body), signal: abort.signal });
        let answer: unknown = null;
        try {
          answer = await res.json();
        } catch {
          answer = null;
        }
        if (!res.ok) return { id: null, status: 'failed', error: errorOf(res.status, answer, o.apiKey) };
        const data = typeof answer === 'object' && answer !== null ? ((answer as { data?: unknown }).data as { id?: unknown; to?: unknown } | undefined) : undefined;
        const to = Array.isArray(data?.to) ? (data.to[0] as { status?: unknown } | undefined) : undefined;
        const receipt: TextReceipt = { id: typeof data?.id === 'string' ? data.id : null, status: typeof to?.status === 'string' ? to.status : 'accepted' };
        return res.headers.get('idempotent-replayed') === 'true' ? { ...receipt, repeat: true } : receipt;
      } catch (err) {
        return { id: null, status: 'failed', error: abort.signal.aborted ? `no answer in ${timeoutMs} ms` : (err instanceof Error ? err.name : 'error') };
      } finally {
        clearTimeout(timer);
      }
    },
  };
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
