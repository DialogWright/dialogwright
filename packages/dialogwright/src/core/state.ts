import { lastFour } from './callerNumber';
import type { App, SlotId } from './app/types';
import { intentLabel } from './app/intents';
import { appOf } from './app/registry';
import { slotLocaleOf } from './locale';
import { candidateSpans } from './spans';
import {
  bucketAttempt, bucketElapsed, currentAttempts,
  type AttemptBucket, type ElapsedBucket, type Session,
} from './session';

export const HISTORY_WINDOW = 3;

export interface TurnInput {
  text: string;
  isFinal: boolean;
  dtmf: string | null;
}

/** What the model sees. Numbers are bucketed, because the model is read coarsely. */
export interface TurnState {
  node: { id: string; promptJustPlayed: string; options: string[] };
  turn: { attempt: AttemptBucket; elapsed: ElapsedBucket };
  activeForm: string | null;
  activeFormLabel: string | null;
  slots: Record<SlotId, { value: string | null; confirmed: boolean }>;
  history: Array<{ node: string; intent: string; outcome: string }>;
  /**
   * Identity as the model sees it: the principal's assurance level, never who it is; then the
   * app's own fields (App.callerState), where it has any.
   */
  caller: { verified: boolean; level: 0 | 1 | 2; priorCalls: number } & Readonly<Record<string, string | number | boolean>>;
  asr: { text: string; isFinal: boolean; bargeIn: boolean; dtmf: string | null };
  candidateSpans: string[];
  /** the model sees 'intent', 'form', 'transfer', or the slot id */
  pendingConfirmation: { target: 'intent' | 'form' | 'transfer' | SlotId; value: string } | null;
}

/**
 * The pending confirmation as the model sees it: what is being confirmed, and the thing itself in
 * words. The transfer offer names what a yes buys rather than a form or a slot.
 */
function pendingState(app: App, pc: Session['pendingConfirmation']): TurnState['pendingConfirmation'] {
  if (pc === null) return null;
  if (pc.target === 'intent') return { target: 'intent', value: intentLabel(app, pc.intent) };
  if (pc.target === 'form') return { target: 'form', value: intentLabel(app, pc.form) };
  if (pc.target === 'transfer') return { target: 'transfer', value: 'connect you to a person' };
  // The caller's number offered (core/callerNumber.ts): the model is told what the caller heard of
  // it, its last four, never the whole number.
  if (pc.offered) return { target: pc.slot, value: `the number they are calling from, ending in ${lastFour(pc.value)}` };
  return { target: pc.slot, value: pc.display };
}

/**
 * The caller record: the engine's fields, then the app's own (App.callerState) after them, the
 * engine's winning a name both use.
 */
function callerOf(app: App, session: Session): TurnState['caller'] {
  const own = { verified: session.principal.level >= 1, level: session.principal.level, priorCalls: 0 };
  return app.callerState ? { ...own, ...app.callerState(session), ...own } : own;
}

export function buildTurnState(session: Session, input: TurnInput, nowMs: number): TurnState {
  const app = appOf(session);
  const slots = {} as TurnState['slots'];
  for (const [id, slot] of Object.entries(session.slots)) {
    slots[id] = { value: slot.display, confirmed: slot.confirmed };
  }
  return {
    node: {
      id: session.lastPromptId ?? 'start',
      promptJustPlayed: session.lastPromptText,
      options: [...session.lastPromptOptions],
    },
    turn: {
      attempt: bucketAttempt(currentAttempts(session)),
      elapsed: bucketElapsed(nowMs - session.startedAtMs),
    },
    activeForm: session.form,
    activeFormLabel: session.form ? intentLabel(app, session.form) : null,
    slots,
    history: session.history.slice(-HISTORY_WINDOW).map((h) => ({ ...h })),
    caller: callerOf(app, session),
    // At the code prompt the keypad buffer holds part of a one-time code, which never reaches the model.
    asr: { text: input.text, isFinal: input.isFinal, bargeIn: session.lastInterrupt !== null, dtmf: session.promptedFor === 'otp' ? null : input.dtmf },
    // The number spans in the session's language, as the slots read them (core/turn.ts slotContext).
    candidateSpans: candidateSpans(input.text, slotLocaleOf(session)),
    pendingConfirmation: pendingState(app, session.pendingConfirmation),
  };
}
