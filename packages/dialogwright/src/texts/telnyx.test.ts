import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { parseTelnyxMessage, TELNYX_MEDIA_PREFIX, telnyxIdempotencyKey, telnyxTextProvider } from './telnyx';
import { providerMedia } from './media';
import { receivedRecord, textAuditRow } from './record';

/**
 * Telnyx's texts: its Messaging API v2 by fetch (a fake fetch here: no test reaches Telnyx), and its
 * messaging webhook's events read (`message.received` a text that came in; the status events ignored).
 */

const KEY = `KEY${'0'.repeat(20)}_${'a'.repeat(22)}`;

/** A fetch that answers as Telnyx's Messages API does, keeping each request. */
function telnyxFetch(status = 200, body: unknown = { data: { id: '40385f64-5717-4562-b3fc-2c9600000001', record_type: 'message', to: [{ phone_number: '+15555550177', status: 'queued' }] } }, headers: Record<string, string> = {}): typeof fetch & { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  }) as unknown as typeof fetch & { calls: typeof calls };
  f.calls = calls;
  return f;
}

describe('Telnyx\'s sender', () => {
  it('posts from, to, text and media_urls as JSON to /v2/messages with the key as a bearer token, and reads the id and status', async () => {
    const f = telnyxFetch();
    const p = telnyxTextProvider({ apiKey: KEY, fetch: f });
    expect(p.id).toBe('telnyx');
    const r = await p.send({ from: '+15555550100', to: '5555550177', body: 'Reply with a photo.', media: ['https://media.telnyx.com/a.jpg', 'https://example.com/b.png'] });
    expect(r).toEqual({ id: '40385f64-5717-4562-b3fc-2c9600000001', status: 'queued' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe('https://api.telnyx.com/v2/messages');
    expect(f.calls[0]!.init.method).toBe('POST');
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers['content-type']).toBe('application/json');
    expect(headers['idempotency-key']).toBeUndefined();
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ from: '+15555550100', to: '+15555550177', text: 'Reply with a photo.', media_urls: ['https://media.telnyx.com/a.jpg', 'https://example.com/b.png'] });
  });

  it('a text with no media sends no media_urls; one with a key sends its hash as the Idempotency-Key, never the key', async () => {
    const f = telnyxFetch();
    await telnyxTextProvider({ apiKey: KEY, fetch: f }).send({ from: '+15555550100', to: '+15555550177', body: 'x', key: 'quote R101 2' });
    const body = JSON.parse(String(f.calls[0]!.init.body)) as Record<string, unknown>;
    expect(body).toEqual({ from: '+15555550100', to: '+15555550177', text: 'x' });
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe(telnyxIdempotencyKey('quote R101 2'));
    expect(headers['idempotency-key']).toBe(createHash('sha256').update('quote R101 2', 'utf8').digest('hex'));
    expect(headers['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{1,255}$/);
  });

  it('a send Telnyx replays for its key is marked repeat', async () => {
    const p = telnyxTextProvider({ apiKey: KEY, fetch: telnyxFetch(200, undefined, { 'idempotent-replayed': 'true' }) });
    expect(await p.send({ from: '+15555550100', to: '+15555550177', body: 'x', key: 'k' })).toEqual({ id: '40385f64-5717-4562-b3fc-2c9600000001', status: 'queued', repeat: true });
  });

  it('a refusal is a failed receipt with the first error\'s code and words, numbers and addresses masked, never a throw', async () => {
    const p = telnyxTextProvider({ apiKey: KEY, fetch: telnyxFetch(422, { errors: [{ code: '40310', title: 'Invalid \'to\' address', detail: 'The destination +15555550177 is invalid; see https://developers.telnyx.com/x' }] }) });
    expect(await p.send({ from: '+15555550100', to: '+15555550177', body: 'x' })).toEqual({ id: null, status: 'failed', error: 'HTTP 422 40310: Invalid \'to\' address: The destination [number] is invalid; see [url]' });
  });

  it('a refusal with no body, and a fetch that throws, are failed receipts', async () => {
    const empty = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    expect(await telnyxTextProvider({ apiKey: KEY, fetch: empty }).send({ from: '+15555550100', to: '+15555550177', body: 'x' })).toEqual({ id: null, status: 'failed', error: 'HTTP 401' });
    const throws = (async () => { throw new TypeError('network'); }) as unknown as typeof fetch;
    expect(await telnyxTextProvider({ apiKey: KEY, fetch: throws }).send({ from: '+15555550100', to: '+15555550177', body: 'x' })).toEqual({ id: null, status: 'failed', error: 'TypeError' });
  });

  it('a send with no answer in its time is a failed receipt', async () => {
    const hangs = ((_: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    expect(await telnyxTextProvider({ apiKey: KEY, fetch: hangs, timeoutMs: 10 }).send({ from: '+15555550100', to: '+15555550177', body: 'x' })).toEqual({ id: null, status: 'failed', error: 'no answer in 10 ms' });
  });

  it('never puts the key in a receipt', async () => {
    const p = telnyxTextProvider({ apiKey: KEY, fetch: telnyxFetch(401, { errors: [{ code: '10009', title: 'Authentication failed', detail: `The key ${KEY} is not valid` }] }) });
    const r = await p.send({ from: '+15555550100', to: '+15555550177', body: 'x' });
    expect(r.status).toBe('failed');
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});

/** A message.received event as Telnyx posts it. */
const received = (payload: Record<string, unknown>): unknown => ({
  data: { event_type: 'message.received', id: 'b301ed3f-1490-491f-995f-6e64e69674d4', occurred_at: '2026-11-26T15:00:00.000+00:00', record_type: 'event', payload: { id: '84cca175-9755-4859-b67f-4730d7f58aa3', direction: 'inbound', type: 'MMS', ...payload } },
  meta: { attempt: 1, delivered_to: 'https://voice.example.com/messages/telnyx' },
});

describe('the messaging webhook\'s events', () => {
  it('message.received: from, to, text and each medium by its URL and content type, in order', () => {
    const parsed = parseTelnyxMessage(received({
      from: { phone_number: '+15555550177' }, to: [{ phone_number: '+15555550100', status: 'webhook_delivered' }], text: 'here',
      media: [{ url: `${TELNYX_MEDIA_PREFIX}a.jpg`, content_type: 'image/jpeg', size: 1000 }, { url: `${TELNYX_MEDIA_PREFIX}b.png`, content_type: 'image/png' }],
    }));
    expect(parsed).toEqual({
      kind: 'received',
      message: {
        id: '84cca175-9755-4859-b67f-4730d7f58aa3', from: '+15555550177', to: '+15555550100', body: 'here', provider: 'telnyx',
        media: [{ url: `${TELNYX_MEDIA_PREFIX}a.jpg`, contentType: 'image/jpeg' }, { url: `${TELNYX_MEDIA_PREFIX}b.png`, contentType: 'image/png' }],
      },
      mediaDropped: 0,
    });
  });

  it('keeps only media at Telnyx\'s own URLs, and counts what it dropped', () => {
    const parsed = parseTelnyxMessage(received({ from: { phone_number: '+15555550177' }, to: [{ phone_number: '+15555550100' }], text: '', media: [{ url: `${TELNYX_MEDIA_PREFIX}a.jpg` }, { url: 'https://example.com/evil.jpg' }, { url: 'http://media.telnyx.com/b.jpg' }, { nothing: true }] }));
    expect(parsed?.kind === 'received' ? parsed.message.media : null).toEqual([{ url: `${TELNYX_MEDIA_PREFIX}a.jpg`, contentType: '' }]);
    expect(parsed?.kind === 'received' ? parsed.mediaDropped : null).toBe(3);
    if (parsed?.kind !== 'received') throw new Error('not received');
    expect(textAuditRow(receivedRecord(parsed.message, { mediaDropped: parsed.mediaDropped })).detail).toMatchObject({ media: 1, mediaDropped: 3, provider: 'telnyx' });
  });

  it('a photo alone has an empty body; no message id or sender is no message', () => {
    const photo = parseTelnyxMessage(received({ from: { phone_number: '+15555550177' }, to: [{ phone_number: '+15555550100' }], text: null, media: [{ url: `${TELNYX_MEDIA_PREFIX}a.jpg`, content_type: 'image/jpeg' }] }));
    expect(photo?.kind === 'received' ? photo.message.body : null).toBe('');
    expect(parseTelnyxMessage(received({ id: undefined, from: { phone_number: '+15555550177' }, to: [] }))).toBeNull();
    expect(parseTelnyxMessage(received({ to: [{ phone_number: '+15555550100' }] }))).toBeNull();
  });

  it('the status events of a text sent (message.sent, message.finalized) are a status, with the message id and its status', () => {
    expect(parseTelnyxMessage({ data: { event_type: 'message.finalized', payload: { id: 'm1', to: [{ phone_number: '+15555550177', status: 'delivered' }] } } })).toEqual({ kind: 'status', event: 'message.finalized', id: 'm1', status: 'delivered' });
    expect(parseTelnyxMessage({ data: { event_type: 'message.sent', payload: { id: 'm1', to: [{ status: 'sent' }] } } })).toEqual({ kind: 'status', event: 'message.sent', id: 'm1', status: 'sent' });
  });

  it('anything that is not a messaging event is no message', () => {
    expect(parseTelnyxMessage(null)).toBeNull();
    expect(parseTelnyxMessage('message.received')).toBeNull();
    expect(parseTelnyxMessage({ data: { event_type: 'call.initiated', payload: {} } })).toBeNull();
    expect(parseTelnyxMessage({ data: { payload: {} } })).toBeNull();
  });
});

describe('a provider\'s own media', () => {
  it('Twilio\'s and Telnyx\'s own URLs, and no other', () => {
    expect(providerMedia('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1')).toBe(true);
    expect(providerMedia(`${TELNYX_MEDIA_PREFIX}abc/image.jpg`)).toBe(true);
    expect(providerMedia('https://example.com/x.jpg')).toBe(false);
    expect(providerMedia('https://media.telnyx.com.example.com/x.jpg')).toBe(false);
  });
});
