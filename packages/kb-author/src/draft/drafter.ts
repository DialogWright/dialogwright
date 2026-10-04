import type { KbSourceDocument } from 'dialogwright';

/**
 * A drafter proposes passages from a source document: for each answer a caller could be given, the
 * topic it answers (one the knowledge base has, or a new one it proposes), a short spoken answer,
 * and the words of the section that support it, copied exactly. It is pluggable: the Claude adapter
 * (./claude.ts) asks a model through the user's own key; the fake (./fake.ts) answers from fixed
 * rules, for tests. Whatever a drafter returns is only a proposal: kb:draft checks every draft
 * (./validate.ts) and writes the ones that pass to kb/pending, which is never said; a person approves
 * each one in kb:review before it can be.
 */

/** A topic a draft proposes: not in topics.yaml yet, written to kb/pending/topics.yaml until a reviewer accepts it. */
export interface ProposedTopic {
  /** Its id, as topics.yaml would key it: letters, digits and underscores, starting with a letter. */
  id: string;
  /** The topic in a few words, as a caller would recognise it. */
  title: string;
  /** Words and phrases that name it exactly. */
  keywords?: string[];
  /** Example questions a caller asks about it, in their words. */
  asks?: string[];
}

/** One drafted passage. */
export interface Draft {
  /** The topic it answers: an id in topics.yaml, or a new topic proposed. */
  topic: string | ProposedTopic;
  /** The answer, said word for word: one or two short sentences, no variables. */
  answer: string;
  /** The words of the section that support the answer, copied exactly. */
  excerpt: string;
  /** The section of the source it is drawn from (a key under its sections). */
  section: string;
  /** For each fact of kb.yaml's applies, the value or values it answers. Default: every caller. */
  applies?: Record<string, string | string[]>;
  /** The days it is in force. Default: from the day it is drafted, open-ended. */
  effective?: { from: string; to?: string };
}

/** A topic the knowledge base has, as a drafter sees it. */
export interface TopicSummary {
  id: string;
  title: string;
  keywords: readonly string[];
  asks: readonly string[];
}

/** What a drafter is given for one source document. */
export interface DraftRequest {
  /** The source document, with only the sections to draft from. */
  source: KbSourceDocument;
  /** The topics the knowledge base has (and those already proposed), so a draft reuses one where it fits. */
  existingTopics: readonly TopicSummary[];
  /** The language the answers are written in (the app's default locale). */
  locale: string;
  /** The longest an answer may be, in characters (kb.yaml's maxAnswerChars). */
  maxAnswerChars: number;
  /** The facts a passage can depend on, each with its values (kb.yaml's applies). */
  applies: Readonly<Record<string, readonly string[]>>;
  /** What the author wants drafted, in their words (kb:draft --topic-hint). */
  topicHints: readonly string[];
}

/** Something that drafts passages. */
export interface Drafter {
  /** Who drafted, as `drafted.by` records it (the adapter and its model). */
  readonly id: string;
  draft(request: DraftRequest): Promise<Draft[]>;
}

/** A drafter that could not draft (no key, the API refused, an answer that did not parse). */
export class DraftError extends Error {}
