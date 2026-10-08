import type { FormId, Intent, SlotId, ToolName } from './app/types';
import type { SlotPartial } from './slots/types';
import type { AnswerMap } from '../jev/types';
import type { Nomination } from '../kb/types';
import { ANONYMOUS } from '../gate/principal';
import { formOf, isCarried } from './app/lookup';
import { appOf, defaultAppId, getApp } from './app/registry';
import type { App } from './app/types';
import type { GateVerdict, Principal, ToolCall } from '../gate/types';
import type { Channel, ChannelCaps } from '../channel/caps';

/**
 * The version of the Session shape: a store (server/stores/types.ts) keeps it beside each session it
 * saves (StoredCall.schema), never inside it, so a trace and a golden are as they were. A session
 * saved under another version is not resumed: the caller is put through to a person instead
 * (server/sessions.ts restore). Raise it with any change to Session a saved one would not satisfy (a
 * field added that the core reads without a default, a field whose meaning changes).
 */
export const SESSION_SCHEMA = 1;

export interface SlotState {
  value: string | null;
  display: string | null;
  confirmed: boolean;
  attempts: number;
  window: SlotPartial | null;
  /** help prompts already played for this slot since it was last emptied; each plays at most once */
  helped: string[];
  /**
   * The caller declined the slot (a slot's `callerNumber` with `onNo` or `ifNone` set to `skip`):
   * empty, but answered, so the form does not ask it and goes on. Absent on every other slot, so a
   * session of an app without such a slot is as it was.
   */
  declined?: true;
}

export interface HistoryEntry {
  node: string;
  intent: string;
  outcome: string;
}

/**
 * What the tools returned about the verified caller, kept for the rest of the call. The app's
 * (App.facts makes, copies and clears them); the engine never reads one by name.
 */
export interface SessionFacts {
  [key: string]: unknown;
}

/** The entry call waiting on identity, and the level the gate said it needs. */
export interface StepUp {
  call: ToolCall;
  need: 1 | 2;
}

export type PendingConfirmation =
  | {
      target: 'intent';
      intent: Intent;
      /**
       * the routing utterance's answers and text, so slots it spoke fill once the intent is confirmed
       * Shared by reference across session clones; never mutated. Complete only when the route happened outside a form:
       * a mid-form switch stashes the old form's slot answers, and the new form's other slots are asked normally.
       */
      answers: Readonly<AnswerMap>;
      text: string;
      /**
       * The topics retrieval nominated for that utterance (SlotContext.nominated), when it ran on its
       * turn: the confirmed form fills from those words, so its topic slot reads their nominations,
       * not the yes turn's. Absent when retrieval did not run (and for every app without knowledge).
       */
      nominated?: readonly Nomination[];
    }
  /**
   * A slot's value read back for a yes. `offered`: a value offered before the slot was asked, the
   * slot still empty: a yes fills it with `value`, and a no asks the slot's own question with no
   * attempt counted. By `from`: absent, the number the caller is calling from, offered for a slot
   * that holds a phone number (SlotSpec.callerNumber, core/callerNumber.ts); `facts`, a value the
   * app proposes from its facts (a slot's `offer: facts`, FactsConfig.offers: e.g. an address the
   * call-start lookup found). Absent `offered`: a value the caller said, read back.
   */
  | { target: 'slot'; slot: SlotId; value: string; display: string; offered?: true; from?: 'facts' }
  /**
   * the summary question; attempts counts unanswered turns and resets when a correction lands.
   * askedChange records that "What should I change?" has already been asked for this summary, so
   * the next spoken answer with nothing usable in it walks the ladder instead of asking it again.
   * The question is free at most once per summary: the keypad's 2 can ask for it again, and each
   * of those spends a rung.
   * readAs is the prompt the summary was last read as, where the form's summary hook read it as
   * another (FormDef.onSummaryRead; e.g. a short re-read): the same question, so its keypad works there too.
   */
  | { target: 'form'; form: FormId; attempts: number; askedChange?: boolean; readAs?: string }
  /**
   * A form check's refusal read back before it acts (a check outcome's `confirm`, core/turn.ts
   * stopForm): the check by its action, and what the gate said (its verdict and reason), so a yes
   * acts on that refusal as written without asking the gate again, and a no empties the slots the
   * check reads. `attempts` counts unanswered turns, as the summary's does.
   */
  | { target: 'check'; form: FormId; action: ToolName; verdict: GateVerdict; reason: string; attempts: number }
  /**
   * The transfer offered to a frustrated caller. `attempts` counts silences
   * at the offer only: every spoken answer settles it, a yes as a transfer and anything else as a
   * decline, so the offer is asked at most twice and never walks to the keypad or to an agent.
   */
  | {
      target: 'transfer';
      attempts: number;
      /**
       * the confirmation the offer displaced, where the same turn had just armed one: an explicit
       * intent confirm, a slot readback, or a form summary with its attempt count. Declining the
       * offer restores it and asks it again, so neither the caller's request nor the ladder's place
       * in it is lost to the detour. Never itself a transfer: the offer is not made at the offer.
       */
      resume?: PendingConfirmation;
      /**
       * the form whose completion made the offer, having no answer to give (eligibility with no
       * passage in force). A yes is a transfer to a person; a decline finishes that form, so the
       * answer that was not there is never looked up again.
       */
      after?: FormId;
      /**
       * Why the offer was made, when it was not for a frustrated caller: `no-answer`, the knowledge
       * base had no answer to give (kb/answer.ts: a form's completion, or an informational intent's
       * passage). A yes to it, plain or "yes, connect me to a person", is a handoff for a person
       * (`live-agent`), not a frustrated caller's: the caller asked a question we could not answer.
       */
      why?: 'no-answer';
    };

/** The user spoke over our line: the part of it that had played (never the user's words), and how far in (UserInterrupt). */
export interface Interrupt {
  heard: string;
  afterMs: number;
}

export interface Session {
  sessionId: string;
  /** The app this call is for (src/core/app); the engine resolves it with appOf. An id, so the session stays a plain serializable value. */
  appId: string;
  turnIndex: number;
  startedAtMs: number;
  form: FormId | null;
  slots: Record<SlotId, SlotState>;
  intentAttempts: number;
  /** what the last prompt asked for; 'otp' is the keypad code, which is never a slot */
  promptedFor: 'intent' | 'confirm' | 'otp' | SlotId | null;
  lastPromptId: string | null;
  lastPromptText: string;
  lastPromptOptions: string[];
  /** the intent DTMF menu was just played */
  menuActive: boolean;
  pendingConfirmation: PendingConfirmation | null;
  /** intents the caller added mid-form, handled in order after the current form completes */
  queued: FormId[];
  /** forms closed by a completion prompt on this call, reported in handoff data */
  completed: FormId[];
  history: HistoryEntry[];
  /** The channel's kind ('voice', 'chat'): recorded in the audit and on the console. The core never branches on it; it reads `caps`. */
  channel: string;
  /** What the channel can do. The core decides by these, never by the channel's name. */
  caps: ChannelCaps;
  /**
   * The language the call is spoken in: one of the app's locales (App.locales), its default until the
   * session's start names another the app has (core/locale.ts matchLocale). Only a session of an app
   * that declares locales has one; read it with localeOf, which gives the app's default otherwise.
   */
  locale?: string;
  /**
   * The number the caller is calling from, its digits, `+` first when the carrier wrote it in
   * international form (core/callerNumber.ts callerNumberOf): kept at the session's start for an
   * app with a slot that offers it (SlotSpec.callerNumber), when the carrier sent a number such a
   * slot can use, and for an app that keeps it for its code (app.yaml `callerNumber: { use: hint }`,
   * App.callerNumber), when the carrier sent any usable number. It is never identity: the offer, the
   * call-start lookup, the gate's callerNumber rule (GateFacts.callerNumber) and app code through
   * callerOf read it. Absent otherwise, so every other session is as it was.
   */
  callerNumber?: string;
  /**
   * The number the caller called (the DNIS), as callerNumber is kept: only for an app whose
   * app.yaml `callerNumber` says `called: true`, and only on a call whose carrier sent one. Read it
   * with calledOf (core/callerNumber.ts). Absent otherwise.
   */
  calledNumber?: string;
  /**
   * The slots the open form has made an offer for, each once per form: the caller's number
   * (callerNumber), or a value proposed from the facts (a slot's `offer: facts`). A slot reopened
   * later is asked its own question. Absent until an offer is made, and gone when the form closes or
   * another is entered.
   */
  callerOffered?: SlotId[];
  /** Who the caller is proven to be. Written only from a verifier result or a portal sign-in (src/gate/types.ts Principal). */
  principal: Principal;
  facts: SessionFacts;
  /** The entry call waiting on identity, and the level it needs; null when none is. */
  stepUp: StepUp | null;
  /** The form whose entry call has passed the gate. */
  entered: FormId | null;
  /**
   * The open form's checks that have passed (FormDef.checks, core/checks.ts): by action, the hash of
   * the params it passed with, so a check runs again only when what it reads changes. Absent until a
   * check runs, and gone when the form closes or another is entered, so a session of an app without
   * checks is as it was.
   */
  checked?: Record<string, string>;
  /**
   * The values the caller said yes to at a summary, by slot (HandoffData.unconfirmed): written at a
   * yes that changed nothing the summary read, and when a form with a summary completes on the
   * caller's yes, for each of its filled slots but the identity factors and a `verified` slot (never
   * counted), and only for an app whose handoff marks or leaves out the values never confirmed. A slot still holding its value
   * here counts as confirmed in the handoff; one changed since does not. Kept for the slots that
   * outlast the form (carried), dropped for those its close empties. Absent for every other app, so
   * their sessions are as they were. Never in what the model is sent.
   */
  agreed?: Record<SlotId, string>;
  /** Failed verifications, of the identity factors together and of the one-time code, which the gate's attempts rule caps. */
  identityAttempts: { factors: number; code: number };
  /** The one-time code has been texted on this call (sendCode); asking for it again does not text another, a reissue does. */
  codeSent: boolean;
  /** Unanswered turns at the keypad-code prompt (silence, a miss, a spoken code): the code prompt's own retry ladder. */
  codeReasks: number;
  /**
   * Hash of the values the summary read back, taken each time it is spoken. The caller's yes
   * arms it as confirmedHash; closing the form or filing the report clears it.
   */
  pendingHash: string | null;
  /** Hash of the values the caller confirmed at the summary, which the gate's confirmed rule compares a write against. Spent by the write. */
  confirmedHash: string | null;
  /**
   * The downstream service (App.services) whose answer is awaited, or null: a completion handed it work
   * (e.g. a depot agent, about a report just filed). Until its service_result arrives, the form
   * stays open and every caller turn is ignored.
   */
  pendingService: string | null;
  /** Turns the injection screen quarantined on this call. */
  screenHits: number;
  dtmfBuffer: string;
  /** the barge-in that cut off the last prompt, until the next prompt turn consumes it */
  lastInterrupt: Interrupt | null;
  consecutiveFailures: number;
  /**
   * Turns on this call the frustration gate scored high. The count is the
   * rung: one is acknowledged, two is offered a transfer, three is transferred. The turn that
   * answers the offer is not counted.
   */
  frustratedTurns: number;
  /** the caller turned the transfer offer down; it is not offered again on this call */
  transferDeclined: boolean;
  ended: boolean;
}

export function emptySlot(): SlotState {
  return { value: null, display: null, confirmed: false, attempts: 0, window: null, helped: [] };
}

function cloneSlot(s: SlotState): SlotState {
  return { ...s, helped: [...s.helped], window: s.window ? { ...s.window } : null };
}

/**
 * The confirmation a transfer offer displaced is copied too: restoring it hands back an object a
 * later turn may count attempts on, and that must not reach back into the session we were handed.
 */
function clonePending(pc: PendingConfirmation | null): PendingConfirmation | null {
  if (pc === null) return null;
  if (pc.target === 'transfer' && pc.resume) return { ...pc, resume: { ...pc.resume } };
  return { ...pc };
}

/** A copy of an app's facts: its own (App.facts.clone), or a whole copy for an app without one. */
function cloneFacts(app: App, f: SessionFacts): SessionFacts {
  return app.facts ? app.facts.clone(f) : structuredClone(f);
}

export function emptySlots(appId: string = defaultAppId()): Record<SlotId, SlotState> {
  return Object.fromEntries(Object.keys(getApp(appId).slots).map((id) => [id, emptySlot()])) as Record<SlotId, SlotState>;
}

export function newSession(
  sessionId: string,
  nowMs: number,
  channel: Channel,
  principal: Principal = ANONYMOUS,
  appId: string = defaultAppId(),
): Session {
  const app = getApp(appId);
  return {
    sessionId,
    appId,
    turnIndex: 0,
    startedAtMs: nowMs,
    form: null,
    slots: emptySlots(appId),
    intentAttempts: 0,
    promptedFor: null,
    lastPromptId: null,
    lastPromptText: '',
    lastPromptOptions: [],
    menuActive: false,
    pendingConfirmation: null,
    queued: [],
    completed: [],
    history: [],
    channel: channel.kind,
    caps: { ...channel.caps },
    // Only for an app that declares locales: any other app's sessions are as they were before locales.
    ...(app.locales ? { locale: app.locales.default } : {}),
    principal,
    facts: app.facts?.initial() ?? {},
    stepUp: null,
    entered: null,
    identityAttempts: { factors: 0, code: 0 },
    codeSent: false,
    codeReasks: 0,
    pendingHash: null,
    confirmedHash: null,
    pendingService: null,
    screenHits: 0,
    dtmfBuffer: '',
    lastInterrupt: null,
    consecutiveFailures: 0,
    frustratedTurns: 0,
    transferDeclined: false,
    ended: false,
  };
}

/**
 * Deep enough copy that resolve() can mutate freely without touching the caller's object.
 * the pending confirmation's stashed answers are shared by reference because they are read-only
 */
export function cloneSession(s: Session): Session {
  return {
    ...s,
    caps: { ...s.caps },
    slots: Object.fromEntries(Object.keys(s.slots).map((id) => [id, cloneSlot(s.slots[id]!)])) as Record<SlotId, SlotState>,
    lastPromptOptions: [...s.lastPromptOptions],
    history: s.history.map((h) => ({ ...h })),
    // The principal is immutable (readonly all the way down), so it is shared rather than copied.
    facts: cloneFacts(appOf(s), s.facts),
    stepUp: s.stepUp ? { ...s.stepUp, call: { ...s.stepUp.call, params: { ...s.stepUp.call.params } } } : null,
    identityAttempts: { ...s.identityAttempts },
    pendingConfirmation: clonePending(s.pendingConfirmation),
    ...(s.checked ? { checked: { ...s.checked } } : {}),
    ...(s.callerOffered ? { callerOffered: [...s.callerOffered] } : {}),
    ...(s.agreed ? { agreed: { ...s.agreed } } : {}),
    queued: [...s.queued],
    completed: [...s.completed],
    lastInterrupt: s.lastInterrupt ? { ...s.lastInterrupt } : null,
  };
}

export type AttemptBucket = 'first' | 'second' | 'third_or_more';
export function bucketAttempt(attempts: number): AttemptBucket {
  if (attempts <= 0) return 'first';
  if (attempts === 1) return 'second';
  return 'third_or_more';
}

export type ElapsedBucket = 'under_30s' | 'under_2m' | 'over_2m';
export function bucketElapsed(ms: number): ElapsedBucket {
  if (ms < 30_000) return 'under_30s';
  if (ms < 120_000) return 'under_2m';
  return 'over_2m';
}

export type PriorCallsBucket = 'none' | 'one' | 'several';
export function bucketPriorCalls(n: number): PriorCallsBucket {
  if (n <= 0) return 'none';
  if (n === 1) return 'one';
  return 'several';
}

export function setForm(session: Session, form: FormId): Session {
  session.form = form;
  // The form in hand is never also waiting in the queue, however it was entered:
  // a switch to a queued intent starts it now rather than promising it twice.
  session.queued = session.queued.filter((q) => q !== form);
  session.intentAttempts = 0;
  session.pendingConfirmation = null;
  session.menuActive = false;
  // A step-up belongs to the entry call of the form it was raised for; the new form asks the gate afresh.
  session.stepUp = null;
  session.codeReasks = 0;
  session.pendingHash = null;
  // The checks a form passed are its own: the new form runs its checks afresh.
  delete session.checked;
  // So are its offers (the caller's number, a value from the facts): the new form may offer again.
  delete session.callerOffered;
  return session;
}

/**
 * The form is over, completed or abandoned: its business slots, its entry, its step-up and any
 * confirmation go. Identity stays for the rest of the call, the slots the app carries (App.carrySlots,
 * and a slot that listens for the call, SlotSpec.listen `call`), and the facts but for what the app
 * clears (App.facts.onFormClosed: e.g. a parcel list, since the call may just have filed a new report).
 */
export function closeForm(session: Session): Session {
  const app = appOf(session);
  if (session.form) {
    for (const id of formOf(app, session.form).slots) {
      if (isCarried(app, id)) continue;
      session.slots[id] = emptySlot();
      // A value the caller agreed to goes with the slot: one said again in a later form is heard anew.
      if (session.agreed !== undefined) delete session.agreed[id];
    }
  }
  session.form = null;
  session.entered = null;
  session.stepUp = null;
  session.codeReasks = 0;
  session.pendingHash = null;
  session.confirmedHash = null;
  session.pendingConfirmation = null;
  delete session.checked;
  delete session.callerOffered;
  app.facts?.onFormClosed?.(session.facts);
  return session;
}

export function requiredSlots(session: Session): readonly SlotId[] {
  return session.form ? formOf(appOf(session), session.form).slots : [];
}

/** The open form's slots still to ask: empty, and not declined (SlotState.declined). */
export function missingSlots(session: Session): SlotId[] {
  return requiredSlots(session).filter((id) => session.slots[id]!.value === null && session.slots[id]!.declined !== true);
}

export function currentAttempts(session: Session): number {
  if (session.promptedFor === 'confirm') {
    const pc = session.pendingConfirmation;
    return pc?.target === 'form' || pc?.target === 'check' ? pc.attempts : 0;
  }
  if (session.promptedFor === 'intent' || session.promptedFor === null) return session.intentAttempts;
  if (session.promptedFor === 'otp') return session.codeReasks;
  return session.slots[session.promptedFor]!.attempts;
}
