import type { SlotCandidate, SlotContext, SlotSpec } from '../slots/types';
import type { Ack } from '../fia';
import type { Decision } from '../decision';
import type { Session, SessionFacts } from '../session';
import type { TurnContext } from '../turn';
import type { KbSource, TurnOut } from '../lifecycle';
import type { AppKnowledge } from '../../kb/types';
import type { Thresholds } from '../thresholds';
import type { AnswerMap, QuestionMap } from '../../jev/types';
import type { ServiceResult } from '../../channel/events';
import type { AuditDraft } from '../../audit/types';
import type { GateDecision, GateLookups, Level, Party, Principal, RuleContext, RuleOutcome, ToolCall } from '../../gate/types';
import type { CompiledPolicy } from '../../gate/compiled';

/** Engine id types: plain strings. An app defines which values exist; the engine never hard-codes them. */
export type SlotId = string;
export type FormId = string;
export type Intent = string;
export type ToolName = string;

export interface IntentDef {
  /** Criteria text sent to the decision model. */
  criteria: string;
  /** Spoken label ("track a parcel"), used in acknowledgements and confirmations. */
  label: string;
  /** form: starts a form; informational: plays its prompt (or says its passage, or switches to its locale) and resumes; control: agent, repeat, done, other, none. */
  kind: 'form' | 'informational' | 'control';
  /** For informational intents, the prompt played. An informational intent has this, `passage` or `locale` (`locale` may go with this). */
  promptId?: string;
  /**
   * For informational intents, in place of `promptId`: a passage of the app's knowledge base
   * (App.knowledge.kb), said word for word. No retrieval and no gate (general information, said to
   * anyone): the passage in force today for its topic, in the call's language, is resolved with no
   * facts (a passage an informational intent names applies to every caller), and said through the
   * `kb_answer` line; when none can be said (none in force, stale, no translation) the
   * `kb_unavailable` line is said and a person offered, once per call (kb/answer.ts).
   */
  passage?: string;
  /**
   * For informational intents: the locale the call switches to when it is chosen (one of
   * App.locales). Its `promptId`, if any, is said in that locale, then the call resumes; a channel
   * with speech is asked first to switch its voice and recognition (a `set_language` action, with the
   * languages App.voice.locales names). Goes with `promptId` or alone, never with `passage`. Choosing
   * the locale the call is already in says the prompt and changes nothing else.
   */
  locale?: string;
  /**
   * When the model is unsure of this intent (outside a form, read from INTENT_EXPLICIT up to
   * INTENT_IMPLICIT): `confirm` asks the caller ("Just to check, do you want to ...?"), `no-match`
   * treats the reading as no match (the no-match line, counted). For a form intent, an informational
   * one and `done`. Absent: the app's (App.unsureIntent).
   */
  unsure?: UnsureIntent;
}

/** What an intent the model is unsure of gets: a confirmation, or the no-match line (IntentDef.unsure, App.unsureIntent). */
export type UnsureIntent = 'confirm' | 'no-match';

export interface FormDef {
  /** Business slots, in prompt priority order. */
  slots: readonly SlotId[];
  /** The manifest prompt confirming the filled form, or null. */
  summaryPromptId: string | null;
  /**
   * The actions (tools) the form's hooks call through the gate: its entry call and the calls its
   * completion and summary hooks make. Declared by every form of an app or by none; the app map
   * (dialogwright/testing appMapText) draws a form to them, and `check` reports an action no form
   * reaches (core/app/reach.ts). Never read by the engine at run time. Without it, the app does not
   * say where its calls are made.
   */
  calls?: readonly ToolName[];
  /**
   * The call made before the form's own slots are asked (it may step identity up). Without it the
   * form is entered as it starts: no call, nothing to step up, and neither onEntry nor
   * principalEntry is called.
   */
  entry?(s: Session): ToolCall;
  /** Applies a successful entry call's result to the session (e.g. stores facts, preselects a slot). */
  onEntry?(s: Session, value: unknown): void;
  /**
   * In place of the entry call, for a principal who is neither anonymous nor the app's subject
   * (identity.subjectKind): someone acting for subjects (e.g. depot staff for customers), for whom the
   * subject's own entry call does not apply. Null lets the form go on; otherwise the Decision to speak,
   * or `refused` with its line. A form with an entry call but no principalEntry fails closed: its
   * entry call is made as for anyone else, and the gate decides.
   */
  principalEntry?(ctx: EntryContext): Decision | Refused | null;
  /**
   * For a form whose completion is a confirmed write (the gate's confirmed rule): the values it will write, read from
   * the session. Each time the summary is spoken their hash is taken, for the caller's yes to arm. A
   * form without one holds no confirmation.
   */
  confirmedParams?(s: Session): Readonly<Record<string, string>>;
  /** Runs when the form's slots are complete (and confirmed, where it has a summary). */
  complete(ctx: CompletionContext): Completion;
  /**
   * The form heard a spoken turn: `answers` are perception's, the app's own questions'
   * (App.questions) among them, for a preference the caller may volunteer at any point (e.g. a part
   * of the day), which the hook keeps in the session's facts. It runs before the turn fills a slot
   * or decides anything:
   * - as the form is entered on spoken words, with the answers it fills from (the opener's; after
   *   an explicit intent check, the opener's and then the yes's own, so the yes's are newer);
   * - on every later spoken turn while the form is open, unless the gates set the turn aside
   *   (side speech, a held partial, words that could not be made out). A quarantined turn, a failed
   *   ask, silence and the keypad carry no answers, so never reach it.
   */
  onAnswers?(ctx: AppContext, answers: AnswerMap): void;
  /**
   * At this form's pending summary, an answer that was neither a yes nor a correction that changed
   * a slot (a no with nothing usable in it, or no answer to the question at all): the form's own
   * move along what its summary offers (e.g. "anything later?" steps the offered time). Null, or no
   * move and no acks, leaves the turn to the engine (a no asks what to change; no answer re-asks).
   */
  onSummaryAnswer?(ctx: AppContext, answers: AnswerMap): SummaryMove | null;
  /**
   * At this form's pending summary, the change question (ModelWording.changeSlot) named `slot` as the
   * detail to change: true keeps the slot and takes the answer as the form's own move instead (e.g.
   * "a later time that day" names the date but asks to keep it and move the time), so the slot is not
   * reopened, the changeSlot row says `kept`, and the answer goes on to onSummaryAnswer.
   */
  keepsSlot?(answers: AnswerMap, slot: SlotId, t: Thresholds): boolean;
  /**
   * The summary as it is about to be read (summaryPromptId, with every slot's display): the form's
   * own look at what it names that the slots do not hold (e.g. a record found from them, an option
   * offered, read through ctx.callTool and kept in the facts). It runs on every turn whose decision
   * reads this form's pending summary, after the frustration step, so a summary the transfer offer
   * replaced is not read and not rendered; and when a corpus entry is seeded at the summary. What it
   * returns is applied there: `vars` over the slots' displays, `acks` after the turn's own (the line
   * right before the summary), and `promptId` read in place of summaryPromptId (e.g. a short re-read
   * of only what moved), which stays the same pending question: yes, no, the keypad's 1 and 2 and the
   * retry ladder read it as the summary. The confirmation hash (confirmedParams) is taken after it, so
   * a yes arms exactly what was read. Null reads the summary as it is.
   */
  onSummaryRead?(ctx: SummaryContext): SummaryRead | null;
}

/** A form's summary hook (FormDef.onSummaryRead): an AppContext with the acks the summary will follow. */
export interface SummaryContext extends AppContext {
  readonly acks: readonly Ack[];
}

/** What a form's summary hook (FormDef.onSummaryRead) makes of the summary about to be read; each part optional. */
export interface SummaryRead {
  /** The prompt read in its place (e.g. "{when}. Does that work?"); absent, summaryPromptId. */
  promptId?: string;
  /** Variables over the slots' displays (e.g. a found record's day and time). */
  vars?: Record<string, string>;
  /** Lines after the turn's own, right before the summary (e.g. "The closest I have is 1:00 PM."). */
  acks?: Ack[];
}

/**
 * What a form's answer hook at its summary (FormDef.onSummaryAnswer) made of an answer there:
 * - `moved`: what the summary offers changed; it is read again, re-armed with a fresh count, after `acks`;
 * - not moved, with `acks` (e.g. "that's the earliest opening"): the summary is read again after
 *   them, and the turn counts on its retry ladder like any other answer that did not settle it.
 */
export interface SummaryMove {
  moved: boolean;
  acks: Ack[];
}

/** What an app hook may reach in a turn: the session, the turn, and tools through the gate. */
export interface AppContext {
  s: Session;
  tc: TurnContext;
  /** The turn's output: a hook may record a KB source or queue an effect on it. */
  out: TurnOut;
  /**
   * A call through the gate, recorded like every other; `value` is null unless the gate allowed it.
   * `redacted` names the fields of the value the policy withheld from the caller (policy.yaml
   * `redact:`, each now null), present only when it withheld any.
   */
  callTool(call: ToolCall): { decision: GateDecision; value: unknown; redacted?: readonly string[] };
}

/** A form's entry hook: an AppContext with the turn's acks so far. */
export interface EntryContext extends AppContext {
  acks: Ack[];
}

/** What a completion handler may do: an EntryContext, with the engine's refusal. */
export interface CompletionContext extends EntryContext {
  /** A call the gate did not allow: its line where there is one, a person where there is not. */
  refusal(decision: GateDecision): Completion;
}

/**
 * The gate refused one of the form's calls and there is a line for it: the line is said, and the
 * call carries on as after a completion (the next queued request, or "anything else?"), but the
 * form is not counted as completed.
 */
export interface Refused {
  kind: 'refused';
  acks: Ack[];
}

/**
 * What a full, confirmed form's completion does with the turn. Each carries the turn's acks so far.
 * - `said`: the answer's lines; the form is completed and the call carries on (finishForm).
 * - `end`: the form is completed and the call ends on its line (`promptId` with `vars`, after
 *   `acks`), the form and its slots left on the session as they were, its filled slots confirmed
 *   where it has a summary (the caller just agreed to them). With a request queued, the call carries
 *   on instead: the line is said, then the next request is bridged into, as after `said`.
 * - `refused`: the form ends without its answer (the gate refused the call, or there was none to
 *   give and no transfer to offer); its line is said and the call carries on, the form uncounted.
 * - `reconfirm`: the gate refused the write and the form loop asks again. On the confirmed rule (the values changed
 *   after the summary was read) that reads the summary again; where an app's own rule refused a value
 *   and the completion cleared that slot (e.g. a delivery date in the future), it asks for it again.
 * - `decision`: the completion takes the turn (report_filed, a transfer offer, a handoff) and the
 *   form is finished later.
 */
export type Completion =
  | { kind: 'said'; acks: Ack[] }
  | { kind: 'end'; promptId: string; vars: Record<string, string>; acks: Ack[] }
  | Refused
  | { kind: 'reconfirm'; acks: Ack[] }
  | { kind: 'decision'; decision: Decision };

export interface IdentityConfig {
  /**
   * The principal kind the app serves and verifies (e.g. 'customer'). Any other kind but anonymous
   * acts for subjects, and enters a form through its principalEntry instead of the entry call.
   */
  subjectKind: string;
  /**
   * The app's word for a party who acts for subjects (e.g. 'agent'), as the harness's errors name
   * one (a scenario's or corpus entry's `as` that is not one). Default 'delegate'.
   */
  delegateKind?: string;
  /**
   * Factor slots collected on voice for a step-up (e.g. accountId, dob), asked in this order. Each
   * slot id is also the name of the verify tool's param that carries its value.
   */
  factorSlots: SlotId[];
  /** The tool that verifies the factors (e.g. verifyCustomer). */
  verifyTool: ToolName;
  /**
   * Level 2's tools: the one that checks the one-time code (e.g. verifyCode) and the one that sends
   * it (sendCode). Both, or neither: a ladder of one rung (identity.yaml with no level 2) has no
   * code, so nothing may need level 2 (validateApp) and the lifecycle never sends one.
   */
  codeTool?: ToolName;
  sendCodeTool?: ToolName;
  /** How many digits the one-time code has, keyed on the keypad: 4 to 8. Without it, 6 (identity.yaml's `otp: { length }`). */
  codeLength?: number;
  /**
   * The params of the call that texts the one-time code (sendCodeTool), read from the session (e.g.
   * the verified customer's account ID). Without it the call carries none.
   */
  sendCodeParams?(s: Session): Record<string, string>;
  /** The line said before the factors are asked again after a failed match. Without it, 'identity_failed'. */
  failedPromptId?: string;
  /**
   * What each level of the ladder is called (identity.yaml's `name`, e.g. 1: "verified"): labels for
   * the console and the policy card. The engine records and decides on the numbers; a name never
   * reaches the session, the model, an outcome or an audit row.
   */
  levelNames?: Readonly<{ 1: string; 2?: string }>;
  /**
   * The level a sign-in proves (identity.yaml's `signIn`), on a channel that can sign a caller in
   * (ChannelCaps.signIn): always the top of the ladder. Without it the app takes no sign-in, and an
   * `auth.signed_in` event is ignored.
   */
  signInLevel?: 1 | 2;
  /**
   * The token claim that carries the subject's id, for a channel that signs in with a token (the
   * engine's web chat, server/chat/signin.ts): identity.yaml's `signIn.claim`. Without it, `sub`. The
   * id it carries is looked up with principals.subjectPrincipal at signInLevel; an app that maps
   * token claims some other way sets PrincipalDirectory.fromClaims.
   */
  signInClaim?: string;
  /**
   * The roles a party of the delegate kind may have, as identity.yaml declares them. With it, every
   * delegate the app's portal and principals produce is checked against it (validateApp, and the
   * harness as it signs one in). Without it (an identity written in code), roles are not checked.
   */
  delegateRoles?: readonly string[];
  /**
   * The failed tries allowed at each identity check (identity.yaml's `attempts`): the policy's
   * maxAttempts must be the same number (validateApp). Without it, the policy's is not checked.
   */
  maxAttempts?: number;
}

/**
 * What the engine reads from the app's verify tool (IdentityConfig.verifyTool) when the gate allowed
 * it: whether the factors matched and, on a match, the principal they prove (verified to level 1).
 */
export type VerifyOutcome = { ok: true; principal: Party } | { ok: false };

export interface ToolDef {
  /**
   * Runs the tool against the app's systems. Only ever called after the gate allowed it. `tc` is the
   * turn context (the systems, today's date) and `out` the turn's output, where a tool may queue an
   * effect (e.g. a missing-parcel report's depot notice) so resolve stays pure.
   *
   * What the call carries to the console, the trace and the audit is redactCall's copy: each param
   * that is a slot with a redact setting masked as the slot says (SlotSpec.redact), each other param
   * as policy.yaml's `audit:` declares it (PolicyTables.audit). `check` refuses a param the tool
   * lists (its params, below) that neither covers.
   */
  run(call: ToolCall, sys: unknown, ctx: { s: Session; tc: TurnContext; out: TurnOut; code?: string }): { value: unknown; summary: string; ref?: string };
  /**
   * The audit rows for a call the gate let run, after its gate row (core/audit.ts). Without it, one
   * `tool_result` row with the tool's name and summary. Rows carry no PHI: the call is the redacted
   * copy, and the summary is the tool's own one line. The hook is the app's own code: it must never
   * put a raw slot value in a row, and `after` (below) is the whole session, raw slots included, so
   * read from it only what a row may carry. The engine holds it to that for the call's own params:
   * wherever a row's text repeats the raw value of a param that is recorded masked or never, the
   * value is masked there too (core/recording.ts).
   */
  audit?(t: ToolAuditInput): AuditDraft[];
  /**
   * The fields of what the tool returns that the policy may withhold from a party acting for
   * subjects (policy.yaml `redact:`): of the value when it is an object, of each item when it is a
   * list. Only a field named here may be named there. The tool returns the whole record; the engine
   * sets each withheld field to null after the tool runs (core/resultRedaction.ts), before anything
   * else sees the value, and adds `redacted: <fields>` to the summary. The summary itself is the
   * tool's, written from the whole record: it must never carry one of these fields.
   */
  fields?: readonly string[];
  /**
   * The params the tool's calls carry, by name (`params: []` for none): what `check` holds to being
   * recorded as declared, each a slot with a redact setting or a param policy.yaml's `audit:` names.
   * The calls are built in code (a form's hooks, the identity flow), so the tool, which reads them,
   * is where they are listed. `check` requires it of every tool, and holds it to the params the
   * action's rules name; the gate-event goldens list any param an app's own calls carry that its
   * tool does not (dialogwright/testing gateEventGolden). The engine records the calls as declared
   * either way: a param no slot's redact or `audit:` declaration covers is recorded as it is.
   */
  params?: readonly string[];
}

/** What a tool's audit hook (ToolDef.audit) is given about a call the gate let run. */
export interface ToolAuditInput {
  /** The call as recorded (redactCall): each param masked as its slot or policy.yaml's `audit:` says, a secret one left out. */
  call: ToolCall;
  /** The tool's one-line summary of what it returned. */
  summary: string;
  /** The id of a record the tool created, where it made one. */
  ref?: string;
  /**
   * The session as the turn left it (a verify tool's row reads the level it reached). The FULL
   * session, raw slot values and all, not a redacted copy: a hook must not copy a slot value from it
   * into a row. The engine does not check the rows an app's hook returns.
   */
  after: Session;
  /** The knowledge-base passage the turn's answer was read from, if any. */
  kb: KbSource | null;
}

/**
 * A downstream service the app's tools hand work to and the call waits on (e.g. another agent reached
 * over A2A, a triage system): a turn queues it as an effect, `{ kind: 'service', service, params }`.
 * The server asks it after the turn and runs its answer, a `service.result` event, as the call's next
 * turn; the answer is untrusted, and the app says it (App.onServiceResult).
 */
export interface ServiceDef {
  /**
   * Ask the service. Never throws: no endpoint, a timeout, an error or a reply that does not check is
   * an answer with a null result (with the client's note of why, where it keeps one).
   */
  resolve(params: Readonly<Record<string, string>>, opts: ServiceResolveOptions): Promise<ServiceResult>;
  /**
   * A result read back from a frame log for replay, put through the check the live reply passed (a
   * hand-edited log gets no further than the service's reply would have). Null replays as no answer.
   */
  fromLog(result: unknown): unknown;
  /** The audit row for the service's answer to a request the call was waiting on. Without it, or null, none. */
  audit?(result: unknown, note: unknown): AuditDraft | null;
}

export interface ServiceResolveOptions {
  /** The service's endpoint, as the launcher that started it passed it to the server; null for none. */
  url: string | null;
  /** The budget for the request; the service's own default unless the server shortens it. */
  timeoutMs?: number;
}

/**
 * What the role rule (R5 in the tables) lets a role do with a tool: make the call, be refused it (BLOCK 'role'), or have a person
 * take it (NEEDS_HUMAN, PolicyTables.rolePersonReason).
 */
export type RoleAccess = 'allow' | 'refuse' | 'person';

/** The gate's tables (src/gate/policy.ts evaluateCall): the whole of what the app's agent may do. Their `rulesFor` lists the built-in rules by their table ids (R1 identity, R2 scope, R3 confirmed, R5 role, R6 attempts, R7 fields); the gate records them under their names. */
export interface PolicyTables {
  /** The identity level each tool needs; a tool without one needs the highest (fails closed). */
  toolLevel: Readonly<Record<ToolName, Level>>;
  purposeLevel: Readonly<Record<string, Level>>;
  rulesFor: Readonly<Record<ToolName, readonly string[]>>;
  /** R7 (fields): the fields each tool may send on to a downstream service; a tool with no row sends none. */
  serviceFields: Readonly<Partial<Record<ToolName, readonly string[]>>>;
  confirmedFields: readonly string[];
  /** R6 (attempts): failed attempts allowed at each identity check (the factors, the one-time code). */
  maxAttempts: number;
  /**
   * R5 (role): per tool, what each role of a principal that has one (e.g. depot staff) may do with it. A
   * tool or a role with no row is refused. Without the table, every role is refused.
   */
  roles?: Readonly<Record<ToolName, Readonly<Record<string, RoleAccess>>>>;
  /** The role rule's NEEDS_HUMAN reason when a role's access is 'person' (e.g. 'staff-filing'). Default 'role-person'. */
  rolePersonReason?: string;
  /**
   * R2 (scope): per tool, the param that names the subject the call acts on, and whether its value is a
   * record id the gate resolves to its owner (GateLookups.ownerOf) or the subject's own id. A tool
   * that runs scope (R2) without a row is BLOCKed (fails closed); validateApp refuses an app with one.
   */
  subjects: Readonly<Record<ToolName, SubjectParam>>;
  /**
   * Rules the app adds beside the gate's built-in ones (src/gate/policy.ts RULE_IDS), named in
   * rulesFor like them; an id must not be a built-in's (validateApp checks). An app's own rule
   * (e.g. no report for a parcel already delivered) is one. A custom rule is the app's own code: its
   * RuleResult.compared reaches the audit and the console, with every raw value of a param of the
   * call that is recorded masked or never masked there too (core/recording.ts).
   */
  customRules?: Readonly<Record<string, (c: RuleContext) => RuleOutcome>>;
  /** The words the built-in rules' lines use, so the console and the audit read in the app's terms. Without it, neutral words. */
  wording?: PolicyWording;
  /**
   * The fields of a tool's result withheld from a party acting for subjects (policy.yaml `redact:`),
   * by who asks: a delegate kind (`agent`), or a kind and one of its roles (`agent.clerk`), whose
   * row for a tool replaces the kind's. Each tool's list names fields the tool declares
   * (ToolDef.fields). A subject acting for themselves is never redacted. Without it, nothing is.
   */
  redact?: Readonly<Record<string, Readonly<Record<ToolName, readonly string[]>>>>;
  /**
   * How each param that is not a slot with a redact setting is recorded (policy.yaml `audit:`), by
   * param name, in every call that carries it: the gate event, the trace, the console and the audit
   * (core/recording.ts). Without it, such a param is recorded as it is.
   */
  audit?: Readonly<Record<string, AuditMask>>;
}

/**
 * How a param is recorded (policy.yaml `audit:`): `last4` by its last four characters ("...1234"),
 * `mask` hidden ("•"), `length` by its length ("<38 chars>"), `secret` never (left out of the call
 * as recorded, and "•" wherever else its value would appear), `keep` as it is.
 */
export type AuditMask = 'last4' | 'mask' | 'length' | 'secret' | 'keep';

/** Scope (R2): the param naming a call's subject; `via: 'record'` when it is a record id to resolve to its owner. */
export interface SubjectParam {
  readonly param: string;
  readonly via?: 'record';
}

/** Who is asking, as the scope rule words it: one of the app's subjects, or a party acting for subjects. */
export type ScopeAsker = 'subject' | 'delegate';

/**
 * The words the gate's built-in rules use in their description and compared lines (RuleResult).
 * Each is optional; the engine's own are neutral.
 */
export interface PolicyWording {
  /**
   * The scope rule's description, by who asks and how the tool names its subject (a record, or the subject's id
   * as a param). Default: "The record belongs to someone this caller may see".
   */
  scope?: Readonly<Partial<Record<ScopeAsker, Readonly<Partial<Record<'record' | 'param', string>>>>>>;
  /** The scope rule's compared line names the owner of a record as this (default "record owner"), and a subject named by id as this (default "subject"). */
  recordOwner?: string;
  subject?: string;
  /**
   * The role rule's compared line for a role and what the roles table gives it for the tool. Default:
   * "role <role> may <tool>: yes", "...: no", "...: with a person".
   */
  role?(role: string, tool: ToolName, access: RoleAccess): string;
}

/**
 * How the engine makes, copies and clears the app's session facts (Session.facts): what its tools
 * returned about the caller, which the engine holds as an opaque record and never reads by name.
 */
export interface FactsConfig {
  /** A new session's facts. */
  initial(): SessionFacts;
  /** A copy deep enough that writes to it (a turn's, on a cloned session) never reach the original. */
  clone(f: Readonly<SessionFacts>): SessionFacts;
  /** Clears what a closed form leaves stale (e.g. the parcel list, since the call may just have reported one). */
  onFormClosed?(f: SessionFacts): void;
  /**
   * What the app's slot specs read of the facts: `records` (SlotContext.records: e.g. the customer's
   * parcels, to choose one), and `sources`, lists by name for slots that name theirs
   * (SlotContext.sources: a `record` slot's `from`). Without it, none.
   */
  forSlots?(f: Readonly<SessionFacts>): SlotRecords;
}

/** What FactsConfig.forSlots gives the slot specs: one list (`records`), lists by name (`sources`), or both. Absent parts are empty. */
export interface SlotRecords {
  records?: readonly unknown[];
  sources?: Readonly<Record<string, readonly unknown[]>>;
}

/**
 * The words the engine's own questions to the decision model use about the app's domain (the intent
 * question, the hedge, the summary's change question: core/questions.ts; the injection screen:
 * core/screen.ts). Each is optional; without it the engine's own, neutral words are used. Every
 * string is sent to the model as it is, so a change to one re-keys a recorded cassette.
 */
export interface ModelWording {
  /** Whom the caller is asking, in the intent question ("What is the caller asking <this> to do?"). Default "this service". */
  addressee?: string;
  /** intentTentative's criteria: the hedge is about the request itself (true), or only about a detail (false). */
  tentative?: { readonly true: string; readonly false: string };
  /** confirmsNo's criteria: what a no to a confirmation is (true; e.g. with a correction in the app's own values as its example), and what is not (false). */
  confirmsNo?: { readonly true: string; readonly false: string };
  /** changeSlot: which detail of a form just read back the caller names as wrong. */
  changeSlot?: ChangeSlotWording;
  /** The injection screen's one question: its instructions, and what counts as manipulation (true) and as ordinary (false). */
  screen?: { readonly instructions: string; readonly true: string; readonly false: string };
}

export interface ChangeSlotWording {
  /** The question's instructions. */
  instructions?: string;
  /**
   * The slots the question can offer, in its fixed presentation order (kept so the wire order, and
   * any option-order bias in the model's answer, stay stable); each offered only when the pending
   * form has it. A form slot not listed is not offered. Without it, the form's own slots in its order.
   */
  order?: readonly SlotId[];
  /** Per slot in `order`, the criterion for naming it as the thing to change without its new value. validateApp checks each has one. */
  text?: Readonly<Record<SlotId, string>>;
  /** The `none` criterion: a new value given rather than a detail named, a plain yes or no, or nothing. */
  none?: string;
}

/** How the app is named on the operator console and its browser storage. */
export interface AppBrand {
  /** The app's name, as the console's title and its speaker labels show it (e.g. "Example Parcels"). */
  readonly name: string;
  /** The console's short mark, top left (e.g. "EP"). */
  readonly mark: string;
  /**
   * The prefix of the console's browser storage keys ("<key>-console-presenter",
   * "<key>.console.traceNames", "<key>.console.resume"). Kept stable, a browser's saved choices
   * survive (e.g. "example-parcels"). Default: the app id.
   */
  readonly key?: string;
}

/**
 * The operator console's view of the app (src/server/dashboard): the words and vocabulary its page
 * (view.js, page.html) shows instead of mirroring one app. Each field is optional; without one the
 * console uses the app's own ids and neutral words. The server sends it to the page as JSON
 * (src/server/dashboard/meta.ts consoleMetaOf), so every value is plain data.
 */
export interface ConsoleConfig {
  /** Each form in words, as the NOW panel says it (e.g. report_missing, "Report a missing parcel"). Default: the id with spaces. */
  readonly formLabels?: Readonly<Record<FormId, string>>;
  /**
   * Every slot in the order the chips and the perception groups show them outside a form.
   * Default: the identity factor slots, then each form's slots in turn, once each.
   */
  readonly slotOrder?: readonly SlotId[];
  /** Each slot as the NOW panel names it (e.g. accountId, "Account ID"). Default: the slot id. */
  readonly slotLabels?: Readonly<Record<SlotId, string>>;
  /**
   * The question id prefixes that belong to a slot, where its questions are not named after it
   * (e.g. parcelSelect asks parcelChoice). A slot not listed owns the ids that start with its own.
   */
  readonly questionPrefixes?: Readonly<Record<SlotId, readonly string[]>>;
  /** Slot questions measured against SLOT_DETECT besides the ones ending in "Given" (e.g. containsAccountId). */
  readonly detectQuestions?: readonly string[];
  /** The level badge's words for levels 0, 1 and 2 (e.g. "anonymous", "ID + DOB", "+ code"). */
  readonly levels?: readonly [string, string, string];
  /** Handoff reasons the app adds, in words (e.g. staff-filing). */
  readonly handoffReasons?: Readonly<Record<string, string>>;
  /** The key fact of a task, read off its turn's audit rows, as the NOW panel says it. In order; a row matches the first that fits. */
  readonly facts?: readonly ConsoleFact[];
  /** Audit row types the audit list shows as good news, beside a passed identity check (e.g. report_created, kb_answer). */
  readonly goodAuditTypes?: readonly string[];
  /** A downstream service's answer (service.result) as the conversation pane shows it. */
  readonly serviceNote?: ServiceNoteWording;
  /** A portal sign-in mid-chat (an auth.signed_in turn): the conversation pane's marker, and the role the caller line names the person by (view.js). */
  readonly signIn?: { readonly marker: string; readonly role: string };
  /** Session id prefixes of the app's chats (e.g. CH, WC), so the console knows a replayed trace was a chat (view.js). */
  readonly chatPrefixes?: readonly string[];
  /** Who hears what the agent says, in the handoff card's note (e.g. "the customer"). Default "the caller". */
  readonly heardBy?: string;
  /** Buttons in the console's header that open the app's own pages (e.g. its chat pages; page.html). */
  readonly links?: readonly ConsoleLink[];
}

/**
 * One way a turn's audit rows give the task's key fact (view.js factOf):
 * - `created`: a row recording a record the turn created; `text` with `{}` for the detail field.
 * - `lookup`: a tool's result; the allowed call's `param` names the record ("parcel 7101 · in transit").
 * - `answer`: a knowledge-base answer, named by a slot's display or, without one, its detail field.
 * - `note`: a row that adds `text` to the fact already held, unless the fact already says `unless`.
 */
export type ConsoleFact =
  | { readonly kind: 'created'; readonly type: string; readonly field: string; readonly text: string }
  | { readonly kind: 'lookup'; readonly tool: string; readonly param: string; readonly noun: string }
  | { readonly kind: 'answer'; readonly type: string; readonly field: string; readonly topicSlot?: SlotId }
  | { readonly kind: 'note'; readonly type: string; readonly when: Readonly<Record<string, string | number | boolean>>; readonly text: string; readonly unless?: string };

/** A downstream service's answer, as the conversation pane words it. */
export interface ServiceNoteWording {
  /** Who answered (e.g. "Depot agent · A2A"). */
  readonly label: string;
  /** An answer taken (e.g. "answered the filed report"). */
  readonly answered: string;
  /** Why an answer was refused or never came, by the client's reason code. A code not listed is shown as it is. */
  readonly reasons?: Readonly<Record<string, string>>;
}

/** A console header button that opens one of the app's pages in a window of its own. */
export interface ConsoleLink {
  /** The button's element id (e.g. "chat"). */
  readonly id: string;
  readonly label: string;
  /** Its tooltip. */
  readonly title: string;
  readonly href: string;
  /** The window name (window.open's target), so a second click reuses the window. */
  readonly target: string;
  /** window.open's features ("width=440,height=700"). */
  readonly features: string;
}

/** The phone line's speech settings for the app. */
export interface VoiceConfig {
  /** Words the speech recognizer should expect (ConversationRelay `hints`), before the engine's number words. */
  readonly hints?: readonly string[];
  /**
   * How digits that are identifiers are spelled out for TTS on the wire, in order. Only what goes
   * out is rewritten: the session text, the trace and the manifest keep the readable form.
   */
  readonly spokenDigits?: readonly SpokenDigitRule[];
  /** The locale a call starts in, by the number called (E.164); a number not listed starts in the app's default. Each is one of App.locales. */
  readonly numbers?: Readonly<Record<string, string>>;
  /** Per-locale speech settings on the phone, by the app's locale tags: languages, a voice per carrier, hints. */
  readonly locales?: Readonly<Record<string, VoiceLocale>>;
}

/** How the phone speaks and hears one of the app's locales (VoiceConfig.locales). Each field is optional. */
export interface VoiceLocale {
  /** The language the voice speaks the locale in, a language tag. Default: the locale's tag. */
  readonly tts?: string;
  /** The language speech is recognized in, a language tag. Default: the locale's tag. */
  readonly transcription?: string;
  /**
   * The voice, by voice provider id (twilio, telnyx), each in the carrier's own names. It wins over
   * the deployment's voice for that carrier; without it, the default locale has the deployment's and
   * any other the carrier's default voice. A name alone is spoken with the deployment's TTS provider
   * (Twilio's TTS_PROVIDER, or Twilio's default when that is unset); a Twilio voice may name its own
   * provider (`{ voice, provider }`), and a Telnyx voice's name carries its provider.
   */
  readonly voices?: Readonly<Record<string, string | ProviderVoice>>;
  /** Words the recognizer should expect in this locale, in place of VoiceConfig.hints. */
  readonly hints?: readonly string[];
  /**
   * The speech recognizer, by voice provider id (twilio, telnyx), each in the carrier's own names.
   * It wins over the deployment's recognizer for that carrier (TWILIO_TRANSCRIPTION_PROVIDER and
   * TWILIO_SPEECH_MODEL, TELNYX_TRANSCRIPTION_PROVIDER); a field it leaves out is the carrier's
   * default, never the deployment's. Without it, the default locale has the deployment's recognizer
   * and any other the carrier's default, since a deployment's model may hear one language only.
   */
  readonly recognition?: Readonly<Record<string, Recognition>>;
}

/** A Twilio voice with its TTS provider (one of TWILIO_TTS_PROVIDERS, src/channel/voiceProviders.ts), as Twilio names them. */
export interface ProviderVoice {
  readonly voice: string;
  readonly provider: string;
}

/** A speech recognizer on one carrier: its provider and its model, in the carrier's own names; a field left out is the carrier's default. */
export interface Recognition {
  readonly provider?: string;
  readonly model?: string;
}

/**
 * One spoken-digits rule (src/server/adapter.ts spokenDigits). `pattern` is global. It is a regular
 * expression the app supplies, so trusted code run over every line the agent speaks: keeping it
 * free of catastrophic backtracking (ReDoS) is the app's responsibility, not the engine's.
 * - `lead`: capture 1 is the words before the digits, capture 2 the digits; "parcel 7101" reads "parcel 7 1 0 1".
 * - `groups`: the whole match is digit groups separated by spaces, each spelled out, with a comma
 *   pause between groups; "4471 8293" reads "4 4 7 1, 8 2 9 3".
 */
export interface SpokenDigitRule {
  readonly pattern: RegExp;
  readonly spell: 'lead' | 'groups';
}

/**
 * The handoff note's words about the app's domain (src/handoff): the facts read from the audit,
 * and the summary model's instructions. Each is optional; without it the engine's own, neutral words.
 */
export interface HandoffWording {
  /** Who the note is for, the person the call is handed to, in the summary model's instructions: "a human <this> agent" (e.g. "delivery contact-center"). Default "contact-center". */
  readonly recipient?: string;
  /** The Identity line by the level reached (an app may name its factors). Default "not verified", "level 1", "level 2". */
  readonly levels?: Readonly<Record<number, string>>;
  /** The Identity line for a principal kind that starts the call signed in (call_started's principal; e.g. depot staff through the portal). */
  readonly signedIn?: Readonly<Record<string, string>>;
  /** A refusal in words by the gate's reason (e.g. scope, already-delivered). Default: the engine's neutral words, or the reason as it is. */
  readonly blocked?: Readonly<Record<string, string>>;
  /** For a principal kind that started signed in, its own words for a refusal by reason (e.g. a depot agent's scope). */
  readonly blockedAs?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Handoff reasons the app adds, in words (e.g. staff-filing). */
  readonly reasons?: Readonly<Record<string, string>>;
  /** Records the call created, read from an audit row's detail field, and listed in the facts under `key` (e.g. report_created, report, reportsFiled). */
  readonly created?: { readonly type: string; readonly field: string; readonly key: string };
}

export interface App {
  id: string;
  intents: Record<Intent, IntentDef>;
  /** Keypad menu order: digit to intent. */
  menu: ReadonlyArray<{ digit: string; intent: Intent }>;
  forms: Record<FormId, FormDef>;
  slots: Record<SlotId, SlotSpec>;
  /**
   * How a caller proves who they are: the factors a step-up asks for and the tools that check them.
   * Without it the app verifies no one: every caller stays anonymous, nothing steps up, and
   * validateApp refuses any tool that needs a level above 0.
   */
  identity?: IdentityConfig;
  tools: Record<ToolName, ToolDef>;
  policy: PolicyTables;
  /**
   * The gate the app's calls go through (core/app/lookup.ts gateOf). Without it, the policy's named
   * rules: the ones its tables were compiled from (compilePolicy, definePolicy, defineApp), or, for
   * tables written by hand, the tables read as rules (gate/compiled.ts programFromTables). An app sets
   * it only to put another gate in front of its calls, as the shadow gate does
   * (dialogwright/testing withShadowGate).
   */
  gate?: CompiledPolicy;
  /**
   * The app's session facts. Without it a session's facts start empty, are copied whole
   * (structuredClone) with the session, stay when a form closes, and give the slot specs no records.
   * Facts are plain structured-cloneable data (no functions or class instances): sessions are plain,
   * serializable values, and the default copy is a structuredClone.
   */
  facts?: FactsConfig;
  /** A fresh copy of the app's systems (mock or real clients) and the gate's lookups over them. */
  systems(): { sys: unknown; lookups: GateLookups };
  /** The downstream services the app's tools hand work to, by name (Effect `service`). Without it, none. */
  services?: Readonly<Record<string, ServiceDef>>;
  /**
   * A downstream service's answer to a request the call is waiting on (session.pendingService), as
   * the line the caller hears. The answer is untrusted: the app checks it and speaks only approved lines.
   * Without one, such an answer is ignored.
   */
  onServiceResult?(ctx: AppContext, service: string, result: unknown): Ack;
  /**
   * What a call the gate BLOCKed says, by the gate's reason and who asked: a prompt id, or null for
   * no line, when the caller goes to a person. Without it, every BLOCK goes to a person.
   */
  blockPromptId?(reason: string | undefined, p: Principal): string | null;
  /** The words the engine's own model questions use about the app's domain. Without it, neutral words. */
  wording?: ModelWording;
  /**
   * Slots that, like identity, outlast the form that filled them (e.g. the caller's own name and
   * birthday, so a second task on the call does not ask for them again). Every other slot of a
   * form is emptied as it closes. Without it, none. Shorthand for `listen: 'call'` on each slot it
   * names (SlotSpec.listen): a value said outside a form is kept too. A slot named here that sets
   * another `listen` is refused (validateApp, `check`).
   *
   * A carried value pre-fills the next form that has the slot, as it was confirmed on the form that
   * filled it: the caller is not asked for it again, and hears it again only where that form has a
   * summary (summaryPromptId), which reads every slot back before a yes arms a write. A form without
   * one completes on the carried value unread, so carry a slot into such a form only where that is
   * harmless (e.g. an ID carried into a form that only hands off), and give a form that writes from
   * a carried value a summary.
   */
  carrySlots?: readonly SlotId[];
  /**
   * What an intent the model is unsure of gets, for every intent that does not say (IntentDef.unsure):
   * outside a form, a reading from INTENT_EXPLICIT up to INTENT_IMPLICIT is confirmed (`confirm`,
   * "Just to check, do you want to ...?") or taken as no match (`no-match`: the no-match line,
   * counted, as a reading below the band). A form intent, an informational one and `done` alike.
   * Without it, `confirm`.
   */
  unsureIntent?: UnsureIntent;
  /**
   * The app's own named thresholds and their defaults (e.g. how sure the model must be of a part
   * of the day before a hook keeps it), read where the engine's are: TurnContext.thresholds and
   * SlotContext.thresholds carry them beside the engine's, and a run's `--threshold NAME=VALUE`
   * overrides one like any other. A name may not be the engine's. Without it, none.
   */
  thresholds?: Readonly<Record<string, number>>;
  /**
   * Fields of the app's own for the caller record the decision model is sent with each turn
   * (TurnState.caller; e.g. whether the caller has a booking open), after the engine's, which win a
   * shared name. Sent to the model as it is, so a change re-keys a recorded cassette. Without it,
   * the engine's fields only.
   */
  callerState?(s: Session): Readonly<Record<string, string | number | boolean>>;
  /**
   * Perception questions of the app's own, asked beside the engine's and the slots' on a spoken turn
   * (e.g. a part of the day the caller volunteers, or a move along what a summary offers). The app
   * decides when each is asked, from the session (s.form, s.pendingConfirmation, s.menuActive); an
   * empty map asks none. An id the engine or a slot asks throws. Their answers reach the app's form
   * hooks (FormDef.onAnswers, onSummaryAnswer, keepsSlot). Each question is sent to the model as
   * it is, so a change to one re-keys a recorded cassette. Without it, the app asks none.
   *
   * Naming: the engine's ids are reserved (core/questions.ts ENGINE_QUESTION_IDS), and so is every id
   * any of the app's slots asks (SlotSpec.questions, by convention the slot's id and a part: `dobMonth`,
   * `nameSpan`). An app question's id names what it asks (`timeOfDay`, `timePreference`) and never
   * reuses a slot question's id, even one whose slot is not on the same form: the collision throws
   * only on a turn that asks both, so it would surface mid-call rather than at registration.
   * validateApp cannot catch it, since the app's questions are built per turn; an id a slot declares
   * (SlotSpec.questionIds) throws on any turn that asks the app's question, whether or not the slot
   * is asked on it.
   */
  questions?(s: Session, ctx: SlotContext): QuestionMap;
  /** The app's name and mark on the console. Without it, the app id. */
  brand?: AppBrand;
  /** What the operator console shows in the app's words. Without it, the app's ids and neutral words. */
  console?: ConsoleConfig;
  /** The phone line's speech hints and digit spelling. Without it, number words only, and no digits spelled out. */
  voice?: VoiceConfig;
  /** The handoff note's words about the app's domain. Without it, neutral words. */
  handoff?: HandoffWording;
  /** The prompt manifest and voice tags, plus the spoken vocabulary that gets a clip of its own. */
  prompts: {
    /** Every line, in the app's default locale (App.locales.default; en-US for an app without locales). */
    manifest: Record<string, { text: string; interruptible: boolean }>;
    /** Per-clip voice tags for the clip generator (clip id to tag, e.g. "[calm]"); the tag syntax is the TTS provider's. */
    tags: Record<string, string>;
    /**
     * The spoken values that need a recorded clip of their own, in recording order (e.g. each form
     * intent's label, then each day part's display). A prompt variable named in `vars` that is
     * rendered as exactly `text` plays clip `id` in place of TTS; a value not listed is spoken by TTS.
     * Without it the app has no vocabulary clips.
     */
    vocabulary?: ReadonlyArray<{ id: string; text: string; vars: readonly string[] }>;
    /**
     * Prompt variables always spoken by TTS, as composed values with no clip (e.g. the account ID,
     * dates, a parcel number, the phone's last four). Each must end its clause in a recorded line
     * (prompts/segments.ts seamViolations). Without it, none.
     */
    spokenVars?: readonly string[];
    /**
     * Prompt variables that carry data read from a tool or a knowledge base (e.g. a parcel's
     * status, amount and owner, a passage's approved answer). A line with one is spoken whole by
     * TTS: never recorded, never split into clips (prompts/segments.ts ttsOnly). Without it, none.
     */
    dataVars?: readonly string[];
    /**
     * The opening line's prompt ids by case. `voice`: any channel that speaks. On a text channel:
     * `chat` for an anonymous visitor, `chatSignedIn` (with `{first}`) for a signed-in subject,
     * `chatDelegate` (with `{first}`) for a signed-in delegate. Each defaults to `greeting`,
     * `greeting_chat`, `greeting_chat_signed_in`, `greeting_chat_delegate` respectively.
     */
    greetings?: { voice?: string; chat?: string; chatSignedIn?: string; chatDelegate?: string };
  };
  /**
   * The languages the app speaks. A session speaks one of them (Session.locale): the default, or the
   * one its start names (SessionStart.locale) where the app has it; a line is said from the session's
   * locale and, where that locale leaves the line out, from the default (prompts.manifest). Without
   * it the app speaks one language, en-US, and its sessions carry no locale: the session, the trace
   * and the console are exactly as they were before locales.
   */
  locales?: AppLocales;
  /**
   * The principals the app's people sign in as (a subject at a level, a delegate by id). The engine
   * reads it in its harness only: a scenario's or corpus entry's `as` (a delegate) and a scenario's
   * `signIn` step (a subject) name their principal through it. An app's own sign-in routes (its
   * portals) read it too. Without it no scenario or corpus entry can sign anyone in.
   */
  principals?: PrincipalDirectory;
  /**
   * The app's portals: who is listed for sign-in and how a portal token is made and checked. For an
   * app's own routes (e.g. its chat pages); the engine never reads it.
   */
  portal?: PortalConfig;
  /**
   * For the regression harness and the decision-model stubs only, never read by the real model
   * path (the stub clients, JEV_CLIENT=stub, do read them): what the
   * corpus checks its labels against, how a corpus entry's mid-call state is seeded, the stubs'
   * domain heuristics and the labels the fixture stub reads, what replay keys for a masked digit,
   * and the keypad baseline the metrics compare a completion against. Without it the corpus checks
   * no slot label beyond its slot id, an entry spoken mid-call cannot be seeded (only no_form
   * entries run), the stubs answer with their generic heuristics only, and every baseline is 0.
   */
  testing?: TestingHooks;
  /**
   * Where the app's regression fixtures live, for the harness, the stubs and the clients that read
   * them (src/run/fixtures.ts). Without it the harness has no fixtures to run against and says so.
   */
  fixtures?: AppFixtures;
  /**
   * The app's knowledge base (an app folder's kb/, which defineApp loads; ../../kb/types.ts), and its
   * retriever (its code's, or the engine's default, kb/hybrid.ts): short approved passages, resolved for the caller and the day
   * (kb/resolve.ts resolvePassage) and said word for word. Without it the app answers no general
   * questions from passages, and every turn is exactly as it was before knowledge bases.
   */
  knowledge?: AppKnowledge;
  /**
   * The content hashes of the configuration the app was built from (an app folder's YAML; defineApp
   * sets them). The engine records them once per call, in the call_started audit row, and puts the
   * combined hash on every trace record, so a call can be tied to the policy and prompts in force.
   * They are never sent to the model. Without it, the audit rows, the traces and the console are
   * exactly as they were before configuration hashes.
   */
  configHashes?: ConfigHashes;
}

/**
 * The content hashes of an app's configuration files (App.configHashes; core/app/configHash.ts).
 * Each is a SHA-256, 64 lowercase hex characters, of the file's parsed content as JSON with object
 * keys in document order at every level, arrays in order and no whitespace: comments, whitespace,
 * flow or block style and quoting do not change it; any value does, and so does the order of keys
 * (slots.yaml's key order is the app's slot order).
 */
export interface ConfigHashes {
  /** The combined hash: SHA-256 of the files' `<file>:<hash>` lines, sorted by file and joined by newlines (configHashLines). */
  readonly app: string;
  /** Each file's hash, by its path in the app folder (app.yaml, policy.yaml, locale/es/prompts.yaml, ...). */
  readonly files: Readonly<Record<string, string>>;
}

/** One line as a manifest holds it (App.prompts.manifest, AppLocales.prompts). */
export interface PromptManifestEntry {
  text: string;
  interruptible: boolean;
}

/** The languages an app speaks (App.locales). */
export interface AppLocales {
  /** The locale of App.prompts.manifest, a language tag (e.g. en-US): what a session speaks unless its start names another the app has. */
  readonly default: string;
  /**
   * The lines of each other locale, by language tag (e.g. es, pt-BR), then prompt id. A locale need
   * not have every line: one it leaves out is said from App.prompts.manifest. Never the default locale.
   */
  readonly prompts: Readonly<Record<string, Readonly<Record<string, PromptManifestEntry>>>>;
}

/**
 * The app's regression fixtures, as paths under the working directory. Under `dir` the harness
 * reads `corpus.jsonl`, `scenarios/*.json` (the scripted calls), `expected/` (the label-derived
 * baseline) and `recorded/<model>.jsonl` (the model cassette).
 */
export interface AppFixtures {
  readonly dir: string;
}

/**
 * The principals the app's people act as, for the engine's harness (App.principals). Each returns
 * null for an id that is not one; a principal of the wrong kind or level is the app's error, and the
 * harness refuses it.
 */
export interface PrincipalDirectory {
  /** The principal a subject signs in as, at `level` (e.g. a customer by account ID). Read for a scenario's `signIn` step, at the level a sign-in proves (IdentityConfig.signInLevel). */
  subjectPrincipal?(id: string, level: 1 | 2): Party | null;
  /** The principal a delegate signs in as (e.g. depot staff by id). Read for a scenario's or corpus entry's `as`. */
  delegatePrincipal?(id: string): Party | null;
  /**
   * The principal the token claims of a verified sign-in name, for an app that maps token claims its own way:
   * a delegate (someone on staff signing in to the chat), a subject by a token claim the identity's
   * `signIn.claim` cannot express, or null to fall back to that rule (the id in the token claim, through
   * subjectPrincipal). Read by the engine's web chat (server/chat/signin.ts), first, for every token it
   * has verified. The token claims come from the site's identity provider, signed, but are still the app's to
   * check (a role, a tenant). What it returns is checked as the harness checks a principal: a subject
   * at the sign-in level, or a delegate of the declared kind and roles.
   */
  fromClaims?(payload: Readonly<Record<string, unknown>>): Party | null;
}

/** One of the app's subjects who may sign in through a portal, as the chat shows them once signed in. */
export interface SubjectListing {
  /** The id the sign-in names (e.g. the account ID). */
  readonly id: string;
  readonly first: string;
  readonly last: string;
}

/** Someone acting for the app's subjects (e.g. depot staff) who may sign in through a portal of their own. */
export interface DelegateListing {
  /** The id the sign-in names (e.g. "taylor"): unique, so a delegate has one live chat. */
  readonly id: string;
  readonly name: string;
  /** The app's own details about them (e.g. depot, depotId). */
  readonly attrs?: Readonly<Record<string, string>>;
  /** The app's role (e.g. viewer, clerk); see PolicyTables.roles. */
  readonly role: string;
}

/**
 * An app's portals (App.portal): for the app's own sign-in routes, never read by the engine. Typed
 * here so every app's portal routes have the same shape to read.
 */
export interface PortalConfig {
  /** The subjects who may sign in (e.g. a customer web chat's portal). Without it, none. */
  subjects?(): ReadonlyArray<SubjectListing>;
  /** The delegates who may sign in (e.g. a staff chat's portal). Without it, none. */
  delegates?(): ReadonlyArray<DelegateListing>;
  /** A delegate's role as the app's chat page shows it (display only). Without it, the role itself. */
  roleLabel?(role: string): string;
  /**
   * The delegate portal's signed sign-in token: `sign` makes one for a listed delegate (null for an
   * id that is not one), `verify` checks one and returns the delegate id it proves, or null. Without
   * it, no delegate can sign in through a token.
   */
  delegateToken?: {
    sign(delegateId: string, secret: string, nowSec: number, ttlSec: number): string | null;
    verify(token: string, secret: string, nowSec: number): string | null;
  };
}

/**
 * A corpus entry's slot labels as the corpus file carries them (CorpusEntry.slots), keyed by slot
 * id. Their shape is the app's own: the engine checks only that each key is a slot, and hands the
 * labels to the app's testing hooks.
 */
export type CorpusSlotLabels = Readonly<Record<string, unknown>>;

/** What a heuristic is told besides the utterance: the run's date, pinned so the stub's answers do not drift with the calendar. */
export interface HeuristicContext {
  readonly todayIso: string;
}

/** The regression harness's and the decision-model stubs' view of an app. Never read by the real model path; the stub clients (JEV_CLIENT=stub) read it. */
export interface TestingHooks {
  /**
   * Checks a corpus entry's slot labels against what each slot's questions can offer (e.g. an
   * account ID span, a birthday, a knowledge-base topic, a day part). Throws, naming `entryId`, on a
   * label a question could never pick. The corpus has already checked that each is a slot id, and
   * one the entry's context listens for.
   */
  checkCorpusSlots?(entryId: string, text: string, slots: CorpusSlotLabels): void;
  /**
   * What a corpus entry spoken mid-call is seeded with (src/harness-text/runner.ts
   * seedCorpusSession); the seeding itself is the harness's. Without it, such an entry throws.
   */
  seed?: {
    /** The verified caller a seeded session in a form context is (e.g. a seed customer, signed in to level 2). */
    caller(): Principal;
    /** The stand-in for each slot a seeded form has already collected, identity factors included. */
    placeholders: Readonly<Record<SlotId, SlotCandidate>>;
    /**
     * For the anything_else context: the form just answered before "anything else?", and the call
     * that answered it, made through the gate as the seed's own (e.g. getAccount, listParcels).
     * Without it, a corpus entry in that context throws.
     */
    anythingElse?(): { form: FormId; call: ToolCall };
  };
  /** The heuristic stub's domain answers (src/jev/heuristicStub.ts; the building blocks are src/jev/heuristicKit.ts). */
  heuristics?: {
    /**
     * By choice-question id: the label `text` most likely picks among `labels` (null: none) and the
     * probability the stub puts on it. Consulted before the stub's own heuristics.
     */
    choice?: Readonly<Record<string, (text: string, labels: readonly string[], ctx: HeuristicContext) => { label: string | null; p: number }>>;
    /** By yes-or-no question id: the probability that `text` says yes. Consulted before the stub's own. */
    noul?: Readonly<Record<string, (text: string, ctx: HeuristicContext) => number>>;
    /**
     * The app's own intents' keywords, in the order they win (the first match is the guess), ahead
     * of the stub's own for the control intents (done, agent, repeat).
     */
    intents?: ReadonlyArray<readonly [Intent, RegExp]>;
    /**
     * The organization's name in lower case (e.g. "example parcels"), as a caller who says they are
     * from it ("i'm an example parcels supervisor") is told by the injection screen's stand-in.
     */
    organization?: string;
  };
  /**
   * The fixture stub's answers from a corpus entry's slot labels (src/jev/fixtureStub.ts), by
   * question id; a question the app does not list is answered by the stub's generic labels.
   */
  labeled?: {
    /** Choice questions: the label the entry's slots pick (undefined: none). One the question does not offer is a quiet none. */
    choice?: Readonly<Record<string, (slots: CorpusSlotLabels) => string | undefined>>;
    /**
     * Choice questions that pick a span of the text: the span the entry's slots name, which the
     * question must offer (else the corpus entry is wrong and the stub throws naming it as `what`).
     */
    spans?: Readonly<Record<string, { what: string; span(slots: CorpusSlotLabels): string | undefined }>>;
    /** Yes-or-no questions: the probability the entry's slots give. */
    noul?: Readonly<Record<string, (slots: CorpusSlotLabels) => number>>;
  };
  /**
   * The probability a yes-or-no question gets when nothing in the utterance bears on it, for the
   * app's own questions (the stubs' defaults cover the engine's). Without it, the stubs' defaults.
   */
  quietNoul?: Readonly<Record<string, number>>;
  /** The form a corpus entry in the offer_transfer context is seeded inside, so a declined offer has a question to return to. Without it, that context is unknown. */
  offerTransferForm?: FormId;
  /**
   * What replay keys for a digit the frame log has masked (src/harness-text/replay.ts). Without it,
   * the digit '0' for any.
   */
  replay?: {
    /** By identity slot: the digits keyed, in order, for a masked digit at that slot's keypad question. */
    identityKeys?: Readonly<Record<SlotId, string>>;
    /** The digit keyed for a masked one-time-code digit (one the app's verifier accepts). */
    codeDigit?: string;
  };
  /**
   * By service name: the answer the harness gives in place of the service (src/harness-text/runner.ts
   * followEffects; e.g. a depot agent's own triage rules). Without one, the service gives none.
   */
  serviceAnswers?: Readonly<Record<string, (params: Readonly<Record<string, string>>) => unknown>>;
  /** Caller turns each form takes on the keypad menu, which the metrics compare a completion against. Without it, 0. */
  dtmfBaseline?: Readonly<Record<FormId, number>>;
  /**
   * The principals and records the gate grid crosses with every tool (dialogwright/testing
   * gateGridInput): the policy's safety net, run by the app's own tests. Never read by a call.
   * Without it, the app has no grid.
   */
  policyMatrix?(): PolicyMatrix;
}

/**
 * The people and records an app's gate grid crosses with every tool, probe and purpose
 * (TestingHooks.policyMatrix). The grid adds an anonymous caller and an empty subject itself.
 */
export interface PolicyMatrix {
  readonly principals: {
    /** One of the app's subjects proven to level 1, and the same subject at level 2. */
    readonly subject1: Party;
    readonly subject2: Party;
    /** Someone acting for subjects, one per role the app's tables name (PolicyTables.roles), by role. Empty when the app has none. */
    readonly delegates: Readonly<Record<string, Party>>;
    /** A delegate whose role no table names. */
    readonly unlistedRole: Party;
    /** A delegate with no role. */
    readonly roleless: Party;
    /** A party who is neither one of the app's subjects nor of any delegate's kind. */
    readonly otherParty: Party;
  };
  /**
   * The subjects a call names, each as a subject id (for a tool whose PolicyTables.subjects row names
   * the subject) and as one of their records (for a row `via: 'record'`): the subject's own, another
   * subject the delegates act for, one no principal of the matrix may see, and one that does not exist.
   */
  readonly records: Readonly<Record<'own' | 'inScope' | 'outOfScope' | 'unknown', PolicyMatrixSubject>>;
  /**
   * The params of a call, per tool, as named sets (e.g. a date an app's own rule passes and one it
   * fails); the grid sets the subject param. A tool without sets gets one, built from its subject
   * param, the confirmed fields (if it runs the confirmed rule) and its service fields, each valued from `values`.
   */
  readonly calls?: Readonly<Record<ToolName, Readonly<Record<string, Readonly<Record<string, string>>>>>>;
  /** A value per param name for the calls the grid builds; any other param is 'x'. */
  readonly values?: Readonly<Record<string, string>>;
  /** The day the grid's facts carry (GateFacts.todayIso). Default 2026-09-18, the regression's day. */
  readonly todayIso?: string;
  /**
   * The lookups the grid evaluates against. Default: a fresh copy of the app's (App.systems). An app
   * whose seed data has no record outside every principal's scope may add one here, over its own.
   */
  lookups?(): GateLookups;
}

/** A subject a grid call names: their id, and the id of one of their records. */
export interface PolicyMatrixSubject {
  readonly subject: string;
  /** One of the subject's records: needed only by a policy with a scope rule on a record (`scope: { record }`). */
  readonly record?: string;
}
