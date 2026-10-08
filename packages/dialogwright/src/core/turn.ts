import { isAnonymous, isParty, type GateDecision } from '../gate/types';
import { confirmationHash } from '../gate/policy';
import { noulValue, type AnswerMap, type QuestionMap } from '../jev/types';
import type { Action } from '../channel/actions';
import type { SessionEvent, UserSpeech, UserText } from '../channel/events';
import type { SlotCandidate, SlotContext } from './slots/types';
import { informationOf, intentLabel, isFormIntent, type Informs } from './app/intents';
import { informationalAnswer, offerAfterUnavailable, type InformationalAnswer } from '../kb/answer';
import { anythingElseSilenceOf, correctsFormOf, formOf, handoffUnconfirmedOf, identityOf, listenOf, slotSpecOf } from './app/lookup';
import { appOf } from './app/registry';
import type { App, CheckOutcome, Completion, FormCheck, FormId, SlotId, SummaryMove } from './app/types';
import { candidateSpans, candidateWordSpans } from './spans';
import { closeForm, cloneSession, emptySlot, missingSlots, setForm, type PendingConfirmation, type Session } from './session';
import { buildTurnState, type TurnState } from './state';
import { buildQuestions, callerMatchAsked } from './questions';
import { evaluateGates, frustrationOf, type FrustrationRung, type GateRow, type Verdict } from './gates';
import { activeSlots, applyDtmf, fillSlots, nextPrompt, pendingSlotConfirmation, retryStep, slotsToFill, valuesGiven, type Ack, type FillEvent, type FillResult, type RetryStep } from './fia';
import { askSlot, handoff, offerTransfer, prompt, type CompleteDecision, type Decision, type PromptDecision } from './decision';
import { appContext, askCallerMatch, askCode, awaitingSignIn, CALLER_MATCH_PROMPT, callerMatchOf, callTool, completion, continueIdentity, sendCodeAndAsk, ensureEntry, handleCodeDigit, newTurnOut, noteCallerMatch, stepUp, takeSummaryHash, type CallerMatchOutcome, type Effect, type GateEvent, type KbSource, type OfferSettled, type TurnOut } from './lifecycle';
import { checkEnding, checkHash, outcomeOf, runChecks, type CheckReconfirmed, type FormStopped } from './checks';
import { callerCandidate, callerNumberSlots, hintsCallerNumber, keptCalledNumber, keptCallerNumber, lastFour, skipsIfNone, skipsOnNo } from './callerNumber';
import { factsCandidate, factsOfferSlots, greetingOfferPromptId, greetingOfferSlots } from './factsOffer';
import { recordedValue, recordingOf } from './recording';
import type { Tools } from './tools';
import { atLeast, withAppThresholds, type Thresholds } from './thresholds';
import type { ScreenResult } from './screen';
import { auditDrafts } from './audit';
import type { AuditDraft } from '../audit/types';
import { decisionToActions, promptText, spokenText, type RenderContext } from '../prompts/render';
import { saidCode } from './spokenCode';
import { defaultLocaleOf, matchLocale, slotLocaleOf, speechLanguagesOf } from './locale';
import type { TurnKnowledge } from './knowledge';
import type { Nomination } from '../kb/types';

export interface TurnContext {
  nowMs: number;
  todayIso: string;
  thresholds: Thresholds;
  /** The systems a turn may reach, only ever through the gate (lifecycle.ts callTool). */
  tools: Tools;
  render?: RenderContext | null;
  /**
   * For a keypad event: its class as decided once, when the digit arrived (ArrivalDigit). The
   * server's recording and this turn's handling both follow it, and a digit whose class at arrival
   * is not its class now (the prompt moved under it) is ignored rather than keyed into whatever the
   * prompt became. Unset, it is decided from the session the turn runs on, which is the same moment
   * for a caller that runs each event as it arrives (the harness, the CLI).
   */
  digitClass?: ArrivalDigit;
  /**
   * For a keypad event: `promptedFor` when the digit arrived. A digit answers the question it was
   * keyed at, so one whose question has moved on by the time its turn runs is ignored, even where
   * the class is the same: a account ID digit keyed while the spoken account ID was being taken is
   * not keyed into the date of birth. Unset, not checked (the same moment, as above).
   */
  digitPromptedFor?: Session['promptedFor'];
  /**
   * For a digit keyed 'ahead': promptEpoch(session) when it arrived. It is ignored only if a prompt
   * was spoken since (the epoch moved): a turn that said nothing (an echo transcribed and ignored,
   * a silence turn the keypress cancelled) left the caller answering the question they heard. Unset,
   * an 'ahead' digit is never keyed.
   */
  digitEpoch?: number;
  /**
   * Whether the event arrived while a downstream service's answer was awaited (session.pendingService
   * set, as it stood then). Such a prompt, digit or silence is ignored even when its turn runs after
   * the answer is in: the caller had not yet heard what the answer's turn asks. Unset, false.
   */
  duringService?: boolean;
  /**
   * What retrieval nominated for this turn's words (core/knowledge.ts TurnKnowledge), run once by
   * runTurn before the turn is planned, and only when a topic slot is listening (topicsListening):
   * plan() and resolve() hand the same nominations to every slot's questions and fill
   * (SlotContext.nominated). Absent on every other turn and for an app without a knowledge base; a
   * caller that plans or resolves without runTurn passes it to give a turn nominations.
   */
  knowledge?: TurnKnowledge;
}

/**
 * What a keypad digit is keyed into, when it is sensitive: a digit of the one-time code, or a digit
 * of the account ID or date of birth keyed at its question. Null for anything else.
 */
export type SensitiveDigit = 'code' | 'identity' | null;

/**
 * A keypad digit's class as the server decides it on arrival: its SensitiveDigit on the session as
 * it stood then, or 'ahead' for a digit keyed while a turn that can move the prompt (anything but a
 * keypad turn) was still in flight or queued. What that turn will ask is unknown, so an 'ahead'
 * digit is logged masked, like the account ID it may well be. It is keyed only if no prompt was
 * spoken between its arrival and its turn (TurnContext.digitEpoch), and then only as a digit that
 * is not sensitive where it lands; otherwise the caller hears the question and keys again.
 */
export type ArrivalDigit = SensitiveDigit | 'ahead';

/**
 * The call's prompt epoch: how many turns have spoken. `turnIndex` is exactly that, since bookkeep
 * counts every decision but `ignore` and `hold`, the two that send nothing.
 */
export function promptEpoch(session: Session): number {
  return session.turnIndex;
}

/**
 * The one predicate for "this keypad event is sensitive": a digit 0-9 keyed at the code prompt, or
 * at an identity factor's question (App.identity.factorSlots; e.g. the account ID or date of birth). Whoever records the event decides it with this, once,
 * and passes the answer on; every logged copy of a sensitive digit (the frame log, the trace, the
 * dashboard) is masked. The core itself still receives an identity digit as keyed, since it fills
 * the slot; a code digit is checked and forgotten (lifecycle.ts). `#` and `*` carry nothing.
 */
export function sensitiveDigit(session: Session, event: SessionEvent): SensitiveDigit {
  return sensitiveDigitAt(appOf(session), session.promptedFor, event);
}

/** sensitiveDigit at a given prompt of `app`'s: the class depends on nothing else. */
export function sensitiveDigitAt(app: App, promptedFor: Session['promptedFor'], event: SessionEvent): SensitiveDigit {
  if (event.type !== 'user.key' || !/^\d$/.test(event.digit)) return null;
  if (promptedFor === 'otp') return 'code';
  if (promptedFor !== null && identityOf(app).factorSlots.includes(promptedFor)) return 'identity';
  return null;
}

/** What a keypad turn needs of its arrival (TurnContext). */
export type DigitArrivalContext = Pick<TurnContext, 'digitClass' | 'digitPromptedFor' | 'digitEpoch' | 'duringService'>;

/**
 * How a keypad digit runs on `session`, the session its turn runs on, given what was decided when
 * it arrived: its SensitiveDigit where it lands, or 'ignored'. A digit is ignored when the call is
 * over or a downstream service's answer is (or was, on arrival) awaited; when its class on arrival is
 * not its class now, or the question it was keyed at is not the question now; and, keyed 'ahead',
 * when a prompt was spoken since it arrived or it would land somewhere sensitive. The one predicate
 * for it: the turn acts on it, and the server logs from it whether a digit keyed ahead was taken.
 */
export function digitAtRun(session: Session, event: SessionEvent, tc: DigitArrivalContext): SensitiveDigit | 'ignored' {
  if (session.ended || session.pendingService !== null || tc.duringService === true) return 'ignored';
  const now = sensitiveDigit(session, event);
  const arrived = tc.digitClass === undefined ? now : tc.digitClass;
  if (arrived === 'ahead') return now === null && tc.digitEpoch !== undefined && tc.digitEpoch === promptEpoch(session) ? null : 'ignored';
  if (arrived !== now) return 'ignored';
  if (tc.digitPromptedFor !== undefined && tc.digitPromptedFor !== session.promptedFor) return 'ignored';
  return now;
}

/** One turn's context and its outputs beside the decision, threaded through the handlers together. */
interface TurnIO {
  /** The session's app, resolved once for the turn. */
  app: App;
  tc: TurnContext;
  out: TurnOut;
  /** What the channel is asked to do before the turn's lines (a language switch's set_language), in order. */
  prefix: Action[];
  /** A words turn's state, as the gates read it: a turn at the greeting's proposal reads the request again from it (openingAfterOffer). */
  turnState?: TurnState;
  /** The slot this turn's answer to the greeting's proposal filled: the request said with it opens its form without filling it again. */
  kept?: SlotId;
  /** The gates' rows when a turn at the greeting's proposal read its words again as an opening turn (openingAfterOffer), for the debug table. */
  openingRows?: GateRow[];
}

export interface Plan {
  needsModel: boolean;
  turnState: TurnState | null;
  questions: QuestionMap | null;
}

export interface TurnError {
  name: string;
  message: string;
}

export interface TurnResult {
  session: Session;
  turnState: TurnState | null;
  rows: GateRow[];
  verdict: Verdict | null;
  fillEvents: FillEvent[];
  decision: Decision;
  /** what the channel is asked to do, in order */
  actions: Action[];
  /** every gate decision this turn, allowed or not, with what the tool returned */
  gateEvents: GateEvent[];
  /** the knowledge-base passage this turn's answer came from, if any */
  kb: KbSource | null;
  /** side effects for the runner or the server to perform after the turn */
  effects: Effect[];
  /** the form a check ended this turn (core/checks.ts); absent on every other turn */
  stopped?: FormStopped;
  /** the check whose read-back the caller said no to this turn (core/checks.ts); absent on every other turn */
  reconfirmed?: CheckReconfirmed;
  /** the offer of the caller's number this turn settled; absent on every other turn */
  offer?: OfferSettled;
  /** what became of the caller-ID match this turn (identity.yaml's callerId), in order; absent on every other turn */
  callerMatch?: CallerMatchOutcome[];
  /** what the injection screen made of this turn's words; null when it was not asked (no model turn) */
  screen: ScreenResult | null;
  /** the screen fired: perception's answers were discarded and nothing was filled, gated or called */
  quarantined: boolean;
  /** what this turn tells the audit log, in order; the runner appends them to the chain (core/audit.ts) */
  audit: AuditDraft[];
}

/** What the slot specs see of a turn's words and the session (exported for tests). */
export function slotContext(session: Session, text: string, tc: TurnContext): SlotContext {
  // What the app's slot specs read of its facts (e.g. the customer's parcels, once listParcels has
  // passed the gate; none before identity): one list, and lists by name for slots that name theirs.
  const given = appOf(session).facts?.forSlots?.(session.facts);
  // The spans are read in the session's language (none for an app without locales: English, as always).
  const locale = slotLocaleOf(session);
  return {
    text,
    candidateSpans: candidateSpans(text, locale),
    candidateWordSpans: candidateWordSpans(text, locale),
    todayIso: tc.todayIso,
    thresholds: tc.thresholds,
    records: given?.records ?? [],
    // Only for an app that names its lists: any other app's slots see the context they always have.
    ...(given?.sources !== undefined ? { sources: given.sources } : {}),
    // Never a real slot's window or prompt: fillSlots and buildQuestions each substitute a spec's
    // own slot's pending partial and `prompted` in via slotCtx (fia.ts) before calling
    // fill/questions, so no slot's fill or questions ever sees another slot's. applyDtmf shares
    // this base context unchanged; no spec's dtmf.parse reads either.
    window: null,
    current: null,
    prompted: false,
    // The session's language, only for an app that declares locales: any other app's slots see the
    // context they always have.
    ...withLocale(locale),
    // What retrieval nominated, only on a turn it ran for: any other turn's slots see the context
    // they always have.
    ...(tc.knowledge !== undefined ? { nominated: tc.knowledge.nominated } : {}),
  };
}

/**
 * The turn context for a slot context built from words other than this turn's (an intent confirmed
 * by a yes fills from what was said before it): this turn's nominations, retrieved for the yes, do not
 * describe those words, so they are replaced by the ones retrieved for the words themselves on their
 * own turn (`nominated`, kept with the pending confirmation), or dropped when none were.
 */
function knowledgeOfWords(tc: TurnContext, nominated: readonly Nomination[] | undefined): TurnContext {
  const { knowledge: _, ...rest } = tc;
  if (nominated !== undefined) return { ...rest, knowledge: { nominated } };
  return tc.knowledge === undefined ? tc : rest;
}

const withLocale = (locale: string | undefined): { locale?: string } => (locale === undefined ? {} : { locale });

/** Gate 8's threshold per slot kind: a detected slot (SlotSpec.detect) against SLOT_DETECT, a picked one against SLOT_CHOICE_CONFIRM. */
function slotThreshold(app: App, slot: SlotId, t: Thresholds): number {
  return slotSpecOf(app, slot).detect === true ? t.SLOT_DETECT : t.SLOT_CHOICE_CONFIRM;
}

/** One row per slot the turn tried to fill, so the debug table is complete. */
function slotRows(app: App, events: FillEvent[], t: Thresholds): GateRow[] {
  return events.map(({ slot, outcome }) => ({
    gate: `slot:${slot}`,
    value: outcome.kind === 'filled' || outcome.kind === 'window' ? outcome.confidence : null,
    threshold: slotThreshold(app, slot, t),
    passed: outcome.kind === 'filled' || outcome.kind === 'window' || outcome.kind === 'disambiguate' || outcome.kind === 'help',
    outcome: outcome.kind === 'invalid' ? `${outcome.kind}:${outcome.reason}` : outcome.kind,
    decided: false,
  }));
}

/** A keypad fill answers no question, so it carries neither a confidence nor a threshold. */
function dtmfRow(slot: SlotId): GateRow {
  return { gate: `slot:${slot}`, value: null, threshold: null, passed: true, outcome: 'dtmf', decided: false };
}

// Only words (a 'user.speech' or 'user.text' event) ever need the model: 'session.start',
// 'user.key', 'user.interrupt', 'channel.error', and the server-made 'user.silence', 'service.result'
// and 'auth.signed_in' events are all resolved from the session alone.
export function plan(session: Session, event: SessionEvent, turnContext: TurnContext): Plan {
  // While a downstream service's answer is awaited, or for words said during that wait, the turn is
  // ignored, so the model is not asked either.
  if ((event.type !== 'user.speech' && event.type !== 'user.text') || session.ended || session.pendingService !== null || turnContext.duringService === true) return { needsModel: false, turnState: null, questions: null };
  const tc = appTurnContext(appOf(session), turnContext);
  const turnState = buildTurnState(session, heard(session, event), tc.nowMs);
  const questions = buildQuestions(session, slotContext(session, event.text, tc));
  return { needsModel: true, turnState, questions };
}

/**
 * What the model is told was heard: the words, whether they are final, and the keys pressed so
 * far. Typed text is always final, exactly as a final transcript is.
 */
function heard(s: Session, event: UserSpeech | UserText): { text: string; isFinal: boolean; dtmf: string | null } {
  return { text: event.text, isFinal: event.type === 'user.text' ? true : event.final, dtmf: s.dtmfBuffer || null };
}

/**
 * The turn's context as the app's code reads it: with the app's own thresholds (App.thresholds)
 * under the run's, so a run that overrides one keeps its value. The context itself for an app
 * without any.
 */
export function appTurnContext(app: App, tc: TurnContext): TurnContext {
  return app.thresholds ? { ...tc, thresholds: withAppThresholds(tc.thresholds, app.thresholds) } : tc;
}

/** The summary's variables: every slot's display, empty when unfilled. */
export function summaryVars(s: Session): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [id, slot] of Object.entries(s.slots)) vars[id] = slot.display ?? '';
  return vars;
}

/**
 * Everything the summary stands for, as one comparable value: every slot's value, not its display,
 * since a display can stay the same while the value moves (a statement always reads back as "your
 * description"); and every slot's window too, so a narrowing (a dob month/day pending its year, a
 * date window pending its day) counts as progress.
 */
function summaryState(s: Session): string {
  return JSON.stringify(Object.keys(appOf(s).slots).map((id) => [id, s.slots[id]!.value, s.slots[id]!.window] as const));
}

/**
 * A correction to a form the caller has already been read back. It only counts as progress when
 * it changes something: repeating the value the summary just said is a turn the caller spent not
 * answering the question, and it must walk the ladder rather than reset it.
 */
function correctingFill(s: Session, answers: AnswerMap, ctx: SlotContext, form: FormId): FillResult {
  const app = appOf(s);
  const before = summaryState(s);
  const fill = fillSlots(s, answers, ctx, formOf(app, form).slots.map((id) => slotSpecOf(app, id)), { correcting: true });
  // A disambiguation changes no slot yet and still has to be asked, so it is progress either way.
  if (!fill.progress || fill.disambiguate || summaryState(s) !== before) return fill;
  return { ...fill, progress: false };
}

/**
 * The slots of a form read back to the caller that this turn's words would give a new value, read
 * as correctingFill would fill them but without filling anything: the gates read it before the
 * verdict is settled (evaluateGates `given`). Empty unless a summary is pending.
 */
function summaryValuesGiven(s: Session, answers: AnswerMap, ctx: SlotContext): ReadonlySet<SlotId> {
  const pc = s.pendingConfirmation;
  if (pc?.target !== 'form') return new Set();
  const app = appOf(s);
  return valuesGiven(s, answers, ctx, formOf(app, pc.form).slots.map((id) => slotSpecOf(app, id)), { correcting: true });
}

/**
 * The summary question. Only a form that has one ever sets a form confirmation (askSummary). Each
 * time it is spoken, the hash of exactly what it reads back is taken, for the caller's yes to arm.
 */
function summaryPrompt(s: Session, form: FormId, acks: Ack[]): PromptDecision {
  const promptId = formOf(appOf(s), form).summaryPromptId;
  if (promptId === null) throw new Error(`form ${form} has no summary prompt`);
  takeSummaryHash(s, form);
  return prompt(promptId, 'confirm', summaryVars(s), acks, ['yes', 'no']);
}

/**
 * The decision as it is spoken: one that reads a form's pending summary (its summaryPromptId) is
 * read through the form's summary hook (FormDef.onSummaryRead). Applied once per turn, to the decision the
 * turn settled on: after the frustration step, so a summary the transfer offer replaced is neither
 * read nor rendered.
 */
function readSummary(s: Session, decision: Decision, io: TurnIO): Decision {
  if (decision.kind !== 'prompt') return decision;
  const pc = s.pendingConfirmation;
  if (pc?.target !== 'form' || decision.promptId !== formOf(io.app, pc.form).summaryPromptId) return decision;
  return renderSummary(s, decision, io.tc, io.out);
}

/**
 * The pending summary `decision` reads, through the form's summary hook (FormDef.onSummaryRead): its vars
 * over the slots' displays, its acks last, and the prompt it is read as, recorded on the pending
 * confirmation (readAs) so the keypad takes it as the summary. The hash a yes arms is taken here,
 * after the hook, since the hook may have moved what the summary names. Also how a corpus entry
 * seeded at the summary has it read (harness-text/runner.ts). `decision` itself for a form without
 * a hook, its hash taken all the same.
 */
export function renderSummary(s: Session, decision: PromptDecision, tc: TurnContext, out: TurnOut): PromptDecision {
  const pc = s.pendingConfirmation;
  if (pc?.target !== 'form') return decision;
  const def = formOf(appOf(s), pc.form);
  const read = def.onSummaryRead?.({ ...appContext(s, tc, out), acks: decision.acks }) ?? null;
  takeSummaryHash(s, pc.form);
  delete pc.readAs;
  if (read === null) return decision;
  const promptId = read.promptId ?? decision.promptId;
  if (promptId !== decision.promptId) pc.readAs = promptId;
  return { ...decision, promptId, vars: { ...summaryVars(s), ...read.vars }, acks: [...decision.acks, ...(read.acks ?? [])] };
}

/** The form is full: ask the summary question instead of completing. */
function askSummary(s: Session, form: FormId, acks: Ack[], io: TurnIO): Decision {
  // A form without a summary has nothing to confirm: it completes as soon as it is full.
  if (formOf(io.app, form).summaryPromptId === null) return completeForm(s, form, acks, io);
  s.pendingConfirmation = { target: 'form', form, attempts: 0 };
  return summaryPrompt(s, form, acks);
}

/**
 * "What should I change?", which takes the place of one re-ask: it occupies the ladder's first
 * rung so that three answers with nothing usable in them still reach an agent.
 */
function askChange(pc: Extract<PendingConfirmation, { target: 'form' }>, acks: Ack[]): PromptDecision {
  pc.askedChange = true;
  pc.attempts = Math.max(pc.attempts, 1);
  return prompt('ask_change', 'confirm', {}, acks);
}

/** Add an intent the caller asked for on the side; returns the ack to speak, if it was new. */
function enqueue(s: Session, intent: FormId | undefined): Ack[] {
  if (intent === undefined || intent === s.form || s.queued.includes(intent)) return [];
  s.queued.push(intent);
  return [{ promptId: 'ack_queued', vars: { intentLabel: intentLabel(appOf(s), intent) } }];
}

/** No slot agreed to at a summary: a completion with no summary's yes behind it. */
const NONE_AGREED: ReadonlySet<SlotId> = new Set();

/** The open form's values, by slot, as they stand: what heldAsRead compares a yes's fill against. */
function formValues(s: Session, form: FormId): Record<SlotId, string | null> {
  return Object.fromEntries(formOf(appOf(s), form).slots.map((id) => [id, s.slots[id]!.value]));
}

/**
 * The slots of `form` the caller said yes to as the summary read them: filled, and holding the value
 * they held before the yes's own words filled anything (`before`, formValues). A value the yes
 * changed ("yes, but I rent") was never read back, so it is not among them.
 */
function heldAsRead(s: Session, form: FormId, before: Record<SlotId, string | null>): Set<SlotId> {
  return new Set(formOf(appOf(s), form).slots.filter((id) => s.slots[id]!.value !== null && s.slots[id]!.value === before[id]));
}

/**
 * The form is full and confirmed: its completion answers through the gate (lifecycle.ts), then
 * the call continues. A completion that takes the turn itself returns its decision as it is, and
 * the form is finished later: by a downstream service's answer (service_result), or by the answer to
 * the transfer it offered (declineTransfer). `agreed` are the slots the caller said yes to as the
 * summary read them (heldAsRead), which a check's refusal does not read back again (stopForm).
 */
function completeForm(s: Session, form: FormId, acks: Ack[], io: TurnIO, agreed: ReadonlySet<SlotId> = NONE_AGREED): Decision {
  // The form's checks first: a yes that changed what one reads ("yes, but I rent") is refused here,
  // with the check's own line, and the write is never attempted.
  const checks = runChecks(s, form, io.tc, io.out);
  if (checks.kind !== 'passed') return stopForm(s, form, checks, acks, io, agreed);
  const c = completion(s, form, [...acks, ...passedAcks(s, checks)], io.tc, io.out);
  switch (c.kind) {
    case 'said':
      return finishForm(s, form, c.acks, io);
    case 'end':
      // A request is waiting: the completion's line is said, and the call goes on to it.
      if (s.queued.length > 0) return finishForm(s, form, [...c.acks, { promptId: c.promptId, vars: c.vars }], io);
      return endOnCompletion(s, form, c);
    case 'refused':
      return finishForm(s, form, c.acks, io, false);
    case 'reconfirm':
      // The values moved after the summary was read: the form loop reads it again.
      return continueForm(s, io, c.acks, null);
    case 'decision':
      return c.decision;
  }
}

/**
 * The caller said yes to `form`'s summary and the form completed: each of its filled slots' values is
 * agreed (Session.agreed), so a handoff later in the call counts it as confirmed while it holds that
 * value (HandoffData.unconfirmed). Only for an app whose handoff marks or leaves out the values never
 * confirmed, and only for a form with a summary; every other session is as it was. The slot's own
 * `confirmed` flag is left alone: it is part of what the model is sent each turn.
 */
function agree(s: Session, form: FormId): void {
  const app = appOf(s);
  const def = formOf(app, form);
  if (handoffUnconfirmedOf(app) === 'send' || def.summaryPromptId === null) return;
  // An identity factor, and a slot handed over only as `verified`, is never counted (unconfirmedSlots),
  // so no copy of its value is kept.
  const factors = identityOf(app).factorSlots;
  const agreed: Record<SlotId, string> = { ...(s.agreed ?? {}) };
  for (const id of def.slots) {
    const value = s.slots[id]!.value;
    if (value !== null && !factors.includes(id) && slotSpecOf(app, id).handoff !== 'verified') agreed[id] = value;
  }
  s.agreed = agreed;
}

/**
 * The caller's yes to `form`'s summary, spoken or keyed, with the slots still holding what it read:
 * the turn's own words changed none of them (`unchanged`), and, for a form whose write the summary
 * arms (FormDef.confirmedParams), its hash is still the one taken as it was read. Agreed then
 * (agree), before the completion runs, so a completion that hands the call to a person at once, or a
 * check or the gate that ends the form, still counts what the caller said yes to as confirmed. A yes
 * that changed a value ("yes, but it was Sunday") is agreed only if the form then completes
 * (finishForm), as before.
 */
function agreeAsRead(s: Session, form: FormId, unchanged: boolean): void {
  const app = appOf(s);
  if (!unchanged || handoffUnconfirmedOf(app) === 'send') return;
  const params = s.pendingHash !== null ? formOf(app, form).confirmedParams?.(s) : undefined;
  if (params !== undefined && confirmationHash(params, app.policy.confirmedFields) !== s.pendingHash) return;
  agree(s, form);
}

/**
 * A completion that ends the call (Completion `end`): the form is counted, and it and its slots stay
 * on the session as they were, the filled ones confirmed where the form has a summary, since the
 * caller has just agreed to it.
 */
function endOnCompletion(s: Session, form: FormId, c: Extract<Completion, { kind: 'end' }>): CompleteDecision {
  s.completed.push(form);
  const def = formOf(appOf(s), form);
  if (def.summaryPromptId !== null) for (const id of def.slots) if (s.slots[id]!.value !== null) s.slots[id]!.confirmed = true;
  agree(s, form);
  return { kind: 'complete', form, promptId: c.promptId, vars: c.vars, acks: c.acks, completed: [...s.completed] };
}

/**
 * Close a form and carry on: the next queued intent, bridged into, or "anything else?". Identity,
 * the app's facts, the identity slots and the slots the app carries stay; the form's other slots,
 * its entry and any confirmation go (closeForm). `completed` is false for a form the gate refused:
 * it closes the same way but is not reported as completed.
 */
function finishForm(s: Session, form: FormId, acks: Ack[], io: TurnIO, completed = true): Decision {
  if (completed) {
    s.completed.push(form);
    agree(s, form);
  }
  closeForm(s);
  const next = s.queued.shift();
  if (!next) return prompt('anything_else', 'intent', {}, acks);
  setForm(s, next);
  // The request was added on this very turn, so the caller already hears it bridged into;
  // promising it "after this" as well would say the same thing twice.
  const label = intentLabel(io.app, next);
  const kept = acks.filter((a) => !(a.promptId === 'ack_queued' && a.vars.intentLabel === label));
  return continueForm(s, io, [...kept, { promptId: 'bridge_next', vars: { intentLabel: label } }], null);
}

/** "Thanks for calling Example Parcels. Goodbye." (or "chatting", on a chat): the caller said they are done. */
function goodbye(s: Session, acks: Ack[] = []): CompleteDecision {
  return { kind: 'complete', form: null, promptId: s.caps.speech ? 'goodbye' : 'goodbye_chat', vars: {}, acks, completed: [...s.completed] };
}

/** `promptedFor` as an attempt/prompt target; before the first prompt the turn is an intent turn. */
function promptedTarget(s: Session): 'intent' | 'confirm' | 'otp' | SlotId {
  return s.promptedFor ?? 'intent';
}

/** The retry ladder's rung on this channel: a chat has no keypad, so its keypad rung is another plain re-ask. */
function rungFor(s: Session, attempts: number, t: Thresholds): RetryStep {
  const step = retryStep(attempts, t);
  return step === 'dtmf' && !s.caps.keypad ? 'open' : step;
}

/**
 * A turn at the code prompt that did not key a code: silence, a miss, or the code said aloud. It
 * walks the code prompt's own ladder (the code is never re-asked forever), and a person at the end.
 */
function codeReask(s: Session, io: TurnIO, acks: Ack[], promptId: 'ask_otp' | 'ask_otp_spoken' | 'otp_spoken_reissued'): Decision {
  if (retryStep(++s.codeReasks, io.tc.thresholds) === 'agent') return handoff(s, 'max-attempts', acks);
  if (promptId === 'otp_spoken_reissued') return sendCodeAndAsk(s, io.tc, io.out, acks, true);
  return promptId === 'ask_otp' ? askCode(s, acks) : prompt(promptId, 'otp', {}, acks);
}

/**
 * `plain` is true only for a silence turn's first rung: the caller never heard anything to be
 * unintelligible about, so the re-ask is the plain question, not the "Sorry, ..." retry text
 * (`nomatch_open`/`ask_<slot>_retry`), which stays reserved for an answer that missed.
 * `intentQuestion` is that plain question for the intent: the opening one (`ask_intent`), or the one
 * the caller was asked instead (`anything_else`, App.anythingElseSilence).
 */
function failAttempt(s: Session, target: 'intent' | 'confirm' | 'otp' | SlotId, io: TurnIO, acks: Ack[] = [], plain = false, retryPromptId: string | null = null, intentQuestion = 'ask_intent'): Decision {
  const t = io.tc.thresholds;
  // A guard, not a path anything takes today: `nomatch` re-asks a pending confirmation before it
  // gets here and `proceed` maps a confirm target to a slot. Should a confirm turn reach it, the
  // summary's own ladder owns the attempt rather than the intent's.
  if (target === 'confirm') {
    if (s.pendingConfirmation?.target === 'form' || s.pendingConfirmation?.target === 'check') return reaskConfirmation(s, io, acks);
    target = 'intent';
  }
  // Waiting on the portal sign-in: whatever this was, the answer is the same, and it costs nothing.
  // Not only an intent turn: with the parked form still open, a reply that fills nothing is charged
  // to the form's next slot, though the only question the customer was asked is the sign-in.
  if (awaitingSignIn(s)) return prompt('signin_reminder', 'intent', {}, acks);
  if (target === 'otp') return codeReask(s, io, acks, 'ask_otp');
  const attempts = target === 'intent' ? ++s.intentAttempts : ++s.slots[target]!.attempts;
  const step = rungFor(s, attempts, t);
  if (step === 'agent') return handoff(s, 'max-attempts', acks);
  if (target === 'intent') {
    if (step === 'dtmf') return { ...prompt('nomatch_dtmf_menu', 'intent', {}, acks, io.app.menu.map((m) => m.digit)), menu: true };
    if (plain) return prompt(intentQuestion, 'intent', {}, acks);
    return prompt('nomatch_open', 'intent', {}, acks);
  }
  // A slot narrowed to a window re-asks the window question, not the generic retry:
  // "next week. Which day works for you?" is what the caller failed to answer.
  const window = s.slots[target]!.window;
  if (step === 'open' && window) return askSlot(s, target, window, acks);
  if (step === 'open' && plain) return askedAgain(s, target, acks);
  // The slot said why the answer could not be its value, and the generic retry would misstate it.
  if (step === 'open' && retryPromptId !== null) return prompt(retryPromptId, target, {}, acks);
  // A slot with no keypad rung stays on the retry text through the dtmf rung too.
  const toDtmf = step === 'dtmf' && slotSpecOf(io.app, target).dtmf !== undefined;
  return prompt(toDtmf ? `ask_${target}_dtmf` : `ask_${target}_retry`, target, {}, acks);
}

const ACK_FRUSTRATION: Ack = { promptId: 'ack_frustration', vars: {} };
const ACK_SCREEN: Ack = { promptId: 'screen_reprompt', vars: {} };
const ACK_SCREEN_FORM: Ack = { promptId: 'screen_reprompt_form', vars: {} };

/**
 * The question the caller was on, asked again exactly as it stands: no attempt, re-ask or offer
 * counter moves, since a quarantined turn is not an answer the caller failed. A pending confirmation
 * is asked again as it was (the summary's hash is retaken over the same values); otherwise the prompt
 * the caller was on: the code, a choice between two (the pair it offered, kept as its options), a
 * slot's question or its keypad rung, the keypad menu, or the intent question.
 */
function reaskCurrent(s: Session, acks: Ack[]): Decision {
  const app = appOf(s);
  const pc = s.pendingConfirmation;
  if (pc) {
    switch (pc.target) {
      case 'transfer':
        return offerTransfer(acks);
      case 'form':
        if (s.lastPromptId === 'ask_change') return prompt('ask_change', 'confirm', {}, acks);
        if (s.lastPromptId === 'confirm_dtmf') return prompt('confirm_dtmf', 'confirm', {}, acks, ['1', '2']);
        return summaryPrompt(s, pc.form, acks);
      case 'slot':
        return slotConfirmPrompt(pc, acks);
      case 'check':
        return checkConfirmPrompt(s, pc, acks);
      case 'intent':
        return prompt('confirm_intent_explicit', 'intent', { intentLabel: intentLabel(app, pc.intent) }, acks, ['yes', 'no']);
    }
  }
  const asked = s.promptedFor;
  if (asked === 'otp') return askCode(s, acks);
  const [a, b] = s.lastPromptOptions;
  if (s.lastPromptId?.startsWith('disambiguate_') && asked !== null && asked !== 'confirm' && a !== undefined && b !== undefined) {
    return prompt(s.lastPromptId, asked, { a, b }, acks, [a, b]);
  }
  if (asked !== null && asked !== 'intent' && asked !== 'confirm') {
    if (s.lastPromptId === `ask_${asked}_dtmf`) return prompt(s.lastPromptId, asked, {}, acks);
    return s.slots[asked]!.window === null ? askedAgain(s, asked, acks) : askSlot(s, asked, s.slots[asked]!.window, acks);
  }
  // Parked for the portal sign-in with nothing else open, the question the customer is on is the
  // sign-in. After the confirmations: one left open is still the question, and is asked again.
  if (awaitingSignIn(s)) return prompt('signin_reminder', 'intent', {}, acks);
  if (s.menuActive) return { ...prompt('nomatch_dtmf_menu', 'intent', {}, acks, app.menu.map((m) => m.digit)), menu: true };
  return prompt('ask_intent', 'intent', {}, acks);
}

/**
 * A turn the injection screen flagged. Perception's answers are discarded, so nothing
 * fills, no gate runs and no tool is called for them (a summary asked again is still read through
 * its form's summary hook, as on any turn); the frustration rungs and summary corrections, which
 * read those answers, are skipped with them. The first costs the caller one neutral reprompt in
 * front of the question they were on; a second in the call goes to a person.
 *
 * The reprompt is the menu line ("I can track a parcel, book a delivery window, ...") only where the caller is
 * choosing what to do. Inside a form, at its code or its summary, that line would read oddly in front
 * of the question, so it is "Let's keep going." there.
 */
function quarantine(s: Session): Decision {
  s.screenHits += 1;
  if (s.screenHits >= 2) return handoff(s, 'security');
  const inForm = s.form !== null || s.promptedFor === 'otp' || s.pendingConfirmation?.target === 'form';
  return reaskCurrent(s, [inForm ? ACK_SCREEN_FORM : ACK_SCREEN]);
}

/**
 * The screen's row for the debug table, first on every screened turn so the stage always shows: it
 * decides only when it fires. A failed screen is reported as `error` and passes (it fails open).
 */
function screenRow(screen: ScreenResult, t: Thresholds): GateRow {
  const outcome = screen.fired ? 'quarantine' : screen.error !== null ? 'error' : 'clear';
  return { gate: 'screen', value: screen.value, threshold: t.SCREEN_FIRE, passed: !screen.fired, outcome, decided: screen.fired };
}

/** What an informational intent said, as acks in front of the question the call resumes on, and whether it answered. */
interface Informed {
  readonly acks: Ack[];
  readonly answered: boolean;
}

/**
 * What an informational intent says: its prompt, or its knowledge-base passage (resolved and
 * recorded by kb/answer.ts informationalAnswer: the answer, or the unavailable line). One that
 * names a locale switches the call to it first (switchLocale), so its prompt, if any, and every
 * line after it are said in the new locale.
 */
function informed(s: Session, io: TurnIO, informs: Informs): Informed {
  if (informs.passage !== undefined) {
    const said: InformationalAnswer = informationalAnswer(s, io.tc, io.out, informs.passage);
    return { acks: [said.ack], answered: said.answered };
  }
  if (informs.locale !== undefined) switchLocale(s, io, informs.locale);
  return { acks: informs.promptId !== undefined ? [{ promptId: informs.promptId, vars: {} }] : [], answered: true };
}

/**
 * The call goes on in `target`, one of the app's locales (an intent's IntentDef.locale): the
 * session's locale changes, and a channel with speech is asked first to speak and hear it
 * (set_language, with the languages app.yaml's voice.locales names, each the tag where it names
 * none), so the turn's lines are spoken, and the caller's next words heard, in it. The locale the
 * call is already in changes nothing; an app without locales has none to switch to.
 */
function switchLocale(s: Session, io: TurnIO, target: string): void {
  if (!io.app.locales || target === s.locale) return;
  s.locale = target;
  if (s.caps.speech) io.prefix.push({ type: 'set_language', ...speechLanguagesOf(io.app, target) });
  // A value already held is said in the new locale too: a fill's display is its slot's display(value,
  // locale) (the slot conformance kit's `display` check), so it is formatted again in the new one. A
  // slot shown as said (SlotSpec.displayFrom) keeps the words: they are the caller's in any locale,
  // and display(value) would give the written value in their place.
  const locale = slotLocaleOf(s);
  const formatted = (id: SlotId): boolean => Object.hasOwn(io.app.slots, id) && slotSpecOf(io.app, id).displayFrom !== 'said';
  const shown = (id: SlotId, value: string): string => slotSpecOf(io.app, id).display(value, locale);
  // A factor filled from the caller-ID match has no display: it is never said, in any language.
  for (const [id, slot] of Object.entries(s.slots)) if (slot.value !== null && slot.by !== 'caller-id' && formatted(id)) slot.display = shown(id, slot.value);
  const pc = s.pendingConfirmation;
  if (pc?.target === 'slot' && formatted(pc.slot)) pc.display = shown(pc.slot, pc.value);
}

/**
 * A fill's acks and its disambiguation formatted again in the session's locale, after a switch in the
 * same breath (switchLocale): the caller's words were heard in the old language, and every line the
 * turn says, these included, is said in the new one. A fill's ack names only its own slot (`ack_<slot>`).
 */
function inLocaleOf(s: Session, io: TurnIO, fill: FillResult): Pick<FillResult, 'acks' | 'disambiguate'> {
  const locale = slotLocaleOf(s);
  const shown = (id: SlotId, c: SlotCandidate): SlotCandidate => ({ ...c, display: slotSpecOf(io.app, id).display(c.value, locale) });
  return {
    acks: fill.acks.map((a) => ({ ...a, vars: Object.fromEntries(Object.entries(a.vars).map(([k, v]) => [k, Object.hasOwn(io.app.slots, k) ? (s.slots[k]?.display ?? v) : v])) })),
    disambiguate: fill.disambiguate && { ...fill.disambiguate, a: shown(fill.disambiguate.slot, fill.disambiguate.a), b: shown(fill.disambiguate.slot, fill.disambiguate.b) },
  };
}

type TransferConfirmation = Extract<PendingConfirmation, { target: 'transfer' }>;

/**
 * Back to wherever the call was, without counting a turn against the caller: a pending
 * confirmation asked again, an open form's next question, the plain intent question, or the
 * keypad menu. The declined transfer offer and an informational intent
 * both come back through here, because neither is a turn the caller spent failing the question
 * beneath. A transfer target never reaches here: gate 6 settles every spoken answer at the offer, and
 * `escalate` never nests an offer inside one, so `reaskConfirmation`'s transfer branch is not
 * relied on by this function. A choice named in the same breath as an informational question at
 * a confirmation is dropped, not carried into the reask: `disambiguate` only reaches
 * `continueForm`, and a pending confirmation is re-asked as it was.
 */
function resume(s: Session, io: TurnIO, acks: Ack[], disambiguate: FillResult['disambiguate'] = null, help: FillResult['help'] = null): Decision {
  if (s.pendingConfirmation) return reaskConfirmation(s, io, acks, false);
  if (s.form) return continueForm(s, io, acks, disambiguate, help);
  // The caller was on the keypad menu before this turn: it comes back with the rung intact.
  if (s.menuActive) return { ...prompt('nomatch_dtmf_menu', 'intent', {}, acks, io.app.menu.map((m) => m.digit)), menu: true };
  // Before any task is started the form loop has nothing to ask: the plain intent question comes
  // back, not the "Sorry, I didn't catch that" retry.
  return prompt('ask_intent', 'intent', {}, acks);
}

/**
 * The offer turned down: by a no, by an answer that is neither a yes nor a no, or by a second
 * silence. It is not offered again on this call, and the caller goes back to the question they
 * were on -- declining costs them no attempt, since they did answer the question we asked.
 */
function declineTransfer(s: Session, io: TurnIO, pc: TransferConfirmation, acks: Ack[]): Decision {
  s.transferDeclined = true;
  // An offer a completion made in place of its answer: the form ends there, unanswered, rather than
  // coming back round to look the answer up again (and offer again).
  if (pc.after !== undefined && s.form === pc.after) {
    s.pendingConfirmation = null;
    return finishForm(s, pc.after, acks, io, false);
  }
  // A confirmation the offer displaced comes back rather than being dropped: an explicit intent
  // confirm still holds the caller's request, and a summary still holds its attempt count.
  s.pendingConfirmation = pc.resume ?? null;
  return resume(s, io, acks);
}

/**
 * A confirmation the caller did not answer stands; re-ask it until the retry policy runs out.
 * `count` is false when the turn spent itself adding a request rather than dodging the
 * question, which is not a failed answer and must not walk the caller toward the keypad.
 */
function reaskConfirmation(s: Session, io: TurnIO, acks: Ack[] = [], count = true): Decision {
  const t = io.tc.thresholds;
  const pc = s.pendingConfirmation!;
  if (pc.target === 'slot' && pc.at === 'greeting') {
    // The greeting's proposal, unanswered (a silence, words that answer neither): asked once more,
    // then dropped for the open question. No attempt is counted on the slot or the intent.
    if (!count) return slotConfirmPrompt(pc, acks);
    pc.attempts = (pc.attempts ?? 0) + 1;
    if (pc.attempts < 2) return slotConfirmPrompt(pc, acks);
    s.pendingConfirmation = null;
    offerSettled(s, io, pc, 'none');
    return prompt(GREET_AFTER_OFFER, 'intent', {}, acks);
  }
  if (pc.target === 'slot') {
    const st = s.slots[pc.slot]!;
    if (!count) return slotConfirmPrompt(pc, acks);
    const attempts = ++st.attempts;
    const step = rungFor(s, attempts, t);
    // The caller's number offered and never answered: the offer is closed at the end of its ladder.
    // A slot that skips on a no (`onNo: skip`) is left empty, declined, and the form goes on: an
    // offer nobody answered is not worth a person.
    if (pc.offered && (step === 'agent' || step === 'dtmf')) {
      offerSettled(s, io, pc, 'none');
      if (skipsOnNo(io.app, pc.slot)) {
        s.pendingConfirmation = null;
        Object.assign(st, emptySlot(), { attempts, declined: true });
        return continueForm(s, io, acks, null);
      }
    }
    if (step === 'agent') { s.pendingConfirmation = null; return handoff(s, 'max-attempts', acks); }
    // A readback the caller never answers burns the same attempts as a wrong value, so it
    // lands on the keypad rather than looping on a value we still cannot vouch for.
    if (step === 'dtmf') {
      s.pendingConfirmation = null;
      Object.assign(st, emptySlot(), { attempts, ...(st.readBackNos !== undefined ? { readBackNos: st.readBackNos } : {}) });
      // The caller's number offered and never answered, or a library slot's read-back (readBackNo
      // `ask`): the slot's own ladder from here, its keypad where it has one, else its retry.
      const spec = slotSpecOf(io.app, pc.slot);
      if ((pc.offered || spec.readBackNo === 'ask') && spec.dtmf === undefined) return prompt(`ask_${pc.slot}_retry`, pc.slot, {}, acks);
      return prompt(`ask_${pc.slot}_dtmf`, pc.slot, {}, acks);
    }
    return slotConfirmPrompt(pc, acks);
  }
  if (pc.target === 'check') {
    // A refusal the slots no longer hold is not asked again: the check runs again on what they hold.
    if (staleCheck(s, pc)) { s.pendingConfirmation = null; return continueForm(s, io, acks, null); }
    // A check's read-back the caller does not answer is asked again, then a person: the refusal
    // never acts on silence, and there is no keypad form of it.
    if (!count) return checkConfirmPrompt(s, pc, acks);
    pc.attempts += 1;
    if (retryStep(pc.attempts, t) === 'agent') { s.pendingConfirmation = null; return handoff(s, 'max-attempts', acks); }
    return checkConfirmPrompt(s, pc, acks);
  }
  if (pc.target === 'transfer') {
    // Only silence gets here: the gate settles every spoken answer to the offer, as a transfer or
    // as a decline, so `count` never has anything to say about it. The offer never walks to the
    // keypad or to an agent -- a second silence declines it and the call carries on.
    pc.attempts += 1;
    if (pc.attempts >= 2) return declineTransfer(s, io, pc, acks);
    return offerTransfer(acks);
  }
  if (pc.target === 'form') {
    if (!count) return summaryPrompt(s, pc.form, acks);
    pc.attempts += 1;
    const step = rungFor(s, pc.attempts, t);
    if (step === 'agent') { s.pendingConfirmation = null; return handoff(s, 'max-attempts', acks); }
    // A summary the caller keeps talking past is offered on the keypad rather than read again.
    if (step === 'dtmf') return prompt('confirm_dtmf', 'confirm', {}, acks, ['1', '2']);
    return summaryPrompt(s, pc.form, acks);
  }
  if (!count) return prompt('confirm_intent_explicit', 'intent', { intentLabel: intentLabel(io.app, pc.intent) }, acks, ['yes', 'no']);
  s.intentAttempts += 1;
  if (retryStep(s.intentAttempts, t) === 'agent') {
    s.pendingConfirmation = null;
    return handoff(s, 'max-attempts', acks);
  }
  return prompt('confirm_intent_explicit', 'intent', { intentLabel: intentLabel(io.app, pc.intent) }, acks, ['yes', 'no']);
}

const NO_INPUT_ACK: Ack = { promptId: 'no_input', vars: {} };

/**
 * Silence is an unanswered turn on whatever was prompted; no model is asked. Right after "anything
 * else?" (the `anything_else` line), the app says what the caller hears (App.anythingElseSilence):
 * that question again, by default, rather than the opening question; or the goodbye.
 */
function handleSilence(s: Session, io: TurnIO): Decision {
  if (s.promptedFor === null) return { kind: 'ignore' };
  s.dtmfBuffer = '';
  if (s.pendingConfirmation) return reaskConfirmation(s, io, [NO_INPUT_ACK]);
  if (s.promptedFor === 'intent' && s.lastPromptId === 'anything_else') {
    const after = anythingElseSilenceOf(io.app);
    if (after === 'goodbye') return goodbye(s, [NO_INPUT_ACK]);
    if (after === 'repeat') return failAttempt(s, 'intent', io, [NO_INPUT_ACK], true, null, 'anything_else');
  }
  // `promptedFor === 'confirm'` without a pending confirmation cannot happen; the fallback is defensive.
  return failAttempt(s, s.promptedFor === 'confirm' ? 'intent' : s.promptedFor, io, [NO_INPUT_ACK], true);
}

/**
 * After slots changed: disambiguate, read back, pass the form's entry call through the gate (which
 * may ask for identity first), then ask the next slot or complete.
 */
function continueForm(s: Session, io: TurnIO, acks: Ack[], disambiguate: FillResult['disambiguate'], help: FillResult['help'] = null): Decision {
  // Gates never proceed outside a form, but the defensive queue path can; re-ask for an intent rather than crash.
  const form = s.form;
  if (!form) return prompt('nomatch_open', 'intent', {}, acks);
  if (disambiguate) {
    return prompt(`disambiguate_${disambiguate.slot}`, disambiguate.slot, { a: disambiguate.a.display, b: disambiguate.b.display }, acks, [disambiguate.a.display, disambiguate.b.display]);
  }
  const readback = pendingSlotConfirmation(s);
  if (readback) {
    s.pendingConfirmation = readback;
    return prompt(`confirm_${readback.slot}`, readback.slot, { [readback.slot]: readback.display }, acks, ['yes', 'no']);
  }
  // Identity is asked for here, and only because the gate said STEP_UP for the entry call; the
  // factors, and each check of them, are the lifecycle's (lifecycle.ts). A verification on the way
  // adds its own ack ("Thanks, Alex."), so the rest of the turn speaks `said`, a copy of `acks`.
  const said = [...acks];
  const entry = ensureEntry(s, io.tc, io.out, said);
  // A refused entry call still drains the queue: the caller's other requests are not lost to it.
  if (entry?.kind === 'refused') return finishForm(s, form, entry.acks, io, false);
  if (entry) return entry;
  // The form's checks, once its entry is through: an answer that rules the caller out ends the form
  // here, before the next question (core/checks.ts).
  const checks = runChecks(s, form, io.tc, io.out);
  if (checks.kind !== 'passed') return stopForm(s, form, checks, said, io);
  said.push(...passedAcks(s, checks));
  const next = nextPrompt(s);
  // The caller said whether they know the answer rather than answering: the slot's help prompt
  // takes the question's place this once, and the attempt count does not move, but only when the form would still ask that slot next; otherwise the question the
  // form actually owes wins, and the help decision is dropped along with it.
  if (help && next.kind === 'ask' && next.slot === help.slot) return { ...prompt(help.promptId, help.slot, {}, said), help };
  // A slot that offers the caller's number, or proposes a value from the facts (`offer: facts`), is
  // offered rather than asked, or, with nothing to offer and `ifNone: skip`, left empty (declined)
  // for the next.
  let ask = next;
  while (ask.kind === 'ask' && ask.window === null) {
    const offer = makeOffer(s, ask.slot, said, io);
    if (offer === DECLINED) {
      ask = nextPrompt(s);
      continue;
    }
    if (offer) return offer;
    break;
  }
  if (ask.kind === 'complete') return askSummary(s, form, said, io);
  return askSlot(s, ask.slot, ask.window, said);
}

/** What makeOffer returns for a slot it left empty, declined (`ifNone: skip`): the form goes on to the next. */
const DECLINED = 'declined' as const;

/**
 * The slot's offer, as a yes or no in place of its question: the number the caller is calling from
 * (offerCallerNumber), or a value proposed from the facts (offerFromFacts). An offer still pending
 * (kept through a detour) is asked again as it stands, not made a second time.
 */
function makeOffer(s: Session, slot: SlotId, acks: Ack[], io: TurnIO): Decision | null | typeof DECLINED {
  const pc = s.pendingConfirmation;
  if (pc?.target === 'slot' && pc.offered && pc.slot === slot) return slotConfirmPrompt(pc, acks);
  if (factsOfferSlots(io.app).includes(slot)) return offerFromFacts(s, slot, acks, io);
  return offerCallerNumber(s, slot, acks, io);
}

/**
 * A value the app's facts propose for the slot (a slot's `offer: facts`, FactsConfig.offers; e.g. the
 * street the call-start lookup found), offered as a yes or no in place of the slot's question: once
 * per slot per form, on a slot not yet asked and not proposed at the greeting, when the facts have a
 * candidate for it. The line says the candidate's display and nothing more, and the model is told
 * only that (core/state.ts). Null
 * when there is none, and the slot is asked as always. The slot stays empty until the yes, and the
 * yes fills it alone: who the caller is, their level and their attempts are not touched.
 */
function offerFromFacts(s: Session, slot: SlotId, acks: Ack[], io: TurnIO): PromptDecision | null {
  // Proposed at the greeting already (offerAt: greeting): not again in the form that has the slot.
  if (s.callerOffered?.includes(slot) || s.slots[slot]!.attempts > 0 || s.greetingOffered === slot) return null;
  const c = factsCandidate(io.app, slot, s.facts);
  if (c === null) return null;
  s.callerOffered = [...(s.callerOffered ?? []), slot];
  const pc: Extract<PendingConfirmation, { target: 'slot' }> = { target: 'slot', slot, value: c.value, display: c.display, offered: true, from: 'facts' };
  s.pendingConfirmation = pc;
  return offerPrompt(pc, acks);
}

/**
 * The number the caller is calling from, offered as a yes or no in place of the slot's question
 * (SlotSpec.callerNumber, core/callerNumber.ts): once per slot per form, on a slot not yet asked, when
 * the session kept a number that fits it and the app does not refuse the offer (App.callerOffer, asked
 * once, only when an offer is about to be made). Null when there is no offer to make, and the slot is
 * asked as always; DECLINED when there is none and the slot skips (`ifNone: skip`), so it is left
 * empty and declined. The slot stays empty until the yes.
 */
function offerCallerNumber(s: Session, slot: SlotId, acks: Ack[], io: TurnIO): Decision | null | typeof DECLINED {
  if (!callerNumberSlots(io.app).includes(slot) || s.callerOffered?.includes(slot) || s.slots[slot]!.attempts > 0) return null;
  let c = s.callerNumber === undefined ? null : callerCandidate(io.app, slot, s.callerNumber, slotLocaleOf(s));
  if (c !== null) {
    // Asked once per slot per form, whatever it says: the slot is not offered again.
    s.callerOffered = [...(s.callerOffered ?? []), slot];
    if (!callerOfferAllowed(s, slot, io)) c = null;
  }
  if (c === null) {
    if (!skipsIfNone(io.app, slot)) return null;
    s.slots[slot]!.declined = true;
    return DECLINED;
  }
  const pc: Extract<PendingConfirmation, { target: 'slot' }> = { target: 'slot', slot, value: c.value, display: c.display, offered: true };
  s.pendingConfirmation = pc;
  return offerPrompt(pc, acks);
}

/**
 * Whether the app lets the caller's number be offered for `slot` (App.callerOffer); true without the
 * hook. A hook that throws makes no offer, and the slot goes on as for a call with no number (its
 * `ifNone`): an offer is a convenience, never a reason to lose the turn. What the hook wrote to the
 * facts is put back and the side effects queued since it began are dropped, as for a tool that throws
 * (lifecycle.ts callTool `failSoft`); the gate's records of the calls it made stay, since those calls
 * were made. Nothing of the error is kept or logged, since its message may hold the number.
 */
function callerOfferAllowed(s: Session, slot: SlotId, io: TurnIO): boolean {
  const hook = io.app.callerOffer;
  if (hook === undefined) return true;
  const effectsBefore = io.out.effects.length;
  let before: Session['facts'] | undefined;
  try {
    before = io.app.facts?.clone(s.facts);
    return hook(appContext(s, io.tc, io.out), slot) === true;
  } catch {
    if (before !== undefined) s.facts = before;
    io.out.effects.length = effectsBefore;
    return false;
  }
}

/**
 * The offer settled this turn (TurnOut.offer, the audit's `offer` row): the line as it was said, in
 * the session's language, and what the caller answered. A value proposed from the facts is written
 * into the line as the slot's value is recorded (recordingOf: its redact, else policy.yaml's
 * `audit:`), so the audit holds no more of it than the slot's own rows do.
 */
function offerSettled(s: Session, io: TurnIO, pc: Extract<PendingConfirmation, { target: 'slot' }>, answer: OfferSettled['answer']): void {
  const promptId = `offer_${pc.slot}`;
  const locale = s.locale ?? defaultLocaleOf(io.app);
  if (pc.from === 'facts') {
    const shown = recordedValue(recordingOf(io.app, pc.slot), pc.display) ?? '•';
    io.out.offer = { slot: pc.slot, source: 'facts', promptId, said: promptText(io.app, promptId, { [pc.slot]: shown }, s.locale), answer, locale };
    return;
  }
  const last4 = lastFour(pc.value);
  io.out.offer = { slot: pc.slot, source: 'caller-number', promptId, said: promptText(io.app, promptId, { last4 }, s.locale), answer, last4, locale };
}

/**
 * The offer's answer gave the slot no value (a no, or no answer at all): with `onNo: skip` the slot
 * is left empty, declined, and the form goes on to the next; otherwise it is asked as always.
 */
function declineOnNo(s: Session, io: TurnIO, slot: SlotId): void {
  if (skipsOnNo(io.app, slot) && s.slots[slot]!.value === null) s.slots[slot]!.declined = true;
}

/**
 * The offer's line: `offer_<slot>`, with the last four digits of the number offered, or, for a value
 * proposed from the facts, its display as `{<slot>}`. A proposal at the greeting asks for no slot (no
 * form is open, and no slot reads the answer as its own prompted one): it stands in for the intent
 * question.
 */
function offerPrompt(pc: Extract<PendingConfirmation, { target: 'slot' }>, acks: Ack[]): PromptDecision {
  const vars = pc.from === 'facts' ? { [pc.slot]: pc.display } : { last4: lastFour(pc.value) };
  return prompt(`offer_${pc.slot}`, pc.at === 'greeting' ? 'intent' : pc.slot, vars, acks, ['yes', 'no']);
}

/** A slot's pending read-back asked (again): its `confirm_<slot>`, or, for a value offered, `offer_<slot>`. */
function slotConfirmPrompt(pc: Extract<PendingConfirmation, { target: 'slot' }>, acks: Ack[]): PromptDecision {
  return pc.offered ? offerPrompt(pc, acks) : prompt(`confirm_${pc.slot}`, pc.slot, { [pc.slot]: pc.display }, acks, ['yes', 'no']);
}

/**
 * At the caller's number's offer, a number said that the slot refused (the wrong length or shape):
 * the caller gave a number of their own, so the offer is closed and the slot's question is retried
 * as for any missed answer, with the slot's own retry line where it has one. Null when the turn gave
 * the slot no such number.
 */
function offeredSlotMissed(s: Session, io: TurnIO, slot: SlotId, fill: FillResult, acks: Ack[]): Decision | null {
  const invalid = fill.events.find((e) => e.slot === slot && e.outcome.kind === 'invalid')?.outcome;
  if (invalid?.kind !== 'invalid') return null;
  s.pendingConfirmation = null;
  return failAttempt(s, slot, io, [...acks, ...fill.acks], false, invalid.retryPromptId ?? null);
}

/** The form's checksPassed line, when this turn's checks passed the last of them (core/checks.ts). */
function passedAcks(s: Session, checks: Extract<ReturnType<typeof runChecks>, { kind: 'passed' }>): Ack[] {
  return checks.passedPromptId === null ? [] : [{ promptId: checks.passedPromptId, vars: summaryVars(s) }];
}

type CheckConfirmation = Extract<PendingConfirmation, { target: 'check' }>;

/** What a form's checks made of a turn when it was not that all of them that were ready passed. */
type ChecksStopped = Exclude<ReturnType<typeof runChecks>, { kind: 'passed' }>;

/**
 * Identity asked for a check (lifecycle.ts stepUp, as for an entry call's STEP_UP), to level `need`.
 * Null when it cannot be: an app without identity, or a caller already at that level (a rule of the
 * app's own that says STEP_UP whatever the level would only ask again, round the code), so the check's
 * refusal goes on as it always has, to a person. Factors already in hand that match verify at once
 * ("my account is 5550 1234, born April 12th, 1980", said on the way), and the form loop then runs the
 * check again.
 */
function checkStepUp(s: Session, check: FormCheck, need: 1 | 2, acks: Ack[], io: TurnIO): Decision | null {
  if (!io.app.identity) return null;
  if (!isAnonymous(s.principal) && s.principal.level >= need) return null;
  const said = [...acks];
  const next = stepUp(s, { tool: check.action, params: {} }, need, io.tc, io.out, said);
  if (next === null) return continueForm(s, io, said, null);
  // A step-up made with the form entered asks the gate for no entry call, so nothing is refused here.
  return next.kind === 'refused' ? null : next;
}

/**
 * A check that waits only on an identity factor it reads (core/checks.ts, `identity`): the factor is
 * filled only by verifying, so identity is asked for now, to level 1, and the check runs once it is
 * given. The factors are taken only from an anonymous caller on a channel that asks for them (fia.ts
 * activeSlots); anywhere else (a web chat, whose callers sign in and never type a factor; a caller
 * verified some other way) the check can never run, and the form goes to a person (`form_stopped`,
 * with no reason) rather than complete with it unrun.
 */
function awaitFactors(s: Session, form: FormId, check: FormCheck, acks: Ack[], io: TurnIO): Decision {
  const collects = isAnonymous(s.principal) && !s.caps.signIn;
  const asked = collects ? checkStepUp(s, check, 1, acks, io) : null;
  return asked ?? endByCheck(s, form, check, { verdict: 'NEEDS_HUMAN' }, acks, io);
}

/**
 * A check refused (core/checks.ts): the form ends as its reason's outcome says (endByCheck), unless the
 * outcome reads the refusal back first (its `confirm`) and a slot the check reads is not confirmed:
 * neither read back on its own and said yes to (SlotState.confirmed) nor among `agreed`, the slots the
 * caller said yes to as a summary read them. Then the form pauses on that yes or no (checkReadBack),
 * and nothing is recorded as stopped yet.
 *
 * A STEP_UP is no refusal of the form: the check needs a level the caller has not proven (a check above
 * what the form's entry proves, which `pnpm check` warns of). Identity is asked for as for an entry
 * call's STEP_UP (checkStepUp), and once the caller is verified the form loop runs the check again
 * (continueForm); a failed verification ends as the identity ladder ends. In an app without identity,
 * or for a caller already at the level asked for, it goes to a person, as it always has. A check that
 * waits only on an identity factor is no refusal either (awaitFactors).
 */
function stopForm(s: Session, form: FormId, stopped: ChecksStopped, acks: Ack[], io: TurnIO, agreed: ReadonlySet<SlotId> = NONE_AGREED): Decision {
  if (stopped.kind === 'identity') return awaitFactors(s, form, stopped.check, acks, io);
  const refused = stopped;
  if (refused.decision.verdict === 'STEP_UP') {
    const asked = checkStepUp(s, refused.check, refused.decision.needLevel === 2 ? 2 : 1, acks, io);
    if (asked !== null) return asked;
  }
  const readBack = checkReadBack(s, form, refused, acks, agreed);
  if (readBack !== null) return readBack;
  return endByCheck(s, form, refused.check, refused.decision, acks, io);
}

/**
 * The form ends as a check's refusal says, and the audit is told (`form_stopped`, `confirmed` when the
 * refusal was read back first and the caller said yes). The form is never counted as completed. When
 * the form was entered on this very turn, the line that said so is dropped (its ack_intent, "Sure, I
 * can help you ...", or the bridge_next into it from the queue, "Now, let's ..."), so the caller does
 * not hear yes and no in one breath. `end` leaves the form and its slots on the session, as a
 * completion that ends the call does, with no question pending (the call is over, so nothing reads
 * them again); with a request queued, the call goes on to it instead.
 */
function endByCheck(s: Session, form: FormId, check: FormCheck, decision: Pick<GateDecision, 'verdict' | 'reason'>, acks: Ack[], io: TurnIO, confirmed = false): Decision {
  const label = intentLabel(io.app, form);
  const entering = (a: Ack): boolean => ((a.promptId === 'ack_intent' || a.promptId === 'bridge_next') && a.vars.intentLabel === label) || (a.promptId === 'ack_intent_then' && a.vars.a === label);
  const kept = acks.filter((a) => !entering(a));
  const ending = checkEnding(s, check, decision, kept, summaryVars(s));
  io.out.stopped = { form, action: check.action, reason: decision.reason ?? null, then: ending.then, ...(confirmed ? { confirmed: true as const } : {}) };
  switch (ending.then) {
    case 'end':
      if (s.queued.length > 0) return finishForm(s, form, [...ending.acks, ending.line], io, false);
      s.pendingConfirmation = null;
      s.pendingHash = null;
      return { kind: 'complete', form, promptId: ending.line.promptId, vars: ending.line.vars, acks: ending.acks, completed: [...s.completed] };
    case 'anything-else':
      return finishForm(s, form, ending.acks, io, false);
    case 'handoff':
      return handoff(s, ending.reason, ending.acks);
  }
}

/**
 * A refusal read back before it acts (a check outcome's `confirm`): the outcome's yes-or-no line,
 * rendered with the form's slot displays as `say` is, the check's refusal kept on the session as the
 * pending confirmation (Session.pendingConfirmation, target `check`). Null when the outcome has no
 * read-back, or every slot the check reads is confirmed already (a read-back of its own, or the
 * summary's yes: `agreed`) or is an identity factor, so a value is never read back twice.
 */
function checkReadBack(s: Session, form: FormId, refused: Extract<ReturnType<typeof runChecks>, { kind: 'refused' }>, acks: Ack[], agreed: ReadonlySet<SlotId>): PromptDecision | null {
  const { check, decision } = refused;
  const outcome = outcomeOf(check, decision);
  if (outcome?.confirm === undefined || decision.reason === undefined) return null;
  // An identity factor the check reads holds what the caller's verification matched: it is not read back.
  const factors = identityOf(appOf(s)).factorSlots;
  if (check.with.every((id) => s.slots[id]!.confirmed || agreed.has(id) || factors.includes(id))) return null;
  const pc: CheckConfirmation = { target: 'check', form, action: check.action, verdict: decision.verdict, reason: decision.reason, hash: refused.hash, attempts: 0 };
  s.pendingConfirmation = pc;
  return checkConfirmPrompt(s, pc, acks);
}

/** The check a pending read-back is for, and the outcome its refusal maps to (which has the read-back line). */
function pendingCheck(s: Session, pc: CheckConfirmation): { check: FormCheck; outcome: CheckOutcome } {
  const check = (formOf(appOf(s), pc.form).checks ?? []).find((c) => c.action === pc.action);
  const outcome = check === undefined ? null : outcomeOf(check, pc);
  if (check === undefined || outcome === null) throw new Error(`form ${pc.form} has no check ${pc.action} with an outcome for "${pc.reason}"`);
  return { check, outcome };
}

/** A check's pending read-back asked (again): the outcome's `confirm` line, with the form's slot displays. */
function checkConfirmPrompt(s: Session, pc: CheckConfirmation, acks: Ack[]): PromptDecision {
  return prompt(pendingCheck(s, pc).outcome.confirm!, 'confirm', summaryVars(s), acks, ['yes', 'no']);
}

/**
 * Whether a check's pending read-back is of a refusal the slots no longer hold: a turn while it was
 * out (an informational answer's breath, a declined transfer offer's) changed what the check reads.
 * It is not asked again or acted on then: the check runs again on what they hold (continueForm).
 */
function staleCheck(s: Session, pc: CheckConfirmation): boolean {
  return checkHash(s, pendingCheck(s, pc).check) !== pc.hash;
}

/**
 * Yes to a check's read-back: the slots it reads are confirmed, and the refusal acts as written,
 * without asking the gate again (it already answered, and nothing it reads has changed). A refusal
 * gone stale is not acted on: the check runs again.
 */
function checkConfirmed(s: Session, pc: CheckConfirmation, io: TurnIO): Decision {
  if (staleCheck(s, pc)) return continueForm(s, io, [], null);
  const { check } = pendingCheck(s, pc);
  for (const id of check.with) if (s.slots[id]!.value !== null) s.slots[id]!.confirmed = true;
  return endByCheck(s, pc.form, check, pc, [], io, true);
}

/**
 * No to a check's read-back: the deciding answer was misheard. The slots the check reads that are not
 * confirmed (one confirmed at its own read-back is not the answer misheard) are emptied, and so is the
 * check's own pass (Session.checked), so it runs again once they fill; the audit is told
 * (`check_reconfirmed`). The right answer said with the no ("no, it's in Ashford") is taken, and the
 * form goes on, the check running again on it; otherwise the first of them is asked again, a step on
 * its ladder (askOnLadder). A second no to the same check's read-back goes to a person.
 */
function checkDeclined(s: Session, pc: CheckConfirmation, answers: AnswerMap, ctx: SlotContext, io: TurnIO): { decision: Decision; events: FillEvent[] } {
  const { check } = pendingCheck(s, pc);
  io.out.reconfirmed = { form: pc.form, action: pc.action, reason: pc.reason };
  const nos = (s.checkReadBackNos?.[pc.action] ?? 0) + 1;
  s.checkReadBackNos = { ...(s.checkReadBackNos ?? {}), [pc.action]: nos };
  if (nos >= 2) return { decision: handoff(s, 'max-attempts'), events: [] };
  const reads = formOf(io.app, pc.form).slots.filter((id) => check.with.includes(id));
  const unconfirmed = reads.filter((id) => !s.slots[id]!.confirmed);
  const emptied = unconfirmed.length > 0 ? unconfirmed : reads;
  const declined = Object.fromEntries(emptied.map((id) => [id, s.slots[id]!.value]));
  for (const id of emptied) emptyForReadBack(s, id);
  if (s.checked !== undefined) delete s.checked[pc.action];
  const said = sameBreath(s, answers, ctx, emptied, declined, io);
  if (said.taken) return { decision: continueForm(s, io, [ACK_DECLINED, ...said.fill.acks], said.fill.disambiguate), events: said.fill.events };
  return { decision: askOnLadder(s, io, emptied[0]!, [ACK_DECLINED]), events: said.fill.events };
}

/**
 * No to a library slot's own read-back (SlotSpec.readBackNo `ask`): the slot is emptied, its nos
 * counted (SlotState.readBackNos), and the right answer said with the no ("no, I own it") is taken
 * and goes on as any fill does (read back in its turn, if it is a value the slot reads back);
 * otherwise the slot is asked again, a step on its ladder (askOnLadder). A second no goes to a person.
 */
function slotDeclined(s: Session, pc: Extract<PendingConfirmation, { target: 'slot' }>, answers: AnswerMap, ctx: SlotContext, io: TurnIO): { decision: Decision; events: FillEvent[] } {
  const st = s.slots[pc.slot]!;
  const nos = (st.readBackNos ?? 0) + 1;
  st.readBackNos = nos;
  if (nos >= 2) return { decision: handoff(s, 'max-attempts'), events: [] };
  emptyForReadBack(s, pc.slot);
  const said = sameBreath(s, answers, ctx, [pc.slot], { [pc.slot]: pc.value }, io);
  if (said.taken) return { decision: continueForm(s, io, [ACK_DECLINED, ...said.fill.acks], said.fill.disambiguate), events: said.fill.events };
  return { decision: askOnLadder(s, io, pc.slot, [ACK_DECLINED]), events: said.fill.events };
}

/** A slot emptied by a no to a read-back: its attempts and its count of nos stay. */
function emptyForReadBack(s: Session, id: SlotId): void {
  const st = s.slots[id]!;
  Object.assign(st, emptySlot(), { attempts: st.attempts, ...(st.readBackNos !== undefined ? { readBackNos: st.readBackNos } : {}) });
}

/**
 * What a no to a read-back said of the slots it emptied, as an ordinary fill of them: `taken` when it
 * gave one of them a value other than the one declined ("no, I own it"). Anything else it gave (the
 * value declined, heard again; a part of a date) is put back to empty, so a bare no fills nothing, and
 * its fill events are dropped, so the trace and the debug table show no value the slot did not keep.
 */
function sameBreath(s: Session, answers: AnswerMap, ctx: SlotContext, slots: readonly SlotId[], declined: Record<SlotId, string | null>, io: TurnIO): { taken: boolean; fill: FillResult } {
  const fill = fillSlots(s, answers, ctx, slots.map((id) => slotSpecOf(io.app, id)));
  let taken = false;
  const undone = new Set<SlotId>();
  for (const id of slots) {
    const st = s.slots[id]!;
    if (st.value !== null && st.value !== declined[id]) taken = true;
    else if (st.value !== null || st.window !== null) {
      emptyForReadBack(s, id);
      undone.add(id);
    }
  }
  const events = fill.events.filter((e) => !undone.has(e.slot));
  return { taken, fill: taken ? { ...fill, events } : { ...fill, events, acks: [], disambiguate: null } };
}

const ACK_DECLINED: Ack = { promptId: 'ack_declined', vars: {} };

/**
 * A slot emptied by a no to a read-back, asked again as a step on its own ladder: the no counts one
 * attempt, so the question walks its rungs as any missed answer's does (its keypad question at the
 * keypad rung where it takes keys and the channel has a keypad), and a person at the end.
 */
function askOnLadder(s: Session, io: TurnIO, slot: SlotId, acks: Ack[]): Decision {
  const st = s.slots[slot]!;
  st.attempts += 1;
  const step = rungFor(s, st.attempts, io.tc.thresholds);
  if (step === 'agent') return handoff(s, 'max-attempts');
  if (step === 'dtmf' && slotSpecOf(io.app, slot).dtmf !== undefined) return prompt(`ask_${slot}_dtmf`, slot, {}, acks);
  return askSlot(s, slot, null, acks);
}

/**
 * Whether the form owes the read-back of a value a library slot reads back (pendingSlotConfirmation,
 * on a slot with readBackNo `ask`): a value given at a summary is read back before the checks read
 * it. A slot written in code is not asked this, so it goes on as it always has.
 */
function libraryReadBackOwed(s: Session): boolean {
  const owed = pendingSlotConfirmation(s);
  return owed !== null && slotSpecOf(appOf(s), owed.slot).readBackNo === 'ask';
}

/**
 * What a portal sign-in keeps of the confirmation pending as it arrives (the auth.signed_in turn): a
 * slot or summary confirmation, or one a transfer offer displaced, is kept to be asked again; the
 * offer itself, an intent confirmation (the sign-in settles it) and a check's read-back are dropped.
 * A check's refusal was decided before the sign-in, so the parked form runs its checks again instead.
 */
export function pendingAtSignIn(pc: PendingConfirmation | null): PendingConfirmation | null {
  const kept = pc?.target === 'transfer' ? (pc.resume ?? null) : pc;
  return kept?.target === 'slot' || kept?.target === 'form' ? kept : null;
}

/**
 * "I'd be happy to help you ...": every form the caller picks is said out loud; a queued form chained
 * in by completeForm is bridged with bridge_next instead.
 */
function ackIntent(s: Session, form: FormId): Ack {
  return { promptId: 'ack_intent', vars: { intentLabel: intentLabel(appOf(s), form) } };
}

/**
 * The form heard a spoken turn (FormDef.onAnswers): before the turn fills anything or decides, so
 * what the caller volunteered (a preference, say) is in place for whatever the turn goes on to ask.
 */
function formHeard(s: Session, form: FormId, answers: AnswerMap, io: TurnIO): void {
  formOf(io.app, form).onAnswers?.(appContext(s, io.tc, io.out), answers);
}

/**
 * The form's own move at its pending summary (FormDef.onSummaryAnswer), for an answer that was
 * neither a yes nor a correction that changed a slot. Null when the form has none, or neither moved
 * nor said anything: the engine's own path then takes the turn.
 */
function summaryMove(s: Session, form: FormId, answers: AnswerMap, io: TurnIO): SummaryMove | null {
  const move = formOf(io.app, form).onSummaryAnswer?.(appContext(s, io.tc, io.out), answers) ?? null;
  return move !== null && (move.moved || move.acks.length > 0) ? move : null;
}

/**
 * `answers` are what the form fills from; `yes`, after an explicit intent check, the answers of the
 * yes that confirmed it, which the form hears after the opener's (they are newer) but never fills from.
 */
function enterForm(s: Session, form: FormId, answers: AnswerMap, ctx: SlotContext, io: TurnIO, queue?: FormId, yes?: AnswerMap): { decision: Decision; events: FillEvent[] } {
  // Words said outside a form (the request, or the request a yes confirmed) asked nothing of a slot
  // that listens only in its form (SlotSpec.listen `form`), so nothing is taken for it up front,
  // whatever such a slot would make of the words without its question.
  const fromOutside = s.form === null;
  // Entering a form is always said out loud, however sure the intent was: it is what tells
  // the caller which task started, whether the route was confident, mid-confidence, or a
  // switch away from another form.
  setForm(s, form);
  formHeard(s, form, answers, io);
  if (yes) formHeard(s, form, yes, io);
  // Queued after setForm, so the queue is read against the form actually being entered. Two tasks
  // named on one utterance get one line, in the order they will be done ("Sure, I can help you track
  // a parcel, and then report a missing one."), not a promise about "that" before the first is named.
  const queued = enqueue(s, queue);
  const acks: Ack[] = queued.length && queue !== undefined
    ? [{ promptId: 'ack_intent_then', vars: { a: intentLabel(io.app, form), b: intentLabel(io.app, queue) } }]
    : [ackIntent(s, form)];
  // A yes to the greeting's proposal with the request in the same breath: the slot holds what the yes was to.
  const specs = (fromOutside ? slotsToFill(s).filter((spec) => listenOf(io.app, spec.id) !== 'form') : slotsToFill(s)).filter((spec) => spec.id !== io.kept);
  const fill = fillSlots(s, answers, ctx, specs);
  return { decision: continueForm(s, io, [...acks, ...fill.acks], fill.disambiguate, fill.help), events: fill.events };
}

/**
 * A priority switch's correction (IntentDef.priority `correctsForm`), before the priority form is
 * entered. The turn was planned with the old form open (or with none), so the model was asked about
 * every slot it listens for, and its answers are in hand: a value they give replaces the one on
 * file, and a value said again unchanged changes nothing. With a form open, those of its slots the
 * turn listened for (activeSlots: none at the code prompt); with none ("anything else?"), the call's
 * own (slotsToFill: the carried slots, those that listen anywhere, the identity factors where the
 * turn listens for them).
 *
 * It is an ordinary fill, not a summary's correction (FillOptions.correcting): no question follows
 * to read anything back, so nothing on file is given up for less. A window (a part of a date) never
 * empties a filled slot, and a slot that keeps the value on file unless it was just asked (a text
 * slot's `keep`) keeps it: "wait, water is coming through the wall right now" at the read-back
 * replaces the urgency, not the problem the caller described.
 *
 * What the fill would say is dropped: an acknowledgement before the priority form's line is noise,
 * and there is no question to ask on the way out, so a disambiguation changes nothing. The form left
 * is still neither closed nor completed, nothing in it is confirmed by this, and its checks do not
 * run: the switch wins whatever the corrected values would have made a check say. Returns the
 * fill's events, which join the turn's.
 */
function correctOnSwitch(s: Session, answers: AnswerMap, ctx: SlotContext): FillEvent[] {
  if (s.form === null) return fillSlots(s, answers, ctx, slotsToFill(s)).events;
  const app = appOf(s);
  const listening = new Set(activeSlots(s).map((spec) => spec.id));
  const specs = formOf(app, s.form).slots.filter((id) => listening.has(id)).map((id) => slotSpecOf(app, id));
  return fillSlots(s, answers, ctx, specs).events;
}

function handleVerdict(s: Session, verdict: Verdict, answers: AnswerMap, ctx: SlotContext, io: TurnIO): { decision: Decision; events: FillEvent[] } {
  const t = io.tc.thresholds;
  // The open form hears the turn whatever the turn then does (a form it switches to hears it again
  // as it is entered), unless the gates set the turn aside: side speech, a held partial or words that
  // could not be made out say nothing the caller meant for it.
  if (s.form !== null && verdict.kind !== 'ignore' && verdict.kind !== 'hold' && verdict.kind !== 'nomatch') formHeard(s, s.form, answers, io);
  const greeted = atGreetingOffer(s, verdict, answers, ctx, io);
  if (greeted !== null) return greeted;
  const identifying = atGreetingIdentity(s, verdict, answers, ctx, io);
  if (identifying !== null) return identifying;
  const declined = atCallerMatch(s, verdict, answers, ctx, io);
  if (declined !== null) return declined;
  switch (verdict.kind) {
    case 'ignore':
      return { decision: { kind: 'ignore' }, events: [] };
    case 'hold':
      return { decision: { kind: 'hold' }, events: [] };
    case 'nomatch':
      // An unintelligible answer to a confirmation is an unanswered confirmation,
      // not a slot nomatch; leaving the confirmation pending would let it go stale.
      if (s.pendingConfirmation) return { decision: reaskConfirmation(s, io), events: [] };
      return { decision: failAttempt(s, promptedTarget(s), io), events: [] };
    case 'handoff':
      return { decision: handoff(s, verdict.reason), events: [] };
    case 'replay':
      return { decision: { kind: 'replay', text: s.lastPromptText }, events: [] };
    case 'inform': {
      // The answer plays as an ack in front of the question the caller was on. What else the
      // breath carried for the open form still fills, as on the queue verdict; outside a form only
      // what belongs to the call does (slotsToFill), since this turn opens no form for the rest.
      // No attempt counter moves. A passage that could not be said is followed by the offer of a
      // person, once per call (kb/answer.ts).
      const fill = fillSlots(s, answers, ctx, slotsToFill(s));
      const before = s.locale;
      const said = informed(s, io, verdict);
      // A switch in the same breath: what was heard in the old language is said in the new one.
      const { acks: filled, disambiguate } = s.locale === before ? fill : inLocaleOf(s, io, fill);
      const acks = [...said.acks, ...filled];
      const offer = said.answered ? null : offerAfterUnavailable(s, acks);
      return { decision: offer ?? resume(s, io, acks, disambiguate, fill.help), events: fill.events };
    }
    case 'confirmed': {
      const pc = s.pendingConfirmation!;
      s.pendingConfirmation = null;
      if (pc.target === 'slot' && pc.offered) {
        // The caller's number offered (callerNumber), or a value from the facts (`offer: facts`): the
        // yes fills the slot with it, confirmed, as a keyed number is, and nothing else: who the
        // caller is, their level and their attempts stay as they were. The summary still reads it back whole. The offer is the slot's first
        // question, so what else the yes carried ("yes, and it's about an order") fills the form's
        // other slots, as a no's does; the offered slot holds the number the yes was to.
        Object.assign(s.slots[pc.slot]!, { value: pc.value, display: pc.display, confirmed: true, window: null });
        offerSettled(s, io, pc, 'yes');
        const fill = fillSlots(s, answers, ctx, slotsToFill(s).filter((spec) => spec.id !== pc.slot));
        return { decision: continueForm(s, io, fill.acks, fill.disambiguate, fill.help), events: fill.events };
      }
      if (pc.target === 'slot') {
        // The stashed value and display go unread: the gate decided on this turn's yes
        // before any fill could run, so the slot still holds exactly what we read back.
        s.slots[pc.slot]!.confirmed = true;
        return { decision: continueForm(s, io, [], null), events: [] };
      }
      // A check's refusal read back (its outcome's `confirm`), and the caller agrees: it acts as written.
      if (pc.target === 'check') return { decision: checkConfirmed(s, pc, io), events: [] };
      if (pc.target === 'form') {
        const acks = enqueue(s, verdict.queue);
        // A yes that also changes a value ("yes, but it was Sunday") changes it. The write reads its
        // values from the slots, so the gate (the confirmed rule) refuses it against what the summary said, and the
        // summary is read again: what is filed is only ever what the caller heard and agreed to.
        const read = summaryState(s);
        const asRead = formValues(s, pc.form);
        const fill = correctingFill(s, answers, ctx, pc.form);
        if (fill.disambiguate) return { decision: continueForm(s, io, [...acks, ...fill.acks], fill.disambiguate), events: fill.events };
        // A value the yes gave that a library slot reads back ("yes, but I rent", with `confirmValues:
        // [rent]`) is read back first, as it would be anywhere else; the form loop then reads the summary
        // again. A slot written in code (no readBackNo) goes on to the checks and the completion, as it always has.
        if (libraryReadBackOwed(s)) return { decision: continueForm(s, io, [...acks, ...fill.acks], null), events: fill.events };
        agreeAsRead(s, pc.form, summaryState(s) === read);
        return { decision: completeForm(s, pc.form, [...acks, ...fill.acks], io, heldAsRead(s, pc.form, asRead)), events: fill.events };
      }
      // The offer was accepted: the transfer the caller was offered is the one they get. One made
      // for a question there was no answer to (a form's completion, or an informational intent's
      // passage: `why: 'no-answer'`) is not a frustrated caller's.
      if (pc.target === 'transfer') return { decision: handoff(s, pc.why === 'no-answer' || pc.after !== undefined ? 'live-agent' : 'frustrated'), events: [] };
      if (pc.intent === 'agent') return { decision: handoff(s, 'live-agent'), events: [] };
      if (pc.intent === 'done') return { decision: goodbye(s), events: [] };
      // An informational intent the model was unsure of (gates.ts, `inform_explicit`): the yes says
      // it, as the inform verdict does, and the call goes back to the intent question. Nothing fills:
      // the yes opens no form.
      const informs = informationOf(io.app, pc.intent);
      if (informs !== undefined) {
        const said = informed(s, io, informs);
        return { decision: (said.answered ? null : offerAfterUnavailable(s, said.acks)) ?? resume(s, io, said.acks), events: [] };
      }
      if (!isFormIntent(io.app, pc.intent)) return { decision: failAttempt(s, 'intent', io), events: [] };
      // Fill from what the caller originally said, not from the "yes"; the form hears the yes too.
      // Its topic slot reads the topics nominated for those words, not this turn's (for the yes).
      const said = slotContext(s, pc.text, knowledgeOfWords(io.tc, pc.nominated));
      // A priority intent that corrects the form, checked first ("just to check, ..."): those words
      // were heard with the form left still open, and nothing has filled since, so the yes corrects
      // from them exactly as a switch taken at once would have (correctOnSwitch).
      if (pc.intent !== s.form && correctsFormOf(io.app, pc.intent)) {
        const corrected = correctOnSwitch(s, pc.answers, said);
        const entered = enterForm(s, pc.intent, pc.answers, said, io, undefined, answers);
        return { decision: entered.decision, events: [...corrected, ...entered.events] };
      }
      return enterForm(s, pc.intent, pc.answers, said, io, undefined, answers);
    }
    case 'rejected': {
      const pc = s.pendingConfirmation!;
      s.pendingConfirmation = null;
      if (pc.target === 'form') {
        const acks = enqueue(s, verdict.queue);
        // "No, Friday" corrects and re-asks in one turn; continueForm re-arms the summary with a
        // fresh attempt count once the corrected slot -- or the narrowing it needs -- is settled.
        const fill = correctingFill(s, answers, ctx, pc.form);
        if (fill.progress) return { decision: continueForm(s, io, [...acks, ...fill.acks], fill.disambiguate), events: fill.events };
        s.pendingConfirmation = pc;
        // "No, anything later?" is the form's own move along what its summary offers: a move is a
        // correction and re-arms the summary; no move, with its line (an edge), is an unchanged
        // summary and counts a turn on its ladder.
        const move = summaryMove(s, pc.form, answers, io);
        if (move?.moved) {
          s.pendingConfirmation = null;
          return { decision: continueForm(s, io, [...acks, ...fill.acks, ...move.acks], null), events: fill.events };
        }
        if (move) return { decision: reaskConfirmation(s, io, [...acks, ...move.acks]), events: fill.events };
        // Nothing usable came with the no: ask what to change and keep the summary pending. That
        // question is asked once per summary; a caller who answers it with another bare no has
        // spent a turn on the confirmation, so the ladder counts it (keypad, then an agent).
        if (pc.askedChange === true) return { decision: reaskConfirmation(s, io, acks), events: fill.events };
        return { decision: askChange(pc, acks), events: fill.events };
      }
      if (pc.target === 'transfer') {
        // An offer a completion made closes its form on a no, so nothing the no carried is kept for it.
        if (pc.after !== undefined) return { decision: declineTransfer(s, io, pc, []), events: [] };
        // The answer is an ordinary utterance as well, so whatever it filled
        // stands and the form loop asks whatever is next -- "no, keep going" re-asks the question
        // the caller was on, and "keep going, it was Saturday" answers it on the way past. Outside
        // a form there is no question to answer on the way past: only the call's slots fill (slotsToFill).
        const fill = fillSlots(s, answers, ctx, slotsToFill(s));
        return { decision: declineTransfer(s, io, pc, fill.acks), events: fill.events };
      }
      if (pc.target === 'slot' && pc.offered) {
        // The caller's number offered and declined: the slot's own question, with no attempt counted,
        // since the caller answered what we asked. A number said with the no ("no, use 555 555 0199")
        // fills as said, and the form goes on; one that is not a number of the slot's shape is a
        // missed answer to the slot's question, and is retried as one.
        // With `onNo: skip`, a no with no number leaves the slot empty, declined, and the form goes on.
        const fill = fillSlots(s, answers, ctx, slotsToFill(s));
        const missed = offeredSlotMissed(s, io, pc.slot, fill, []);
        offerSettled(s, io, pc, missed || s.slots[pc.slot]!.value !== null ? 'other' : 'no');
        if (missed) return { decision: missed, events: fill.events };
        declineOnNo(s, io, pc.slot);
        return { decision: continueForm(s, io, fill.acks, fill.disambiguate, fill.help), events: fill.events };
      }
      // A library slot (SlotSpec.readBackNo `ask`): asked again, or given the answer the no carried.
      if (pc.target === 'slot' && slotSpecOf(io.app, pc.slot).readBackNo === 'ask') return slotDeclined(s, pc, answers, ctx, io);
      if (pc.target === 'slot') {
        // A declined readback means the spoken path failed; go straight to the keypad,
        // and let a second decline hand off rather than read a third value back.
        const st = s.slots[pc.slot]!;
        st.attempts = Math.max(st.attempts + 1, t.MAX_ATTEMPTS - 1);
        if (retryStep(st.attempts, t) === 'agent') return { decision: handoff(s, 'max-attempts'), events: [] };
        Object.assign(st, emptySlot(), { attempts: st.attempts });
        return { decision: prompt(`ask_${pc.slot}_dtmf`, pc.slot, {}, [ACK_DECLINED]), events: [] };
      }
      // A check's refusal read back, and the caller says it was misheard: the slots it reads are asked again.
      if (pc.target === 'check') return checkDeclined(s, pc, answers, ctx, io);
      // Declining a mid-form switch means "stay where we were", so resume the form
      // rather than counting an intent failure against the caller.
      if (s.form) return { decision: continueForm(s, io, [], null), events: [] };
      return { decision: failAttempt(s, 'intent', io), events: [] };
    }
    case 'confirm_unanswered': {
      // The confirmation still owns the turn, but an added request is not lost on the way:
      // it joins the queue and is acked in front of the re-asked confirmation.
      const acks = enqueue(s, verdict.queue);
      const pc = s.pendingConfirmation;
      if (pc?.target === 'form') {
        // A correction is a correction whether or not the caller prefixed it with "no", and an
        // answer to ask_change is read for a value before it is read for a slot name.
        const fill = correctingFill(s, answers, ctx, pc.form);
        if (fill.progress) {
          s.pendingConfirmation = null;
          return { decision: continueForm(s, io, [...acks, ...fill.acks], fill.disambiguate), events: fill.events };
        }
        // "Anything later?", with no yes or no, is the same move as "no, anything later?"; an
        // unmoved summary is re-asked where an unanswered turn already counts.
        const move = summaryMove(s, pc.form, answers, io);
        if (move?.moved) {
          s.pendingConfirmation = null;
          return { decision: continueForm(s, io, [...acks, ...fill.acks, ...move.acks], null), events: fill.events };
        }
        if (move) return { decision: reaskConfirmation(s, io, [...acks, ...move.acks], acks.length === 0), events: fill.events };
        return { decision: reaskConfirmation(s, io, acks, acks.length === 0), events: fill.events };
      }
      if (pc?.target === 'slot' && pc.offered) {
        // At the caller's number's offer, a number said with no yes or no ("my cell is 555 555 0199")
        // answers the slot: it fills as said and the offer is closed. Anything else the turn filled
        // stands, and the offer is asked again.
        const fill = fillSlots(s, answers, ctx, slotsToFill(s));
        if (s.slots[pc.slot]!.value !== null) {
          s.pendingConfirmation = null;
          offerSettled(s, io, pc, 'other');
          return { decision: continueForm(s, io, [...acks, ...fill.acks], fill.disambiguate), events: fill.events };
        }
        // A number of the wrong shape ("use five five five") is not the number offered, nor a number
        // the slot takes: the offer is closed, and the slot's question retried as for a missed answer.
        const missed = offeredSlotMissed(s, io, pc.slot, fill, acks);
        if (missed) offerSettled(s, io, pc, 'other');
        if (missed) return { decision: missed, events: fill.events };
        return { decision: reaskConfirmation(s, io, [...acks, ...fill.acks], acks.length === 0 && !fill.progress), events: fill.events };
      }
      // Only a request that actually joined the queue buys the turn: asking for the same thing
      // twice is a turn spent, and must not hold the ladder at zero forever.
      return { decision: reaskConfirmation(s, io, acks, acks.length === 0), events: [] };
    }
    case 'change_slot': {
      const acks = enqueue(s, verdict.queue);
      const form = s.pendingConfirmation?.target === 'form' ? s.pendingConfirmation.form : s.form;
      s.pendingConfirmation = null;
      // By default a turn that gives any new value never gets here: the gates set the naming aside
      // and the turn is a no with a correction (App.changeSlotWithValue). An app that lets the
      // naming decide regardless (`decides`) comes here with the value as well.
      // "The date's wrong, it was Friday" names a detail and replaces it in one breath: the value
      // it carries is worth more than the question we would otherwise ask. Only
      // a new value for the slot they named answers it, though: "wrong parcel, it was
      // Friday" moves the date and still leaves the parcel to ask for.
      const fill = form ? correctingFill(s, answers, ctx, form) : null;
      // `fill.progress` is what keeps a re-speak of the value the summary just read back off this
      // path: naming a detail and repeating it unchanged answers nothing, so it reopens the slot
      // rather than re-arming the summary with a fresh attempt count.
      const named = fill?.progress === true
        && fill.events.some((e) => e.slot === verdict.slot && (e.outcome.kind === 'filled' || e.outcome.kind === 'window' || e.outcome.kind === 'disambiguate'));
      if (named) return { decision: continueForm(s, io, [...acks, ...fill!.acks], fill!.disambiguate), events: fill!.events };
      // The named slot is asked from scratch, but the attempts it already cost stand: a caller
      // who could not say it the first time should not start the ladder over. Whatever else the
      // same breath filled is kept, and acked on the way into the question.
      const st = s.slots[verdict.slot]!;
      Object.assign(st, emptySlot(), { attempts: st.attempts });
      // Reopened, a slot the caller declined is theirs to answer again.
      delete st.declined;
      // A slot that offers the caller's number, reopened, is asked its own question from here on,
      // whether or not its number was offered before (offered once per form, callerOffered), and
      // whether or not there was a number to offer (one that skips with none, `ifNone: skip`, is asked).
      // So is one that proposes a value from the facts (`offer: facts`): the caller said it is wrong.
      const offering = ((s.callerNumber !== undefined || skipsIfNone(io.app, verdict.slot)) && callerNumberSlots(io.app).includes(verdict.slot)) || factsOfferSlots(io.app).includes(verdict.slot);
      if (offering && !(s.callerOffered ?? []).includes(verdict.slot)) s.callerOffered = [...(s.callerOffered ?? []), verdict.slot];
      const said = [...acks, ...(fill?.acks ?? [])];
      // What else the breath changed ("the town's wrong, and I rent it", where the naming decides)
      // goes through the form's checks now, as any fill does in continueForm, rather than waiting
      // for the reopened slot's answer: a caller it rules out is not asked that slot first.
      if (form !== null && fill?.progress === true && s.entered === form) {
        // A value it gave that a library slot reads back (SlotSpec.readBackNo `ask`) is read back first,
        // as the form loop does, before any check reads it; the reopened slot is asked after.
        if (libraryReadBackOwed(s)) return { decision: continueForm(s, io, said, null), events: fill.events };
        const checks = runChecks(s, form, io.tc, io.out);
        if (checks.kind !== 'passed') return { decision: stopForm(s, form, checks, said, io), events: fill.events };
        said.push(...passedAcks(s, checks));
      }
      return { decision: askSlot(s, verdict.slot, null, said), events: fill?.events ?? [] };
    }
    case 'route':
      if (verdict.confirm === 'explicit') {
        // The words' nominations go with them, for the form the yes opens (only when retrieval ran).
        s.pendingConfirmation = { target: 'intent', intent: verdict.intent, answers, text: ctx.text, ...(ctx.nominated !== undefined ? { nominated: ctx.nominated } : {}) };
        return { decision: prompt('confirm_intent_explicit', 'intent', { intentLabel: intentLabel(io.app, verdict.intent) }, [], ['yes', 'no']), events: [] };
      }
      // "No, that's all" at "anything else?": the call ends with the goodbye alone.
      if (verdict.intent === 'done') return { decision: goodbye(s), events: [] };
      // A switch to a priority intent that corrects the form (IntentDef.priority `correctsForm`):
      // what the turn said for the slots it was asked about replaces what they held, before the
      // priority form is entered.
      if (verdict.intent !== s.form && correctsFormOf(io.app, verdict.intent)) {
        const corrected = correctOnSwitch(s, answers, ctx);
        const entered = enterForm(s, verdict.intent, answers, ctx, io, verdict.queue);
        return { decision: entered.decision, events: [...corrected, ...entered.events] };
      }
      // A second task named on the same breath as the first is queued as the form opens;
      // on an explicit-confirm route it is dropped and the caller can re-add it.
      return enterForm(s, verdict.intent, answers, ctx, io, verdict.queue);
    case 'disambiguate_intent':
      return { decision: prompt('disambiguate_intent', 'intent', { a: intentLabel(io.app, verdict.a), b: intentLabel(io.app, verdict.b) }, [], [intentLabel(io.app, verdict.a), intentLabel(io.app, verdict.b)]), events: [] };
    case 'intent_failed':
      return { decision: failAttempt(s, 'intent', io), events: [] };
    case 'queue': {
      // The gates only emit queue inside a form; without one there is nothing to add to.
      if (!s.form) return handleVerdict(s, { kind: 'proceed' }, answers, ctx, io);
      const acks = enqueue(s, verdict.intent);
      const fill = fillSlots(s, answers, ctx, slotsToFill(s));
      // Adding a request is not a failed answer: re-ask the open slot without counting an attempt.
      return { decision: continueForm(s, io, [...acks, ...fill.acks], fill.disambiguate, fill.help), events: fill.events };
    }
    case 'proceed': {
      // Speech at the code prompt is refused, and nothing it said is filled: the code is keyed or
      // not at all. A code actually said aloud arrives masked (spokenCode.ts) and counts as exposed,
      // so the caller is told a new one has been sent rather than asked to key the old one.
      if (s.promptedFor === 'otp') return { decision: codeReask(s, io, [], saidCode(ctx.text) ? 'otp_spoken_reissued' : 'ask_otp_spoken'), events: [] };
      const fill = fillSlots(s, answers, ctx, slotsToFill(s));
      if (!fill.progress) {
        // Nothing to blame the failure on when the prompt was not a slot's: the slot the form
        // needs next takes the attempt, so the retry ladder still walks somewhere.
        const asked = promptedTarget(s);
        const target = asked === 'intent' || asked === 'confirm' ? (missingSlots(s)[0] ?? 'intent') : asked;
        const invalid = fill.events.find((e) => e.slot === target && e.outcome.kind === 'invalid')?.outcome;
        const retry = invalid?.kind === 'invalid' ? (invalid.retryPromptId ?? null) : null;
        return { decision: failAttempt(s, target, io, [], false, retry), events: fill.events };
      }
      return { decision: continueForm(s, io, fill.acks, fill.disambiguate, fill.help), events: fill.events };
    }
  }
}

function handleDtmf(s: Session, digit: string, io: TurnIO): { decision: Decision; rows: GateRow[] } {
  const tc = io.tc;
  // The keypad code: buffered, checked and forgotten by the lifecycle. It is never a slot.
  if (s.promptedFor === 'otp') {
    const acks: Ack[] = [];
    const decision = handleCodeDigit(s, digit, tc, io.out, acks);
    return { decision: decision ?? continueForm(s, io, acks, null), rows: [] };
  }
  s.dtmfBuffer += digit;
  if (s.menuActive) {
    const option = io.app.menu.find((m) => m.digit === digit);
    s.dtmfBuffer = '';
    // A wrong key is a failed menu attempt, not dead air.
    if (!option) return { decision: failAttempt(s, 'intent', io), rows: [] };
    if (option.intent === 'agent') return { decision: handoff(s, 'live-agent'), rows: [] };
    // An informational intent's key plays its line as the spoken intent does (the inform verdict):
    // an ack in front of the question the caller was on, here the keypad menu, its rung intact.
    const informs = informationOf(io.app, option.intent);
    if (informs !== undefined) {
      const said = informed(s, io, informs);
      return { decision: (said.answered ? null : offerAfterUnavailable(s, said.acks)) ?? resume(s, io, said.acks), rows: [] };
    }
    if (!isFormIntent(io.app, option.intent)) return { decision: { kind: 'ignore' }, rows: [] };
    setForm(s, option.intent);
    return { decision: continueForm(s, io, [ackIntent(s, option.intent)], null), rows: [] };
  }
  // The summary's keypad fallback: 1 confirms, 2 opens the change question, anything else is a miss.
  if (s.promptedFor === 'confirm' && s.pendingConfirmation?.target === 'form') {
    const pc = s.pendingConfirmation;
    s.dtmfBuffer = '';
    // Only where the keys mean something: the summary itself ("yes or no"), as its form's summary
    // hook last read it too (readAs), the keypad prompt that names them, and the slow-turn hint, which
    // offers the keypad in so many words. At ask_change a digit answers nothing, so it is not a missed
    // turn either.
    const summaryId = formOf(io.app, pc.form).summaryPromptId;
    const advertised = s.lastPromptId === 'confirm_dtmf' || s.lastPromptId === 'system_slow_dtmf_hint'
      || (summaryId !== null && s.lastPromptId === summaryId) || (pc.readAs !== undefined && s.lastPromptId === pc.readAs);
    if (!advertised) return { decision: { kind: 'ignore' }, rows: [] };
    if (digit === '1') {
      s.pendingConfirmation = null;
      agreeAsRead(s, pc.form, true);
      return { decision: completeForm(s, pc.form, [], io, heldAsRead(s, pc.form, formValues(s, pc.form))), rows: [] };
    }
    if (digit === '2') return { decision: askChange(pc, []), rows: [] };
    return { decision: reaskConfirmation(s, io), rows: [] };
  }
  const result = applyDtmf(s, s.dtmfBuffer, slotContext(s, '', tc));
  switch (result.kind) {
    case 'collecting':
      return { decision: { kind: 'ignore' }, rows: [] };
    case 'no_target':
      s.dtmfBuffer = '';
      return { decision: { kind: 'ignore' }, rows: [] };
    case 'invalid':
      s.dtmfBuffer = '';
      return { decision: failAttempt(s, result.slot, io), rows: [] };
    case 'filled': {
      s.dtmfBuffer = '';
      // A number keyed at the offer of the caller's number is the caller's own answer to it.
      const pc = s.pendingConfirmation;
      if (pc?.target === 'slot' && pc.offered && pc.slot === result.slot) offerSettled(s, io, pc, 'other');
      s.pendingConfirmation = null;
      return { decision: identityAtGreeting(s) ? identifyAtGreeting(s, io, []) : continueForm(s, io, [], null), rows: [dtmfRow(result.slot)] };
    }
  }
}

/**
 * The frustration rungs the gate reached, applied to what the turn was going to say anyway.
 * Only a prompt can carry them: a decision that ends the call says its own
 * line, and an ignored or held turn says nothing at all, so neither is a place to react.
 */
function escalate(s: Session, decision: Decision, rung: FrustrationRung | undefined): Decision {
  if (rung === undefined || decision.kind !== 'prompt') return decision;
  // What a completion just said while a downstream service's answer is awaited (e.g. a report's
  // number) is not taken back for an offer: the answer follows. The same goes for an offer already
  // on the table, which keeps what it was for.
  if (rung === 'ack' || s.pendingService !== null || s.pendingConfirmation?.target === 'transfer') {
    return { ...decision, acks: [ACK_FRUSTRATION, ...decision.acks] };
  }
  // The offer takes the place of the question this turn would have asked. What the turn filled or
  // routed stands, and the question comes back once the offer is answered -- from the form loop,
  // or, where this turn had armed a confirmation of its own, from `resume`.
  const displaced = s.pendingConfirmation;
  s.pendingConfirmation = displaced !== null ? { target: 'transfer', attempts: 0, resume: displaced } : { target: 'transfer', attempts: 0 };
  s.promptedFor = 'confirm';
  return offerTransfer(decision.acks);
}

function handleFailure(s: Session): Decision {
  s.consecutiveFailures += 1;
  if (s.consecutiveFailures >= 2) return handoff(s, 'system-failure');
  return prompt(s.caps.keypad ? 'system_slow_dtmf_hint' : 'system_slow_chat', promptedTarget(s));
}

function bookkeep(s: Session, decision: Decision, verdictLabel: string): void {
  if (decision.kind === 'ignore' || decision.kind === 'hold') return;
  s.turnIndex += 1;
  s.history.push({ node: s.lastPromptId ?? 'start', intent: verdictLabel, outcome: decision.kind });
  if (decision.kind === 'prompt') {
    s.lastPromptId = decision.promptId;
    s.lastPromptText = spokenText(appOf(s), decision, s.locale);
    s.lastPromptOptions = [...decision.options];
    s.promptedFor = decision.target;
    s.menuActive = decision.menu === true;
    s.dtmfBuffer = '';
    // A help prompt is recorded only once it is the decision actually spoken: `escalate` can
    // still replace it with the transfer offer, whose own decision carries no `help` of its own.
    if (decision.help) s.slots[decision.help.slot]!.helped.push(decision.help.promptId);
  } else if (decision.kind === 'complete' || decision.kind === 'handoff') {
    s.lastPromptId = decision.promptId;
    s.lastPromptText = spokenText(appOf(s), decision, s.locale);
    // A code keyed partway is not kept past the call: the buffer goes with any decision that leaves the prompt.
    s.dtmfBuffer = '';
    s.ended = true;
  }
}

/** The purpose the call-start lookup is made with (app.yaml's `callerNumber.lookup`): a gate decision and the audit say what it was. */
export const CALLER_LOOKUP_PURPOSE = 'caller-lookup';

/**
 * The call-start lookup (app.yaml's `callerNumber: { use: hint, lookup }`): one call, through the gate
 * (lifecycle.ts callTool), as the caller not yet proven, with the number kept as its one param. Its
 * gate decision is recorded like every other (the trace, the console, the audit, the param masked as
 * policy.yaml's `audit:` says). A refusal is silent: nothing is said or kept, and the call goes on as
 * without a number. So is a failure: a tool that throws is recorded as failed (callTool's
 * `failSoft`), and a result the facts hook throws on leaves the facts as they were, so neither keeps
 * the greeting from being said. An allowed result goes to the app's facts
 * (FactsConfig.fromCallerLookup). Only for a session that kept the caller's number, an anonymous
 * caller (a call; a chat has no number) and an app that names a lookup. Tools are synchronous
 * (ToolDef.run), so the greeting waits for nothing but the tool's own run: there is no wait to bound.
 */
function callerLookup(s: Session, io: TurnIO): void {
  const tool = io.app.callerNumber?.lookup;
  if (tool === undefined || !hintsCallerNumber(io.app) || s.callerNumber === undefined || !isAnonymous(s.principal)) return;
  const { decision, value } = callTool(s, { tool, params: { callerNumber: s.callerNumber }, purpose: CALLER_LOOKUP_PURPOSE }, io.tc, io.out, undefined, { failSoft: true });
  const facts = io.app.facts;
  if (decision.verdict !== 'ALLOW' || value === null || value === undefined || facts?.fromCallerLookup === undefined) return;
  const before = facts.clone(s.facts);
  try {
    facts.fromCallerLookup(s.facts, value);
  } catch {
    s.facts = before;
  }
}

/** The open question, asked once the greeting's proposal is settled. */
const GREET_AFTER_OFFER = 'greet_after_offer';

/**
 * The proposal at the greeting (a slot's `offerAt: greeting`): on a call, after the call-start lookup,
 * the first such slot in slots.yaml order the facts have a candidate for is proposed (`offer_<slot>`)
 * after `greeting_offer` (app.yaml's `prompts.greetings.offer`), in place of the greeting and its open question, and kept on the session
 * (greetingOffered) so its form does not propose it again. Null when there is none: a chat (no number
 * was looked up), no such slot, or no candidate; the greeting is then as always.
 */
function greetingProposal(s: Session, io: TurnIO): PromptDecision | null {
  if (!s.caps.speech) return null;
  for (const slot of greetingOfferSlots(io.app)) {
    const c = factsCandidate(io.app, slot, s.facts);
    if (c === null) continue;
    s.greetingOffered = slot;
    const pc: Extract<PendingConfirmation, { target: 'slot' }> = { target: 'slot', slot, value: c.value, display: c.display, offered: true, from: 'facts', at: 'greeting' };
    s.pendingConfirmation = pc;
    return offerPrompt(pc, [{ promptId: greetingOfferPromptId(io.app), vars: {} }]);
  }
  return null;
}

/**
 * A turn at the greeting's proposal (the pending read-back `at: greeting`): what it settles, or null
 * for the turn's own path. A yes fills the slot, confirmed; a no fills it only with a value of the
 * caller's own said with it ("no, it's 14 Birch Lane"), as does such a value said with neither, whatever
 * the slot listens for (ownAnswer). Either way the `offer` audit row is written, and the request said in
 * the same breath, if any, is the opening request (openingAfterOffer). A priority intent in the same
 * breath takes the turn before any of this (the gates), so a yes said with one is not kept. A turn that asks for something else (a request, an informational question, a
 * choice between two) drops the proposal, unanswered and not repeated, and goes on as the opening turn
 * it is. Words that answer neither, a silence or words not made out are asked again on the ladder of
 * reaskConfirmation; a handoff, a replay and a held or ignored turn are what they always are.
 */
function atGreetingOffer(s: Session, verdict: Verdict, answers: AnswerMap, ctx: SlotContext, io: TurnIO): { decision: Decision; events: FillEvent[] } | null {
  const pc = s.pendingConfirmation;
  if (pc?.target !== 'slot' || pc.at !== 'greeting') return null;
  switch (verdict.kind) {
    case 'ignore':
    case 'hold':
    case 'nomatch':
    case 'handoff':
    case 'replay':
      return null;
    case 'confirm_unanswered': {
      // A value of the caller's own with no yes or no ("it's at 7 Birch Lane") answers the question
      // asked: the slot takes it, whatever it listens for, and the open question follows.
      const own = ownAnswer(s, pc, answers, ctx, io);
      if (s.slots[pc.slot]!.value === null) return { decision: reaskConfirmation(s, io), events: [] };
      s.pendingConfirmation = null;
      offerSettled(s, io, pc, 'other');
      return { decision: prompt(GREET_AFTER_OFFER, 'intent', {}, own.acks), events: own.events };
    }
    case 'confirmed': {
      s.pendingConfirmation = null;
      Object.assign(s.slots[pc.slot]!, { value: pc.value, display: pc.display, confirmed: true, window: null });
      offerSettled(s, io, pc, 'yes');
      io.kept = pc.slot;
      return openingAfterOffer(s, answers, ctx, io);
    }
    case 'rejected': {
      s.pendingConfirmation = null;
      // "No, it's 14 Birch Lane" answers the question asked: the slot takes it, whatever it listens for.
      const own = ownAnswer(s, pc, answers, ctx, io);
      offerSettled(s, io, pc, s.slots[pc.slot]!.value !== null ? 'other' : 'no');
      return openingAfterOffer(s, answers, ctx, io, own);
    }
    default:
      s.pendingConfirmation = null;
      return null;
  }
}

/**
 * After a yes or a no to the greeting's proposal: the turn's words read again as an opening turn, with
 * the proposal settled (the gates once more, from the same answers). A request goes on as one ("yes,
 * I'd like to report a problem"); with none, what the words gave the call's own slots is kept (as on
 * any turn that opens no form) and the open question is asked (`greet_after_offer`).
 */
function openingAfterOffer(s: Session, answers: AnswerMap, ctx: SlotContext, io: TurnIO, own: Pick<FillResult, 'acks' | 'events'> = { acks: [], events: [] }): { decision: Decision; events: FillEvent[] } {
  const { rows, verdict } = evaluateGates(s, io.turnState!, answers, io.tc.thresholds);
  // Shown beside the turn's own rows, never credited with deciding it: the proposal's answer did.
  io.openingRows = rows.map((r) => ({ ...r, gate: `opening:${r.gate}`, decided: false }));
  if (verdict.kind !== 'intent_failed' && verdict.kind !== 'replay') {
    const opened = handleVerdict(s, verdict, answers, ctx, io);
    return { decision: opened.decision, events: [...own.events, ...opened.events] };
  }
  const fill = fillSlots(s, answers, ctx, slotsToFill(s).filter((spec) => spec.id !== io.kept));
  return { decision: prompt(GREET_AFTER_OFFER, 'intent', {}, [...own.acks, ...fill.acks]), events: [...own.events, ...fill.events] };
}

/**
 * What a turn at the greeting's proposal said for the slot proposed, filled into it alone, whatever
 * the slot listens for: the question asked was about it. A value it took is kept from being filled
 * again by the rest of the turn (TurnIO.kept).
 */
function ownAnswer(s: Session, pc: Extract<PendingConfirmation, { target: 'slot' }>, answers: AnswerMap, ctx: SlotContext, io: TurnIO): FillResult {
  const fill = fillSlots(s, answers, ctx, [slotSpecOf(io.app, pc.slot)]);
  if (s.slots[pc.slot]!.value !== null) io.kept = pc.slot;
  return fill;
}

/**
 * The caller-ID question at the greeting (identity.yaml's `callerId` with `ask: greeting`): on a call
 * whose number the call-start lookup matched to one account (callerMatchOf), `identity_caller_match`
 * after the greeting's line before a proposal (`greeting_offer`, as for a proposal at the greeting), in
 * place of the greeting and its open question. Identity is then under way with no form open (a step-up
 * `at: greeting`, whose call is the verify tool's). Null when there is no match, on a chat, and for
 * every app without it; the greeting, or a proposal at the greeting, is then as always.
 */
function callerMatchAtGreeting(s: Session, io: TurnIO): PromptDecision | null {
  const identity = io.app.identity;
  if (!s.caps.speech || identity?.callerId?.ask !== 'greeting') return null;
  const match = callerMatchOf(s);
  const slot = match === null ? undefined : identity.factorSlots.find((id) => !Object.hasOwn(match, id));
  if (slot === undefined) return null;
  s.stepUp = { call: { tool: identity.verifyTool, params: {} }, need: 1, at: 'greeting' };
  return askCallerMatch(s, slot, io.out, [{ promptId: greetingOfferPromptId(io.app), vars: {} }]);
}

/** Identity under way at the greeting, with no form open (a step-up `at: greeting`, callerMatchAtGreeting). */
function identityAtGreeting(s: Session): boolean {
  return s.form === null && s.stepUp?.at === 'greeting' && isAnonymous(s.principal);
}

/**
 * Identity asked for at the greeting goes on: the next factor, or the check once the factors are in
 * (lifecycle.ts continueIdentity). Once the caller is verified, the open question (`greet_after_offer`),
 * after "Thank you, Avery. You're verified."
 */
function identifyAtGreeting(s: Session, io: TurnIO, acks: Ack[]): Decision {
  const said = [...acks];
  return continueIdentity(s, io.tc, io.out, said) ?? prompt(GREET_AFTER_OFFER, 'intent', {}, said);
}

/**
 * A turn while identity is under way at the greeting (identityAtGreeting): what it settles, or null
 * for the turn's own path. A factor said fills, and the next is asked or the check runs; "different
 * account" or a no to the caller-ID question sets the match aside and asks every factor at once, from
 * the first (with `identity_caller_declined` first, where prompts.yaml has it); words that give no
 * factor walk the asked slot's own ladder. A request said instead (a form, an informational question,
 * a choice between two) ends it: the request goes on, and the match, if it was not turned down, is
 * kept for when identity is needed. Side speech, a held partial, words not made out, a handoff and a
 * replay are what they always are.
 */
function atGreetingIdentity(s: Session, verdict: Verdict, answers: AnswerMap, ctx: SlotContext, io: TurnIO): { decision: Decision; events: FillEvent[] } | null {
  if (!identityAtGreeting(s)) return null;
  if (verdict.kind === 'route' || verdict.kind === 'disambiguate_intent' || verdict.kind === 'inform') {
    s.stepUp = null;
    if (s.callerMatch === 'offered') delete s.callerMatch;
    return null;
  }
  if (verdict.kind !== 'intent_failed' && verdict.kind !== 'proceed') return null;
  const declined = callerMatchDeclined(s, answers, io);
  const fill = fillSlots(s, answers, ctx, slotsToFill(s));
  const acks: Ack[] = [];
  if (declined) {
    noteCallerMatch(s, io.out, 'declined');
    acks.push(...declinedAck(io.app));
  } else if (!fill.progress) {
    const target = promptedTarget(s);
    const invalid = fill.events.find((e) => e.slot === target && e.outcome.kind === 'invalid')?.outcome;
    const retry = invalid?.kind === 'invalid' ? (invalid.retryPromptId ?? null) : null;
    return { decision: failAttempt(s, target, io, [], false, retry), events: fill.events };
  }
  if (fill.disambiguate) {
    const d = fill.disambiguate;
    return { decision: prompt(`disambiguate_${d.slot}`, d.slot, { a: d.a.display, b: d.b.display }, [...acks, ...fill.acks], [d.a.display, d.b.display]), events: fill.events };
  }
  return { decision: identifyAtGreeting(s, io, [...acks, ...fill.acks]), events: fill.events };
}

/**
 * Inside a form, a no or "different account" at the caller-ID question (or at a factor asked while
 * the match stands): the match is set aside for the call, and every factor is asked, from the first
 * (with `identity_caller_declined` first, where prompts.yaml has it). What else the turn said fills as
 * on any turn. Null for every other turn.
 */
function atCallerMatch(s: Session, verdict: Verdict, answers: AnswerMap, ctx: SlotContext, io: TurnIO): { decision: Decision; events: FillEvent[] } | null {
  if (s.form === null || verdict.kind !== 'proceed' || s.pendingConfirmation !== null || !callerMatchDeclined(s, answers, io)) return null;
  const fill = fillSlots(s, answers, ctx, slotsToFill(s));
  noteCallerMatch(s, io.out, 'declined');
  return { decision: continueForm(s, io, [...declinedAck(io.app), ...fill.acks], fill.disambiguate, fill.help), events: fill.events };
}

/** The caller turned the caller-ID match down (questions.ts callerMatchDeclined, read as a no to a confirmation is). */
function callerMatchDeclined(s: Session, answers: AnswerMap, io: TurnIO): boolean {
  return callerMatchAsked(s) && atLeast(noulValue(answers, 'callerMatchDeclined'), io.tc.thresholds.CONFIRM_NO);
}

/** The line said before every factor is asked after the caller-ID match is turned down: `identity_caller_declined`, where prompts.yaml has it. */
function declinedAck(app: App): Ack[] {
  return Object.hasOwn(app.prompts.manifest, CALLER_DECLINED_PROMPT) ? [{ promptId: CALLER_DECLINED_PROMPT, vars: {} }] : [];
}
const CALLER_DECLINED_PROMPT = 'identity_caller_declined';

/**
 * A slot's question asked again as it was first asked: the caller-ID question where that was it (the
 * match still standing), else the slot's own.
 */
function askedAgain(s: Session, slot: SlotId, acks: Ack[]): PromptDecision {
  if (s.lastPromptId === CALLER_MATCH_PROMPT && callerMatchAsked(s)) return prompt(CALLER_MATCH_PROMPT, slot, {}, acks);
  return askSlot(s, slot, null, acks);
}

/**
 * The opening line: the voice greeting, or on chat someone acting for the app's subjects or a
 * signed-in subject by name, or the web visitor's.
 */
function greeting(s: Session): PromptDecision {
  const p = s.principal;
  const ids = appOf(s).prompts.greetings;
  if (!s.caps.speech && !isAnonymous(p)) {
    const subject = p.kind === identityOf(appOf(s)).subjectKind;
    const id = subject ? (ids?.chatSignedIn ?? 'greeting_chat_signed_in') : (ids?.chatDelegate ?? 'greeting_chat_delegate');
    return prompt(id, 'intent', { first: p.first });
  }
  if (!s.caps.speech) return prompt(ids?.chat ?? 'greeting_chat', 'intent');
  return prompt(ids?.voice ?? 'greeting', 'intent');
}

/**
 * `screen` is the injection screen's reading of a speech or text event's words, asked beside perception;
 * null (or absent) when it was not asked. It is only read on a words turn, and only after the
 * post-filing wait, when a caller's words are ignored anyway.
 *
 * The turn's audit drafts are built from what the turn reports, once it has run (core/audit.ts).
 */
export function resolve(session: Session, event: SessionEvent, answers: AnswerMap | null, tc: TurnContext, error: TurnError | null = null, screen: ScreenResult | null = null): TurnResult {
  const r = resolveTurn(session, event, answers, tc, error, screen);
  const audit = auditDrafts({
    before: session, after: r.session, event, decision: r.decision, gateEvents: r.gateEvents, kb: r.kb, screen: r.screen, quarantined: r.quarantined,
    ...(r.stopped ? { stopped: r.stopped } : {}),
    ...(r.reconfirmed ? { reconfirmed: r.reconfirmed } : {}),
    ...(r.offer ? { offer: r.offer } : {}),
    ...(r.callerMatch ? { callerMatch: r.callerMatch } : {}),
  });
  return { ...r, audit };
}

function resolveTurn(session: Session, event: SessionEvent, answers: AnswerMap | null, turnContext: TurnContext, error: TurnError | null, screen: ScreenResult | null): Omit<TurnResult, 'audit'> {
  const s = cloneSession(session);
  const tc = appTurnContext(appOf(s), turnContext);
  const io: TurnIO = { app: appOf(s), tc, out: newTurnOut(), prefix: [] };
  // The turn's actions: what it asks first (a language switch), then its decision's lines in the session's locale, as it is now.
  const act = (decision: Decision): Action[] => [...io.prefix, ...decisionToActions(io.app, decision, tc.render, s.locale)];
  // Read at return time, not here: the handlers below fill `io.out` as the turn runs.
  const base = () => ({ session: s, turnState: null, rows: [] as GateRow[], verdict: null, fillEvents: [], ...io.out, screen, quarantined: false });
  if (s.ended) return { ...base(), decision: { kind: 'ignore' }, actions: [] };
  // A completion has handed work to a downstream service (e.g. a report just filed, its number
  // said); the service's answer is what comes next. Until it does, nothing the caller says or keys can
  // re-read the summary or complete the form again.
  // The same goes for anything that arrived during the wait and only runs once the answer is in:
  // the caller said it before hearing what the answer's turn asks, so it answers nothing.
  if ((s.pendingService !== null || tc.duringService === true) && (event.type === 'user.speech' || event.type === 'user.text' || event.type === 'user.key' || event.type === 'user.silence')) {
    return { ...base(), decision: { kind: 'ignore' }, actions: [] };
  }

  switch (event.type) {
    case 'session.start': {
      // The locale the channel asks for, where the app speaks it; any other request leaves the
      // session in the app's default. An app without locales has no locale to set.
      if (event.locale !== undefined && io.app.locales) s.locale = matchLocale(io.app, event.locale) ?? io.app.locales.default;
      // The number the caller is calling from, kept only where a slot can offer it or the app keeps it
      // for its code, and the number called only where the app keeps it (core/callerNumber.ts).
      const caller = keptCallerNumber(io.app, event.callerNumber);
      if (caller !== undefined) s.callerNumber = caller;
      const called = keptCalledNumber(io.app, event.calledNumber);
      if (called !== undefined) s.calledNumber = called;
      // The app's lookup by that number, once, before the greeting, through the gate.
      if (caller !== undefined) callerLookup(s, io);
      // The caller-ID question at the greeting (identity.yaml's callerId, ask: greeting), with a match
      // now; else a slot that proposes at the greeting (offerAt: greeting), with a candidate now: either
      // in place of the open question. The caller-ID question wins: a proposal is then made at its slot.
      const decision = callerMatchAtGreeting(s, io) ?? greetingProposal(s, io) ?? greeting(s);
      bookkeep(s, decision, 'setup');
      return { ...base(), decision, actions: act(decision) };
    }
    case 'user.key': {
      // The prompt moved between the digit's arrival and this turn: a digit recorded as part of the
      // code is never fed to a slot, one pressed before the code prompt is not part of the code, a
      // digit logged as itself never fills the account ID or birth date, a account ID digit is not
      // keyed into the birth date, and one keyed ahead of a question it had not heard answers nothing.
      const now = digitAtRun(s, event, tc);
      if (now === 'ignored') return { ...base(), decision: { kind: 'ignore' }, actions: [] };
      // A sensitive digit is not written into the history, even as the last one keyed: the history
      // is part of the state the model is sent.
      const label = now === 'code' ? 'dtmf:code' : now === 'identity' ? 'dtmf:identity' : `dtmf:${event.digit}`;
      const { decision: handled, rows } = handleDtmf(s, event.digit, io);
      const decision = readSummary(s, handled, io);
      bookkeep(s, decision, label);
      return { ...base(), rows, decision, actions: act(decision) };
    }
    case 'user.interrupt':
      // Barge-in is state, not a turn: the next speech turn reports it to the model.
      s.lastInterrupt = { heard: event.heard, afterMs: event.afterMs };
      return { ...base(), decision: { kind: 'ignore' }, actions: [] };
    case 'channel.error':
      return { ...base(), decision: { kind: 'ignore' }, actions: [] };
    case 'service.result': {
      // A downstream service's answer to the request this call is waiting on (the service it asked); any
      // other is not ours to say, and neither is one the app has no way to say.
      const onResult = io.app.onServiceResult;
      if (s.pendingService === null || event.service !== s.pendingService || !onResult) return { ...base(), decision: { kind: 'ignore' }, actions: [] };
      s.pendingService = null;
      // The answer is untrusted: the app checks it and speaks only its own approved lines.
      const ack = onResult(appContext(s, tc, io.out), event.service, event.result);
      const decision = readSummary(s, s.form ? finishForm(s, s.form, [ack], io) : prompt('anything_else', 'intent', {}, [ack]), io);
      bookkeep(s, decision, 'service_result');
      return { ...base(), decision, actions: act(decision) };
    }
    case 'auth.signed_in': {
      // Only the customer chat server makes this, after the portal's sign-in; the relay never produces
      // it off the wire. It raises an anonymous web chat and nothing else: a sign-in never replaces a
      // verified customer or a delegate, and a phone call has no portal. A sign-in proves the level the
      // app's identity says it does (identity.yaml's `signIn`, the top of its ladder), or it is not
      // one: a customer below the top here would be walked into the keypad code, which a chat does not
      // have. An app that says nothing of a sign-in takes none.
      // The event's principal is checked, not trusted: a proven party (isParty), or the event is ignored.
      const signInLevel = identityOf(appOf(s)).signInLevel;
      if (!s.caps.signIn || signInLevel === undefined || !isAnonymous(s.principal) || !isParty(event.principal) || event.principal.kind !== identityOf(appOf(s)).subjectKind || event.principal.level !== signInLevel) {
        return { ...base(), decision: { kind: 'ignore' }, actions: [] };
      }
      s.principal = event.principal;
      const acks: Ack[] = [{ promptId: 'signin_thanks', vars: { first: event.principal.first } }];
      // Signing in is the customer choosing to carry on with what was parked, so a question left open
      // from before is not answered by their next message: a transfer offer is dropped (a slot or
      // summary confirmation it displaced comes back) and an intent confirmation is settled by the
      // sign-in itself. A slot confirmation, kept or restored, is asked again by continueForm; a
      // summary confirmation cannot be pending while the entry call is parked, since the summary
      // comes only after it. Not through resume(): the offer was not declined, and nothing counts
      // an attempt.
      s.pendingConfirmation = pendingAtSignIn(s.pendingConfirmation);
      const parked = s.stepUp !== null && s.form !== null;
      // The waiting request goes back to the gate as new: its entry call is built again, from the
      // customer now signed in, rather than replayed from before.
      s.stepUp = null;
      const decision = readSummary(s, parked ? continueForm(s, io, acks, null) : prompt('signin_ready', 'intent', {}, acks), io);
      bookkeep(s, decision, 'signed_in');
      return { ...base(), decision, actions: act(decision) };
    }
    case 'user.silence': {
      const decision = readSummary(s, handleSilence(s, io), io);
      bookkeep(s, decision, 'silence');
      // Silence resolves whatever was prompted; a stale barge-in marker does not carry into
      // the next turn, same as a real one.
      s.lastInterrupt = null;
      return { ...base(), decision, actions: act(decision) };
    }
    case 'user.speech':
    case 'user.text': {
      const turnState = buildTurnState(s, heard(s, event), tc.nowMs);
      const screened: GateRow[] = screen ? [screenRow(screen, tc.thresholds)] : [];
      // Quarantine does not wait on perception: its answers are discarded whether or not they came.
      if (screen?.fired) {
        const decision = readSummary(s, quarantine(s), io);
        bookkeep(s, decision, 'screen');
        s.lastInterrupt = null;
        return { ...base(), turnState, rows: screened, decision, actions: act(decision), quarantined: true };
      }
      if (error || answers === null) {
        const decision = handleFailure(s);
        bookkeep(s, decision, 'error');
        // The turn state above already reported the barge-in, failed ask or not.
        s.lastInterrupt = null;
        return { ...base(), turnState, rows: screened, decision, actions: act(decision) };
      }
      s.consecutiveFailures = 0;
      io.turnState = turnState;
      const ctx = slotContext(s, event.text, tc);
      const { rows, verdict } = evaluateGates(s, turnState, answers, tc.thresholds, summaryValuesGiven(s, answers, ctx));
      // The gate worked the rung out from the count but left the count alone; the turn owns the
      // bookkeeping, and only a verdict that carries a rung is a frustrated turn to count.
      const rung = frustrationOf(verdict);
      if (rung !== undefined) s.frustratedTurns += 1;
      const { decision: resolved, events } = handleVerdict(s, verdict, answers, ctx, io);
      const decision = readSummary(s, escalate(s, resolved, rung), io);
      rows.push(...(io.openingRows ?? []), ...slotRows(io.app, events, tc.thresholds));
      bookkeep(s, decision, verdict.kind);
      // The barge-in has now been reported to the model; it does not carry into the next turn.
      s.lastInterrupt = null;
      return { ...base(), turnState, rows: [...screened, ...rows], verdict, fillEvents: events, decision, actions: act(decision) };
    }
  }
}
