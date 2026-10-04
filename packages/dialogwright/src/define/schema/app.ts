import { z } from 'zod';
import { checkAlways, identifier, matching, name, text, textMap, unique } from './common';

/**
 * app.yaml: who the app is and how it presents itself. It mirrors the App contract's presentation
 * fields (id, brand, console, voice, handoff, wording, thresholds, carrySlots, unsureIntent, fixtures, and the
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

const voice = z
  .strictObject({
    hints: z.array(text()).optional().describe('Words the speech recognizer should expect (ConversationRelay hints), before the engine\'s number words.'),
    spokenDigits: z.array(spokenDigitRule).optional().describe('How digits that are identifiers are spelled out for text-to-speech, tried in order.'),
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
  })
  .describe("The handoff note's words about the app's domain. Each field is optional; without one the engine's own neutral words are used.");

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
      })
      .optional()
      .describe("The opening line's prompt ids by case. Each prompt must exist in prompts.yaml."),
    spokenVars: z.array(identifier()).optional().describe('Prompt variables always spoken by text-to-speech, as composed values with no clip (for example the account ID, dates, a parcel number). Each must end its clause in a recorded line.'),
    dataVars: z.array(identifier()).optional().describe("Prompt variables that carry data read from a tool or a knowledge base (for example a parcel's status, a passage's approved answer). A line with one is spoken whole by text-to-speech: never recorded, never split into clips."),
    vocabulary: z.array(vocabulary).optional().describe('The spoken values that need a recorded clip of their own, in recording order (for example each form intent\'s label, then each day part\'s display).'),
    tags: textMap(identifier()).optional().describe('Per-clip voice tags for the clip generator (clip id to tag, for example "[calm]"); the tag syntax is the text-to-speech provider\'s.'),
  })
  .describe('What the app says about its prompts besides their text (which is in prompts.yaml): the opening lines, the variables the clip generator must treat specially, and the clips\' vocabulary and voice tags.');

export const appSchema = z
  .strictObject({
    id: matching(/^[a-z][a-z0-9_-]*$/, 'is not a valid app id: it must be lowercase, starting with a letter, with only letters, digits, hyphens and underscores', 'rename it, for example "my-app" or "parcels"')
      .describe('The app\'s id (for example "clinic"): lowercase letters, digits, hyphens and underscores. It names the app in the registry and, by default, its browser storage.'),
    locale: matching(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'is not a language tag like "en-US" or "fr"', 'write a language tag: a lowercase language ("en", "fr") optionally followed by a region ("en-US", "pt-BR")')
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
    prompts: promptSettings.optional(),
  })
  .describe('app.yaml: who the app is and how it presents itself.');

export type AppYaml = z.infer<typeof appSchema>;
export type ConsoleFactYaml = z.infer<typeof consoleFact>;
