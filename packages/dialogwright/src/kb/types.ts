/**
 * An app's knowledge base, as the loader builds it from the `kb/` folder (./folder.ts): short,
 * approved passages, each the fixed answer to one topic for some callers on some days, with the
 * source text its approval was taken over. Answers are never generated: a passage is chosen (a
 * topic nominated by retrieval, selected by the decision model), resolved by code for the caller's
 * facts and the day (./resolve.ts), and said word for word.
 */

/** kb/kb.yaml: the knowledge base's settings. */
export interface KbSettings {
  /** The gated tool that resolves a passage (it reads the caller's facts); it has an action in policy.yaml. */
  readonly action: string;
  /** The facts a passage can depend on, each with every value it can take, in the order kb.yaml lists them. */
  readonly applies: Readonly<Record<string, readonly string[]>>;
  /** What a caller in another locale hears when their locale has no passage: nothing (`none`), or the default locale's (`default`). */
  readonly localeFallback: 'none' | 'default';
  /** The longest answer a passage may have, in characters. */
  readonly maxAnswerChars: number;
  /** How topics are nominated: settings the retriever reads. */
  readonly retrieval: { readonly cap: number; readonly floor?: number; readonly embedder?: string };
}

/** A topic's wording in one locale (kb/locale/<tag>/topics.yaml). */
export interface KbTopicWording {
  readonly title?: string;
  readonly keywords: readonly string[];
  readonly asks: readonly string[];
  /** The account line's text in this locale; the tool is the default locale's. */
  readonly accountLineText?: string;
}

/** One topic (kb/topics.yaml). */
export interface KbTopic {
  readonly id: string;
  readonly title: string;
  readonly keywords: readonly string[];
  /** Example questions a caller asks about it. */
  readonly asks: readonly string[];
  readonly risk: 'regulated' | 'low';
  /** A line from the caller's own data, said after the answer, read through the gated tool `from`. */
  readonly accountLine?: { readonly text: string; readonly from: string };
  /** Its wording in the other locales that give any, by language tag. */
  readonly locales: Readonly<Record<string, KbTopicWording>>;
}

/** Whether a passage may be said: approved, and nothing it was approved over has changed since. */
export type KbFreshness =
  /** Approved, and both hashes match what is there now. */
  | 'fresh'
  /** It has no approval. */
  | 'unapproved'
  /** Its source section's text changed since approval (or is gone). */
  | 'source-changed'
  /** The source is as approved, but the passage (or its topic's account line) was edited since. */
  | 'edited';

/** One passage (kb/passages/<id>.yaml, kb/locale/<tag>/passages/<id>.yaml). */
export interface KbPassage {
  readonly id: string;
  readonly topic: string;
  readonly version: string;
  /** Its language tag. */
  readonly locale: string;
  /** The callers it answers: for each fact it depends on, the values it answers (sorted). A fact not here: any value. */
  readonly applies: Readonly<Record<string, readonly string[]>>;
  /** The days it is in force, both inclusive (ISO dates); no `to`: open-ended. */
  readonly effective: { readonly from: string; readonly to?: string };
  /** The source document (a file id in kb/sources) and section it is drawn from. */
  readonly source: { readonly document: string; readonly section: string };
  /** The approved answer, whitespace collapsed: what is said, word for word. */
  readonly answer: string;
  readonly approval?: {
    readonly owner: string;
    readonly approvedBy: string;
    readonly on: string;
    readonly sourceHash: string;
    readonly hash: string;
  };
  /** The default-locale passage this one translates. */
  readonly translates?: string;
  /** Its file, from the app folder (kb/passages/<id>.yaml). */
  readonly file: string;
  /** The hashes of what is there now: of its source section's text (null when the section is missing), and of everything an approval covers. */
  readonly current: { readonly sourceHash: string | null; readonly hash: string };
  /** Whether it may be said: approved, with both hashes matching `current`. */
  readonly freshness: KbFreshness;
}

/** One source document (kb/sources/<doc>.yaml). */
export interface KbSourceDocument {
  /** Its file name without .yaml: what a passage's source.document names. */
  readonly id: string;
  /** Its title. */
  readonly document: string;
  readonly provenance?: { readonly url?: string; readonly file?: string; readonly retrieved?: string };
  readonly sections: Readonly<Record<string, { readonly heading?: string; readonly text: string }>>;
}

/** An app's knowledge base: the `kb/` folder, loaded. */
export interface KnowledgeBase {
  readonly settings: KbSettings;
  /** The app's default locale: kb/passages' and kb/topics.yaml's. */
  readonly defaultLocale: string;
  /** The topics, by id, in kb/topics.yaml's order. */
  readonly topics: Readonly<Record<string, KbTopic>>;
  /** Every passage of every locale, by id, sorted by id. */
  readonly passages: Readonly<Record<string, KbPassage>>;
  /** The source documents, by file id, sorted by id. */
  readonly sources: Readonly<Record<string, KbSourceDocument>>;
}

/** A topic retrieval puts forward for the caller's words, with its score (higher is closer). */
export interface KbNomination {
  readonly topic: string;
  readonly score: number;
}

/**
 * Nominates topics for what a caller said. An app may give its own (App.knowledge.retriever); the
 * turn runs it before planning, only when the app has a knowledge base and a topic slot is listening.
 */
export interface KnowledgeRetriever {
  nominate(input: { readonly text: string; readonly locale: string; readonly todayIso: string }): readonly KbNomination[] | Promise<readonly KbNomination[]>;
}

/** An app's knowledge (App.knowledge): its knowledge base, and the retriever its code gives, if any. */
export interface AppKnowledge {
  readonly kb: KnowledgeBase;
  readonly retriever?: KnowledgeRetriever;
}

/** Why no passage can be said. */
export type KbUnavailable =
  /** The knowledge base has no such topic. */
  | 'unknown-topic'
  /** No passage of the topic answers this caller on this day. */
  | 'not-in-force'
  /** One answers in the default locale, but none in the caller's, and kb.yaml's localeFallback is none. */
  | 'no-translation'
  /** Exactly one answers, but it is not fresh (unapproved, its source changed, or edited since approval): it is withheld. */
  | 'stale'
  /** More than one answers (a knowledge base `check` would refuse). */
  | 'ambiguous';

/** What resolvePassage found: the one passage to say, or why there is none (with the withheld passage, when it is stale). */
export type KbResolution =
  | { readonly passage: KbPassage; readonly fresh: true }
  | { readonly unavailable: KbUnavailable; readonly passage?: KbPassage };
