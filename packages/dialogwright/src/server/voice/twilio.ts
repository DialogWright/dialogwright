import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CallbackParams, StartDocumentOptions, VoiceProvider, WebhookRequest } from './provider';
import { escapeXml, formFields, xmlResponse } from './xml';

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

/**
 * The ConversationRelay connect document. Attributes follow Twilio's ConversationRelay TwiML reference.
 *
 * `partialPrompts="true"` is on for the no-input wait, not for scoring: the adapter still runs a
 * turn only on a final prompt, but a partial tells it the caller has started speaking, so the
 * wait is cancelled at the first syllable rather than after the whole utterance is transcribed.
 */
export function twilioConnectDocument(o: StartDocumentOptions, paths: RelayPaths): string {
  const attrs = [
    `url="wss://${escapeXml(o.publicHost)}${paths.socket}?token=${escapeXml(o.token)}"`,
    'transcriptionProvider="Deepgram"',
    'speechModel="flux"',
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
  if (o.ttsProvider && o.voice) {
    attrs.push(`ttsProvider="${escapeXml(o.ttsProvider)}"`, `voice="${escapeXml(o.voice)}"`);
  }
  return xmlResponse(`<Connect action="https://${escapeXml(o.publicHost)}${paths.action}"><ConversationRelay ${attrs.join(' ')}/></Connect>`);
}

function parse(req: WebhookRequest): CallbackParams | null {
  const raw = formFields(req.rawBody);
  const callId = (raw.CallSid ?? '').trim();
  if (!callId) return null;
  return {
    callId,
    raw,
    ...(raw.From !== undefined ? { from: raw.From } : {}),
    ...(raw.To !== undefined ? { to: raw.To } : {}),
    ...(raw.CallStatus !== undefined ? { callStatus: raw.CallStatus } : {}),
    ...(raw.SessionStatus !== undefined ? { sessionStatus: raw.SessionStatus } : {}),
    ...(raw.HandoffData !== undefined ? { handoffData: raw.HandoffData } : {}),
  };
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
