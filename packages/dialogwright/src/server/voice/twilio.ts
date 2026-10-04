import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CallbackParams, StartDocumentOptions, VoiceProvider, WebhookRequest } from './provider';
import { attr, escapeXml, formFields, placeLanguages, recognitionAttrs, pauseVerb, relayElement, xmlResponse } from './xml';
import type { Recognition } from '../../core/app/types';

/**
 * Twilio request signature: HMAC-SHA1 over the full URL followed by every POST
 * parameter's name and value in sorted key order, base64 encoded.
 */
export function computeTwilioSignature(fullUrl: string, params: Record<string, string>, authToken: string): string {
  const tail = Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', authToken).update(fullUrl + tail).digest('base64');
}

export function validateTwilioSignature(
  fullUrl: string,
  params: Record<string, string>,
  header: string | undefined,
  authToken: string,
): boolean {
  if (!header) return false;
  const expected = Buffer.from(computeTwilioSignature(fullUrl, params, authToken));
  const given = Buffer.from(header);
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/** Where a start document points the relay's socket and the end of the relay's session. */
export interface RelayPaths {
  /** The WebSocket path, `/conversation/twilio` (or the legacy `/conversation`). */
  readonly socket: string;
  /** The `<Connect action>` path, `/cr-action/twilio` (or the legacy `/cr-action`). */
  readonly action: string;
}

/** The provider's own paths; the legacy unprefixed ones are server/twiml.ts connectRelayTwiml's. */
export const TWILIO_PATHS: RelayPaths = { socket: '/conversation/twilio', action: '/cr-action/twilio' };

/** Twilio's recognizer when a caller of the document names none: Deepgram flux, as the document always had. */
const TWILIO_DEFAULT_RECOGNITION: Recognition = { provider: 'Deepgram', model: 'flux' };

/**
 * The ConversationRelay connect document. Attributes follow Twilio's ConversationRelay TwiML reference.
 * The recognizer (`transcriptionProvider`, `speechModel`) is the deployment's (TWILIO_TRANSCRIPTION_PROVIDER,
 * TWILIO_SPEECH_MODEL). For an app that names its languages, the call's start language (`ttsLanguage`,
 * `transcriptionLanguage`), one `<Language>` child per language it may switch to with its own voice
 * and recognizer (xml.ts placeLanguages), and `<Parameter>` children (the `locale` the engine reads
 * back from the setup frame).
 *
 * `partialPrompts="true"` is on for the no-input wait, not for scoring: the adapter still runs a
 * turn only on a final prompt, but a partial tells it the caller has started speaking, so the
 * wait is cancelled at the first syllable rather than after the whole utterance is transcribed.
 */
export function twilioConnectDocument(o: StartDocumentOptions, paths: RelayPaths): string {
  const placed = placeLanguages(o, { ttsProvider: true, relayModel: true });
  // Without languages, the deployment's recognizer (Deepgram flux unless TWILIO_* says otherwise), in
  // the place it has always had: a one-locale en-US app's document is byte for byte as before.
  const recognition = o.language ? placed.recognition : (o.recognition ?? TWILIO_DEFAULT_RECOGNITION);
  const attrs = [
    `url="wss://${escapeXml(o.publicHost)}${paths.socket}?token=${escapeXml(o.token)}"`,
    ...recognitionAttrs(recognition),
    'partialPrompts="true"',
    'dtmfDetection="true"',
    // On speakerphone, room noise was interrupting prompt playback and leaving the caller in
    // silence until the no-input timer fired: low needs confident, longer speech to interrupt, and backchannels ("uh-huh") never do.
    'interruptible="any"',
    'interruptSensitivity="low"',
    'ignoreBackchannel="true"',
    'reportInputDuringAgentSpeech="any"',
    'deepgramSmartFormat="false"',
    `hints="${escapeXml(o.hints)}"`,
  ];
  if (o.language) {
    // A call in a named language: its voice here only when every language has it (placeLanguages).
    attrs.push(attr('ttsLanguage', o.language.tts), attr('transcriptionLanguage', o.language.transcription));
    if (placed.voice.voice !== undefined) {
      if (placed.voice.ttsProvider !== undefined) attrs.push(attr('ttsProvider', placed.voice.ttsProvider));
      attrs.push(attr('voice', placed.voice.voice));
    }
  } else if (o.ttsProvider && o.voice) {
    attrs.push(`ttsProvider="${escapeXml(o.ttsProvider)}"`, `voice="${escapeXml(o.voice)}"`);
  }
  const relay = relayElement(attrs, placed.children);
  return xmlResponse(`${pauseVerb(o.pauseS)}<Connect action="https://${escapeXml(o.publicHost)}${paths.action}">${relay}</Connect>`);
}

/**
 * Twilio's form fields in the engine's terms. The call id is empty when CallSid is absent: the legacy
 * action callback still answers such a request (with a hangup), so it is read rather than refused.
 */
export function twilioCallbackParams(raw: Record<string, string>): CallbackParams {
  return {
    callId: (raw.CallSid ?? '').trim(),
    raw,
    ...(raw.From !== undefined ? { from: raw.From } : {}),
    ...(raw.To !== undefined ? { to: raw.To } : {}),
    ...(raw.CallStatus !== undefined ? { callStatus: raw.CallStatus } : {}),
    // Twilio always says: a call is live only while it is in-progress, and a callback without the
    // field is read as not live, exactly as the engine read it before providers said so themselves.
    live: raw.CallStatus === 'in-progress',
    ...(raw.SessionStatus !== undefined ? { sessionStatus: raw.SessionStatus } : {}),
    ...(raw.HandoffData !== undefined ? { handoffData: raw.HandoffData } : {}),
  };
}

function parse(req: WebhookRequest): CallbackParams | null {
  const params = twilioCallbackParams(formFields(req.rawBody));
  return params.callId ? params : null;
}

/** Twilio's ConversationRelay: form-encoded webhooks signed with the account's auth token, and TwiML. */
export const twilioProvider: VoiceProvider = {
  id: 'twilio',
  contentType: 'text/xml',
  verify: (req, secret, publicHost) =>
    validateTwilioSignature(`https://${publicHost}${req.url}`, formFields(req.rawBody), req.headers['x-twilio-signature'], secret),
  parse,
  startDocument: (o) => twilioConnectDocument(o, TWILIO_PATHS),
  dialDocument: (n) => xmlResponse(`<Dial>${escapeXml(n)}</Dial>`),
  hangupDocument: () => xmlResponse('<Hangup/>'),
  apologizeAndDialDocument: (n) =>
    xmlResponse(`<Say>Sorry, we lost the connection. Let me get someone to help you.</Say><Dial>${escapeXml(n)}</Dial>`),
};
