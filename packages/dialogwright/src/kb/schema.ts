import { z } from 'zod';
import { checkAlways, identifier, matching, text, unique } from '../define/schema/common';

/**
 * The files of an app's knowledge base, the optional `kb/` folder (./folder.ts reads it):
 *
 *   kb/kb.yaml                          the settings: the gated action that resolves a passage, the applies domain, ...
 *   kb/topics.yaml                      the topics: title, keywords, example questions, risk, account line
 *   kb/passages/<id>.yaml               one approved answer each, in the app's default locale
 *   kb/sources/<doc>.yaml               the source documents' text by section, which approvals hash
 *   kb/locale/<tag>/topics.yaml         a locale's titles, keywords and example questions
 *   kb/locale/<tag>/passages/<id>.yaml  a locale's passages (usually translations of the default's)
 *   kb/pending/<id>.yaml                drafts waiting for review: never loaded at run time (pnpm kb:approve moves one into passages/)
 *   kb/pending/topics.yaml              topics the drafts propose, as topics.yaml has them: never loaded (pnpm kb:review accepts one into topics.yaml)
 *   kb/rejected/<id>.yaml               drafts a reviewer rejected, with who, when and why: never loaded
 *   kb/approvals.jsonl                  every approval, one JSON line each, appended by pnpm kb:approve (or by an app's
 *                                       migration script, `from: migration`, ./log.ts ApprovalLogLine) and never rewritten;
 *                                       read as data, so check holds each approval to its line
 *
 * The zod schemas here are the source of truth; the JSON Schemas under packages/dialogwright/schemas
 * (kb-*.schema.json) are generated from them (define/schema/json.ts).
 */

/** A passage's or a source document's id: its file name without .yaml. */
export const KB_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** An ISO calendar date, as YAML 1.2 core reads an unquoted 2026-01-01: a string. */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The longest answer a passage may have when kb.yaml does not say: about what is said in one breath. */
export const DEFAULT_MAX_ANSWER_CHARS = 400;

/** How many topics retrieval nominates at most when kb.yaml does not say. */
export const DEFAULT_RETRIEVAL_CAP = 8;

/** How many sections of approved documents retrieval nominates at most, unless kb.yaml's documents.cap says. */
export const DEFAULT_SECTIONS_CAP = 4;

/** The most kb.yaml's documents.cap may be. */
export const MAX_SECTIONS_CAP = 8;

/**
 * The most sections a turn may offer: the cap's most, and with follow-ups (documents.followUps) half as many
 * again beside a question's own (kb/sections.ts nominate). Each is a yes-or-no the topic slot asks.
 */
export const MAX_SECTIONS_OFFERED = MAX_SECTIONS_CAP + Math.floor(MAX_SECTIONS_CAP / 2);

/** A SHA-256, 64 lowercase hex characters. */
const sha256 = () => matching(/^[0-9a-f]{64}$/, 'is not a SHA-256 hash: it must be 64 lowercase hex characters', 'leave the hashes to pnpm kb:approve, which writes them');

/** A real calendar date in ISO form (2026-01-31; not 2026-02-30). */
export const isoDate = () =>
  matching(ISO_DATE, 'is not a date in the form YYYY-MM-DD', 'write the date as YYYY-MM-DD, for example 2026-01-01').check(
    checkAlways((value, ctx) => {
      if (typeof value !== 'string' || !ISO_DATE.test(value)) return;
      const d = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
        ctx.addIssue({ code: 'custom', path: [], message: `${value} is not a day of the calendar`, params: { fix: 'write a day that exists, for example 2026-02-28' } });
      }
    }),
  );

const fileId = () => matching(KB_FILE_ID, 'is not a valid id: it must start with a letter or digit and use only letters, digits, underscores, hyphens and dots', 'rename it using only letters, digits, underscores, hyphens and dots (for example "opening-hours-2026"), and the file to match');

/** A value of the applies domain: a plain word or code. */
const domainValue = () => matching(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'is not a valid value: it must start with a letter or digit and use only letters, digits, underscores, hyphens and dots', 'write the value as a plain word or code, for example "adult"');

// ---------------------------------------------------------------------------------------------
// kb.yaml
// ---------------------------------------------------------------------------------------------

export const kbSettingsSchema = z
  .strictObject({
    action: identifier().describe('The gated tool that resolves a passage for a caller (it reads the facts the applies domain names, such as the caller\'s plan, from the system of record). It must be a tool with an action in policy.yaml.'),
    applies: z
      .record(identifier(), unique(domainValue(), 'value').min(1, { error: 'must list at least one value' }), { error: 'must be a map from a fact to the values it can take' })
      .default({})
      .describe('The facts a passage can depend on, each with every value it can take (for example card: [adult, junior]). Every topic needs a passage in force for every combination. Default: none, so one passage per topic answers everyone.'),
    localeFallback: z
      .enum(['none', 'default'])
      .default('none')
      .describe('What a caller in another locale hears when a topic has no passage in their locale. none: nothing (the answer is unavailable and a person is offered), which fails closed for regulated text. default: the default locale\'s passage. Default none.'),
    maxAnswerChars: z
      .number({ error: 'must be a number' })
      .int({ error: 'must be a whole number' })
      .min(40, { error: 'must be at least 40' })
      .max(2000, { error: 'must be at most 2000' })
      .default(DEFAULT_MAX_ANSWER_CHARS)
      .describe(`The longest answer a passage may have, in characters: an answer is spoken, so it is short. Default ${DEFAULT_MAX_ANSWER_CHARS}.`),
    retrieval: z
      .strictObject({
        cap: z.number({ error: 'must be a number' }).int({ error: 'must be a whole number' }).min(1, { error: 'must be at least 1' }).max(32, { error: 'must be at most 32' }).default(DEFAULT_RETRIEVAL_CAP).describe(`How many topics retrieval nominates at most. Default ${DEFAULT_RETRIEVAL_CAP}.`),
        floor: z.number({ error: 'must be a number' }).min(0, { error: 'must be between 0 and 1' }).max(1, { error: 'must be between 0 and 1' }).optional().describe('The cosine similarity below which a topic found by its meaning (dense retrieval) is not nominated; a keyword match always counts. Default: the embedder\'s own (pnpm kb:bakeoff sweeps it).'),
        embedder: z.string().min(1, { error: 'must not be empty' }).optional().describe('The embedding model that finds topics by meaning beside their keywords (hybrid retrieval): potion-base-8M. pnpm kb:index writes its vectors of the topics\' titles, keywords and example questions to kb/.index/<embedder>.json, and pnpm check holds that file to them. Default: none, so topics are nominated by their keywords alone.'),
      })
      .default({ cap: DEFAULT_RETRIEVAL_CAP })
      .describe('How topics are nominated for a caller\'s words: settings only, read by the retriever.'),
    documents: z
      .strictObject({
        summarize: z.enum(['on', 'off']).default('off').describe('on: where no topic answers a question, the line may answer it from the sections of the documents in kb/sources that a person approved for summarizing (pnpm kb:approve --document), worded by a model from the sections the decision model chose, held to them by the checks and the drift judge. A section a passage cites, and one marked summarize: false, is never summarized. Default off: only topics answer.'),
        cap: z.number({ error: 'must be a number' }).int({ error: 'must be a whole number' }).min(1, { error: 'must be at least 1' }).max(MAX_SECTIONS_CAP, { error: `must be at most ${MAX_SECTIONS_CAP}` }).default(DEFAULT_SECTIONS_CAP).describe(`How many sections retrieval nominates at most, each asked whether it says what the caller asked. Default ${DEFAULT_SECTIONS_CAP}.`),
        floor: z.number({ error: 'must be a number' }).min(0, { error: 'must be between 0 and 1' }).max(1, { error: 'must be between 0 and 1' }).optional().describe('The cosine similarity below which a section found by its meaning is not nominated; a keyword match always counts. Default: retrieval.floor, else the embedder\'s own (pnpm kb:bakeoff --sections sweeps it).'),
        retrieval: z.enum(['hybrid', 'dense']).default('hybrid').describe('How sections are found for a caller\'s words: hybrid (the default), by their keywords and their meaning fused; dense, by their meaning alone (on a long document, keywords on common words can crowd the right section out: measure both with pnpm kb:bakeoff --sections). Dense needs an embedder: retrieval.embedder, or documents.embedder.'),
        embedder: z
          .strictObject({
            onnx: z.string().min(1, { error: 'must not be empty' }).describe('The ONNX sentence-embedding model\'s Hugging Face id, such as Xenova/bge-small-en-v1.5.'),
            revision: matching(/^[0-9a-f]{40}$/, 'is not a commit: it must be 40 lowercase hex characters', 'give the commit of the model\'s repository (a branch such as main moves under a committed index)').describe('The commit of the model\'s repository to load.'),
            pooling: z.enum(['cls', 'mean']).default('cls').describe('How its token vectors become one: the first token\'s (cls, for bge) or their mean. Default cls.'),
            dtype: z.enum(['fp32', 'fp16', 'q8']).default('fp32').describe('Its weights\' precision. Default fp32.'),
          })
          .optional()
          .describe('A contextual embedding model of its own for the sections (an ONNX model, run by the optional package @huggingface/transformers, which the app installs): their vectors are in an index of their own (kb/.index/<model>.json, pnpm kb:index), and the topics keep retrieval.embedder. Opt-in: the package is large, and its vectors can differ in their last digits from one machine to another, which can move a section near the floor in or out of the nominations. Default: the sections are in retrieval.embedder\'s index.'),
        followUps: z
          .enum(['on', 'off'])
          .optional()
          .describe('on: a question is read with the caller\'s earlier one on the call (the last question answered from the knowledge base, or found nothing for), so a follow-up ("what about out of network?") finds and answers what it continues: sections are found for the words alone and for the earlier question with them, merged (no model asked; a question that stands on its own keeps its sections), and the decision model, reading each section, the wording model and the drift judge are each given the earlier question beside it. Default off: each question on its own. Measure it with pnpm kb:bakeoff --sections --follow-ups.'),
        followUpWording: z
          .enum(['always', 'continued', 'never'])
          .optional()
          .describe('With followUps on, when the wording model and the drift judge are given the caller\'s earlier question beside their question. always (the default): every time, so a new question after another may be answered with the earlier one\'s subject too, which the judge then refuses. continued: only where the decision model reads the question as continuing the earlier one ("what about for a family?"), one more yes-or-no in the same request (the topic slot\'s <slot>Continues, at KB_FOLLOW_UP). never: the question alone (sections are still found and read with the earlier question).'),
      })
      .default({ summarize: 'off', cap: DEFAULT_SECTIONS_CAP, retrieval: 'hybrid' })
      .describe('Answers from approved documents, where no topic answers: off by default.'),
  })
  .describe('kb/kb.yaml: the knowledge base\'s settings.');

export type KbSettingsYaml = z.infer<typeof kbSettingsSchema>;

// ---------------------------------------------------------------------------------------------
// topics.yaml and locale/<tag>/topics.yaml
// ---------------------------------------------------------------------------------------------

const accountLine = z
  .strictObject({
    text: text().describe('The line said after the answer, from the caller\'s own data: its variables ({balance}) are fields of the tool\'s result, which the tool declares (ToolDef.fields).'),
    from: identifier().describe('The tool that reads the caller\'s data, a gated read with its own action in policy.yaml. When the gate refuses it, or it finds nothing, the answer is said without this line.'),
  })
  .describe('A line from the caller\'s own data, said after the approved answer.');

const topic = z
  .strictObject({
    title: text().describe('The topic in a few words, as a caller would recognise it ("Opening hours"). Retrieval reads it, and the topic question offers it.'),
    keywords: unique(text(), 'keyword').optional().describe('Words and phrases that name the topic exactly (codes, product names). Retrieval matches them as phrases.'),
    asks: unique(text(), 'question').optional().describe('Example questions a caller asks about the topic, in their words. Retrieval reads them, and the paraphrase tests start from them.'),
    risk: z.enum(['regulated', 'low']).default('regulated').describe('regulated: only an approved passage is ever said, word for word. low: where the form\'s answer line words its answer (prompts.yaml generate: { answer: { from: answer, goal } }), a model may word the approved passage for the caller\'s question, held to it by the checks and the drift judge, and the passage is said whenever one fails. Which topics are low risk is the app designer\'s call. Default regulated.'),
    accountLine: accountLine.optional(),
  })
  .describe('One topic of the knowledge base.');

export const kbTopicsSchema = z
  .record(identifier(), topic, { error: 'must be a map from topic id to the topic' })
  .describe('kb/topics.yaml: the topics callers ask about, by id.');

export type KbTopicsYaml = z.infer<typeof kbTopicsSchema>;

export const kbGlossarySchema = z
  .record(text(), text(), { error: 'must be a map from a term to the words said in its place' })
  .describe('kb/glossary.yaml: the words documents use that callers would not know, and the words said in their place ("CYD: calendar year deductible"), applied to the sections answered from by summarizing (kb.yaml documents) as a whole word or phrase, its case as written, the longest first. Never to an approved passage, which is said as approved. A document\'s approval covers its sections as replaced, so a change that reaches one withholds it until a person approves it again.');

export type KbGlossaryYaml = z.infer<typeof kbGlossarySchema>;

/** A section's key as kb/sections.yaml names it: its document's id, #, and its id. */
export const SECTION_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]*#.+$/;

const sectionHints = z
  .strictObject({
    asks: unique(text(), 'question').optional().describe('Questions a caller asks that this section answers, in their words ("how much is a generic drug" for a table\'s row that says Tier 1). Retrieval reads them beside the section\'s own text; they are never said, so a document\'s approval does not cover them.'),
    keywords: unique(text(), 'keyword').optional().describe('Words and phrases that name what the section answers exactly. Retrieval matches them as phrases.'),
  })
  .describe('How a section of a document is found: what retrieval reads beside its own text.');

export const kbSectionsSchema = z
  .record(matching(SECTION_KEY, 'is not a section\'s key: it is the document\'s id, #, and the section\'s id (benefit-booklet#claims/how-to-submit-a-claim)', 'name the section as its document in kb/sources names it: <document id>#<section id>'), sectionHints, { error: 'must be a map from a section\'s key to its questions and keywords' })
  .describe('kb/sections.yaml: how the sections of documents approved for summarizing are found (kb.yaml documents), by section: the questions callers ask that each answers, and its keywords. Retrieval reads them; they are never said, so a document\'s approval does not cover them and editing them needs none.');

export type KbSectionsYaml = z.infer<typeof kbSectionsSchema>;

const localeTopic = z
  .strictObject({
    title: text().optional().describe('The topic\'s title in this locale.'),
    keywords: unique(text(), 'keyword').optional().describe('Keywords in this locale.'),
    asks: unique(text(), 'question').optional().describe('Example questions in this locale.'),
    accountLine: z.strictObject({ text: text().describe('The account line in this locale; it reads the same tool, with the same variables, as kb/topics.yaml\'s.') }).optional(),
  })
  .describe('A topic\'s wording in this locale.');

export const kbLocaleTopicsSchema = z
  .record(identifier(), localeTopic, { error: 'must be a map from topic id to its wording in this locale' })
  .describe('kb/locale/<tag>/topics.yaml: the topics\' titles, keywords and example questions in this locale, by topic id (each a topic of kb/topics.yaml).');

export type KbLocaleTopicsYaml = z.infer<typeof kbLocaleTopicsSchema>;

// ---------------------------------------------------------------------------------------------
// passages/<id>.yaml
// ---------------------------------------------------------------------------------------------

const approval = z
  .strictObject({
    owner: text().describe('Who owns the content (a team).'),
    approvedBy: text().describe('Who approved it.'),
    on: isoDate().describe('The day it was approved.'),
    sourceHash: sha256().describe('SHA-256 of the source section\'s text at approval (its words, whitespace collapsed). A changed source makes the passage stale.'),
    hash: sha256().describe('SHA-256 of everything approved: the passage\'s id, locale and version, its topic and the topic\'s title, the answer, applies, effective dates, the source text and the account line. An edit after approval makes it differ.'),
  })
  .describe('Who approved the passage, when, and the hashes of what they approved. Written by pnpm kb:approve, which also logs it in kb/approvals.jsonl; pnpm check refuses an approval with no line there.');

export const kbPassageSchema = z
  .strictObject({
    id: fileId().describe('The passage id, the same as its file name without .yaml.'),
    topic: identifier().describe('The topic it answers (an id in kb/topics.yaml).'),
    version: text().describe('The passage\'s own version ("2026.1"), recorded with every answer.'),
    locale: z.string().min(1, { error: 'must not be empty' }).optional().describe('Its language tag. Default: the app\'s default locale under kb/passages, the folder\'s under kb/locale/<tag>/passages.'),
    applies: z
      .record(identifier(), z.union([domainValue(), unique(domainValue(), 'value').min(1, { error: 'must list at least one value' })]), { error: 'must be a map from a fact in kb.yaml\'s applies to its value or values' })
      .optional()
      .describe('Which callers it answers: for each fact in kb.yaml\'s applies, a value or a list of values. A fact left out means any value. Default: every caller.'),
    effective: z
      .strictObject({
        from: isoDate().describe('The first day it is in force.'),
        to: isoDate().optional().describe('The last day it is in force (inclusive). Default: open-ended.'),
      })
      .describe('The days it is in force, both inclusive.'),
    source: z
      .strictObject({
        document: fileId().describe('The source document: a file name in kb/sources, without .yaml.'),
        section: text().describe('The section of that document the answer is drawn from (a key under its sections).'),
      })
      .describe('Where the answer comes from. Its text is hashed at approval.'),
    answer: text().describe('The approved answer, said word for word: fixed text with no variables, short enough to say in one breath.'),
    approval: approval.optional(),
    translates: fileId().optional().describe('For a passage in another locale, the default-locale passage it translates (same topic).'),
  })
  .describe('kb/passages/<id>.yaml: one approved answer.');

export type KbPassageYaml = z.infer<typeof kbPassageSchema>;

// ---------------------------------------------------------------------------------------------
// pending/<id>.yaml
// ---------------------------------------------------------------------------------------------

export const kbPendingSchema = kbPassageSchema
  .omit({ approval: true })
  .extend({
    drafted: z
      .strictObject({
        by: text().describe('Who or what drafted it: a person, or the drafting tool and its model.'),
        on: isoDate().describe('The day it was drafted.'),
        excerpt: text().optional().describe('The words of the source section the answer is drawn from, quoted exactly. pnpm kb:approve refuses a draft whose excerpt is not in the section word for word.'),
      })
      .describe('Where the draft came from. pnpm kb:approve drops it when it moves the draft into kb/passages.'),
  })
  .describe('kb/pending/<id>.yaml: a draft passage waiting for review. Never read at run time or said; pnpm kb:approve checks it and moves it into kb/passages (or kb/locale/<tag>/passages), with its approval.');

export type KbPendingYaml = z.infer<typeof kbPendingSchema>;

// ---------------------------------------------------------------------------------------------
// sources/<doc>.yaml
// ---------------------------------------------------------------------------------------------

export const kbSourceSchema = z
  .strictObject({
    document: text().describe('The document\'s title, as a person would cite it.'),
    title: text()
      .optional()
      .describe('A person\'s title for the document, in place of the one read from it (document:), which a re-read writes again: kb:ingest and kb:refresh keep this one. Callers hear it, an answer cites it, and its approval holds it. Default: document.'),
    provenance: z
      .strictObject({
        url: text().optional().describe('Where it was read from on the web.'),
        file: text().optional().describe('The file it was read from.'),
        retrieved: isoDate().optional().describe('The day it was read.'),
        crawl: z
          .strictObject({
            start: text().describe('The page the crawl started from.'),
            depth: z.number({ error: 'must be a number' }).int({ error: 'must be a whole number' }).min(0, { error: 'must be 0 or more' }).describe('How many links from the start page it read.'),
            include: z.array(text()).optional().describe('The globs over URL paths it was narrowed to.'),
            allowHosts: z.array(text()).optional().describe('Other hosts it could read.'),
            maxPages: z.number({ error: 'must be a number' }).int({ error: 'must be a whole number' }).min(1, { error: 'must be at least 1' }).optional().describe('The most pages it read.'),
            rateMs: z.number({ error: 'must be a number' }).int({ error: 'must be a whole number' }).min(1, { error: 'must be at least 1' }).optional().describe('The least time between two requests to a host, in milliseconds.'),
          })
          .optional()
          .describe('For a page read by a crawl (pnpm kb:ingest <url>): the crawl\'s settings, which pnpm kb:refresh crawls with again.'),
      })
      .optional()
      .describe('Where the text came from.'),
    summarize: z.literal(false, { error: 'must be false, or left out' }).optional().describe('false: no section of it is ever answered from by summarizing (kb.yaml documents), and it needs no approval for it: for a document that is only the source of passages (a certificate, a policy). Default: it may be summarized once a person approves it for that.'),
    applies: z
      .record(identifier(), z.union([domainValue(), unique(domainValue(), 'value').min(1, { error: 'must list at least one value' })]), { error: 'must be a map from a fact in kb.yaml\'s applies to its value or values' })
      .optional()
      .describe('Which callers an answer summarized from it is for (kb.yaml documents), as a passage\'s applies: for each fact in kb.yaml\'s applies, a value or a list of values. Default: every caller.'),
    approval: z
      .strictObject({
        owner: text().describe('Who owns the content (a team).'),
        approvedBy: text().describe('Who approved it for summarizing.'),
        on: isoDate().describe('The day it was approved.'),
        hash: sha256().describe('SHA-256 of everything approved: the document\'s id, title and applies, and each section\'s id, heading, text and whether it may be summarized. A changed word makes it differ, and the document is withheld until it is approved again.'),
      })
      .optional()
      .describe('Who approved the document for summarizing (kb.yaml documents: on), when, and the hash of what they approved. Written by pnpm kb:approve --document, which also logs it in kb/approvals.jsonl; pnpm check refuses an approval with no line there.'),
    sections: z
      .record(
        text(),
        z.strictObject({
          heading: text().optional().describe('The section\'s heading in the document.'),
          text: text().describe('The section\'s text, as the document has it. Approvals hash it (whitespace collapsed), so a changed word makes its passages stale.'),
          page: z.number({ error: 'must be a number' }).int({ error: 'must be a whole number' }).min(1, { error: 'must be at least 1' }).optional().describe('For a document with pages (a PDF): the page the section starts on. Provenance only: approvals do not hash it.'),
          lastPage: z.number({ error: 'must be a number' }).int({ error: 'must be a whole number' }).min(1, { error: 'must be at least 1' }).optional().describe('For a section that runs on past its first page: the page it ends on. Provenance only.'),
          summarize: z.literal(false, { error: 'must be false, or left out' }).optional().describe('false: never answered from by summarizing (kb.yaml documents), whatever the document\'s approval: for what a document says that should not be said to a caller. Default: summarized where no passage cites it.'),
        }),
        { error: 'must be a map from section id to the section' },
      )
      .describe('The document\'s sections, by id (a number like "3.2" or a short name).'),
  })
  .describe('kb/sources/<doc>.yaml: one source document\'s text by section.');

export type KbSourceYaml = z.infer<typeof kbSourceSchema>;

/** The kinds of kb file, each with its schema and its JSON Schema's name (schemas/<name>.schema.json). */
export const KB_KINDS = {
  kbSettings: { schema: kbSettingsSchema, jsonName: 'kb-settings', title: 'kb/kb.yaml', startsWith: 'the gated action that resolves a passage, for example "action: findPassage"' },
  kbTopics: { schema: kbTopicsSchema, jsonName: 'kb-topics', title: 'kb/topics.yaml', startsWith: 'a topic id and its title, for example "opening_hours: { title: Opening hours }"' },
  kbGlossary: { schema: kbGlossarySchema, jsonName: 'kb-glossary', title: 'kb/glossary.yaml', startsWith: 'a term and the words said in its place, for example "CYD: calendar year deductible"' },
  kbSections: { schema: kbSectionsSchema, jsonName: 'kb-sections', title: 'kb/sections.yaml', startsWith: 'a section\'s key and its questions, for example "benefit-booklet#claims: { asks: [how do I file a claim] }"' },
  kbLocaleTopics: { schema: kbLocaleTopicsSchema, jsonName: 'kb-locale-topics', title: 'kb/locale/<tag>/topics.yaml', startsWith: 'a topic id and its wording in this locale, for example "opening_hours: { title: Horario }"' },
  kbPassage: { schema: kbPassageSchema, jsonName: 'kb-passage', title: 'kb/passages/<id>.yaml', startsWith: '"id:" (the file name), "topic:", "version:", "effective:", "source:" and "answer:"' },
  kbSource: { schema: kbSourceSchema, jsonName: 'kb-source', title: 'kb/sources/<doc>.yaml', startsWith: '"document:" (its title) and "sections:"' },
  kbPending: { schema: kbPendingSchema, jsonName: 'kb-pending', title: 'kb/pending/<id>.yaml', startsWith: 'the passage\'s fields ("id:", "topic:", "version:", "effective:", "source:", "answer:") and "drafted:"' },
} as const;

export type KbKind = keyof typeof KB_KINDS;
