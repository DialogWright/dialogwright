/**
 * The package's entry point, and its supported API: what an app imports by name.
 *
 *   import { registerApp, validateApp, isChoice, handoff, type App } from 'dialogwright';
 *
 * Everything an app needs is exported here, grouped below: the app contract, the registry, the
 * channel model and the gate's types; the building blocks an app's hooks use (reading the model's
 * answers, the decisions a completion returns, the date, number and span helpers a slot parses with);
 * the server and the harness launchers; and what an app's own tests and testing hooks use (answer
 * builders, a turn driver, the stubs, the fixtures and the regression pieces). Importing it starts
 * nothing: no server, no registration, no I/O.
 *
 * Three more entries are supported: `dialogwright/testing` (an app's tests: the shadow harness, the
 * slot conformance kit, the policy's goldens and the legacy evaluator they compare the gate with),
 * `dialogwright/slot-kit` (the helpers a slot type is written with) and `dialogwright/policy` (the
 * gate an app's calls go through, compiledPolicyOf, and policy.yaml and identity.yaml for an app
 * that is not a folder: definePolicy, defineIdentity, and their compilers).
 *
 * The package also maps every source file to a subpath, `dialogwright/<dir>/<file>` (package.json
 * "exports" "./*": `src/<dir>/<file>.ts`). Those are the engine's internals: reachable, but not part
 * of the supported API, and free to move or change between versions. An app that wants to keep
 * working across versions imports only from 'dialogwright'. If an app needs something this entry
 * does not export, that is a gap in the API worth raising, not a reason to reach in.
 */

// The app contract: the types an app is written against.
export type * from './core/app/types';
export type * from './core/slots/types';

// The app registry, validation and lookups.
export { registerApp, getApp, defaultAppId, defaultAppOrNull, appOf, resetAppsForTest } from './core/app/registry';
export { validateApp, CONSOLE_ELEMENT_IDS, CONTROL_INTENTS, REQUIRED_CONTROL_INTENTS } from './core/app/validate';
export { formOf, slotSpecOf, toolOf } from './core/app/lookup';
export { intentList, formIntents, isFormIntent, intentLabel, informationalPrompt, informationalIntents, intentCriteria } from './core/app/intents';

// The languages an app speaks (App.locales) and the one a session speaks.
export { DEFAULT_LOCALE, defaultLocaleOf, localesOf, matchLocale, localeOf } from './core/locale';

// The app definition: an app folder's YAML joined with its TypeScript parts into the App above.
export { defineApp, AppDefinitionError, isAppDefinitionError } from './define/defineApp';
export type { AppCode, FormHooks, DefineAppOptions } from './define/defineApp';
export { checkApp } from './define/check';
export { slotsJsonSchema } from './define/schema/json';
export type { CheckOptions } from './define/check';
export { loadAppFolder } from './define/load';
export type { LoadedConfig, LoadResult } from './define/load';
export { formatProblem } from './define/problems';
export type { Problem } from './define/problems';

// The knowledge base (an app folder's kb/, App.knowledge): approved passages, resolved for the
// caller and the day and said word for word; defineKnowledge for an app that is not a folder.
export { defineKnowledge, knowledgeProblems } from './define/defineKnowledge';
export type { DefineKnowledgeOptions, KnowledgeProblemsOptions } from './define/defineKnowledge';
export { loadKnowledgeFolder } from './define/load';
export type { KnowledgeFolder } from './define/load';
export { resolvePassage } from './kb/resolve';
export type { ResolveInput } from './kb/resolve';
export { approvalHashOf, collapseWhitespace, sourceHashOf } from './kb/hash';
export type { ApprovedContent } from './kb/hash';
// Authoring the knowledge base (pnpm kb:approve and kb:status, and the @dialogwright/kb-author tools that
// draft, review and refresh it): approving one passage or draft as the command does, and what waits.
export { APPROVALS_LOG, approveOne, excerptInSource, formatApproveResult, notAPerson, pendingDrafts, placeOf as kbPlaceOf, proposedTopics, readApprovalLog } from './kb/approval';
export type { ApprovalLogLine, ApproveOptions, ApproveResult, KbPlace, PendingDraft, ProposedTopic } from './kb/approval';
export { PENDING_TOPICS_FILE } from './kb/folder';
export { parseKbFile } from './define/load';
export { KB_KINDS } from './kb/schema';
export type { KbKind, KbPassageYaml, KbPendingYaml, KbSourceYaml, KbTopicsYaml } from './kb/schema';
// The knowledge record a turn reports (TurnOut.kb): written to the trace, given to a tool's audit hook, shown on the console.
export { KB_SHORT_HASH, kbAuditRow, kbSourceOf, shortHash } from './kb/record';
export type { KbSourceOptions } from './kb/record';
export type { KbSource } from './core/lifecycle';
export type * from './kb/types';
// Speaking an answer: a form's knowledge completion (forms.yaml `answers:`, or a `complete` hook that
// delegates to kbCompletion), the resolving tool of an app with a kb/ folder, and their lines.
export { KB_ANSWER_PROMPT, KB_ANSWER_VAR, KB_TOPIC_PARAM, KB_UNAVAILABLE_PROMPT, kbAnswerTool, kbCompletion, readKbAnswer } from './kb/answer';
export type { KbAnswerToolOptions, KbCompletionOptions } from './kb/answer';
// Retrieval in the turn: a topic slot (SlotSpec.nominates) makes runTurn nominate before it plans,
// within a budget; what it did is the trace's `retrieval`.
export { isTopicSlot } from './core/knowledge';
export { topicCatalog } from './kb/catalog';
export type { TurnKnowledge } from './core/knowledge';
export { RETRIEVE_BUDGET_MS } from './run/retrieve';
export type { RetrievalRecord } from './trace/types';
// The engine's retrievers (the default for an app with a kb/ whose code gives none): keyword, BM25 with phrases.
export { KeywordRetriever } from './kb/keyword';
export type { KeywordRetrieverOptions } from './kb/keyword';
// Dense retrieval over a vector index, and hybrid (keyword and dense, fused): the default for an app whose kb.yaml names an embedder.
export { DenseRetriever, HybridRetriever, RRF_K, defaultRetriever, fuse } from './kb/hybrid';
export type { DefaultRetrieverKind, DefaultRetrieverOptions, DenseOptions, HybridOptions } from './kb/hybrid';
// The static embedder, its pinned model, an in-memory vector index, and the index file (kb/.index/<embedder>.json).
export { StaticEmbedder } from './kb/embed/static';
export type { StaticModelParts } from './kb/embed/static';
export { MemoryVectorIndex } from './kb/embed/memory';
export type { Embedder, EmbedderInfo, TopicField, VectorEntry, VectorHit, VectorIndex } from './kb/embed/types';
export { DEFAULT_EMBEDDER, POTION_BASE_8M, STATIC_MODELS, MODEL_DIR_ENV, ModelError, downloadModel, loadPinnedModel, modelDir, modelPresent } from './kb/embed/model';
export type { PinnedModel } from './kb/embed/model';
export { buildIndex, parseIndex, serializeIndex, indexHashOf } from './kb/vectorIndex';
export type { BuiltIndex, KbIndexData, KbIndexRead } from './kb/vectorIndex';
// The retrieval bake-off (pnpm kb:bakeoff): recall at the cap and candidates on a paraphrase file.
export { bakeoff, parseParaphrases } from './kb/bakeoff';
export type { BakeoffResult, Paraphrases } from './kb/bakeoff';

// The slot library: slots from configuration (a built-in type and its options) rather than code.
// What the author of a slot type uses is in 'dialogwright/slot-kit'; the conformance kit is in
// 'dialogwright/testing'.
export { defineSlot, defineSlots, buildSlot, SlotConfigError, isSlotConfigError, BUILT_IN_SLOT_TYPES, registerSlotType } from './slots/index';
export type {
  BuildSlotOptions, BuildSlotResult, DefineSlotOptions, DefineSlotsOptions, SlotSource, SlotType, SlotTypes, SlotBuildEnv, LibrarySlotSpec,
  BirthdateOptions, ChoiceOptions, ChoiceOption, DateOptions, DigitsOptions, NameOptions, RecordOptions, TextOptions, TopicOptions,
} from './slots/index';

// The channel model: what the engine hears (events), what it does (actions), what a channel can do (caps).
export {
  DEFAULT_LANG, startEvent, speechEvent, textEvent, keyEvents, interruptEvent, silenceEvent, errorEvent,
  serviceResultEvent, signedInEvent, wordsOf,
} from './channel/events';
export type {
  SessionEvent, SessionStart, UserSpeech, UserText, UserKey, UserInterrupt, UserSilence, ChannelError,
  ServiceResult, SignedIn,
} from './channel/events';
export { sayAction, endAction, transferAction, sayText } from './channel/actions';
export type { Action, Say, End, Transfer, SendDigits, SetLanguage, SayPart } from './channel/actions';
export { VOICE_RELAY, WEB_CHAT } from './channel/caps';
export type { Channel, ChannelCaps } from './channel/caps';

// The gate: the policy decision's public types, and who is calling.
export type {
  Level, Anonymous, Party, Principal, ToolCall, GateVerdict, RuleResult, GateDecision, GateLookups, GateFacts,
  RuleContext, RuleOutcome,
} from './gate/types';
export { isAnonymous, isParty } from './gate/types';
export { ANONYMOUS, raise, maskId } from './gate/principal';
export type { CompiledPolicy } from './gate/compiled';

// A few engine types an app's launcher and tests name.
export type { Session, SessionFacts } from './core/session';
export type { Tools, CodeVerifier } from './core/tools';
export type { Thresholds, ThresholdName } from './core/thresholds';
export { DEFAULT_THRESHOLDS, atLeast, THRESHOLD_EPSILON } from './core/thresholds';
export type { JevClient } from './jev/types';

// The model's answers: what an app's own questions (App.questions) ask, and how its hooks and slot
// parsers read what came back (a choice's ranked labels, a yes-or-no's value).
export type { Answer, AnswerMap, ChoiceAnswer, NoulAnswer, ScoreAnswer, Question, QuestionMap, Ranked } from './jev/types';
export { isChoice, isNoul, isScore, noulValue, rankProbabilities, topMargin } from './jev/types';

// Decisions a completion or hook may return, and the lines it may say before them.
export type { Ack } from './core/fia';
export type { Decision, PromptDecision, CompleteDecision, HandoffDecision } from './core/decision';
export { handoff } from './core/decision';
export { handoffPromptId } from './prompts/render';

// Reading values out of words, for slot parsers: dates and birthdays, spoken numbers, masks, and the
// candidate spans a span question offers the model.
export {
  MONTHS, WEEKDAYS, DATE_MODES, RELATIVE_DAYS, WINDOWS, QUALIFIERS,
  parseIso, toIso, addDays, weekdayIndex, snapWeekdayOnOrAfter, resolveDate,
  describeDay, describeWindow, describeDob, normalizeYear, ordinal,
} from './core/extract/date';
export type { ComponentPick, DateComponents, DateWindow, DateResolution } from './core/extract/date';
export { spokenToDigits, tokenize } from './core/extract/spokenNumber';
// Whether a locale reads values out of Spanish words (es and es-*).
export { isSpanish } from './core/extract/lexicon';
export { numbersSaid } from './core/extract/numbersSaid';
export type { NumbersSaidOptions } from './core/extract/numbersSaid';
export { matchesMask } from './core/extract/mask';
export { candidateSpans, candidateWordSpans, FILLER_WORDS, MAX_WORD_NGRAM } from './core/spans';

// The server: the phone line, the console and the app's own routes.
export { startServer, main as serverMain } from './server/index';
export type { RunningServer, ServerOverrides, Sidecars } from './server/index';
export { routeOwns, validateRoutes } from './server/appRoutes';
export type { AppRoute, AppRoutes, AppRouteDeps, AppRoutesFactory } from './server/appRoutes';
export type { ServerConfig } from './server/config';

// The harness: the text CLI, the regression run, the threshold sweep and the cassette trim. An app's
// launchers register the app and then call one of these.
export { main as regressMain } from './harness-text/regress';
export { main as cliMain } from './harness-text/cli';
export { main as sweepMain } from './harness-text/sweep';
export { main as cassetteTrimMain } from './harness-text/cassetteTrim';

// For an app's own tests: whole calls scripted against the server, and the audit log they write.
export { scripted, replayRecords, MemoryAuditLog } from './testing/scripted';
export type { Step, Scripted, ScriptedOptions } from './testing/scripted';

// For an app's own tests: one turn at a time with written-out model answers. resolveTurn is the
// engine's turn (core/turn resolve): a session, an event and the answers in, the decision out.
export { choice, noul, score } from './testing/answers';
export { testSlotContext } from './testing/slots';
export { newSession } from './core/session';
export { resolve as resolveTurn, slotContext } from './core/turn';
export type { TurnContext, TurnResult } from './core/turn';
export { mockCodeVerifier } from './core/tools';
export { spokenText } from './prompts/render';
// What the model would be asked on a turn: the questions and the state it reads.
export { buildQuestions, ENGINE_QUESTION_IDS } from './core/questions';
export { buildTurnState } from './core/state';
export type { TurnState, TurnInput } from './core/state';

// For an app's testing hooks (App.testing) and its fixtures: the stub clients, the heuristic stub's
// helpers, the corpus and scenarios, and the regression run's pieces.
export { FixtureStubClient } from './jev/fixtureStub';
export { HeuristicStubClient } from './jev/heuristicStub';
export { digitSpanLabel, dobParts, saysDob, saysExplicitYear, relativeDaySaid } from './jev/heuristicKit';
export type { DobParts } from './jev/heuristicKit';
export { loadCorpus, parseCorpus, normalizeText } from './jev/corpus';
export type { CorpusEntry, CorpusContext, KnownGap, PinnedOutcome, AnswerOverride } from './jev/corpus';
export { buildClient, buildThresholds, CLIENT_KINDS } from './run/client';
export type { ClientKind } from './run/client';
export { defaultCorpusFile, scenariosDir } from './run/fixtures';
export { loadScenarios } from './harness-text/runner';
export type { Outcome, Scenario, ScenarioStep, ScenarioExpectation } from './harness-text/runner';
export { readBaseline, REGRESS_TODAY } from './harness-text/baseline';
export { runAll } from './harness-text/runAll';
