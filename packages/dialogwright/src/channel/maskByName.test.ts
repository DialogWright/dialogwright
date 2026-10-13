import { describe, expect, it } from 'vitest';
import { floorByName, maskAddress, maskCopiesOf } from './maskByName';
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
    expect(written).not.toMatch(/5555550142|5555550111/);
    expect(redactDeep(callback)).toMatchObject({ CallerId: '…0142', FromSipUri: '…0142@sip.telnyx.com', ToSipUri: '…0111@sip.telnyx.com', callerid: '…0142' });
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
