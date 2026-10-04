import { describe, expect, it } from 'vitest';
import { computeTwilioSignature, twilioProvider } from './twilio';
import { apologizeAndDialTwiml, connectRelayTwiml, dialTwiml, hangupTwiml } from '../twiml';

const START = { publicHost: 'voice.example.com', token: 'a'.repeat(32), hints: 'one,two' };
const HEAD = '<?xml version="1.0" encoding="UTF-8"?>';
const RELAY_ATTRS =
  'transcriptionProvider="Deepgram" speechModel="flux" partialPrompts="true" dtmfDetection="true" interruptible="any" ' +
  'interruptSensitivity="low" ignoreBackchannel="true" reportInputDuringAgentSpeech="any" deepgramSmartFormat="false" hints="one,two"';

describe('the Twilio voice provider', () => {
  it('starts the relay with the document Twilio receives today, at its own socket path', () => {
    expect(twilioProvider.startDocument(START)).toBe(
      `${HEAD}<Response><Connect action="https://voice.example.com/cr-action/twilio">` +
        `<ConversationRelay url="wss://voice.example.com/conversation/twilio?token=${'a'.repeat(32)}" ${RELAY_ATTRS}/></Connect></Response>`,
    );
  });

  it('keeps the legacy document byte for byte, at the unprefixed paths', () => {
    expect(connectRelayTwiml(START)).toBe(
      `${HEAD}<Response><Connect action="https://voice.example.com/cr-action">` +
        `<ConversationRelay url="wss://voice.example.com/conversation?token=${'a'.repeat(32)}" ${RELAY_ATTRS}/></Connect></Response>`,
    );
    expect(connectRelayTwiml({ ...START, ttsProvider: 'Google', voice: 'en-US-Neural2-F' })).toContain(
      'hints="one,two" ttsProvider="Google" voice="en-US-Neural2-F"/>',
    );
  });

  it('adds the voice only when both the TTS provider and the voice are set', () => {
    expect(twilioProvider.startDocument({ ...START, voice: 'en-US-Neural2-F' })).not.toContain('voice=');
    expect(twilioProvider.startDocument({ ...START, ttsProvider: 'Google', voice: 'en-US-Neural2-F' })).toContain(
      'hints="one,two" ttsProvider="Google" voice="en-US-Neural2-F"/>',
    );
  });

  it('names a two-locale call\'s languages: where it starts, each it may switch to with its voice, and the locale parameter', () => {
    const doc = twilioProvider.startDocument({
      ...START,
      ttsProvider: 'Google',
      voice: 'en-US-Neural2-F',
      language: { tts: 'es-US', transcription: 'es-MX', voice: 'es-US-Journey-F', ttsProvider: 'Google' },
      languages: [
        { tts: 'en-US', transcription: 'en-US', voice: 'en-US-Neural2-F', ttsProvider: 'Google' },
        { tts: 'es-US', transcription: 'es-MX', voice: 'es-US-Journey-F', ttsProvider: 'Google' },
      ],
      parameters: { locale: 'es' },
    });
    expect(doc).toBe(
      `${HEAD}<Response><Connect action="https://voice.example.com/cr-action/twilio">` +
        `<ConversationRelay url="wss://voice.example.com/conversation/twilio?token=${'a'.repeat(32)}" ${RELAY_ATTRS} ` +
        'ttsLanguage="es-US" transcriptionLanguage="es-MX" ttsProvider="Google" voice="es-US-Journey-F">' +
        '<Language code="en-US" ttsProvider="Google" voice="en-US-Neural2-F"/>' +
        '<Language code="es-US" ttsProvider="Google" voice="es-US-Journey-F"/>' +
        '<Parameter name="locale" value="es"/>' +
        '</ConversationRelay></Connect></Response>',
    );
  });

  it('gives a language with no voice of its own the carrier\'s default voice, and the legacy paths the same languages', () => {
    const o = {
      ...START,
      ttsProvider: 'Google',
      voice: 'en-US-Neural2-F',
      language: { tts: 'es-US', transcription: 'es-US' },
      languages: [{ tts: 'en-US', transcription: 'en-US' }, { tts: 'es-US', transcription: 'es-US' }],
      parameters: { locale: 'es-US' },
    };
    const doc = twilioProvider.startDocument(o);
    // The deployment's voice is the default locale's, never said in another language.
    expect(doc).not.toContain('voice=');
    expect(doc).toContain('hints="one,two" ttsLanguage="es-US" transcriptionLanguage="es-US"><Language code="en-US"/><Language code="es-US"/><Parameter name="locale" value="es-US"/></ConversationRelay>');
    expect(connectRelayTwiml(o)).toBe(doc.replace('/cr-action/twilio', '/cr-action').replace('/conversation/twilio', '/conversation'));
  });

  it('verifies the signature over the full URL and the sorted form fields', () => {
    const rawBody = 'CallSid=CA1&From=%2B15555550100';
    const url = '/voice/twilio';
    const sig = computeTwilioSignature('https://voice.example.com/voice/twilio', { CallSid: 'CA1', From: '+15555550100' }, 'secret');
    const req = { url, headers: { 'x-twilio-signature': sig }, rawBody, nowSec: 0 };
    expect(twilioProvider.verify(req, 'secret', 'voice.example.com')).toBe(true);
    expect(twilioProvider.verify({ ...req, rawBody: rawBody + '&To=x' }, 'secret', 'voice.example.com')).toBe(false);
    expect(twilioProvider.verify({ ...req, headers: {} }, 'secret', 'voice.example.com')).toBe(false);
    expect(twilioProvider.verify(req, 'secret', 'other.example.com')).toBe(false);
  });

  it('reads the callback into the engine terms', () => {
    const p = twilioProvider.parse({
      url: '/cr-action/twilio', headers: {}, rawBody: 'CallSid=CA1&From=%2B15555550100&CallStatus=in-progress&SessionStatus=ended&HandoffData=%7B%7D', nowSec: 0,
    });
    expect(p).toMatchObject({ callId: 'CA1', from: '+15555550100', callStatus: 'in-progress', sessionStatus: 'ended', handoffData: '{}' });
    expect(p?.raw).toMatchObject({ CallSid: 'CA1', SessionStatus: 'ended' });
    expect(p).not.toHaveProperty('to');
    expect(twilioProvider.parse({ url: '/voice/twilio', headers: {}, rawBody: 'From=x', nowSec: 0 })).toBeNull();
    expect(twilioProvider.parse({ url: '/voice/twilio', headers: {}, rawBody: 'CallSid=%20', nowSec: 0 })).toBeNull();
  });

  it('ends a call with the documents Twilio receives today', () => {
    expect(twilioProvider.hangupDocument()).toBe(`${HEAD}<Response><Hangup/></Response>`);
    expect(twilioProvider.dialDocument('+15555550199')).toBe(`${HEAD}<Response><Dial>+15555550199</Dial></Response>`);
    expect(twilioProvider.apologizeAndDialDocument('+15555550199')).toBe(
      `${HEAD}<Response><Say>Sorry, we lost the connection. Let me get someone to help you.</Say><Dial>+15555550199</Dial></Response>`,
    );
    expect(hangupTwiml()).toBe(twilioProvider.hangupDocument());
    expect(dialTwiml('+15555550199')).toBe(twilioProvider.dialDocument('+15555550199'));
    expect(apologizeAndDialTwiml('+15555550199')).toBe(twilioProvider.apologizeAndDialDocument('+15555550199'));
    expect(twilioProvider.contentType).toBe('text/xml');
    expect(twilioProvider.id).toBe('twilio');
  });
});
