import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { telnyxProvider } from './telnyx';

const START = { publicHost: 'voice.example.com', token: 'b'.repeat(32), hints: 'one,two' };
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' };

describe('the Telnyx voice provider', () => {
  it('starts the relay with TeXML at its own socket and action paths', () => {
    const doc = telnyxProvider.startDocument(START);
    expect(doc).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Connect action="https://voice.example.com/cr-action/telnyx">' +
        `<ConversationRelay url="wss://voice.example.com/conversation/telnyx?token=${'b'.repeat(32)}" dtmfDetection="true" interruptible="any" hints="one,two"/>` +
        '</Connect></Response>',
    );
    expect(doc).not.toContain('speechModel='); // a Twilio-only attribute
    expect(telnyxProvider.contentType).toBe('text/xml');
  });

  it('names its voice whole, with no separate TTS provider (Telnyx voice names carry it)', () => {
    const doc = telnyxProvider.startDocument({ ...START, ttsProvider: 'Google', voice: 'Telnyx.NaturalHD.astra' });
    expect(doc).toContain('hints="one,two" voice="Telnyx.NaturalHD.astra"/>');
    expect(doc).not.toContain('ttsProvider=');
    expect(telnyxProvider.startDocument({ ...START, voice: 'a "q" & b' })).toContain('voice="a &quot;q&quot; &amp; b"');
  });

  it('names the deployment\'s recognizer provider, and never a model, on the relay element', () => {
    expect(telnyxProvider.startDocument({ ...START, recognition: {} })).toBe(telnyxProvider.startDocument(START));
    const doc = telnyxProvider.startDocument({ ...START, recognition: { provider: 'deepgram', model: 'nova-2' } });
    expect(doc).toContain('hints="one,two" transcriptionProvider="deepgram"/>');
    expect(doc).not.toContain('speechModel=');
  });

  it('names a two-locale call\'s language (one for speech and recognition alike), the languages it may switch to with their own voices and recognizers, and the locale parameter', () => {
    const doc = telnyxProvider.startDocument({
      ...START,
      voice: 'Telnyx.Ultra.Callie',
      language: { tts: 'es-US', transcription: 'es-US', voice: 'Telnyx.Ultra.Asher', recognition: { provider: 'google' } },
      languages: [
        { tts: 'en-US', transcription: 'en-US', voice: 'Telnyx.Ultra.Callie', recognition: { provider: 'deepgram', model: 'nova-2' } },
        { tts: 'es-US', transcription: 'es-US', voice: 'Telnyx.Ultra.Asher', recognition: { provider: 'google' } },
      ],
      parameters: { locale: 'es-US' },
    });
    expect(doc).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Connect action="https://voice.example.com/cr-action/telnyx">' +
        `<ConversationRelay url="wss://voice.example.com/conversation/telnyx?token=${'b'.repeat(32)}" dtmfDetection="true" interruptible="any" hints="one,two" ` +
        'language="es-US">' +
        '<Language code="en-US" voice="Telnyx.Ultra.Callie" transcriptionProvider="deepgram" speechModel="nova-2"/><Language code="es-US" voice="Telnyx.Ultra.Asher" transcriptionProvider="google"/>' +
        '<Parameter name="locale" value="es-US"/>' +
        '</ConversationRelay></Connect></Response>',
    );
    // A language with no voice of its own: the carrier's default, never the deployment's default-locale voice.
    const plain = telnyxProvider.startDocument({ ...START, voice: 'Telnyx.Ultra.Callie', language: { tts: 'es-US', transcription: 'es-US' } });
    expect(plain).toContain('hints="one,two" language="es-US"/>');
    expect(plain).not.toContain('voice=');
  });

  it('names what every language shares on the relay element, except a model, which only <Language> takes', () => {
    const same = { voice: 'Telnyx.Ultra.Callie', recognition: { provider: 'deepgram' } };
    const shared = telnyxProvider.startDocument({ ...START, language: { tts: 'en-US', transcription: 'en-US', ...same }, languages: [{ tts: 'en-US', transcription: 'en-US', ...same }] });
    expect(shared).toContain('hints="one,two" transcriptionProvider="deepgram" language="en-US" voice="Telnyx.Ultra.Callie"><Language code="en-US"/></ConversationRelay>');
    const model = { recognition: { provider: 'deepgram', model: 'nova-2' } };
    const withModel = telnyxProvider.startDocument({ ...START, language: { tts: 'en-US', transcription: 'en-US', ...model }, languages: [{ tts: 'en-US', transcription: 'en-US', ...model }] });
    expect(withModel).toContain('hints="one,two" language="en-US"><Language code="en-US" transcriptionProvider="deepgram" speechModel="nova-2"/></ConversationRelay>');
  });

  it('reads a form-encoded TeXML callback and a JSON one alike', () => {
    const form = telnyxProvider.parse({ url: '/cr-action/telnyx', headers: FORM, rawBody: 'CallSid=v2%3Aabc&From=%2B15555550100&CallStatus=in-progress&HandoffData=%7B%7D', nowSec: 0 });
    const json = telnyxProvider.parse({
      url: '/cr-action/telnyx', headers: JSON_TYPE, rawBody: JSON.stringify({ CallSid: 'v2:abc', From: '+15555550100', CallStatus: 'in-progress', handoffData: '{}' }), nowSec: 0,
    });
    expect(form).toMatchObject({ callId: 'v2:abc', from: '+15555550100', callStatus: 'in-progress', handoffData: '{}' });
    expect(json).toMatchObject({ callId: 'v2:abc', from: '+15555550100', callStatus: 'in-progress', handoffData: '{}' });
  });

  it('takes the call id from call_control_id when CallSid is absent, and lower-case from and to', () => {
    const p = telnyxProvider.parse({ url: '/voice/telnyx', headers: JSON_TYPE, rawBody: JSON.stringify({ call_control_id: 'v2:xyz', from: '+15555550100', to: '+15555550111' }), nowSec: 0 });
    expect(p).toMatchObject({ callId: 'v2:xyz', from: '+15555550100', to: '+15555550111' });
  });

  it('reads the content type without regard to case', () => {
    expect(telnyxProvider.parse({ url: '/voice/telnyx', headers: { 'content-type': 'Application/JSON' }, rawBody: '{"call_control_id":"v2:abc"}', nowSec: 0 })?.callId).toBe('v2:abc');
  });

  it('reads a JSON body sent without a content type, and names no call for an unreadable one', () => {
    expect(telnyxProvider.parse({ url: '/voice/telnyx', headers: {}, rawBody: '{"CallSid":"v2:abc"}', nowSec: 0 })?.callId).toBe('v2:abc');
    expect(telnyxProvider.parse({ url: '/voice/telnyx', headers: JSON_TYPE, rawBody: '{not json', nowSec: 0 })).toBeNull();
    expect(telnyxProvider.parse({ url: '/voice/telnyx', headers: JSON_TYPE, rawBody: '["v2:abc"]', nowSec: 0 })).toBeNull();
    expect(telnyxProvider.parse({ url: '/voice/telnyx', headers: FORM, rawBody: 'From=x', nowSec: 0 })).toBeNull();
  });

  it('keeps only the string fields of a JSON body, so nothing nested reaches the frame log as an object', () => {
    const p = telnyxProvider.parse({ url: '/voice/telnyx', headers: JSON_TYPE, rawBody: JSON.stringify({ CallSid: 'v2:abc', payload: { a: 1 }, n: 3 }), nowSec: 0 });
    expect(p?.raw).toEqual({ CallSid: 'v2:abc' });
  });

  it('verifies the Ed25519 signature from its two headers', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const key = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const rawBody = 'CallSid=v2%3Aabc';
    const headers = { 'telnyx-timestamp': '1700000000', 'telnyx-signature-ed25519': sign(null, Buffer.from(`1700000000|${rawBody}`), privateKey).toString('base64') };
    const req = { url: '/voice/telnyx', headers, rawBody, nowSec: 1_700_000_010 };
    expect(telnyxProvider.verify(req, key, 'voice.example.com')).toBe(true);
    expect(telnyxProvider.verify({ ...req, rawBody: `${rawBody}x` }, key, 'voice.example.com')).toBe(false);
    expect(telnyxProvider.verify({ ...req, headers: {} }, key, 'voice.example.com')).toBe(false);
  });

  it('ends a call with TeXML hangup and dial documents', () => {
    expect(telnyxProvider.hangupDocument()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(telnyxProvider.dialDocument('+15555550199')).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Dial>+15555550199</Dial></Response>');
    expect(telnyxProvider.apologizeAndDialDocument('+15555550199')).toContain('<Say>Sorry, we lost the connection.');
  });
});
