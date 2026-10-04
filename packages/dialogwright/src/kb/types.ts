import type { KbSource } from '../core/lifecycle';
import type { KbIndexRead } from './vectorIndex';

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
  /**
   * The vector index of the embedder kb.yaml names (kb/.index/<embedder>.json, ./vectorIndex.ts), as
   * read: present only when kb.yaml names an embedder. `pnpm check` holds it to the topics' texts;
   * the default retriever reads its vectors (./hybrid.ts defaultRetriever).
   */
  readonly index?: KbIndexRead;
}

/** Where a nomination came from: keyword retrieval, dense (embedding) retrieval, or an app's own retriever. */
export type NominationVia = 'keyword' | 'dense' | 'app';

/** A topic retrieval puts forward for the caller's words: its id and title, its score (higher is closer), and how it was found. */
export interface Nomination {
  readonly topic: string;
  readonly title: string;
  readonly score: number;
  readonly via: NominationVia;
}

/** What a retriever is asked: the caller's words this turn, the session's locale, and the day. */
export interface NominateInput {
  readonly text: string;
  readonly locale: string;
  readonly todayIso: string;
}

/**
 * Nominates topics for what a caller said. An app may give its own (App.knowledge.retriever, from
 * its code's `knowledge.retriever`); an app with a kb/ folder that gives none gets the engine's
 * (./hybrid.ts defaultRetriever: hybrid, or keywords alone). runTurn calls it once per turn, before the turn is planned, only
 * when the app has a knowledge base, the turn has words, and a slot that reads nominations
 * (SlotSpec.nominates) is listening; its nominations reach that turn's questions and fill
 * (SlotContext.nominated). It is given a budget (run/retrieve.ts RETRIEVE_BUDGET_MS): one that throws,
 * returns something that is not a list of nominations, or is not back in time nominates nothing, and
 * the turn goes on without it. It must be deterministic (the same words, locale and day, the same
 * nominations, in the same order): its nominations shape the model's request, which a cassette replays by.
 */
export interface Retriever {
  /** Its name in the trace (trace.retrieval.retrieverId). */
  readonly id: string;
  /** The hash of the index it reads, when it has one, recorded with its nominations. */
  readonly indexHash?: string;
  nominate(input: NominateInput): Promise<readonly Nomination[]> | readonly Nomination[];
}

/**
 * A topic as a topic slot offers and says it (TopicCatalog): its id (the label the model chooses and
 * the slot's value), its title in the default locale, and its title in each other locale that gives one.
 */
export interface CatalogTopic {
  readonly id: string;
  readonly title: string;
  /** Its title by locale tag (`{ es: "Horario" }`), for a locale that gives one; the slot says the default title elsewhere. */
  readonly titles?: Readonly<Record<string, string>>;
  /**
   * For an app whose answers are resolved in its own code (CodeKnowledge): the line from the
   * caller's own data said after the topic's answer, read through the gated tool `from` (as a
   * kb/topics.yaml `accountLine`, kb/answer.ts). Its variables are fields of that tool's result,
   * which the tool declares (ToolDef.fields). In the app's default locale; `texts` gives it in
   * another, and a call in a locale without one is answered without it.
   */
  readonly accountLine?: { readonly text: string; readonly from: string; readonly texts?: Readonly<Record<string, string>> };
}

/**
 * The topics an app's knowledge has, in order (kb/topics.yaml's, or the code's), with how many a
 * turn offers (kb.yaml's retrieval.cap): what a topic slot is built with (kb/catalog.ts topicCatalog),
 * to say a topic's title and to know the topics there are.
 */
export interface TopicCatalog {
  readonly topics: readonly CatalogTopic[];
  /** How many nominated topics a turn offers, when the knowledge says (kb.yaml's retrieval.cap). */
  readonly cap?: number;
}

/**
 * An app's knowledge (App.knowledge), in one of two shapes:
 * - a knowledge base (an app folder's kb/, which defineApp loads, or defineKnowledge), and its
 *   retriever: the code's, or the engine's default (./hybrid.ts defaultRetriever), which defineApp
 *   and defineKnowledge set. An App written by hand without one nominates nothing. Its topics are
 *   kb/topics.yaml's.
 * - for an app that resolves its answers in its own code (no kb/): the topics its retriever can
 *   nominate (`topics`, each with its title), and that retriever, which it must give.
 * A topic slot is built with the topics of either (topicCatalog), and runTurn nominates for either.
 */
export type AppKnowledge = KbKnowledge | CodeKnowledge;

/** Knowledge with a knowledge base (an app folder's kb/, or defineKnowledge), and its retriever (the code's, or the engine's default). */
export interface KbKnowledge {
  readonly kb: KnowledgeBase;
  readonly retriever?: Retriever;
  readonly topics?: undefined;
}

/** Knowledge without a knowledge base: the topics the app's own retriever nominates (answers resolved in its own code), and that retriever. */
export interface CodeKnowledge {
  readonly kb?: undefined;
  readonly topics: readonly CatalogTopic[];
  readonly retriever: Retriever;
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

/**
 * Why a knowledge answer is not said: a resolution's reason (KbUnavailable), `no-facts` when the
 * tool could not read the caller's facts from its systems (no such record), or `no-answer` when the
 * resolving tool returned nothing the completion can read (fail closed).
 */
export type KbAnswerUnavailable = KbUnavailable | 'no-facts' | 'no-answer';

/**
 * What a knowledge answer's resolving tool returns (its value, through the gate), and what the
 * knowledge completion (kb/answer.ts kbCompletion) reads: the answer to say word for word with its
 * knowledge record, or why there is none (with the record of a passage withheld, when there was
 * one). kbAnswerTool returns it for an app with a kb/ folder; an app that resolves answers in its
 * own code returns it from its own tool.
 */
export type KbAnswer =
  | { readonly answer: string; readonly source: KbSource }
  | { readonly unavailable: KbAnswerUnavailable | (string & {}); readonly source?: KbSource };
