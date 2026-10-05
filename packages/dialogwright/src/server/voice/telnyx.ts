import type { CallbackParams, PlaybackEvent, StartDocumentOptions, VoiceProvider, WebhookRequest } from './provider';
import { attr, escapeXml, formFields, placeLanguages, recognitionAttrs, pauseVerb, relayElement, xmlResponse } from './xml';
import { verifyTelnyxSignature } from './telnyxSignature';

/**
 * Telnyx's Conversation Relay through TeXML. The socket frames are the shared relay wire; what
 * differs is the start document (TeXML attribute names and Telnyx voices), the Ed25519 webhook
 * signature (telnyxSignature.ts), and the callback's fields.
 *
 * Documented by Telnyx (developers.telnyx.com, "Conversation Relay" and the TeXML
 * `<ConversationRelay>` reference): the `<Connect><ConversationRelay>` document and its attributes
 * (url, voice, language, transcriptionProvider, dtmfDetection, interruptible: none, any, speech or
 * dtmf, BARGE_IN); its two children,
 * `<Language code>` with optional per-language `voice`, `ttsProvider`, `transcriptionProvider` and
 * `speechModel`, and `<Parameter name value>`, whose pairs come back in the setup frame's
 * `customParameters`; the socket frames, the `language` frame among them (`ttsLanguage`,
 * `transcriptionLanguage`: it changes the speech and transcription language); and the webhook
 * signature headers.
 *
 * SEEN ON LIVE CALLS (2026-10-05), where Telnyx's pages differ or say nothing:
 * - The TeXML voice and action webhooks are form-encoded with Twilio-compatible field names (`CallSid`,
 *   `CallSidLegacy`, `From`, `To`, `CallStatus`, `Direction`, `CallSessionId`, `ConnectionId`), signed with
 *   `telnyx-signature-ed25519`. The call id is a `v3:` id. The action callback adds `SessionStatus`,
 *   `SessionId`, `ConversationId`, `DurationSec`, `SessionDuration`, and on a relay failure `ErrorCode`
 *   (64105, "WebSocket connection ended unexpectedly") and `Reason`; a normal hang-up has `CallStatus`
 *   and `SessionStatus` both `completed`.
 * - The setup frame's `callSid` is another, 36-character id; the webhook's `CallSid` comes as
 *   `callControlId` (setupCallId below). Its `from`, `to` and `direction` are null, and the numbers come
 *   in `customParameters` (`telnyx_call_from`, `telnyx_call_to`, and other `telnyx_*` keys).
 * - Telnyx's default recognizer ends a prompt at short pauses: "22 Alder Street" came as three
 *   final prompts. `TELNYX_TRANSCRIPTION_PROVIDER` chooses another (deepgram, google, telnyx).
 * - The event streams the `events` attribute asks for (TELNYX_EVENTS: speaker-events, tokens-played) come
 *   on the socket as `{ "type": "info", "name": <event>, "value": <value> }`: `agentSpeaking` and
 *   `clientSpeaking` with `on` or `off`, and `tokensPlayed` with the line played, as it was sent
 *   (readEvent below).
 * - Telnyx cuts a reply short and reports it played. Right after the caller spoke, the engine sent one
 *   24-word line (9.6 s by the estimate, last: true); agentSpeaking went on 0.07 s later, tokensPlayed
 *   came with the whole line 0.67 s after that, and agentSpeaking went off 0.03 s later, with no
 *   `interrupt` and no clientSpeaking between. The caller heard nothing, and sat in silence until the
 *   no-input wait asked again, 16.6 s after the line went out; then the same line played in full (tokensPlayed 9.6 s after
 *   agentSpeaking on). Earlier calls, before the events were on, had the same silence after a reply right
 *   after the caller spoke. The adapter says such a line again (RESAY_CUT_LINES, server/adapter.ts).
 * - Telnyx sends no partial prompts, only the final one, about a second after the caller's last
 *   clientSpeaking off. On a call (deepgram recognizer) the caller spoke one sentence for 5.5 s
 *   (clientSpeaking on and off twelve times), the no-input wait ran out 0.7 s after the last off, and
 *   "I didn't hear anything." went out 0.3 s before the transcript. clientSpeaking (read below as the
 *   caller speaking) now holds the wait, with NO_INPUT_AFTER_SPEECH_MS after the stop for the transcript
 *   (server/adapter.ts onCallerSpeech). The same call showed clientSpeaking blips of 0.12 to 0.24 s with
 *   no prompt after them (noise the recognizer dropped).
 * - Telnyx acts on an `end` frame at once and drops the speech it has been sent and not yet played. A
 *   turn that ended the call sent "Goodbye." (last: true) and `end` in the same millisecond; agentSpeaking
 *   went on 0.13 s later and off 14 ms after that, Telnyx closed the socket 146 ms after the `end`, and the
 *   caller heard no goodbye. Twilio, by contrast, plays what is queued before it acts on `end` while the
 *   socket stays open. So Telnyx's provider says `endDropsSpeech`, and the adapter holds the `end` until
 *   the lines before it have played (END_AFTER_PLAYBACK, server/adapter.ts): until tokensPlayed or
 *   agentSpeaking off says so, or, without TELNYX_EVENTS, for the lines' estimated length.
 * - A new frame replaces the current playback, even with the relay's interruptible none and the line's
 *   preemptible false. With interruptible="none", the engine sent a new text while the agent was speaking:
 *   agentSpeaking went off about 70 ms later, and on again for the new text. Telnyx documents no frame
 *   that stops playback (the frames a server may send are text, play, sendDigits, language and end), so
 *   BARGE_IN=server stops it this way: a `play` frame of a short silent clip the server hosts
 *   (stopPlayback below, server/voice/silence.ts).
 * - The silent reply (the cut line above) looks like Telnyx's own barge-in: with BARGE_IN=none
 *   (interruptible="none"), three calls in a row played the reply right after a long answer in full. Telnyx
 *   has no barge-in sensitivity setting, so BARGE_IN=server does the barge-in in the engine, from
 *   clientSpeaking, with a minimum length of speech (BARGE_IN_MIN_SPEECH_MS) that a cough or echo does not reach.
 * - With interruptible="none" no `interrupt` ever comes, so a caller who had not finished was not joined
 *   (App.voice.continueWithinMs): "...for one two" came as a final prompt, the reply went out 0.2 s later,
 *   clientSpeaking went on 24 ms after it (before agentSpeaking on), and "three four" came 1.4 s later as a
 *   prompt of its own. The adapter now takes speech that starts that soon as the caller continuing
 *   (server/adapter.ts takeResumed).
 *
 * ASSUMPTIONS, not in Telnyx's published pages and not yet seen on a live call:
 * 1. The parser below also reads a JSON body, and takes `call_control_id` (or `CallControlId`) for the call
 *    id when `CallSid` is absent, should a webhook ever come that way (none has).
 * 2. The `<Connect action>` callback hands the `end` frame's data back as `HandoffData`. The parser
 *    also takes `handoffData`.
 * 3. `hints` is not a documented attribute; it is sent so recognition gets the app's words if Telnyx
 *    honours it, on the understanding that TeXML ignores an attribute it does not know.
 * 4. For an app that names its languages, the call's language is the documented `language`
 *    attribute (one tag for speech and recognition), and the languages it may switch to and the
 *    `locale` custom parameter are the documented `<Language code voice>` and `<Parameter name
 *    value>` children; a switch is the documented `language` frame. Still to confirm on a live call:
 *    that a text frame's `lang` is read (Telnyx's text frame example carries `token` and `last`
 *    only), and that a `<Language>` child's voice and recognizer apply to the call's first language
 *    (the `language` attribute) as well as to a switch.
 * 5. The recognizer: the documented `transcriptionProvider` attribute (TELNYX_TRANSCRIPTION_PROVIDER,
 *    or a locale's own); a model only on `<Language>`, as its documented `speechModel` (the relay
 *    element documents none). That a child inherits what it leaves out from the relay element is
 *    not documented, and is assumed to work as Twilio documents it.
 * 6. The action callback's call status. Telnyx documents `callStatus: "active"` on the relay's setup
 *    frame and `in-progress` among TeXML's call statuses (ringing, in-progress, canceled, completed,
 *    failed, busy, no-answer), but not the callback's own fields. Both words read as a live call
 *    (CallbackParams.live), in `CallStatus` or `callStatus`, in any case; any other status as not
 *    live. A callback with no status at all says nothing, and the engine then reconnects only when
 *    its `SessionStatus` is `failed` and it still holds the call live (server/http.ts decideAction);
 *    anything else hangs up. A live capture of a relay failure should confirm the fields and words.
 * 7. A text frame's own `interruptible` (the app's word on whether a caller may talk over that line) is
 *    not on Telnyx's text frame page (token and last only), and how it meets the relay element's
 *    `interruptible` is not documented. With BARGE_IN=none, dtmf or server the adapter sends it `false`
 *    (channel/relay/frames.ts bargeInFrame) so a line never allows what the element forbids.
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

/**
 * The statuses of a live call in Telnyx's words: `active`, the relay's (its setup frame's
 * `callStatus`), and `in-progress`, TeXML's (its instruction requests; the TeXML call statuses are
 * ringing, in-progress, canceled, completed, failed, busy and no-answer). Compared in lower case.
 */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['active', 'in-progress']);

function parse(req: WebhookRequest): CallbackParams | null {
  const raw = fields(req);
  const callId = (first(raw, 'CallSid', 'call_control_id', 'CallControlId') ?? '').trim();
  if (!callId) return null;
  const from = first(raw, 'From', 'from');
  const to = first(raw, 'To', 'to');
  const callStatus = first(raw, 'CallStatus', 'callStatus');
  const sessionStatus = first(raw, 'SessionStatus');
  const handoffData = first(raw, 'HandoffData', 'handoffData');
  return {
    callId,
    raw,
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(callStatus !== undefined ? { callStatus, live: LIVE_STATUSES.has(callStatus.trim().toLowerCase()) } : {}),
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
    `interruptible="${o.bargeIn ?? 'any'}"`,
    `hints="${escapeXml(o.hints)}"`,
    // The relay element takes a recognizer's provider, not its model (a model goes on <Language>).
    ...recognitionAttrs(o.language ? placed.recognition : (o.recognition ?? {}), false),
    ...(o.events ? [attr('events', o.events)] : []),
  ];
  if (o.language) {
    // One language for speech and recognition alike; its voice here only when every language has it (placeLanguages).
    attrs.push(attr('language', o.language.tts));
    if (placed.voice.voice !== undefined) attrs.push(attr('voice', placed.voice.voice));
  } else if (o.voice) attrs.push(`voice="${escapeXml(o.voice)}"`);
  const relay = relayElement(attrs, placed.children);
  return xmlResponse(`${pauseVerb(o.pauseS)}<Connect action="https://${escapeXml(o.publicHost)}/cr-action/telnyx">${relay}</Connect>`);
}

/** An event's on or off, as Telnyx writes it (`on`, `off`); null for anything else. */
function onOff(value: unknown): boolean | null {
  return value === 'on' ? true : value === 'off' ? false : null;
}

/**
 * Telnyx's event messages (TELNYX_EVENTS) in the engine's terms, in the shape seen on a live call
 * (2026-10-05): `{ type: 'info', name, value }`. agentSpeaking on and off are the playback starting
 * and finishing; tokensPlayed is the playback finishing with the line it played; clientSpeaking on
 * and off are the caller. Any other message, name or value is not a playback event.
 */
function readEvent(message: unknown): PlaybackEvent | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null;
  const m = message as { type?: unknown; name?: unknown; value?: unknown };
  if (m.type !== 'info') return null;
  switch (m.name) {
    case 'agentSpeaking': {
      const on = onOff(m.value);
      return on === null ? null : on ? { kind: 'playback', state: 'started' } : { kind: 'playback', state: 'finished' };
    }
    case 'tokensPlayed':
      return typeof m.value === 'string' ? { kind: 'playback', state: 'finished', text: m.value } : null;
    case 'clientSpeaking': {
      const on = onOff(m.value);
      return on === null ? null : { kind: 'caller', speaking: on };
    }
    default:
      return null;
  }
}

export const telnyxProvider: VoiceProvider = {
  // Seen on a live call (2026-10-05): the setup's callSid is a 36-character id, and the webhook's CallSid
  // (a v3: id) arrives as callControlId.
  setupCallId: (setup) => setup.callControlId ?? setup.callSid,
  // Seen on a live call (2026-10-05): after a text frame with last: true, Telnyx drops the turn's next one.
  textLast: 'final',
  // Seen on a live call (2026-10-05): Telnyx acts on `end` at once and drops the speech it has not yet played.
  endDropsSpeech: true,
  // Seen on a live call (2026-10-05): with TELNYX_EVENTS, the playback and the caller's voice, reported as info messages.
  readEvent,
  // Seen on a live call (2026-10-05): with TELNYX_EVENTS speaker-events, agentSpeaking and clientSpeaking as they happen.
  reportsSpeaking: true,
  // Seen on a live call (2026-10-05): a new frame replaces the current playback, even with interruptible none.
  stopPlayback: 'silent-clip',
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
