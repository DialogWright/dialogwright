import { isAnonymous, isParty } from '../gate/types';
import type { AnswerMap, QuestionMap } from '../jev/types';
import type { Action } from '../channel/actions';
import type { SessionEvent, UserSpeech, UserText } from '../channel/events';
import type { SlotContext } from './slots/types';
import { intentLabel, isFormIntent } from './app/intents';
import { formOf, identityOf, slotSpecOf } from './app/lookup';
import { appOf } from './app/registry';
import type { App, Completion, FormId, SlotId, SummaryMove } from './app/types';
import { candidateSpans, candidateWordSpans } from './spans';
import { closeForm, cloneSession, emptySlot, missingSlots, setForm, type PendingConfirmation, type Session } from './session';
import { buildTurnState, type TurnState } from './state';
import { buildQuestions } from './questions';
import { evaluateGates, frustrationOf, type FrustrationRung, type GateRow, type Verdict } from './gates';
import { activeSlots, applyDtmf, fillSlots, nextPrompt, pendingSlotConfirmation, retryStep, type Ack, type FillEvent, type FillResult, type RetryStep } from './fia';
import { askSlot, handoff, offerTransfer, prompt, type CompleteDecision, type Decision, type PromptDecision } from './decision';
import { appContext, askCode, awaitingSignIn, completion, sendCodeAndAsk, ensureEntry, handleCodeDigit, newTurnOut, takeSummaryHash, type Effect, type GateEvent, type KbSource, type TurnOut } from './lifecycle';
import type { Tools } from './tools';
import { withAppThresholds, type Thresholds } from './thresholds';
import type { ScreenResult } from './screen';
import { auditDrafts } from './audit';
import type { AuditDraft } from '../audit/types';
import { decisionToActions, spokenText, type RenderContext } from '../prompts/render';
import { saidCode } from './spokenCode';
import { matchLocale, slotLocaleOf } from './locale';

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
  };
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

/**
 * The form is full and confirmed: its completion answers through the gate (lifecycle.ts), then
 * the call continues. A completion that takes the turn itself returns its decision as it is, and
 * the form is finished later: by a downstream service's answer (service_result), or by the answer to
 * the transfer it offered (declineTransfer).
 */
function completeForm(s: Session, form: FormId, acks: Ack[], io: TurnIO): Decision {
  const c = completion(s, form, acks, io.tc, io.out);
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
 * A completion that ends the call (Completion `end`): the form is counted, and it and its slots stay
 * on the session as they were, the filled ones confirmed where the form has a summary, since the
 * caller has just agreed to it.
 */
function endOnCompletion(s: Session, form: FormId, c: Extract<Completion, { kind: 'end' }>): CompleteDecision {
  s.completed.push(form);
  const def = formOf(appOf(s), form);
  if (def.summaryPromptId !== null) for (const id of def.slots) if (s.slots[id]!.value !== null) s.slots[id]!.confirmed = true;
  return { kind: 'complete', form, promptId: c.promptId, vars: c.vars, acks: c.acks, completed: [...s.completed] };
}

/**
 * Close a form and carry on: the next queued intent, bridged into, or "anything else?". Identity,
 * the app's facts, the identity slots and the slots the app carries stay; the form's other slots,
 * its entry and any confirmation go (closeForm). `completed` is false for a form the gate refused:
 * it closes the same way but is not reported as completed.
 */
function finishForm(s: Session, form: FormId, acks: Ack[], io: TurnIO, completed = true): Decision {
  if (completed) s.completed.push(form);
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
 */
function failAttempt(s: Session, target: 'intent' | 'confirm' | 'otp' | SlotId, io: TurnIO, acks: Ack[] = [], plain = false, retryPromptId: string | null = null): Decision {
  const t = io.tc.thresholds;
  // A guard, not a path anything takes today: `nomatch` re-asks a pending confirmation before it
  // gets here and `proceed` maps a confirm target to a slot. Should a confirm turn reach it, the
  // summary's own ladder owns the attempt rather than the intent's.
  if (target === 'confirm') {
    if (s.pendingConfirmation?.target === 'form') return reaskConfirmation(s, io, acks);
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
    if (plain) return prompt('ask_intent', 'intent', {}, acks);
    return prompt('nomatch_open', 'intent', {}, acks);
  }
  // A slot narrowed to a window re-asks the window question, not the generic retry:
  // "next week. Which day works for you?" is what the caller failed to answer.
  const window = s.slots[target]!.window;
  if (step === 'open' && window) return askSlot(s, target, window, acks);
  if (step === 'open' && plain) return askSlot(s, target, null, acks);
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
        return prompt(`confirm_${pc.slot}`, pc.slot, { [pc.slot]: pc.display }, acks, ['yes', 'no']);
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
    return askSlot(s, asked, s.slots[asked]!.window, acks);
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
  if (pc.target === 'slot') {
    const st = s.slots[pc.slot]!;
    if (!count) return prompt(`confirm_${pc.slot}`, pc.slot, { [pc.slot]: pc.display }, acks, ['yes', 'no']);
    const attempts = ++st.attempts;
    const step = rungFor(s, attempts, t);
    if (step === 'agent') { s.pendingConfirmation = null; return handoff(s, 'max-attempts', acks); }
    // A readback the caller never answers burns the same attempts as a wrong value, so it
    // lands on the keypad rather than looping on a value we still cannot vouch for.
    if (step === 'dtmf') {
      s.pendingConfirmation = null;
      Object.assign(st, emptySlot(), { attempts });
      return prompt(`ask_${pc.slot}_dtmf`, pc.slot, {}, acks);
    }
    return prompt(`confirm_${pc.slot}`, pc.slot, { [pc.slot]: pc.display }, acks, ['yes', 'no']);
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

/** Silence is an unanswered turn on whatever was prompted; no model is asked. */
function handleSilence(s: Session, io: TurnIO): Decision {
  if (s.promptedFor === null) return { kind: 'ignore' };
  s.dtmfBuffer = '';
  if (s.pendingConfirmation) return reaskConfirmation(s, io, [NO_INPUT_ACK]);
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
  const next = nextPrompt(s);
  // The caller said whether they know the answer rather than answering: the slot's help prompt
  // takes the question's place this once, and the attempt count does not move, but only when the form would still ask that slot next; otherwise the question the
  // form actually owes wins, and the help decision is dropped along with it.
  if (help && next.kind === 'ask' && next.slot === help.slot) return { ...prompt(help.promptId, help.slot, {}, said), help };
  if (next.kind === 'complete') return askSummary(s, form, said, io);
  return askSlot(s, next.slot, next.window, said);
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
  const fill = fillSlots(s, answers, ctx, activeSlots(s));
  return { decision: continueForm(s, io, [...acks, ...fill.acks], fill.disambiguate, fill.help), events: fill.events };
}

function handleVerdict(s: Session, verdict: Verdict, answers: AnswerMap, ctx: SlotContext, io: TurnIO): { decision: Decision; events: FillEvent[] } {
  const t = io.tc.thresholds;
  // The open form hears the turn whatever the turn then does (a form it switches to hears it again
  // as it is entered), unless the gates set the turn aside: side speech, a held partial or words that
  // could not be made out say nothing the caller meant for it.
  if (s.form !== null && verdict.kind !== 'ignore' && verdict.kind !== 'hold' && verdict.kind !== 'nomatch') formHeard(s, s.form, answers, io);
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
      // breath carried still fills, as on the queue verdict; no attempt counter moves.
      const fill = fillSlots(s, answers, ctx, activeSlots(s));
      return { decision: resume(s, io, [{ promptId: verdict.promptId, vars: {} }, ...fill.acks], fill.disambiguate, fill.help), events: fill.events };
    }
    case 'confirmed': {
      const pc = s.pendingConfirmation!;
      s.pendingConfirmation = null;
      if (pc.target === 'slot') {
        // The stashed value and display go unread: the gate decided on this turn's yes
        // before any fill could run, so the slot still holds exactly what we read back.
        s.slots[pc.slot]!.confirmed = true;
        return { decision: continueForm(s, io, [], null), events: [] };
      }
      if (pc.target === 'form') {
        const acks = enqueue(s, verdict.queue);
        // A yes that also changes a value ("yes, but it was Sunday") changes it. The write reads its
        // values from the slots, so the gate (R3) refuses it against what the summary said, and the
        // summary is read again: what is filed is only ever what the caller heard and agreed to.
        const fill = correctingFill(s, answers, ctx, pc.form);
        if (fill.disambiguate) return { decision: continueForm(s, io, [...acks, ...fill.acks], fill.disambiguate), events: fill.events };
        return { decision: completeForm(s, pc.form, [...acks, ...fill.acks], io), events: fill.events };
      }
      // The offer was accepted: the transfer the caller was offered is the one they get. One made
      // for a question there was no answer to is not a frustrated caller's.
      if (pc.target === 'transfer') return { decision: handoff(s, pc.after !== undefined ? 'live-agent' : 'frustrated'), events: [] };
      if (pc.intent === 'agent') return { decision: handoff(s, 'live-agent'), events: [] };
      if (pc.intent === 'done') return { decision: goodbye(s), events: [] };
      if (!isFormIntent(io.app, pc.intent)) return { decision: failAttempt(s, 'intent', io), events: [] };
      // Fill from what the caller originally said, not from the "yes"; the form hears the yes too.
      return enterForm(s, pc.intent, pc.answers, slotContext(s, pc.text, io.tc), io, undefined, answers);
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
        // the caller was on, and "keep going, it was Saturday" answers it on the way past.
        const fill = fillSlots(s, answers, ctx, activeSlots(s));
        return { decision: declineTransfer(s, io, pc, fill.acks), events: fill.events };
      }
      if (pc.target === 'slot') {
        // A declined readback means the spoken path failed; go straight to the keypad,
        // and let a second decline hand off rather than read a third value back.
        const st = s.slots[pc.slot]!;
        st.attempts = Math.max(st.attempts + 1, t.MAX_ATTEMPTS - 1);
        if (retryStep(st.attempts, t) === 'agent') return { decision: handoff(s, 'max-attempts'), events: [] };
        Object.assign(st, emptySlot(), { attempts: st.attempts });
        return { decision: prompt(`ask_${pc.slot}_dtmf`, pc.slot, {}, [{ promptId: 'ack_declined', vars: {} }]), events: [] };
      }
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
      // Only a request that actually joined the queue buys the turn: asking for the same thing
      // twice is a turn spent, and must not hold the ladder at zero forever.
      return { decision: reaskConfirmation(s, io, acks, acks.length === 0), events: [] };
    }
    case 'change_slot': {
      const acks = enqueue(s, verdict.queue);
      const form = s.pendingConfirmation?.target === 'form' ? s.pendingConfirmation.form : s.form;
      s.pendingConfirmation = null;
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
      return { decision: askSlot(s, verdict.slot, null, [...acks, ...(fill?.acks ?? [])]), events: fill?.events ?? [] };
    }
    case 'route':
      if (verdict.confirm === 'explicit') {
        s.pendingConfirmation = { target: 'intent', intent: verdict.intent, answers, text: ctx.text };
        return { decision: prompt('confirm_intent_explicit', 'intent', { intentLabel: intentLabel(io.app, verdict.intent) }, [], ['yes', 'no']), events: [] };
      }
      // "No, that's all" at "anything else?": the call ends with the goodbye alone.
      if (verdict.intent === 'done') return { decision: goodbye(s), events: [] };
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
      const fill = fillSlots(s, answers, ctx, activeSlots(s));
      // Adding a request is not a failed answer: re-ask the open slot without counting an attempt.
      return { decision: continueForm(s, io, [...acks, ...fill.acks], fill.disambiguate, fill.help), events: fill.events };
    }
    case 'proceed': {
      // Speech at the code prompt is refused, and nothing it said is filled: the code is keyed or
      // not at all. A code actually said aloud arrives masked (spokenCode.ts) and counts as exposed,
      // so the caller is told a new one has been sent rather than asked to key the old one.
      if (s.promptedFor === 'otp') return { decision: codeReask(s, io, [], saidCode(ctx.text) ? 'otp_spoken_reissued' : 'ask_otp_spoken'), events: [] };
      const fill = fillSlots(s, answers, ctx, activeSlots(s));
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
      return { decision: completeForm(s, pc.form, [], io), rows: [] };
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
    case 'filled':
      s.dtmfBuffer = '';
      s.pendingConfirmation = null;
      return { decision: continueForm(s, io, [], null), rows: [dtmfRow(result.slot)] };
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
  });
  return { ...r, audit };
}

function resolveTurn(session: Session, event: SessionEvent, answers: AnswerMap | null, turnContext: TurnContext, error: TurnError | null, screen: ScreenResult | null): Omit<TurnResult, 'audit'> {
  const s = cloneSession(session);
  const tc = appTurnContext(appOf(s), turnContext);
  const io: TurnIO = { app: appOf(s), tc, out: newTurnOut() };
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
      const decision = greeting(s);
      bookkeep(s, decision, 'setup');
      return { ...base(), decision, actions: decisionToActions(io.app, decision, tc.render, s.locale) };
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
      return { ...base(), rows, decision, actions: decisionToActions(io.app, decision, tc.render, s.locale) };
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
      return { ...base(), decision, actions: decisionToActions(io.app, decision, tc.render, s.locale) };
    }
    case 'auth.signed_in': {
      // Only the customer chat server makes this, after the portal's sign-in; the relay never produces
      // it off the wire. It raises an anonymous web chat and nothing else: a sign-in never replaces a
      // verified customer or a delegate, and a phone call has no portal. The portal's sign-in is
      // multi-factor, so it is level 2 or it is not one: a level 1 customer here would be walked into
      // the keypad code, which a chat does not have.
      // The event's principal is checked, not trusted: a proven party (isParty), or the event is ignored.
      if (!s.caps.signIn || !isAnonymous(s.principal) || !isParty(event.principal) || event.principal.kind !== identityOf(appOf(s)).subjectKind || event.principal.level !== 2) {
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
      let pc = s.pendingConfirmation;
      if (pc?.target === 'transfer') pc = pc.resume?.target === 'slot' || pc.resume?.target === 'form' ? pc.resume : null;
      if (pc?.target === 'intent') pc = null;
      s.pendingConfirmation = pc;
      const parked = s.stepUp !== null && s.form !== null;
      // The waiting request goes back to the gate as new: its entry call is built again, from the
      // customer now signed in, rather than replayed from before.
      s.stepUp = null;
      const decision = readSummary(s, parked ? continueForm(s, io, acks, null) : prompt('signin_ready', 'intent', {}, acks), io);
      bookkeep(s, decision, 'signed_in');
      return { ...base(), decision, actions: decisionToActions(io.app, decision, tc.render, s.locale) };
    }
    case 'user.silence': {
      const decision = readSummary(s, handleSilence(s, io), io);
      bookkeep(s, decision, 'silence');
      // Silence resolves whatever was prompted; a stale barge-in marker does not carry into
      // the next turn, same as a real one.
      s.lastInterrupt = null;
      return { ...base(), decision, actions: decisionToActions(io.app, decision, tc.render, s.locale) };
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
        return { ...base(), turnState, rows: screened, decision, actions: decisionToActions(io.app, decision, tc.render, s.locale), quarantined: true };
      }
      if (error || answers === null) {
        const decision = handleFailure(s);
        bookkeep(s, decision, 'error');
        // The turn state above already reported the barge-in, failed ask or not.
        s.lastInterrupt = null;
        return { ...base(), turnState, rows: screened, decision, actions: decisionToActions(io.app, decision, tc.render, s.locale) };
      }
      s.consecutiveFailures = 0;
      const ctx = slotContext(s, event.text, tc);
      const { rows, verdict } = evaluateGates(s, turnState, answers, tc.thresholds);
      // The gate worked the rung out from the count but left the count alone; the turn owns the
      // bookkeeping, and only a verdict that carries a rung is a frustrated turn to count.
      const rung = frustrationOf(verdict);
      if (rung !== undefined) s.frustratedTurns += 1;
      const { decision: resolved, events } = handleVerdict(s, verdict, answers, ctx, io);
      const decision = readSummary(s, escalate(s, resolved, rung), io);
      rows.push(...slotRows(io.app, events, tc.thresholds));
      bookkeep(s, decision, verdict.kind);
      // The barge-in has now been reported to the model; it does not carry into the next turn.
      s.lastInterrupt = null;
      return { ...base(), turnState, rows: [...screened, ...rows], verdict, fillEvents: events, decision, actions: decisionToActions(io.app, decision, tc.render, s.locale) };
    }
  }
}
