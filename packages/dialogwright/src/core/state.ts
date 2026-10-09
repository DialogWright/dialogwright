import { lastFour } from './callerNumber';
import type { App, SlotId } from './app/types';
import { formLabel, intentLabel } from './app/intents';
import { appOf } from './app/registry';
import { formOf } from './app/lookup';
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
  /** the model sees 'intent', 'form', 'transfer', 'consent' (the consent to text for the whole call), or the slot id */
  pendingConfirmation: { target: 'intent' | 'form' | 'transfer' | 'consent' | SlotId; value: string } | null;
}

/**
 * The pending confirmation as the model sees it: what is being confirmed, and the thing itself in
 * words. The transfer offer names what a yes buys rather than a form or a slot.
 */
function pendingState(app: App, session: Session): TurnState['pendingConfirmation'] {
  const pc = session.pendingConfirmation;
  if (pc === null) return null;
  if (pc.target === 'intent') return { target: 'intent', value: intentLabel(app, pc.intent) };
  if (pc.target === 'form') return { target: 'form', value: formLabel(app, pc.form) };
  if (pc.target === 'transfer') return { target: 'transfer', value: 'connect you to a person' };
  if (pc.target === 'check') return checkState(app, session, pc);
  // The consent to text for the whole call (app.yaml's textConsent): what a yes agrees to, by the
  // number's last four, never the whole number.
  if (pc.consent === true) return { target: 'consent', value: `text them helpful links during this call, at the number they are calling from, ending in ${lastFour(pc.value)}` };
  // The caller's number offered (core/callerNumber.ts): the model is told what the caller heard of
  // it, its last four, never the whole number.
  if (pc.offered && pc.from !== 'facts') return { target: pc.slot, value: `the number they are calling from, ending in ${lastFour(pc.value)}` };
  // A value read back, or proposed from the facts (`offer: facts`): what the line said of it, its
  // display, and nothing more of what the facts hold.
  return { target: pc.slot, value: pc.display };
}

/**
 * A check's refusal read back (a check outcome's `confirm`), as the model sees it: what is read back
 * is the value the check refused, so it is told as a slot's read-back is, the first slot the check
 * reads that is not confirmed and its display (the trace masks it as it masks that slot's).
 */
function checkState(app: App, session: Session, pc: Extract<Session['pendingConfirmation'], { target: 'check' }>): TurnState['pendingConfirmation'] {
  const reads = formOf(app, pc.form).checks?.find((c) => c.action === pc.action)?.with ?? [];
  const slot = reads.find((id) => session.slots[id]?.confirmed === false) ?? reads[0];
  return slot === undefined ? { target: pc.action, value: pc.reason } : { target: slot, value: session.slots[slot]?.display ?? '' };
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
    activeFormLabel: session.form ? formLabel(app, session.form) : null,
    slots,
    history: session.history.slice(-HISTORY_WINDOW).map((h) => ({ ...h })),
    caller: callerOf(app, session),
    // At the code prompt the keypad buffer holds part of a one-time code, which never reaches the model.
    asr: { text: input.text, isFinal: input.isFinal, bargeIn: session.lastInterrupt !== null, dtmf: session.promptedFor === 'otp' ? null : input.dtmf },
    // The number spans in the session's language, as the slots read them (core/turn.ts slotContext).
    candidateSpans: candidateSpans(input.text, slotLocaleOf(session)),
    pendingConfirmation: pendingState(app, session),
  };
}
