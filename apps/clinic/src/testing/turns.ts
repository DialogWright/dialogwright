import {
  ANONYMOUS, choice, DEFAULT_THRESHOLDS, keyEvents, mockCodeVerifier, newSession, noul, resolveTurn, score,
  silenceEvent, speechEvent, spokenText, startEvent, VOICE_RELAY, type AnswerMap, type Session, type TurnContext,
  type TurnResult,
} from 'dialogwright';
import { clinicApp } from '../index';

/**
 * Turns on the clinic with hand-built model answers, for its own tests: what each turn's perception
 * said is written out, so a test shows exactly which answer drives which behavior. The harness's
 * pinned day, Friday 2026-09-18.
 */
export const TODAY = '2026-09-18';

export function turnContext(): TurnContext {
  return { nowMs: 0, todayIso: TODAY, thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...clinicApp.systems(), codes: mockCodeVerifier } };
}

/** One call's context: its systems are shared by every turn of the call, as the server's are. */
export const tc = turnContext();

/** A calm, clear turn addressed to the line, asking for nothing new; `over` says the rest. */
export function answers(over: AnswerMap = {}): AnswerMap {
  return {
    addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
    rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05),
    frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }),
    intent: choice({ none: 0.9, other: 0.1 }),
    ...over,
  };
}

export const ANSWERING = choice({ answering: 0.95, adding: 0.03, replacing: 0.02 });
export const ADDING = choice({ adding: 0.9, answering: 0.05, replacing: 0.05 });
export const NO_CHANGE = choice({ none: 0.95, name: 0.01, dob: 0.01, provider: 0.01, date: 0.01, memberId: 0.01 });
export const HIGH = score({ none: 0.1, mild: 0.2, high: 0.7 });

export const intent = (i: string): AnswerMap => ({ intent: choice({ [i]: 0.95, none: 0.05 }) });
export const provider = (key: string): AnswerMap => ({ provider: choice({ [key]: 0.92, none: 0.08 }) });
export const NAME: AnswerMap = { nameGiven: noul(0.95), nameSpan: choice({ 'morgan ellis': 0.9, none: 0.1 }) };
export const DOB: AnswerMap = {
  dobGiven: noul(0.95), dobMonth: choice({ june: 0.9, none: 0.1 }), dobDay: choice({ '14': 0.9, none: 0.1 }),
  dobYear: choice({ 'nineteen seventy five': 0.9, none: 0.1 }),
};
export const weekday = (day: string): AnswerMap => ({ dateMode: choice({ weekday: 0.9, none: 0.1 }), dateWeekday: choice({ [day]: 0.9, none: 0.1 }) });
export const timeOfDay = (part: string): AnswerMap => ({ timeOfDay: choice({ [part]: 0.9, none: 0.1 }) });

/** Answers to a summary that are neither a yes nor a clear no. */
export const UNANSWERED: AnswerMap = { intentChange: ANSWERING, confirmsYes: noul(0.05), confirmsNo: noul(0.3), changeSlot: NO_CHANGE };
/** A clear no at a summary, naming no detail. */
export const NO: AnswerMap = { intentChange: ANSWERING, confirmsYes: noul(0.05), confirmsNo: noul(0.9), changeSlot: NO_CHANGE };
/** A clear yes at a summary. */
export const YES: AnswerMap = { intentChange: ANSWERING, confirmsYes: noul(0.95), confirmsNo: noul(0.05), changeSlot: NO_CHANGE };

export function started(ctx: TurnContext = tc): Session {
  return resolveTurn(newSession('clinic-test', 0, VOICE_RELAY, ANONYMOUS, clinicApp.id), startEvent(), null, ctx).session;
}

export function say(s: Session, text: string, over: AnswerMap = {}, ctx: TurnContext = tc): TurnResult {
  return resolveTurn(s, speechEvent(text), answers(over), ctx);
}

/** Keys each digit in turn; the result of the last. */
export function key(s: Session, digits: string, ctx: TurnContext = tc): TurnResult {
  let r: TurnResult | null = null;
  for (const e of keyEvents(digits)) r = resolveTurn(r?.session ?? s, e, null, ctx);
  return r!;
}

export function silence(s: Session, ctx: TurnContext = tc): TurnResult {
  return resolveTurn(s, silenceEvent(), null, ctx);
}

/** What the caller hears for a turn. */
export function heard(r: TurnResult): string {
  return spokenText(clinicApp, r.decision);
}

/** The gate's calls on a turn, as tool:verdict. */
export function calls(r: TurnResult): string[] {
  return r.gateEvents.map((e) => `${e.decision.call.tool}:${e.decision.verdict}`);
}

/** The opener, the name and the birthday of a reschedule with Dr. Chen: the line then asks for the day. */
export function rescheduleToDay(ctx: TurnContext = tc): TurnResult {
  let r = say(started(ctx), 'I need to reschedule my appointment with Dr. Chen', { ...intent('reschedule'), ...provider('chen') }, ctx);
  r = say(r.session, 'Morgan Ellis', { intentChange: ANSWERING, ...NAME }, ctx);
  return say(r.session, 'June fourteenth nineteen seventy five', { intentChange: ANSWERING, ...DOB }, ctx);
}

/** ...and Tuesday: the reschedule's summary, read whole. */
export function rescheduleAtSummary(ctx: TurnContext = tc): TurnResult {
  return say(rescheduleToDay(ctx).session, 'Tuesday', { intentChange: ANSWERING, ...weekday('tuesday') }, ctx);
}
