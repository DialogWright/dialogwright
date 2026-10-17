import { z } from 'zod';
import { checkAlways, identifier, localeTag, matching, name, text, textMap, unique } from './common';
import { RECOGNIZER_NAME, TWILIO_TTS_PROVIDERS } from '../../channel/voiceProviders';
import { PRONOUNCE_MAX_SAY, PRONOUNCE_MAX_WORD, pronounceProblems } from '../../channel/pronounce';
import { DEFAULT_CONTINUE_WITHIN_MS, MAX_CONTINUE_WITHIN_MS } from '../../run/continuation';
import { ATTESTATION_PARAMETER, callDataSourceProblem, HOST_APP_PARAMETER, WEBHOOK_PARAMETER_PREFIX, WITHHELD_PARAMETER } from '../../channel/callData';
import { CALL_DATA_SENDS, CALLER_WITHHELD_USES } from '../../core/app/types';
import { ENV_REFERENCE } from '../../core/app/envReference';
import { E164 } from '../../core/numberLocales';
import { whenSchema } from './condition';
import { CHAT_DATA_KEY, HEADER_NAME } from '../../core/transfer';
import { hoursProblems } from '../../core/hours';

/** A key of voice.numbers: a number written out (E.164) or env.<NAME>. */
const NUMBER_LOCALE_KEY = new RegExp(`(?:${E164.source})|(?:${ENV_REFERENCE.source})`);

/**
 * app.yaml: who the app is and how it presents itself. It mirrors the App contract's presentation
 * fields (id, brand, console, voice, handoff, wording, thresholds, carrySlots, unsureIntent, changeSlotWithValue, anythingElseSilence, ackIntent, callerNumber, textConsent, callData, startParameters, transfer, hours, onStart, fixtures, testing, and the
 * non-text parts of prompts); the dialog itself lives in intents.yaml, forms.yaml, prompts.yaml,
 * policy.yaml and identity.yaml.
 */

/**
 * A fixtures folder inside the package: relative (no leading "/" or "\", no drive letter like
 * "C:"), with no ".." segment. The engine reads it from the working directory, so a path that left
 * the package would read whatever is there.
 */
const FIXTURES_DIR = /^(?![/\\])(?![A-Za-z]:)(?!(?:.*[/\\])?\.\.(?:[/\\]|$)).+$/;

const brand = z
  .strictObject({
    name: text().describe('The app\'s name, as the console\'s title and its speaker labels show it (for example "Example Parcels").'),
    mark: text().describe('The console\'s short mark, top left (for example "EP").'),
    key: text()
      .optional()
      .describe('The prefix of the console\'s browser storage keys. Keep it stable and a browser\'s saved choices survive. Default: the app id.'),
  })
  .describe('How the app is named on the operator console and in its browser storage.');

/** A fact the console reads off a turn's audit rows: one shape per `kind`. */
const consoleFact = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({
      kind: z.literal('created').describe('A row recording a record the turn created.'),
      type: name().describe('The audit row type that records the creation (for example "report_created").'),
      field: name().describe("The audit row's detail field that names the record."),
      text: text().describe('The fact as the NOW panel says it; write {} where the detail field goes.'),
    }),
    z.strictObject({
      kind: z.literal('lookup').describe("A tool's result; the allowed call's param names the record."),
      tool: identifier().describe('The tool whose allowed call is the fact.'),
      param: identifier().describe('The call param that names the record (for example "parcelId").'),
      noun: text().describe('What the record is, in words ("parcel" reads "parcel 7101 · in transit").'),
    }),
    z.strictObject({
      kind: z.literal('answer').describe('A knowledge-base answer.'),
      type: name().describe('The audit row type that records the answer (for example "kb_answer").'),
      field: name().describe("The audit row's detail field that names the answer."),
      topicSlot: identifier().optional().describe("A slot whose display names the answer's topic; without one, the detail field is used."),
    }),
    z.strictObject({
      kind: z.literal('note').describe("A row that adds text to the fact already held, unless the fact already says `unless`."),
      type: name().describe('The audit row type that adds the note.'),
      when: z
        .record(name(), z.union([z.string(), z.number(), z.boolean()]))
        .describe("The row's detail fields that must have these values for the note to apply."),
      text: text().describe('The words added to the fact.'),
      unless: text().optional().describe('Text that, when the fact already says it, stops the note being added.'),
    }),
  ],
  { error: 'is not a fact: it needs a kind of created, lookup, answer or note' },
);

const consoleLink = z
  .strictObject({
    id: matching(/^[a-z][a-z0-9-]*$/, 'is not a valid link id: it must be a lowercase word, hyphens allowed', 'rename it with lowercase letters, digits and hyphens, starting with a letter (for example "chat")')
      .describe('The button\'s element id (for example "chat"). It may not be an id the console page already uses.'),
    label: text().describe("The button's label."),
    title: text().describe("The button's tooltip."),
    href: z
      .string()
      .refine((href) => /^(\/|https?:\/\/)/.test(href), {
        message: 'href must be a path starting with "/" or an http(s) address',
        params: { fix: 'write a path such as "/chat", or a full "https://..." address; other schemes (javascript:, data:) are refused' },
      })
      .describe('The page the button opens: a path on the server ("/chat") or an http(s) address.'),
    target: text().describe("The window name (window.open's target), so a second click reuses the window."),
    features: text().describe('window.open\'s features, for example "width=440,height=700".'),
  })
  .describe('A console header button that opens one of the app\'s own pages in a window of its own.');

const consoleConfig = z
  .strictObject({
    formLabels: textMap(identifier()).optional().describe('Each form in words, as the NOW panel says it (for example report_missing: "Report a missing parcel"). Default: the form id with spaces.'),
    slotOrder: unique(identifier(), 'slot')
      .optional()
      .describe('Every slot, in the order the chips and the perception groups show them outside a form. Default: the identity factor slots, then each form\'s slots in turn, once each.'),
    slotLabels: textMap(identifier()).optional().describe('Each slot as the NOW panel names it (for example accountId: "Account ID"). Default: the slot id.'),
    questionPrefixes: z
      .record(identifier(), z.array(text()))
      .optional()
      .describe('The question id prefixes that belong to a slot, where its questions are not named after it (for example parcelSelect: [parcelChoice]). A slot not listed owns the ids that start with its own.'),
    detectQuestions: z.array(text()).optional().describe('Slot questions measured against the detection threshold besides the ones ending in "Given" (for example containsAccountId).'),
    levels: z
      .array(text())
      .length(3, { error: 'must have exactly three entries, one each for levels 0, 1 and 2' })
      .optional()
      .describe('The level badge\'s words for levels 0, 1 and 2, for example ["anonymous", "ID + DOB", "+ code"].'),
    handoffReasons: textMap().optional().describe('Handoff reasons the app adds, in words (for example staff-filing: "a person on staff filed it").'),
    facts: z.array(consoleFact).optional().describe("The key fact of a task, read off its turn's audit rows, as the NOW panel says it. In order; a row matches the first that fits."),
    goodAuditTypes: z.array(name()).optional().describe('Audit row types the audit list shows as good news, beside a passed identity check (for example report_created, kb_answer).'),
    serviceNote: z
      .strictObject({
        label: text().describe('Who answered (for example "Depot agent · A2A").'),
        answered: text().describe('An answer taken (for example "answered the filed report").'),
        reasons: textMap().optional().describe("Why an answer was refused or never came, by the client's reason code. A code not listed is shown as it is."),
      })
      .optional()
      .describe("A downstream service's answer as the conversation pane shows it."),
    signIn: z
      .strictObject({
        marker: text().describe("The conversation pane's marker for a sign-in mid-chat."),
        role: text().describe('The role the caller line names the person by.'),
      })
      .optional()
      .describe('A portal sign-in mid-chat (an auth.signed_in turn), as the conversation pane shows it.'),
    chatPrefixes: z.array(text()).optional().describe('Session id prefixes of the app\'s chats (for example CH, WC), so the console knows a replayed trace was a chat.'),
    heardBy: text().optional().describe('Who hears what the agent says, in the handoff card\'s note (for example "the customer"). Default "the caller".'),
    links: z.array(consoleLink).optional().describe("Buttons in the console's header that open the app's own pages."),
  })
  .describe("What the operator console shows in the app's words. Each field is optional; without one the console uses the app's own ids and neutral words.");

/** One spoken-digits rule. The pattern is a regular expression source; the engine compiles it with the g flag. */
const spokenDigitRule = z
  .strictObject({
    pattern: text().describe(
      'A regular expression (its source, without slashes), compiled with the g flag, matching digits that are identifiers. Trusted code run over every line the agent speaks: keep it free of catastrophic backtracking.',
    ),
    spell: z
      .enum(['lead', 'groups'])
      .describe(
        'lead: capture 1 is the words before the digits and capture 2 the digits ("parcel 7101" reads "parcel 7 1 0 1"). groups: the whole match is digit groups separated by spaces, each spelled out with a pause between groups ("4471 8293" reads "4 4 7 1, 8 2 9 3").',
      ),
  })
  .check(checkAlways((value, ctx) => {
    const rule = value as { pattern?: unknown; spell?: unknown };
    if (typeof rule?.pattern !== 'string') return;
    let compiled: RegExp;
    try {
      compiled = new RegExp(rule.pattern, 'g');
    } catch (e) {
      ctx.addIssue({
        code: 'custom',
        path: ['pattern'],
        message: `pattern is not a valid regular expression (${e instanceof Error ? e.message : String(e)})`,
        params: { fix: 'write a regular expression JavaScript accepts, as its source without the surrounding slashes (for example \\d{4,}); in YAML, single quotes keep backslashes as they are' },
      });
      return;
    }
    // `|` joins an always-matching empty alternative, so exec('') succeeds and reports the groups.
    const groups = (new RegExp(`${compiled.source}|`).exec('')?.length ?? 1) - 1;
    if (rule.spell === 'lead' && groups < 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['pattern'],
        message: `a "lead" rule needs two capture groups (the words before the digits, then the digits), and this pattern has ${groups}`,
        params: { fix: 'wrap the words before the digits and the digits in parentheses, as in (parcel )(\\d{4,}); or use spell: groups, which needs no capture groups' },
      });
    }
  }))
  .describe('One rule for how identifier digits are spelled out for text-to-speech on the wire. Only what goes out is rewritten: the session text, the trace and the manifest keep the readable form.');

/** A speech recognizer's provider or model, in the carrier's own names. */
const recognizerName = () =>
  matching(RECOGNIZER_NAME, 'is not a recognizer name: it must start with a letter or digit and use only letters, digits, dots, hyphens and underscores', 'write the name as the carrier\'s documentation spells it, for example "Deepgram" or "nova-3-general"');

/** One carrier's speech recognizer for a locale (voice.locales.<tag>.recognition.<provider>). */
const recognition = z
  .strictObject({
    provider: recognizerName().optional().describe('The speech recognition provider, as the carrier names it (Twilio: Deepgram or Google; Telnyx: deepgram, google or telnyx). Twilio\'s transcriptionProvider, Telnyx\'s transcriptionProvider.'),
    model: recognizerName().optional().describe('The provider\'s speech model (Twilio\'s speechModel: nova-3-general, telephony; Telnyx takes one on <Language> only). Left out, the provider\'s default.'),
  })
  .describe('The speech recognizer on one carrier. A field left out is the carrier\'s default, never the deployment\'s; {} asks for the carrier\'s default recognizer.');

/** A Twilio voice with its TTS provider (voice.locales.<tag>.voices.twilio), so it does not depend on the deployment's TTS_PROVIDER. */
const twilioVoice = z
  .strictObject({
    voice: text().describe('The voice, as Twilio names it for that provider (Google: es-US-Neural2-A; Amazon: Lupe-Neural).'),
    provider: z.enum(TWILIO_TTS_PROVIDERS).describe('Twilio\'s TTS provider for the voice (its ttsProvider): Google, Amazon or ElevenLabs.'),
  })
  .describe('A Twilio voice that names its TTS provider. A voice written as a name alone takes the deployment\'s TTS_PROVIDER, or Twilio\'s default provider when that is unset.');

/** Words the voice says another way, with their respellings (channel/pronounce.ts): voice.pronounce, and a locale's own. */
const pronounceList = () =>
  z
    .record(z.string().min(1).max(PRONOUNCE_MAX_WORD), z.string())
    .check(checkAlways((value, ctx) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
      const strings = Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
      for (const p of pronounceProblems(strings)) ctx.addIssue({ code: 'custom', path: [p.word], message: p.message, params: { fix: p.fix } });
    }));

/** One locale's speech settings on the phone (voice.locales.<tag>). */
const voiceLocale = z
  .strictObject({
    tts: localeTag().optional().describe('The language the voice speaks this locale in (a language tag). Default: the locale\'s tag.'),
    transcription: localeTag().optional().describe('The language speech is recognized in for this locale (a language tag). Default: the locale\'s tag.'),
    voices: z
      .record(identifier(), z.union([text(), twilioVoice]))
      .optional()
      .describe(
        'The voice for this locale, by voice provider id (twilio, telnyx): each carrier names its voices its own way. It wins over the deployment\'s voice for that carrier (TTS_VOICE, TELNYX_VOICE). Default: the deployment\'s voice for the default locale, else the carrier\'s default voice. ' +
          'A voice is a name; a Twilio voice may also be { voice, provider }, so it does not depend on the deployment\'s TTS_PROVIDER.',
      ),
    hints: z.array(text()).optional().describe('Words the speech recognizer should expect in this locale, in place of voice.hints.'),
    pronounce: pronounceList()
      .optional()
      .describe('Words the voice says another way in this locale, in place of voice.pronounce: each word (matched whole, whatever its case) with the respelling the voice is sent. {} respells nothing in this locale.'),
    recognition: z
      .record(identifier(), recognition)
      .optional()
      .describe(
        'The speech recognizer for this locale, by voice provider id (twilio, telnyx). It wins over the deployment\'s (TWILIO_TRANSCRIPTION_PROVIDER and TWILIO_SPEECH_MODEL, TELNYX_TRANSCRIPTION_PROVIDER). ' +
          'Default: the deployment\'s for the default locale, else the carrier\'s default, since a deployment\'s model may hear one language only (Twilio\'s default, Deepgram flux, is for English).',
      ),
  })
  .describe('How the phone speaks and hears one locale.');

const voice = z
  .strictObject({
    hints: z.array(text()).optional().describe('Words the speech recognizer should expect (ConversationRelay hints), before the engine\'s number words.'),
    spokenDigits: z.array(spokenDigitRule).optional().describe('How digits that are identifiers are spelled out for text-to-speech, tried in order.'),
    pronounce: pronounceList()
      .optional()
      .describe(
        `Words the text-to-speech voice says wrong, each with a respelling it says right (Alder: All-der). A word is matched whole, whatever its case, in every line the agent speaks, a value the caller gave included; only the text sent to the voice changes, never the trace, the console or a chat. A respelling is plain letters (no SSML: not every carrier reads it), at most ${PRONOUNCE_MAX_SAY} characters; a word at most ${PRONOUNCE_MAX_WORD}.`,
      ),
    continueWithinMs: z
      .number()
      .int()
      .min(0)
      .max(MAX_CONTINUE_WITHIN_MS)
      .optional()
      .describe(
        `A caller who had not finished: when the agent's reply to a final prompt is interrupted within this many milliseconds of starting, the next final prompt continues the one before it, and the turn runs on the words joined, as if they had been said at once, with the cut-off reply undone. 0 turns it off. Default ${DEFAULT_CONTINUE_WITHIN_MS}.`,
      ),
    numbers: z
      .record(
        matching(
          NUMBER_LOCALE_KEY,
          'must be an E.164 number like +15555550142, or env.<NAME>',
          'write env.<NAME> (capitals, digits and underscores) and set the variable to the number in the app\'s settings (.env), or write the number with + and the country code, in quotes ("+15555550142")',
        ),
        localeTag(),
      )
      .optional()
      .describe(
        'The locale a call starts in, by the number called: env.<NAME>, the number in the app\'s settings (.env) as every other number in its YAML, or the number written out (E.164, in quotes). ' +
          'Chosen as the call starts, before any route. The number called is compared as a called condition compares it. A number not listed starts in the app\'s default locale. Each locale must be one of the app\'s.',
      ),
    locales: z
      .record(localeTag(), voiceLocale)
      .optional()
      .describe('Per-locale speech settings for the phone, keyed by the app\'s locale tags: the languages the voice speaks and hears, a voice per carrier, recognition hints. A locale not listed speaks and hears its own tag with the carrier\'s default voice.'),
    twilio: z
      .strictObject({
        interruptSensitivity: z
          .enum(['low', 'medium', 'high'])
          .optional()
          .describe('How readily the caller\'s speech interrupts a line (ConversationRelay interruptSensitivity): low needs confident, longer speech, so room noise on a speakerphone does not cut a line off. Default "low".'),
        ignoreBackchannel: z
          .boolean()
          .optional()
          .describe('Whether a backchannel ("uh-huh", "okay") is kept from interrupting a line (ConversationRelay ignoreBackchannel). Default true.'),
        reportInputDuringAgentSpeech: z
          .enum(['none', 'dtmf', 'speech', 'any'])
          .optional()
          .describe('What the caller says or keys while a line plays that Twilio reports (ConversationRelay reportInputDuringAgentSpeech). Default "any".'),
        deepgramSmartFormat: z
          .boolean()
          .optional()
          .describe('Whether Deepgram formats what it hears (numbers as digits, punctuation) before the engine reads it (ConversationRelay deepgramSmartFormat). Default false: the engine reads digits from the words.'),
      })
      .optional()
      .describe('Twilio\'s ConversationRelay settings for the app\'s calls, each written on its start document; a setting left out keeps the value the document always had.'),
  })
  .describe("The phone line's speech settings for the app.");

const handoff = z
  .strictObject({
    recipient: text().optional().describe('Who the note is for, the person the call is handed to, in the summary model\'s instructions: "a human <this> agent" (for example "delivery contact-center"). Default "contact-center".'),
    levels: z
      .record(matching(/^[0-9]+$/, 'is not a level number', 'key the line by the level number: 0, 1 or 2'), text())
      .optional()
      .describe('The Identity line by the level reached, keyed by level number (0, 1, 2); an app may name its factors. Default "not verified", "level 1", "level 2".'),
    signedIn: textMap().optional().describe('The Identity line for a principal kind that starts the call signed in (for example agent: "signed in as depot staff").'),
    blocked: textMap().optional().describe('A refusal in words by the gate\'s reason (for example scope, already-delivered). Default: the engine\'s neutral words, or the reason as it is.'),
    blockedAs: z
      .record(name(), textMap())
      .optional()
      .describe('For a principal kind that started signed in, its own words for a refusal by reason: principal kind, then reason, then words.'),
    reasons: textMap().optional().describe('Handoff reasons the app adds, in words (for example staff-filing).'),
    created: z
      .strictObject({
        type: name().describe('The audit row type that records a created record (for example "report_created").'),
        field: name().describe("The row's detail field that carries the record (for example \"report\")."),
        key: name().describe('The key the records are listed under in the note\'s facts (for example "reportsFiled").'),
      })
      .optional()
      .describe("Records the call created, read from an audit row's detail field and listed in the facts under `key`."),
    data: z
      .strictObject({
        slots: z
          .union([z.enum(['all', 'none']), unique(identifier(), 'slot')])
          .optional()
          .describe('Which collected slots a transfer hands over: "all" (the default), "none", or a list of slot ids.'),
        send: z
          .record(identifier(), z.enum(['omit', 'masked', 'as-is']))
          .optional()
          .describe(
            'How a slot goes, by slot id, in place of its default: "omit" (left out), "masked" (as the trace masks it: by its redact setting, or its handoff setting where that is last4 or verified) or "as-is" (its display, in the clear). ' +
              'Default: an identity factor is omitted, a slot with a redact setting goes masked, any other slot as it is. Name a slot "as-is" only when the person taking the call needs it in the clear.',
          ),
        unconfirmed: z
          .enum(['send', 'mark', 'omit'])
          .optional()
          .describe(
            'What goes of a value the caller never confirmed (not confirmed on its own, and not the value they said yes to at a summary since): "send" (the default, sent as any other), ' +
              '"mark" (sent, and the data names it: the end frame\'s unconfirmed list, the console\'s "(not confirmed)", the audit\'s handoff row) or "omit" (left out). An identity factor is never counted.',
          ),
        chat: z
          .enum(['none', 'send'])
          .optional()
          .describe('What a web chat\'s transfer message carries of the collected slots: "none" (the default, the reason and transfer.send.chat only, as before) or "send", the same slots a call\'s transfer sends (as slots, chosen and masked by slots, send and unconfirmed above), for the page\'s own handover.'),
      })
      .optional()
      .describe("What a transfer hands the channel of the collected slots: on a phone call, the relay's end frame, which the carrier holds and posts back on its action callback; on a web chat, nothing unless chat says send. Default: no identity factor, a redacted slot masked, any other slot as it is."),
  })
  .describe("The handoff: the note's words about the app's domain, and what a transfer hands the channel (data). Each field is optional; without one the engine's own neutral words and the safe default are used.");

const criterion = () => z.strictObject({ true: text().describe('The criterion for answering yes.'), false: text().describe('The criterion for answering no.') });

const wording = z
  .strictObject({
    addressee: text().optional().describe('Whom the caller is asking, in the intent question ("What is the caller asking <this> to do?"). Default "this service".'),
    tentative: criterion().optional().describe('The hedge question: true when the hedge is about the request itself, false when it is only about a detail.'),
    confirmsNo: criterion().optional().describe('What a no to a confirmation is (true; for example with a correction in the app\'s own values as its example), and what is not (false).'),
    changeSlot: z
      .strictObject({
        instructions: text().optional().describe("The question's instructions."),
        order: unique(identifier(), 'slot').optional().describe('The slots the question can offer, in its fixed presentation order (kept so the wire order, and any option-order bias in the model\'s answer, stay stable); each offered only when the pending form has it. Without it, the form\'s own slots in its order.'),
        text: textMap(identifier()).optional().describe('Per slot in `order`, the criterion for naming it as the thing to change without its new value. Every slot in `order` needs one.'),
        none: text().optional().describe('The `none` criterion: a new value given rather than a detail named, a plain yes or no, or nothing.'),
      })
      .optional()
      .describe('Which detail of a form just read back the caller names as wrong.'),
    screen: z
      .strictObject({
        instructions: text().describe("The injection screen's one question: its instructions."),
        true: text().describe('What counts as manipulation.'),
        false: text().describe('What counts as ordinary.'),
      })
      .optional()
      .describe('The injection screen, which asks whether the caller is trying to manipulate the agent.'),
  })
  .describe("The engine's own model questions in the app's words. Every string is sent to the model as it is, so a change re-keys a recorded cassette. Each field is optional; without one the engine's neutral words are used.");

const vocabulary = z
  .strictObject({
    id: identifier().describe('The clip id.'),
    text: text().describe('The exact words the clip says.'),
    vars: z.array(identifier()).describe('The prompt variables that, rendered as exactly `text`, play this clip in place of text-to-speech.'),
  })
  .describe('One spoken value that has a recorded clip of its own.');

const promptSettings = z
  .strictObject({
    greetings: z
      .strictObject({
        voice: identifier().optional().describe('The opening line on any channel that speaks. Default "greeting".'),
        chat: identifier().optional().describe('The opening line on a text channel for an anonymous visitor. Default "greeting_chat".'),
        chatSignedIn: identifier().optional().describe('The opening line on a text channel for a signed-in subject (with {first}). Default "greeting_chat_signed_in".'),
        chatDelegate: identifier().optional().describe('The opening line on a text channel for a signed-in delegate (with {first}). Default "greeting_chat_delegate".'),
        offer: identifier().optional().describe('On a call that opens on a proposal (a slot\'s offerAt: greeting), the line said before it, in place of the greeting and its open question. Default "greeting_offer".'),
      })
      .optional()
      .describe("The opening line's prompt ids by case. Each prompt must exist in prompts.yaml."),
    spokenVars: z.array(identifier()).optional().describe('Prompt variables always spoken by text-to-speech, as composed values with no clip (for example the account ID, dates, a parcel number). Each must end its clause in a recorded line.'),
    dataVars: z.array(identifier()).optional().describe("Prompt variables that carry data read from a tool or a knowledge base (for example a parcel's status, a passage's approved answer). A line with one is spoken whole by text-to-speech: never recorded, never split into clips."),
    vocabulary: z.array(vocabulary).optional().describe('The spoken values that need a recorded clip of their own, in recording order (for example each form intent\'s label, then each day part\'s display).'),
    tags: textMap(identifier()).optional().describe('Per-clip voice tags for the clip generator (clip id to tag, for example "[calm]"); the tag syntax is the text-to-speech provider\'s.'),
  })
  .describe('What the app says about its prompts besides their text (which is in prompts.yaml): the opening lines, the variables the clip generator must treat specially, and the clips\' vocabulary and voice tags.');

const callerNumber = z
  .strictObject({
    use: z
      .literal('hint')
      .optional()
      .describe('"hint", as written before the numbers were kept for every app: accepted, and changes nothing. The number the caller is calling from is the call\'s data, read by the app\'s code with callerOf(s), whatever this block says.'),
    called: z.boolean().optional().describe('As written before the number called was kept for every app: accepted, and changes nothing. The number called is read with calledOf(s).'),
    lookup: identifier()
      .optional()
      .describe('A tool called once at call start, before the greeting, through the gate as the caller not yet proven, with the number as its one param, callerNumber. A refusal or a failure is silent; an allowed result goes to the facts (FactsConfig.fromCallerLookup). Its action in policy.yaml decides whether it runs. Nothing is withheld from a caller not yet proven, so what the tool returns reaches the app whole: what to return, and what the lines say of it before identity, is the app\'s call. Default: none.'),
    withheld: z
      .enum(CALLER_WITHHELD_USES)
      .optional()
      .describe('What the engine\'s own features do with a number the caller withheld (*67) that the carrier sent anyway, marked so (Telnyx), or a placeholder Twilio sent in its place: "use" (the default) treats it as any number: offered back by a slot, looked up, held by the gate\'s callerNumber rule, matched by identity.yaml\'s callerId; "ignore" treats the call as one with no number for all of them, honouring the caller\'s choice. The app\'s code reads the number either way (callerOf(s), with withheld: true).'),
  })
  .describe('What the engine does with the number the caller is calling from: the call-start lookup, and whether its features use a number the caller withheld. The number itself, and the number called, are the call\'s data, kept for every app and read with callerOf(s) and calledOf(s); a number is a hint, never identity on its own (an app may let a caller-ID match identify an account, with a knowledge factor that verifies it: identity.yaml callerId).');

const records = z
  .strictObject({
    callerNumber: z
      .enum(['last4', 'keep'])
      .optional()
      .describe('How the trace, the frame log, the console and the server\'s log write the caller\'s number (and their SIP or client address, and a copy the carrier sends under another name): "last4" (the default) by its last four digits, or "keep" whole. "keep" needs the console behind sign-in (CONSOLE_AUTH=token): the server refuses to start with it otherwise. What a transfer sends and what app code reads are never changed by it.'),
    businessNumbers: z
      .enum(['keep', 'last4'])
      .optional()
      .describe('How the records write the business\'s own numbers (the number called, transfer and handoff targets): "keep" (the default) whole, or "last4" by their last four.'),
    callerName: z
      .enum(['redact', 'keep'])
      .optional()
      .describe('How the records write the caller\'s name a carrier sends (CNAM: Twilio\'s CallerName): "redact" (the default), or "keep", which needs CONSOLE_AUTH=token as callerNumber\'s keep does.'),
  })
  .describe('How the records (the trace, the frame log, the console, the server\'s log) write the numbers and the caller\'s name a call came with. Default: the caller\'s number by its last four, the business\'s numbers whole, the caller\'s name redacted.');

const textConsent = z
  .strictObject({
    covers: unique(identifier(), 'slot')
      .min(1, { error: 'names no slot' })
      .describe('The slots the consent stands in for: each offers the number the caller is calling from (a digits slot\'s callerNumber). Granted, each is filled with the caller\'s number, confirmed, with no question of its own, and an offer row (answer: consent) records each use; declined or not answered, each asks its own offer.'),
  })
  .describe('Consent to text for the whole call: asked once, on a call, right after the greeting (greeting_offer, then consent_texts with {last4}, then greet_after_offer), when the caller\'s number is kept and the app\'s callerOffer allows the first slot it covers. A yes is recorded as a consent row (scope: call); the slots it covers then use the caller\'s number without asking again. Never asked on a chat. Before a proposal at the greeting, after the caller-ID question at the greeting. Default: none, and every text offer is asked where it is.');

/** One key of callData: where its value comes from, and how it is recorded. */
const callDataKey = z
  .strictObject({
    from: text()
      .check(checkAlways((value, ctx) => {
        if (typeof value !== 'string' || value === '') return;
        const problem = callDataSourceProblem(value);
        // A warning (a number's own field, a setup field no carrier documents) is pnpm check's to say, never the schema's.
        if (problem !== null && problem.warning !== true) ctx.addIssue({ code: 'custom', message: problem.message, params: { fix: problem.fix } });
      }))
      .describe('Where the value comes from: param.<name>, a custom parameter of the call\'s setup (Twilio <Parameter>, Telnyx custom parameter); setup.<field>, a field of the setup frame (from, to, forwardedFrom, callerName, callType, direction, callStatus, parentCallSid, accountSid, callSid, sessionId, callControlId, callSessionId, callLegId, or a string field a carrier adds, which the wire passes through); webhook.<field>, a field of the carrier\'s answer webhook (for example ForwardedFrom, or SipHeader_<name> on Twilio), which the server echoes into the start document as the custom parameter dw_<key>; chat.<key>, a key of the web chat start message\'s context.'),
    redact: z
      .enum(['last4', 'mask', 'length', 'secret', 'keep'])
      .optional()
      .describe('How the value is recorded in the trace, the console, the frame log and the audit: last4 by its last four characters, mask hidden, length by its length, secret never, keep as it is. Default mask. It changes what is written down, never what a transfer sends (send).'),
    send: z
      .enum(CALL_DATA_SENDS)
      .optional()
      .describe('What a transfer sends of the value (callData.<key> in transfer.send): "as-is" (the default), the value as it came; "masked", as redact records it (a secret key then sends nothing).'),
  })
  .describe('One piece of data the call or chat came with, kept for the app\'s code (callDataOf(s)). A key whose source sent nothing is absent.');


/** A target's number: the environment variable that holds it, never a number written in YAML. */
const envTarget = () =>
  matching(ENV_REFERENCE, 'is not an environment variable: it must be env.<NAME>, the name in capitals, digits and underscores', 'write env.<NAME> and set the variable to an E.164 number or a sip: URI in the server\'s environment (.env); a number is never written in YAML');

const SEND_VALUE = 'reason (the handoff\'s reason), form (the form the transfer was chosen on), callData.<key> (sent as it came, or as its redact records it where the key says send: masked), callerNumber and calledNumber (the number the caller is calling from and the number called, whole), slot.<id> (sent as handoff.data sends it), or anything else, a constant sent as written';

/** What goes with a transfer. */
const transferSend = z
  .strictObject({
    headers: z
      .record(matching(HEADER_NAME, 'is not a header a transfer may send: an X- name (letters, digits and hyphens) or User-to-User', 'name an X- header (X-Account-Ref) or User-to-User'), text())
      .optional()
      .describe(`SIP headers on a transfer to a sip: target, by name, each value ${SEND_VALUE}. A phone number carries no headers: they are left out, and the frame log says which. At most 1024 characters in all once encoded; what would go over is left out.`),
    chat: z
      .record(matching(CHAT_DATA_KEY, 'is not a plain word', 'name the key with letters, digits and underscores, starting with a letter'), text())
      .optional()
      .describe(`What a web chat's transfer message carries (its data, handed to the page's onTransfer), by key, each value ${SEND_VALUE}. Absent: the message carries only the reason, as before.`),
  })
  .describe('What goes with the transfer: SIP headers on a call to a sip: target, and data on a web chat\'s transfer message.');

/** One transfer target. */
const transferRule = z
  .strictObject({
    when: whenSchema.optional().describe('When the rule is taken: one condition, or a list that must all hold (reason, form, callData with is, in, notIn or present). A rule without when is always taken. A callData key read from a web chat\'s context (chat.<key>) is what the visitor\'s page sent: routing on it is routing on the visitor\'s own word.'),
    to: envTarget().describe('The environment variable holding the number dialed: an E.164 number or a sip: URI, read as the server starts.'),
    send: transferSend.optional().describe('What goes with a transfer to this target, merged over the top-level send (a name written here wins).'),
  })
  .describe('One transfer target: taken when its conditions all hold, the first such in order.');

const transfer = z
  .strictObject({
    targets: z.array(transferRule).optional().describe('The targets, tried in order: the first whose conditions all hold is taken. The order is the app\'s; the most specific first (callData, then form, then reason) reads best. Default: none, every handoff goes to default.'),
    default: envTarget().describe('Where a handoff goes when no target is taken, and where the server sends a call it puts through with no handoff decision (a lost connection, a server stopping). Usually env.HANDOFF_NUMBER.'),
    send: transferSend.optional(),
  })
  .describe('Where a handoff goes and what goes with it: ordered targets on the handoff\'s reason, the form and the call data, each an environment variable holding an E.164 number or a sip: URI, and the SIP headers (or a web chat\'s data) sent with it. Without it, every handoff dials HANDOFF_NUMBER and sends nothing more.');

/** A weekly schedule: day names or ranges to lists of HH:MM-HH:MM. */
const weekly = z
  .record(z.string(), z.array(z.string()))
  .describe('The days the line is open and when: each key a day (mon, tue, wed, thu, fri, sat, sun) or a range of two (mon-fri; fri-mon goes round the week), each value a list of HH:MM-HH:MM ranges in 24-hour time. A range whose end is before its start runs overnight into the next day; 24:00 ends a range at midnight. A day no key names is closed.');
const closedDates = z
  .array(z.string())
  .describe('Dates the line is closed all day, YYYY-MM-DD (holidays). A date closes the hours that start on it: a range the day before that runs overnight runs to its end.');

const namedSchedule = z
  .strictObject({
    timezone: z.string().optional().describe('An IANA time zone; default the default schedule\'s.'),
    weekly,
    closed: closedDates.optional().describe('Dates this schedule is closed, YYYY-MM-DD; default the default schedule\'s (write [] for none).'),
  })
  .describe('A schedule of its own (a department\'s), read by a condition that names it: { hours: open, schedule: <name> }.');

const hours = z
  .strictObject({
    timezone: z.string().describe('The IANA time zone the hours are kept in, for example America/New_York. Daylight saving is the zone\'s.'),
    weekly,
    closed: closedDates.optional(),
    schedules: z.record(z.string(), namedSchedule).optional().describe('Schedules by name, where the app needs more than one (a billing desk, a night line), each read by { hours: open, schedule: <name> }.'),
  })
  // The time zone, the days, the ranges and the dates are core/hours.ts's to read, said once.
  .check(checkAlways((value, ctx) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    for (const p of hoursProblems(value as never)) ctx.addIssue({ code: 'custom', path: [...p.path], message: p.message, params: { fix: p.fix } });
  }))
  .describe('Business hours: when the line is open, read by the hours condition of a route (routes.yaml) or a transfer target ({ hours: closed }, { hours: open, schedule: billing }), at the time of the call. Default: none, and an hours condition never holds.');

const onStart = z
  .strictObject({
    calls: unique(identifier(), 'action')
      .optional()
      .describe('The actions (policy.yaml) the start hook calls through the gate, as a form\'s calls: so `pnpm check` knows they are reached. Default: none.'),
  })
  .describe('The app\'s start hook (code.onStart in its code): run once as every call or chat starts, before the call-start lookup and the start routes, through the gate like any app call. It may read the call data, the number called and the clock, and write the facts a route or a line reads. Written here exactly when the code has one.');

export const appSchema = z
  .strictObject({
    id: matching(/^[a-z][a-z0-9_-]*$/, 'is not a valid app id: it must be lowercase, starting with a letter, with only letters, digits, hyphens and underscores', 'rename it, for example "my-app" or "parcels"')
      .describe('The app\'s id (for example "clinic"): lowercase letters, digits, hyphens and underscores. It names the app in the registry and, by default, its browser storage.'),
    locale: localeTag()
      .optional()
      .describe('The default locale of prompts.yaml, as a language tag ("en-US"). Other locales\' prompts go in locale/<tag>/prompts.yaml. Default "en-US".'),
    brand: brand.optional(),
    console: consoleConfig.optional(),
    voice: voice.optional(),
    handoff: handoff.optional(),
    wording: wording.optional(),
    thresholds: z
      .record(identifier(), z.number({ error: 'must be a number' }).finite({ error: 'must be a finite number' }))
      .optional()
      .describe("The app's own named thresholds and their defaults (for example TIME_OF_DAY: 0.6), read where the engine's are. A name may not be one of the engine's. A run's --threshold NAME=VALUE overrides one."),
    carrySlots: unique(identifier(), 'slot').optional().describe("Slots that, like identity, outlast the form that filled them (for example the caller's own name and birthday). Every other slot of a form is emptied as it closes. Shorthand for listen: call on each (slots.yaml): a value said outside a form is kept too. A carried value pre-fills the next form that has the slot, so give a form that writes from one a summary."),
    unsureIntent: z
      .enum(['confirm', 'no-match'])
      .optional()
      .describe(
        'What an intent the model is unsure of gets, for every intent that does not say (its own unsure: in intents.yaml). Outside a form, a reading from INTENT_EXPLICIT (0.4) up to INTENT_IMPLICIT (0.6) is ' +
          '"confirm": asked about ("Just to check, do you want to ...?"), or "no-match": taken as no match (the no-match line, counted, as a reading below the band). A form intent, an informational one and done alike. Default "confirm".',
      ),
    changeSlotWithValue: z
      .enum(['set-aside', 'decides'])
      .optional()
      .describe(
        'At a form\'s summary, what the change question\'s reading (wording.changeSlot: a detail named as wrong without its new value) does when the same turn gives one of the form\'s slots a value it does not already hold. ' +
          '"set-aside": the words contradict the reading, so it decides nothing and the turn goes as it would without it (a no with a correction: the value is applied and the summary read again). "decides": the reading decides as it would alone, reopening the detail named unless the turn gives that detail its new value. Default "set-aside".',
      ),
    questionAtSummary: z
      .enum(['aside', 'summary'])
      .optional()
      .describe(
        'At a form\'s summary, what a question gets when the intent read (at INTENT_ROUTE, 0.7, or more) is a form that answers from the knowledge base as an aside or an informational intent, and the model reads the turn as answering the summary. ' +
          '"aside": the question is answered (the knowledge answer or the informational line, through the gate as always), nothing is written, and the summary is asked again. "summary": the turn is the summary\'s, as the model read it (the question goes unanswered and the summary is asked again). Default "aside".',
      ),
    frustration: z
      .strictObject({
        forms: unique(identifier(), 'form')
          .min(1, { error: 'must name at least one form' })
          .optional()
          .describe('The forms in which the frustration ladder runs: the acknowledgement (ack_frustration), then a person offered (offer_transfer), then a person (handoff_frustrated), while one of them is open or set aside for an aside, or, with no form open, on a turn whose intent is one of them ("this is ridiculous, I just want to know about my claim"), or right after one of them (after). On every other turn the caller\'s tone is not counted, and is acknowledged only (elsewhere); a person is still theirs for the asking. Default: every turn.'),
        after: z
          .enum(['count', 'ignore'])
          .optional()
          .describe('With forms: whether frustration right after one of them counts. "count": with no form open, while the call\'s most recent task was one of them (it completed, was refused or ended) and the turn asks for no other task, the ladder runs as it would inside it, until the caller starts another task (a form, or an informational intent with an answer). "ignore": it runs only while one is open or set aside, or on a turn that asks for one. Default "count".'),
        elsewhere: z
          .enum(['acknowledge', 'ignore'])
          .optional()
          .describe('With forms: what a turn read as high frustration gets where the ladder does not run. "acknowledge": the acknowledgement (ack_frustration) before what the turn says, never counted toward the offer of a person. "ignore": nothing. Mild frustration gets nothing either way. Default "acknowledge".'),
        miss: z
          .enum(['ignore', 'count'])
          .optional()
          .describe('What a turn whose frustration is acknowledged (ack_frustration: the ladder\'s first rung, or the acknowledgement where the ladder does not run) is when it would otherwise be a miss: no request heard, no value for the question asked ("this is ridiculous"). "ignore": not a miss, since the frustration was caught: the acknowledgement, then the question the caller was on asked again as it stands (the opening question, "anything else?" where that was it, the slot\'s own question, the summary or the offer), never the miss line, and no attempt counted toward the keypad menu or a person; from the second such turn in a row at the same question each counts as a miss again (after the acknowledgement, with the plain question, the keypad line or the end the ladder reaches, never the miss line), so the escape still comes. "count": the miss line after the acknowledgement, and the miss counted. A turn that also makes a request or gives a value is the same either way. Default "ignore".'),
      })
      .optional()
      .describe('Where the frustration ladder runs, and whether a turn whose frustration is acknowledged is a miss. Default: on every turn, in every form and outside one, and never a miss.'),
    anythingElseSilence: z
      .enum(['repeat', 'opener', 'goodbye'])
      .optional()
      .describe(
        'What a caller who says nothing after "anything else?" (the anything_else line, said when a form is done) hears when the no-input wait runs out. ' +
          '"repeat": the no_input line and "anything else?" again. "opener": the no_input line and the opening question (ask_intent). "goodbye": the no_input line and the goodbye, ending the call as done does. ' +
          'With repeat and opener a further silence walks the intent ladder as at the opening (the keypad menu, then a person). Default "repeat".',
      ),
    ackIntent: z
      .strictObject({
        repeat: z
          .enum(['say', 'skip'])
          .optional()
          .describe(
            'What a request the call has already acknowledged gets when the caller makes it again (a second coverage question after the first was answered): "say", the acknowledgement again; "skip", none: the call goes straight to the form\'s first question, or its answer. ' +
              'A request is acknowledged once it is started with ack_intent, or named in ack_intent_then or ack_queued. Default "say".',
          ),
      })
      .optional()
      .describe('The acknowledgement a request starts with (the ack_intent line, "Sure, I can help you {intentLabel}."): whether a request made again in the same call hears it again. Its other wordings, said in turn, are the line\'s `variants` in prompts.yaml. Default: said every time.'),
    callerNumber: callerNumber.optional(),
    records: records.optional(),
    textConsent: textConsent.optional(),
    callData: z
      .record(identifier(), callDataKey)
      .optional()
      .describe('The data a call or chat came with that the app may read, by key: a custom parameter of the setup, a field of the setup frame or of the answer webhook, or the web chat\'s page context. Only the keys named here are kept, each recorded as its redact says; app code reads them with callDataOf(s), and the model never sees them unless callerState passes one. Default: none.'),
    startParameters: z
      .record(identifier(), matching(ENV_REFERENCE, 'is not an environment variable: it must be env.<NAME>, the name in capitals, digits and underscores', 'write env.<NAME> and set the variable in the server\'s environment (.env); a value is never written in YAML'))
      .check(checkAlways((value, ctx) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
        for (const name of Object.keys(value)) {
          if (name === 'locale') ctx.addIssue({ code: 'custom', path: [name], message: 'the custom parameter "locale" is the engine\'s own (the language a call starts in)', params: { fix: 'rename the parameter' } });
          else if (name === HOST_APP_PARAMETER) ctx.addIssue({ code: 'custom', path: [name], message: `the custom parameter "${HOST_APP_PARAMETER}" is the engine's own (the app a call to a host's number reached)`, params: { fix: 'rename the parameter' } });
          else if (name === WITHHELD_PARAMETER) ctx.addIssue({ code: 'custom', path: [name], message: `the custom parameter "${WITHHELD_PARAMETER}" is the engine's own (a call whose caller withheld their number)`, params: { fix: 'rename the parameter' } });
          else if (name === ATTESTATION_PARAMETER) ctx.addIssue({ code: 'custom', path: [name], message: `the custom parameter "${ATTESTATION_PARAMETER}" is the engine's own (the STIR/SHAKEN attestation of the caller's number)`, params: { fix: 'rename the parameter' } });
          else if (name.startsWith(WEBHOOK_PARAMETER_PREFIX)) ctx.addIssue({ code: 'custom', path: [name], message: `custom parameters named "${WEBHOOK_PARAMETER_PREFIX}..." are the server's echoes of webhook fields (callData's webhook.<field>)`, params: { fix: 'rename the parameter' } });
        }
      }))
      .optional()
      .describe('Custom parameters the server writes into every start document, by name, each value the environment variable that holds it (env.<NAME>), read as the server starts; it refuses to start when one is unset. For a call placed from the app\'s own systems through the carrier, which hands them back on the setup. Default: none.'),
    transfer: transfer.optional(),
    hours: hours.optional(),
    onStart: onStart.optional(),
    fixtures: z
      .strictObject({
        dir: matching(
          FIXTURES_DIR,
          'is not a folder inside the package: it must be a relative path, with no ".." and not starting with "/", "\\" or a drive letter',
          'write the folder relative to the package root, for example "fixtures"',
        ).describe("The directory, relative to the app's package root (the folder its commands run in), holding corpus.jsonl, scenarios/, expected/ and recorded/<model>.jsonl. It must stay inside the package: no absolute path, no \"..\"."),
      })
      .optional()
      .describe("Where the app's regression fixtures live, for the harness, the stubs and the clients that read them."),
    testing: z
      .strictObject({
        adversarial: z
          .enum(['on', 'off'])
          .optional()
          .describe(
            'The adversarial suite (dialogwright/testing adversarialSuite), generated from the app: announced injections, relationships claimed and not proven, off-scope requests, codes said aloud or never sent, and hostile replies from every tool and service, each checked by properties over its run. "on" adds it to the regression: run on every stub regression, a failed case failing the run; with a recording, a case the recording has no answer for yet is listed as not yet recorded, and recorded with the app\'s next --client record. Default "off".',
          ),
      })
      .optional()
      .describe("What the app's regression runs beside its corpus and scripted calls."),
    prompts: promptSettings.optional(),
  })
  .describe('app.yaml: who the app is and how it presents itself.');

export type AppYaml = z.infer<typeof appSchema>;
export type ConsoleFactYaml = z.infer<typeof consoleFact>;
