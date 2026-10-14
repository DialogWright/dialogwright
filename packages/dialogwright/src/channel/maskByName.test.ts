import { describe, expect, it } from 'vitest';
import { callerNumberScrub, DEFAULT_RECORDS, floorByName, maskAddress, maskCallerValue, maskCopiesOf, maskUri, recordsOf } from './maskByName';
import { redactDeep } from '../server/dashboard/events';

/**
 * Telnyx's TeXML webhooks carry the caller's number in fields beside `From`: its caller ID (`CallerId`)
 * and both ends' SIP addresses (`FromSipUri`, `ToSipUri`), whole on an ordinary call. The frame log masks
 * them as addresses: each number in them to its last four, the rest kept, so a withheld call's marks
 * (`anonymous`, `anonymous@anonymous.invalid`) stay readable. Numbers fictional.
 */

describe('an address that may hold a number (maskAddress)', () => {
  it('masks each run of five or more digits, with its +, to its last four, and keeps the rest', () => {
    expect(maskAddress('+15555550142@sip.telnyx.com')).toBe('…0142@sip.telnyx.com');
    expect(maskAddress('sip:+15555550142@sip.telnyx.com;user=phone')).toBe('sip:…0142@sip.telnyx.com;user=phone');
    expect(maskAddress('+15555550142')).toBe('…0142');
    expect(maskAddress('15555550142')).toBe('…0142');
  });

  it('keeps an address with no such run as it is: the marks of a withheld number, an already masked one', () => {
    for (const v of ['anonymous', 'anonymous@anonymous.invalid', 'Anonymous', '…0142@sip.telnyx.com', 'desk-1234@pbx.example.com']) expect(maskAddress(v)).toBe(v);
  });

  it('is what the frame log and the console write of CallerId, FromSipUri and ToSipUri, in any case', () => {
    const callback = {
      CallSid: 'v3:abc', From: '+15555550142', To: '+15555550111', CallerId: '+15555550142',
      FromSipUri: '+15555550142@sip.telnyx.com', ToSipUri: '+15555550111@sip.telnyx.com', callerid: '+15555550142',
    };
    const written = JSON.stringify(redactDeep(callback));
    expect(written).not.toMatch(/5555550142/);
    // Re-pinned (live findings item 26): the business's own number (To, ToSipUri) is kept whole by default.
    expect(redactDeep(callback)).toMatchObject({ CallerId: '…0142', FromSipUri: '…0142@sip.telnyx.com', ToSipUri: '+15555550111@sip.telnyx.com', To: '+15555550111', callerid: '…0142' });
    const last4 = { callerNumber: 'last4', businessNumbers: 'last4', callerName: 'redact' } as const;
    expect(redactDeep(callback, last4)).toMatchObject({ ToSipUri: '…0111@sip.telnyx.com', To: '…0111' });
    const keep = { callerNumber: 'keep', businessNumbers: 'keep', callerName: 'keep' } as const;
    expect(redactDeep({ ...callback, CallerName: 'Jordan Avery' }, keep)).toMatchObject({ From: '+15555550142', CallerId: '+15555550142', CallerName: 'Jordan Avery' });
    expect(redactDeep({ CallerId: 'anonymous', FromSipUri: 'anonymous@anonymous.invalid' })).toEqual({ CallerId: 'anonymous', FromSipUri: 'anonymous@anonymous.invalid' });
  });

  it('is the floor a call data key reading such a field takes', () => {
    expect(floorByName('FromSipUri', '+15555550142@sip.telnyx.com')).toBe('…0142@sip.telnyx.com');
    expect(floorByName('webhook.CallerId', 'anonymous')).toBe('anonymous');
  });
});

describe('every copy of the caller\'s number, whatever its name (maskCopiesOf)', () => {
  it('masks any field whose digits hold the number\'s last seven, and leaves the rest', () => {
    const fields = { CallSid: 'v3:abc', PAssertedIdentity: '<sip:+15555550142@carrier.example.com>', Spaced: '555 555 0142', To: '+15555550111', Note: 'anonymous' };
    const out = maskCopiesOf(fields, '+15555550142');
    expect(JSON.stringify(out)).not.toContain('5550142');
    expect(out.PAssertedIdentity).toBe('<sip:…0142@carrier.example.com>');
    expect(out.Spaced).toBe('…0142');
    expect(out).toMatchObject({ CallSid: 'v3:abc', To: '+15555550111', Note: 'anonymous' });
  });

  it('changes nothing without a number of seven digits or more', () => {
    const fields = { A: '+15555550142' };
    expect(maskCopiesOf(fields, undefined)).toEqual(fields);
    expect(maskCopiesOf(fields, '0142')).toEqual(fields);
  });
});

describe('the records setting (app.yaml records, live findings item 26)', () => {
  it('masks a SIP or client caller by the last four of its user, keeping the scheme and host', () => {
    expect(maskUri('sip:alice.smith@pbx.example.com')).toBe('sip:…mith@pbx.example.com');
    expect(maskUri('client:alice')).toBe('client:…lice');
    expect(maskUri('sip:1001@pbx.example.com')).toBe('sip:…@pbx.example.com');
    expect(maskUri('sip:+15555550142@carrier.example.com')).toBe('sip:…0142@carrier.example.com');
    expect(maskUri('sip:anonymous@anonymous.invalid')).toBe('sip:anonymous@anonymous.invalid');
    expect(maskCallerValue('client:alice')).toBe('client:…lice');
    expect(maskCallerValue('+15555550142')).toBe('…0142');
  });

  it('drops only Twilio\'s geographic fields by their exact names, not a field that merely ends the same way', () => {
    expect(floorByName('FromCity', 'PORTLAND')).toBeNull();
    expect(floorByName('CalledCountry', 'US')).toBeNull();
    expect(floorByName('callState', 'ringing')).toBe('ringing');
    expect(floorByName('queueState', 'open')).toBe('open');
  });

  it('defaults to the caller\'s number by its last four, the business\'s numbers whole, the name redacted', () => {
    expect(recordsOf(null)).toEqual(DEFAULT_RECORDS);
    expect(recordsOf({ records: { callerNumber: 'keep' } })).toEqual({ ...DEFAULT_RECORDS, callerNumber: 'keep' });
    expect(floorByName('to', '+15555550100')).toBe('+15555550100');
    expect(floorByName('callerName', 'Jordan Avery')).toBe('redacted');
    expect(floorByName('callerName', 'Jordan Avery', { ...DEFAULT_RECORDS, callerName: 'keep' })).toBe('Jordan Avery');
    expect(maskCopiesOf({ X: '+15555550142' }, '+15555550142', { ...DEFAULT_RECORDS, callerNumber: 'keep' })).toEqual({ X: '+15555550142' });
  });
});

describe('every copy of the caller\'s number in free text, however spaced (callerNumberScrub, live findings item 28)', () => {
  const scrub = callerNumberScrub('+15555550142')!;
  it('masks it whole, national, local, grouped, or digit by digit as the voice says it, by its last four', () => {
    expect(scrub('We will call you on 5 5 5, 5 5 5, 0 1 4 2. Is that right?')).toBe('We will call you on …0142. Is that right?');
    expect(scrub('on +1 555 555 0142, or (555) 555-0142, or 5555550142, or 555-0142')).toBe('on …0142, or …0142, or …0142, or …0142');
  });
  it('leaves other numbers, a longer run, and the last four alone', () => {
    expect(scrub('ending in 0142, order 25555550142 and 555 555 0199')).toBe('ending in 0142, order 25555550142 and 555 555 0199');
  });
  it('is nothing to do with records that keep the caller\'s number, or with no number of seven digits', () => {
    expect(callerNumberScrub('+15555550142', { ...DEFAULT_RECORDS, callerNumber: 'keep' })).toBeNull();
    expect(callerNumberScrub(undefined)).toBeNull();
    expect(callerNumberScrub('0142')).toBeNull();
  });
});
