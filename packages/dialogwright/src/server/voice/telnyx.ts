import type { CallbackParams, StartDocumentOptions, VoiceProvider, WebhookRequest } from './provider';
import { attr, escapeXml, formFields, placeLanguages, recognitionAttrs, relayElement, xmlResponse } from './xml';
import { verifyTelnyxSignature } from './telnyxSignature';

/**
 * Telnyx's Conversation Relay through TeXML. The socket frames are the shared relay wire; what
 * differs is the start document (TeXML attribute names and Telnyx voices), the Ed25519 webhook
 * signature (telnyxSignature.ts), and the callback's fields.
 *
 * Documented by Telnyx (developers.telnyx.com, "Conversation Relay" and the TeXML
 * `<ConversationRelay>` reference): the `<Connect><ConversationRelay>` document and its attributes
 * (url, voice, language, transcriptionProvider, dtmfDetection, interruptible), the socket frames, and
 * the webhook signature headers.
 *
 * ASSUMPTIONS, not in Telnyx's published pages, to confirm with a live capture of a Telnyx call:
 * 1. The TeXML voice and action webhooks are form-encoded with Twilio-compatible field names
 *    (`CallSid`, `From`, `To`, `CallStatus`). The parser below reads a JSON body as well, and takes
 *    `call_control_id` (or `CallControlId`) for the call id when `CallSid` is absent, so either answer works.
 * 2. The `<Connect action>` callback hands the `end` frame's data back as `HandoffData`. The parser
 *    also takes `handoffData`.
 * 3. `hints` is not a documented attribute; it is sent so recognition gets the app's words if Telnyx
 *    honours it, on the understanding that TeXML ignores an attribute it does not know.
 * 4. For an app that names its languages, the call's language is the documented `language`
 *    attribute (one tag for speech and recognition), and the languages it may switch to and the
 *    `locale` custom parameter are `<Language code voice>` and `<Parameter name value>` children, in
 *    the shape Twilio documents. A live call should confirm Telnyx reads the children, the text
 *    frames' `lang` and the `language` frame (set_language) the same way.
 * 5. The recognizer: the documented `transcriptionProvider` attribute (TELNYX_TRANSCRIPTION_PROVIDER,
 *    or a locale's own); a model only on `<Language>`, the one element Telnyx documents
 *    `speechModel` on. A child inheriting what it leaves out from the relay element is assumed to
 *    work as Twilio documents it.
 * The conformance fixtures (__fixtures__/telnyx) say which of their entries are documented and which assumed.
 */

/** The webhook's fields as strings: a JSON object's string fields, or a form body's fields. */
function fields(req: WebhookRequest): Record<string, string> {
  const type = (req.headers['content-type'] ?? '').toLowerCase();
  const looksJson = type.includes('application/json') || (type === '' && req.rawBody.trimStart().startsWith('{'));
  if (!looksJson) return formFields(req.rawBody);
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.rawBody);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** The first of `names` the fields carry. */
function first(raw: Record<string, string>, ...names: string[]): string | undefined {
  for (const n of names) if (raw[n] !== undefined) return raw[n];
  return undefined;
}

function parse(req: WebhookRequest): CallbackParams | null {
  const raw = fields(req);
  const callId = (first(raw, 'CallSid', 'call_control_id', 'CallControlId') ?? '').trim();
  if (!callId) return null;
  const from = first(raw, 'From', 'from');
  const to = first(raw, 'To', 'to');
  const callStatus = first(raw, 'CallStatus');
  const sessionStatus = first(raw, 'SessionStatus');
  const handoffData = first(raw, 'HandoffData', 'handoffData');
  return {
    callId,
    raw,
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(callStatus !== undefined ? { callStatus } : {}),
    ...(sessionStatus !== undefined ? { sessionStatus } : {}),
    ...(handoffData !== undefined ? { handoffData } : {}),
  };
}

/**
 * The TeXML connect document. `ttsProvider` is left out: a Telnyx voice name carries its provider
 * (`Telnyx.NaturalHD.astra`), so the voice is passed whole. It is the deployment's TELNYX_VOICE
 * (config.ts voiceFor), never Twilio's TTS_VOICE, whose names Telnyx does not know.
 */
function startDocument(o: StartDocumentOptions): string {
  const placed = placeLanguages(o, { ttsProvider: false, relayModel: false });
  const attrs = [
    `url="wss://${escapeXml(o.publicHost)}/conversation/telnyx?token=${escapeXml(o.token)}"`,
    'dtmfDetection="true"',
    'interruptible="any"',
    `hints="${escapeXml(o.hints)}"`,
    // The relay element takes a recognizer's provider, not its model (a model goes on <Language>).
    ...recognitionAttrs(o.language ? placed.recognition : (o.recognition ?? {}), false),
  ];
  if (o.language) {
    // One language for speech and recognition alike; its voice here only when every language has it (placeLanguages).
    attrs.push(attr('language', o.language.tts));
    if (placed.voice.voice !== undefined) attrs.push(attr('voice', placed.voice.voice));
  } else if (o.voice) attrs.push(`voice="${escapeXml(o.voice)}"`);
  const relay = relayElement(attrs, placed.children);
  return xmlResponse(`<Connect action="https://${escapeXml(o.publicHost)}/cr-action/telnyx">${relay}</Connect>`);
}

export const telnyxProvider: VoiceProvider = {
  id: 'telnyx',
  contentType: 'text/xml',
  verify: (req, secret) =>
    verifyTelnyxSignature(
      { signature: req.headers['telnyx-signature-ed25519'], timestamp: req.headers['telnyx-timestamp'], rawBody: req.rawBody, nowSec: req.nowSec },
      secret,
    ),
  parse,
  startDocument,
  dialDocument: (n) => xmlResponse(`<Dial>${escapeXml(n)}</Dial>`),
  hangupDocument: () => xmlResponse('<Hangup/>'),
  apologizeAndDialDocument: (n) =>
    xmlResponse(`<Say>Sorry, we lost the connection. Let me get someone to help you.</Say><Dial>${escapeXml(n)}</Dial>`),
};
