import type { IncomingMedia, IncomingText, OutgoingText, TextProvider, TextReceipt } from './types';

/**
 * Twilio's texts: sending through its Messages API by fetch (no SDK), and reading the fields of its
 * incoming-message webhook. The webhook's signature is checked by the server exactly as the voice
 * webhook's is (server/voice/twilio.ts validateTwilioSignature), before anything here reads it.
 */

/** The Messages API's base. */
export const TWILIO_API = 'https://api.twilio.com';

/** How long a send may take before it is a failure, ms. */
export const TWILIO_SEND_TIMEOUT_MS = 10000;

/** What the Twilio sender needs: the account, its auth token, and (for a test) the fetch it asks with. */
export interface TwilioTextOptions {
  readonly accountSid: string;
  readonly authToken: string;
  /** The fetch it sends with; a test passes its own. Default the global fetch. */
  readonly fetch?: typeof fetch;
  /** The API's base, for a test; default TWILIO_API. */
  readonly base?: string;
  readonly timeoutMs?: number;
}

/** A number as the API takes it: E.164, ten digits read as a North American number (+1). */
export function e164(number: string): string {
  const t = number.trim();
  if (t.startsWith('+')) return `+${t.slice(1).replace(/\D/g, '')}`;
  const digits = t.replace(/\D/g, '');
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

/** A Twilio error's code and message, safe to record: never the body, the numbers or a key. */
function errorOf(status: number, body: unknown): string {
  const b = typeof body === 'object' && body !== null ? (body as { code?: unknown; message?: unknown }) : {};
  const code = typeof b.code === 'number' || typeof b.code === 'string' ? ` ${String(b.code)}` : '';
  const message = typeof b.message === 'string' ? `: ${b.message.replace(/\+?\d{7,}/g, '[number]').slice(0, 200)}` : '';
  return `HTTP ${status}${code}${message}`;
}

/** The Twilio sender (TextProvider): one POST to Messages.json a text, never throwing. */
export function twilioTextProvider(o: TwilioTextOptions): TextProvider {
  const send = o.fetch ?? fetch;
  const url = `${o.base ?? TWILIO_API}/2010-04-01/Accounts/${encodeURIComponent(o.accountSid)}/Messages.json`;
  const auth = `Basic ${Buffer.from(`${o.accountSid}:${o.authToken}`).toString('base64')}`;
  return {
    id: 'twilio',
    async send(text: OutgoingText & { readonly from: string }): Promise<TextReceipt> {
      const form = new URLSearchParams();
      form.set('To', e164(text.to));
      form.set('From', e164(text.from));
      form.set('Body', text.body);
      for (const m of text.media ?? []) form.append('MediaUrl', m);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), o.timeoutMs ?? TWILIO_SEND_TIMEOUT_MS);
      try {
        const res = await send(url, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(), signal: abort.signal });
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        if (!res.ok) return { id: null, status: 'failed', error: errorOf(res.status, body) };
        const b = (body ?? {}) as { sid?: unknown; status?: unknown };
        return { id: typeof b.sid === 'string' ? b.sid : null, status: typeof b.status === 'string' ? b.status : 'accepted' };
      } catch (err) {
        return { id: null, status: 'failed', error: abort.signal.aborted ? `no answer in ${o.timeoutMs ?? TWILIO_SEND_TIMEOUT_MS} ms` : (err instanceof Error ? err.name : 'error') };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** The most media Twilio attaches to one message. */
const MAX_MEDIA = 10;

/**
 * A Twilio incoming-message webhook's fields (From, To, Body, MessageSid, NumMedia, MediaUrlN,
 * MediaContentTypeN) as an IncomingText; null where it names no message or no sender.
 */
export function parseTwilioMessage(fields: Readonly<Record<string, string>>): IncomingText | null {
  const id = fields.MessageSid ?? fields.SmsMessageSid ?? '';
  const from = fields.From ?? '';
  if (id === '' || from === '') return null;
  const count = Math.min(Math.max(Number.parseInt(fields.NumMedia ?? '0', 10) || 0, 0), MAX_MEDIA);
  const media: IncomingMedia[] = [];
  for (let i = 0; i < count; i++) {
    const url = fields[`MediaUrl${i}`];
    if (url === undefined || url === '') continue;
    media.push({ url, contentType: fields[`MediaContentType${i}`] ?? '' });
  }
  return { id, from, to: fields.To ?? '', body: fields.Body ?? '', media, provider: 'twilio' };
}

/** What the webhook is answered with: an empty TwiML response, so Twilio sends nothing back on its own. */
export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
