import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { telnyxProvider } from './telnyx';
import { twilioProvider } from './twilio';
import { callerWithheldIn, setupCalledOf, setupCallerOf } from './registry';
import { WITHHELD_PARAMETER } from '../../channel/callData';

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

  it('says who may interrupt a line (BARGE_IN) on the relay element: any unless told, else speech, dtmf or none', () => {
    expect(telnyxProvider.startDocument({ ...START, bargeIn: 'any' })).toBe(telnyxProvider.startDocument(START));
    for (const mode of ['speech', 'dtmf', 'none'] as const) {
      const doc = telnyxProvider.startDocument({ ...START, bargeIn: mode });
      expect(doc).toContain(`dtmfDetection="true" interruptible="${mode}" hints="one,two"`);
      expect(doc).not.toContain('interruptible="any"');
    }
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
        'language="es-US" voice="Telnyx.Ultra.Asher">' +
        '<Language code="en-US" voice="Telnyx.Ultra.Callie" transcriptionProvider="deepgram" speechModel="nova-2"/><Language code="es-US" voice="Telnyx.Ultra.Asher" transcriptionProvider="google"/>' +
        '<Parameter name="locale" value="es-US"/>' +
        '</ConversationRelay></Connect></Response>',
    );
    // A language with no voice of its own: the carrier's default, never the deployment's default-locale voice.
    const plain = telnyxProvider.startDocument({ ...START, voice: 'Telnyx.Ultra.Callie', language: { tts: 'es-US', transcription: 'es-US' } });
    expect(plain).toContain('hints="one,two" language="es-US"/>');
    expect(plain).not.toContain('voice=');
  });

  it('writes the start language\'s voice on the relay element too, each <Language> keeping its own (Telnyx said nothing without it, 2026-10-13)', () => {
    const languages = [
      { tts: 'en-US', transcription: 'en-US', voice: 'Telnyx.NaturalHD.astra' },
      { tts: 'es-US', transcription: 'es-US', voice: 'Telnyx.NaturalHD.luna' },
    ];
    const english = telnyxProvider.startDocument({ ...START, language: languages[0]!, languages, parameters: { locale: 'en-US' } });
    expect(english).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Connect action="https://voice.example.com/cr-action/telnyx">' +
        `<ConversationRelay url="wss://voice.example.com/conversation/telnyx?token=${'b'.repeat(32)}" dtmfDetection="true" interruptible="any" hints="one,two" ` +
        'language="en-US" voice="Telnyx.NaturalHD.astra">' +
        '<Language code="en-US" voice="Telnyx.NaturalHD.astra"/><Language code="es-US" voice="Telnyx.NaturalHD.luna"/>' +
        '<Parameter name="locale" value="en-US"/>' +
        '</ConversationRelay></Connect></Response>',
    );
    // A call that starts in Spanish has the Spanish voice on the element; a switch still finds each language's own.
    const spanish = telnyxProvider.startDocument({ ...START, language: languages[1]!, languages, parameters: { locale: 'es-US' } });
    expect(spanish).toContain('language="es-US" voice="Telnyx.NaturalHD.luna"><Language code="en-US" voice="Telnyx.NaturalHD.astra"/><Language code="es-US" voice="Telnyx.NaturalHD.luna"/>');
    // A start language with no voice of its own names none on the element: Telnyx's default, never another language's.
    const noVoice = telnyxProvider.startDocument({ ...START, language: { tts: 'es-US', transcription: 'es-US' }, languages: [languages[0]!, { tts: 'es-US', transcription: 'es-US' }] });
    expect(noVoice).toContain('language="es-US"><Language code="en-US" voice="Telnyx.NaturalHD.astra"/><Language code="es-US"/>');
    // Twilio's document is unchanged: the voices only on the <Language> children, none on the element.
    const twilio = twilioProvider.startDocument({ ...START, language: languages[0]!, languages, parameters: { locale: 'en-US' } });
    expect(twilio).toContain('ttsLanguage="en-US" transcriptionLanguage="en-US"><Language code="en-US" voice="Telnyx.NaturalHD.astra"/>');
    expect(twilio).not.toMatch(/<ConversationRelay [^>]* voice=/);
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

  it('says whether the call is live in its own words: active (the relay\'s setup) and in-progress (TeXML) are live, any other status is not', () => {
    const live = (status: string, body: 'form' | 'json' = 'form') =>
      telnyxProvider.parse(body === 'form'
        ? { url: '/cr-action/telnyx', headers: FORM, rawBody: `CallSid=v2%3Aabc&CallStatus=${status}`, nowSec: 0 }
        : { url: '/cr-action/telnyx', headers: JSON_TYPE, rawBody: JSON.stringify({ CallSid: 'v2:abc', CallStatus: status }), nowSec: 0 })?.live;
    expect(live('active', 'json')).toBe(true);
    expect(live('active')).toBe(true);
    expect(live('in-progress')).toBe(true);
    expect(live('Active', 'json')).toBe(true);
    for (const status of ['completed', 'ringing', 'busy', 'failed', 'no-answer', 'canceled']) expect(live(status), status).toBe(false);
    // The relay's own spelling of the field, as its setup frame has it, is read too.
    expect(telnyxProvider.parse({ url: '/cr-action/telnyx', headers: JSON_TYPE, rawBody: JSON.stringify({ CallSid: 'v2:abc', callStatus: 'active' }), nowSec: 0 })).toMatchObject({ callStatus: 'active', live: true });
  });

  it('says nothing of whether the call is live when the callback carries no status', () => {
    const p = telnyxProvider.parse({ url: '/cr-action/telnyx', headers: JSON_TYPE, rawBody: JSON.stringify({ CallSid: 'v2:abc', SessionStatus: 'failed' }), nowSec: 0 });
    expect(p).toMatchObject({ callId: 'v2:abc', sessionStatus: 'failed' });
    expect(p).not.toHaveProperty('live');
    expect(p).not.toHaveProperty('callStatus');
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
    expect(telnyxProvider.dialDocument({ to: '+15555550199' })).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Dial>+15555550199</Dial></Response>');
    expect(telnyxProvider.apologizeAndDialDocument({ to: '+15555550199' })).toContain('<Say>Sorry, we lost the connection.');
  });

  it('pauses before it connects when asked (a planned restart: the restarted server takes the socket), and not otherwise', () => {
    const doc = telnyxProvider.startDocument({ ...START, pauseS: 5 });
    expect(doc).toBe(telnyxProvider.startDocument(START).replace('<Response><Connect', '<Response><Pause length="5"/><Connect'));
    expect(telnyxProvider.startDocument({ ...START, pauseS: 0 })).toBe(telnyxProvider.startDocument(START));
  });

  it('asks for the event streams it is given', () => {
    expect(telnyxProvider.startDocument({ publicHost: 'voice.example.com', token: 'b'.repeat(32), hints: '', events: 'speaker-events tokens-played' })).toContain('events="speaker-events tokens-played"');
    expect(telnyxProvider.startDocument({ publicHost: 'voice.example.com', token: 'b'.repeat(32), hints: '' })).not.toContain('events=');
  });
});

describe("Telnyx's playback events in the engine's terms", () => {
  const info = (name: string, value: unknown) => ({ type: 'info', name, value });
  it('reads agentSpeaking, tokensPlayed and clientSpeaking as a live call sends them', () => {
    expect(telnyxProvider.readEvent!(info('agentSpeaking', 'on'))).toEqual({ kind: 'playback', state: 'started' });
    expect(telnyxProvider.readEvent!(info('agentSpeaking', 'off'))).toEqual({ kind: 'playback', state: 'finished' });
    expect(telnyxProvider.readEvent!(info('tokensPlayed', 'What are you seeing?'))).toEqual({ kind: 'playback', state: 'finished', text: 'What are you seeing?' });
    expect(telnyxProvider.readEvent!(info('clientSpeaking', 'on'))).toEqual({ kind: 'caller', speaking: true });
    expect(telnyxProvider.readEvent!(info('clientSpeaking', 'off'))).toEqual({ kind: 'caller', speaking: false });
  });
  it('reads nothing else: another name, a value it does not know, another type, or no object', () => {
    expect(telnyxProvider.readEvent!(info('agentSpeaking', 'maybe'))).toBeNull();
    expect(telnyxProvider.readEvent!(info('clientSpeaking', 3))).toBeNull();
    expect(telnyxProvider.readEvent!(info('tokensPlayed', 42))).toBeNull();
    expect(telnyxProvider.readEvent!(info('somethingElse', 'on'))).toBeNull();
    expect(telnyxProvider.readEvent!({ type: 'agentSpeaking', value: 'on' })).toBeNull();
    expect(telnyxProvider.readEvent!({ type: 'prompt', voicePrompt: 'hello', last: true })).toBeNull();
    expect(telnyxProvider.readEvent!(null)).toBeNull();
    expect(telnyxProvider.readEvent!('agentSpeaking')).toBeNull();
  });
});

describe('a caller who withheld their number on Telnyx (privacy)', () => {
  // The answer webhook of a call dialled with *67 (2026-10-13), its number replaced: the real number in
  // From, and the marks of a withheld one beside it. Re-pinned (live findings item 26): the marks are
  // read as data, a flag carried with the number (CallbackParams.privacy); the number stays as it came,
  // and what the app does with it is the app's (app.yaml's callerNumber.withheld).
  const fixtures = JSON.parse(readFileSync(new URL('./__fixtures__/telnyx/webhooks.json', import.meta.url), 'utf8')) as {
    alternatives: { source: string; headers: Record<string, string>; rawBody: string }[];
  };
  const captured = fixtures.alternatives.find((w) => w.source.startsWith('captured 2026-10-13'))!;
  const NUMBER = '+15555550142';
  const parseForm = (rawBody: string) => telnyxProvider.parse({ url: '/voice/telnyx', headers: FORM, rawBody, nowSec: 0 })!;
  const body = (fields: Record<string, string>) => new URLSearchParams({ CallSid: 'v3:abc', From: NUMBER, To: '+15555550111', ...fields }).toString();

  it('reads the captured webhook as withheld, the number kept with the flag, every field as it came', () => {
    const p = parseForm(captured.rawBody);
    expect(p.privacy).toBe('withheld');
    expect(p.from).toBe(NUMBER);
    expect(p.to).toBe('+15555550111');
    expect(p.raw).toMatchObject({ From: NUMBER, CallerId: 'anonymous', FromSipUri: 'anonymous@anonymous.invalid', To: '+15555550111', CallSessionId: '0b6e1f2a-6f5d-11ef-9692-02420aeffb1f' });
  });

  it('takes any one mark, in any case: an anonymous caller ID, an anonymous SIP From, a From that is no number, a SIP Privacy header', () => {
    const marks: Record<string, string>[] = [
      { CallerId: 'anonymous' }, { CallerId: 'Anonymous' }, { CallerId: 'RESTRICTED' }, { CallerId: 'private' },
      { FromSipUri: 'anonymous@anonymous.invalid' }, { FromSipUri: 'sip:Anonymous@pbx.example.com' }, { FromSipUri: '"Anonymous" <sip:x@ANONYMOUS.INVALID>;tag=1' },
      { Privacy: 'id' }, { SipHeader_Privacy: 'user;header' },
    ];
    for (const fields of marks) {
      const p = parseForm(body(fields));
      expect(p.privacy, JSON.stringify(fields)).toBe('withheld');
      expect(p.from, JSON.stringify(fields)).toBe(NUMBER);
    }
    expect(parseForm(new URLSearchParams({ CallSid: 'v3:abc', From: 'anonymous' }).toString()).privacy).toBe('withheld');
    expect(parseForm(new URLSearchParams({ CallSid: 'v3:abc', From: 'sip:anonymous@anonymous.invalid' }).toString()).privacy).toBe('withheld');
    // A JSON body the same.
    const json = telnyxProvider.parse({ url: '/voice/telnyx', headers: JSON_TYPE, rawBody: JSON.stringify({ CallSid: 'v3:abc', From: NUMBER, CallerId: 'anonymous' }), nowSec: 0 })!;
    expect(json.privacy).toBe('withheld');
    expect(json.from).toBe(NUMBER);
  });

  it('takes a withheld word as the SIP From\'s display name for a mark', () => {
    for (const from of ['"Anonymous" <sip:+15555550142@carrier.example.com>', 'Restricted <sip:+15555550142@carrier.example.com>']) {
      expect(parseForm(new URLSearchParams({ CallSid: 'v3:abc', From: NUMBER, FromSipUri: from }).toString()).privacy, from).toBe('withheld');
    }
    // A display name that is a person's name is no mark.
    expect(parseForm(new URLSearchParams({ CallSid: 'v3:abc', From: NUMBER, FromSipUri: `"Jordan Avery" <sip:${NUMBER}@carrier.example.com>` }).toString())).not.toHaveProperty('privacy');
  });

  it('reads a call with its number given as not withheld, as before', () => {
    const given: Record<string, string>[] = [{}, { CallerId: NUMBER, FromSipUri: `${NUMBER}@sip.example.com` }, { Privacy: 'none' }];
    for (const fields of given) {
      const p = parseForm(body(fields));
      expect(p, JSON.stringify(fields)).not.toHaveProperty('privacy');
      expect(p.from).toBe(NUMBER);
    }
  });

  it('reads the flag from a setup the server marked, and the setup keeps the number as it came', () => {
    const setup = {
      type: 'setup' as const, sessionId: 'TX1', callSid: '5e9fcc12-0000-4000-8000-000000000000', callControlId: 'v3:abc', callerName: 'Jordan Avery',
      from: null as unknown as string, to: null as unknown as string,
      customParameters: { telnyx_call_from: NUMBER, telnyx_call_to: '+15555550111', [WITHHELD_PARAMETER]: 'true', locale: 'en-US' },
    };
    expect(callerWithheldIn(setup)).toBe(true);
    expect(setupCallerOf('telnyx', setup)).toBe(NUMBER);
    expect(setupCalledOf('telnyx', setup)).toBe('+15555550111');
    const { [WITHHELD_PARAMETER]: _w, ...plain } = setup.customParameters;
    expect(callerWithheldIn({ ...setup, customParameters: plain })).toBe(false);
  });

  it('reads the STIR/SHAKEN attestation, where the webhook carries one', () => {
    expect(parseForm(body({ shaken_stir_attestation: 'A' })).attestation).toBe('A');
    expect(parseForm(body({}))).not.toHaveProperty('attestation');
  });
});
