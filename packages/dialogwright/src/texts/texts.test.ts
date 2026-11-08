import { describe, expect, it } from 'vitest';
import { fakeTextProvider, recordingTexts, TextKeys, textAuditRow, receivedRecord } from './record';
import { textSettings } from './settings';
import { e164, EMPTY_TWIML, parseTwilioMessage, twilioTextProvider } from './twilio';
import type { TextRecord } from './types';

/**
 * Texts (texts/): Twilio's sender by fetch (a fake fetch here: no test reaches Twilio), the webhook's
 * fields read, the settings, and each text recorded with no number whole and no words.
 */

const SID = `AC${'1'.repeat(32)}`;

/** A fetch that answers as Twilio's Messages API does, keeping each request. */
function twilioFetch(status = 201, body: unknown = { sid: 'SM123', status: 'queued' }): typeof fetch & { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch & { calls: typeof calls };
  f.calls = calls;
  return f;
}

describe('Twilio\'s sender', () => {
  it('posts To, From, Body and each MediaUrl to the account\'s Messages.json with basic auth, and reads the sid and status', async () => {
    const f = twilioFetch();
    const p = twilioTextProvider({ accountSid: SID, authToken: 'tok', fetch: f });
    const r = await p.send({ from: '+15555550100', to: '5555550177', body: 'Reply with a photo.', media: ['https://api.twilio.com/m/1', 'https://api.twilio.com/m/2'] });
    expect(r).toEqual({ id: 'SM123', status: 'queued' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from(`${SID}:tok`).toString('base64')}`);
    const form = new URLSearchParams(String(f.calls[0]!.init.body));
    expect(form.get('To')).toBe('+15555550177');
    expect(form.get('From')).toBe('+15555550100');
    expect(form.get('Body')).toBe('Reply with a photo.');
    expect(form.getAll('MediaUrl')).toEqual(['https://api.twilio.com/m/1', 'https://api.twilio.com/m/2']);
  });

  it('a refusal is a failed receipt with the code and message, numbers masked, never a throw', async () => {
    const p = twilioTextProvider({ accountSid: SID, authToken: 'tok', fetch: twilioFetch(400, { code: 21211, message: "The 'To' number +15555550177 is not a valid phone number." }) });
    expect(await p.send({ from: '+15555550100', to: '+15555550177', body: 'x' })).toEqual({ id: null, status: 'failed', error: "HTTP 400 21211: The 'To' number [number] is not a valid phone number." });
  });

  it('a fetch that throws is a failed receipt', async () => {
    const p = twilioTextProvider({ accountSid: SID, authToken: 'tok', fetch: (async () => { throw new TypeError('network'); }) as unknown as typeof fetch });
    expect(await p.send({ from: '+15555550100', to: '+15555550177', body: 'x' })).toEqual({ id: null, status: 'failed', error: 'TypeError' });
  });

  it('writes ten digits as a North American number, and keeps an E.164 one', () => {
    expect(e164('555-555-0177')).toBe('+15555550177');
    expect(e164('+44 20 7946 0000')).toBe('+442079460000');
  });
});

describe('the incoming-message webhook\'s fields', () => {
  it('From, To, Body and each medium by its URL and content type, in order', () => {
    expect(parseTwilioMessage({ MessageSid: 'SM1', From: '+15555550177', To: '+15555550100', Body: 'here', NumMedia: '2', MediaUrl0: 'https://api.twilio.com/a', MediaContentType0: 'image/jpeg', MediaUrl1: 'https://api.twilio.com/b', MediaContentType1: 'image/png' })).toEqual({
      id: 'SM1', from: '+15555550177', to: '+15555550100', body: 'here', provider: 'twilio',
      media: [{ url: 'https://api.twilio.com/a', contentType: 'image/jpeg' }, { url: 'https://api.twilio.com/b', contentType: 'image/png' }],
    });
  });

  it('a photo alone has an empty body; no message id or sender is no message', () => {
    expect(parseTwilioMessage({ MessageSid: 'SM2', From: '+15555550177', To: '+15555550100', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/a', MediaContentType0: 'image/jpeg' })).toMatchObject({ body: '', media: [{ url: 'https://api.twilio.com/a' }] });
    expect(parseTwilioMessage({ From: '+15555550177' })).toBeNull();
    expect(parseTwilioMessage({ MessageSid: 'SM3' })).toBeNull();
  });

  it('is answered with an empty response, so nothing is sent back but the app\'s own', () => {
    expect(EMPTY_TWIML).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  });
});

describe('a text as it is recorded', () => {
  it('the number by its last four, the body by its length, the media by their count, the id and status: no words, no URL', async () => {
    const records: TextRecord[] = [];
    const fake = fakeTextProvider();
    const texts = recordingTexts(fake, '+15555550100', new TextKeys(), (r) => records.push(r));
    await texts.send({ to: '+15555550177', body: 'Photo from Jordan.', media: ['https://api.twilio.com/a'] });
    expect(records).toEqual([{ direction: 'sent', number: '...0177', bodyLength: 18, media: 1, id: 'SMfake1', status: 'queued', provider: 'fake' }]);
    expect(textAuditRow(records[0]!)).toEqual({ type: 'text_sent', detail: { number: '...0177', bodyLength: 18, media: 1, id: 'SMfake1', status: 'queued', provider: 'fake' } });
    const received = textAuditRow(receivedRecord({ id: 'SM9', from: '+15555550177', to: '+15555550100', body: 'hi', media: [{ url: 'https://api.twilio.com/a', contentType: 'image/jpeg' }], provider: 'twilio' }));
    expect(received).toEqual({ type: 'text_received', detail: { number: '...0177', bodyLength: 2, media: 1, id: 'SM9', status: 'received', provider: 'twilio' } });
    expect(JSON.stringify(received)).not.toContain('5555550177');
  });

  it('a text sent again with its key is not sent twice: the first receipt, marked repeat', async () => {
    const records: TextRecord[] = [];
    const fake = fakeTextProvider();
    const keys = new TextKeys();
    const texts = recordingTexts(fake, '+15555550100', keys, (r) => records.push(r));
    const first = await texts.send({ to: '+15555550177', body: 'x', key: 'k1' });
    const again = await recordingTexts(fake, '+15555550100', keys, (r) => records.push(r)).send({ to: '+15555550177', body: 'x', key: 'k1' });
    expect(fake.sent).toHaveLength(1);
    expect(again).toEqual({ ...first, repeat: true });
    expect(records[1]).toMatchObject({ repeat: true });
  });

  it('a failed send is recorded failed, and its key may be sent again', async () => {
    const records: TextRecord[] = [];
    let fail = true;
    const fake = fakeTextProvider({ fail: () => fail });
    const texts = recordingTexts(fake, '+15555550100', new TextKeys(), (r) => records.push(r));
    expect(await texts.send({ to: '+15555550177', body: 'x', key: 'k' })).toMatchObject({ status: 'failed' });
    fail = false;
    expect(await texts.send({ to: '+15555550177', body: 'x', key: 'k' })).toMatchObject({ status: 'queued' });
    expect(records.map((r) => r.status)).toEqual(['failed', 'queued']);
  });
});

describe('the sender\'s settings', () => {
  it('TEXT_FROM unset is no sender', () => {
    expect(textSettings({})).toBeNull();
    expect(textSettings({ TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: 'x' })).toBeNull();
  });

  it('TEXT_FROM with the account and its token', () => {
    expect(textSettings({ TEXT_FROM: '+15555550100', TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: 'tok' })).toEqual({ from: '+15555550100', provider: 'twilio', accountSid: SID, authToken: 'tok' });
  });

  it('refuses, naming the setting, a number not E.164, a missing or malformed account, a missing token', () => {
    expect(() => textSettings({ TEXT_FROM: '555-0100' })).toThrow(/TEXT_FROM is not a phone number/);
    expect(() => textSettings({ TEXT_FROM: '+15555550100' })).toThrow(/TWILIO_ACCOUNT_SID is unset/);
    expect(() => textSettings({ TEXT_FROM: '+15555550100', TWILIO_ACCOUNT_SID: 'AC123' })).toThrow(/TWILIO_ACCOUNT_SID is not a Twilio account id/);
    expect(() => textSettings({ TEXT_FROM: '+15555550100', TWILIO_ACCOUNT_SID: SID })).toThrow(/TWILIO_AUTH_TOKEN is unset/);
  });
});
