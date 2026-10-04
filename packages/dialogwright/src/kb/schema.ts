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
 *   kb/pending/                         drafts, never loaded
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
    risk: z.enum(['regulated', 'low']).default('regulated').describe('regulated: only an approved passage is ever said. low: a later release may let an app answer the long tail in generated wording grounded in approved passages. Default regulated.'),
    accountLine: accountLine.optional(),
  })
  .describe('One topic of the knowledge base.');

export const kbTopicsSchema = z
  .record(identifier(), topic, { error: 'must be a map from topic id to the topic' })
  .describe('kb/topics.yaml: the topics callers ask about, by id.');

export type KbTopicsYaml = z.infer<typeof kbTopicsSchema>;

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
    hash: sha256().describe('SHA-256 of everything approved: topic, answer, applies, effective dates, the source text and the account line. An edit after approval makes it differ.'),
  })
  .describe('Who approved the passage, when, and the hashes of what they approved. Written by pnpm kb:approve.');

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
// sources/<doc>.yaml
// ---------------------------------------------------------------------------------------------

export const kbSourceSchema = z
  .strictObject({
    document: text().describe('The document\'s title, as a person would cite it.'),
    provenance: z
      .strictObject({
        url: text().optional().describe('Where it was read from on the web.'),
        file: text().optional().describe('The file it was read from.'),
        retrieved: isoDate().optional().describe('The day it was read.'),
      })
      .optional()
      .describe('Where the text came from.'),
    sections: z
      .record(
        text(),
        z.strictObject({
          heading: text().optional().describe('The section\'s heading in the document.'),
          text: text().describe('The section\'s text, as the document has it. Approvals hash it (whitespace collapsed), so a changed word makes its passages stale.'),
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
  kbLocaleTopics: { schema: kbLocaleTopicsSchema, jsonName: 'kb-locale-topics', title: 'kb/locale/<tag>/topics.yaml', startsWith: 'a topic id and its wording in this locale, for example "opening_hours: { title: Horario }"' },
  kbPassage: { schema: kbPassageSchema, jsonName: 'kb-passage', title: 'kb/passages/<id>.yaml', startsWith: '"id:" (the file name), "topic:", "version:", "effective:", "source:" and "answer:"' },
  kbSource: { schema: kbSourceSchema, jsonName: 'kb-source', title: 'kb/sources/<doc>.yaml', startsWith: '"document:" (its title) and "sections:"' },
} as const;

export type KbKind = keyof typeof KB_KINDS;
