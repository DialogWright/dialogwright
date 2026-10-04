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

  it('takes the deployment\'s recognizer in the place Deepgram flux has always had, and names it escaped', () => {
    expect(twilioProvider.startDocument({ ...START, recognition: { provider: 'Deepgram', model: 'flux' } })).toBe(twilioProvider.startDocument(START));
    expect(twilioProvider.startDocument({ ...START, recognition: { provider: 'Google', model: 'telephony' } })).toContain(
      `token=${'a'.repeat(32)}" transcriptionProvider="Google" speechModel="telephony" partialPrompts="true"`,
    );
    const providerOnly = twilioProvider.startDocument({ ...START, recognition: { provider: 'Google' } });
    expect(providerOnly).toContain('transcriptionProvider="Google" partialPrompts="true"');
    expect(providerOnly).not.toContain('speechModel=');
    expect(twilioProvider.startDocument({ ...START, recognition: {} })).not.toContain('transcriptionProvider=');
    expect(twilioProvider.startDocument({ ...START, recognition: { provider: 'a"<b' } })).toContain('transcriptionProvider="a&quot;&lt;b"');
  });

  it('names a two-locale call\'s languages: where it starts, each it may switch to with its own voice and recognizer, and the locale parameter', () => {
    const doc = twilioProvider.startDocument({
      ...START,
      ttsProvider: 'Google',
      voice: 'en-US-Neural2-F',
      recognition: { provider: 'Deepgram', model: 'flux' },
      language: { tts: 'es-US', transcription: 'es-MX', voice: 'es-US-Journey-F', ttsProvider: 'Google', recognition: { provider: 'Google', model: 'telephony' } },
      languages: [
        { tts: 'en-US', transcription: 'en-US', voice: 'en-US-Neural2-F', ttsProvider: 'Google', recognition: { provider: 'Deepgram', model: 'flux' } },
        { tts: 'es-US', transcription: 'es-MX', voice: 'es-US-Journey-F', ttsProvider: 'Google', recognition: { provider: 'Google', model: 'telephony' } },
      ],
      parameters: { locale: 'es' },
    });
    // The languages differ, so each is on its own <Language>: the relay element names neither, so
    // neither language inherits the other's (a <Language> inherits what it leaves out).
    expect(doc).toBe(
      `${HEAD}<Response><Connect action="https://voice.example.com/cr-action/twilio">` +
        `<ConversationRelay url="wss://voice.example.com/conversation/twilio?token=${'a'.repeat(32)}" ${RELAY_ATTRS.replace('transcriptionProvider="Deepgram" speechModel="flux" ', '')} ` +
        'ttsLanguage="es-US" transcriptionLanguage="es-MX">' +
        '<Language code="en-US" ttsProvider="Google" voice="en-US-Neural2-F" transcriptionProvider="Deepgram" speechModel="flux"/>' +
        '<Language code="es-US" ttsProvider="Google" voice="es-US-Journey-F" transcriptionProvider="Google" speechModel="telephony"/>' +
        '<Parameter name="locale" value="es"/>' +
        '</ConversationRelay></Connect></Response>',
    );
  });

  it('names a setting every language shares once, on the relay element, and none on the <Language> children', () => {
    const same = { voice: 'en-US-Journey-O', ttsProvider: 'Google', recognition: { provider: 'Deepgram', model: 'nova-3-general' } };
    const doc = twilioProvider.startDocument({
      ...START,
      language: { tts: 'en-US', transcription: 'en-US', ...same },
      languages: [{ tts: 'en-US', transcription: 'en-US', ...same }, { tts: 'en-GB', transcription: 'en-GB', ...same }],
      parameters: { locale: 'en-US' },
    });
    expect(doc).toContain(`token=${'a'.repeat(32)}" transcriptionProvider="Deepgram" speechModel="nova-3-general" partialPrompts="true"`);
    expect(doc).toContain('ttsLanguage="en-US" transcriptionLanguage="en-US" ttsProvider="Google" voice="en-US-Journey-O"><Language code="en-US"/><Language code="en-GB"/>');
    // The voice shared and the recognizer not: each placed on its own terms.
    const mixed = twilioProvider.startDocument({
      ...START,
      language: { tts: 'en-US', transcription: 'en-US', ...same },
      languages: [{ tts: 'en-US', transcription: 'en-US', ...same }, { tts: 'es-US', transcription: 'es-US', voice: same.voice, ttsProvider: 'Google' }],
    });
    expect(mixed).not.toContain('transcriptionProvider="Deepgram" partialPrompts');
    expect(mixed).toContain('ttsProvider="Google" voice="en-US-Journey-O"><Language code="en-US" transcriptionProvider="Deepgram" speechModel="nova-3-general"/><Language code="es-US"/>');
  });

  it('gives a language with no voice or recognizer of its own the carrier\'s defaults, and the legacy paths the same languages', () => {
    const o = {
      ...START,
      ttsProvider: 'Google',
      voice: 'en-US-Neural2-F',
      language: { tts: 'es-US', transcription: 'es-US' },
      languages: [{ tts: 'en-US', transcription: 'en-US' }, { tts: 'es-US', transcription: 'es-US' }],
      parameters: { locale: 'es-US' },
    };
    const doc = twilioProvider.startDocument(o);
    // The deployment's voice and recognizer are the default locale's, never said or heard in another language.
    expect(doc).not.toContain('voice=');
    expect(doc).not.toContain('transcriptionProvider=');
    expect(doc).toContain('hints="one,two" ttsLanguage="es-US" transcriptionLanguage="es-US"><Language code="en-US"/><Language code="es-US"/><Parameter name="locale" value="es-US"/></ConversationRelay>');
    expect(connectRelayTwiml(o)).toBe(doc.replace('/cr-action/twilio', '/cr-action').replace('/conversation/twilio', '/conversation'));
  });

  it('when the call starts in a language with a voice and another has none, names the voice on its <Language> only', () => {
    const doc = twilioProvider.startDocument({
      ...START,
      language: { tts: 'en-US', transcription: 'en-US', voice: 'en-US-Neural2-F', ttsProvider: 'Google', recognition: { provider: 'Deepgram', model: 'flux' } },
      languages: [
        { tts: 'en-US', transcription: 'en-US', voice: 'en-US-Neural2-F', ttsProvider: 'Google', recognition: { provider: 'Deepgram', model: 'flux' } },
        { tts: 'es-US', transcription: 'es-US' },
      ],
    });
    // Were they on the relay element, the Spanish <Language> would inherit an English voice and flux.
    expect(doc).toContain('ttsLanguage="en-US" transcriptionLanguage="en-US"><Language code="en-US" ttsProvider="Google" voice="en-US-Neural2-F" transcriptionProvider="Deepgram" speechModel="flux"/><Language code="es-US"/>');
    expect(doc).not.toContain('transcriptionProvider="Deepgram" partialPrompts');
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

  it('says the call is live only when its status is in-progress, as Twilio words it, and not live with no status, as before', () => {
    const live = (body: string) => twilioProvider.parse({ url: '/cr-action/twilio', headers: {}, rawBody: `CallSid=CA1${body}`, nowSec: 0 })?.live;
    expect(live('&CallStatus=in-progress')).toBe(true);
    for (const status of ['completed', 'ringing', 'busy', 'failed', 'active', 'In-Progress']) expect(live(`&CallStatus=${status}`), status).toBe(false);
    expect(live('&SessionStatus=failed')).toBe(false);
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

  it('pauses before it connects when asked (a planned restart: the restarted server takes the socket), and not otherwise', () => {
    const doc = twilioProvider.startDocument({ ...START, pauseS: 5 });
    expect(doc).toBe(twilioProvider.startDocument(START).replace('<Response><Connect', '<Response><Pause length="5"/><Connect'));
    expect(connectRelayTwiml({ ...START, pauseS: 3 })).toContain('<Response><Pause length="3"/><Connect action="https://voice.example.com/cr-action">');
    expect(twilioProvider.startDocument({ ...START, pauseS: 0 })).toBe(twilioProvider.startDocument(START));
  });
});
