import type { JsonValue, JevClient, QuestionMap } from '../jev/types';
import type { AgentBusiness } from './business/schema';
import { businessText } from './business/text';
import { askWithin, probabilityOf } from './confirm';
import type { ConverseState } from './state';

/**
 * The check after speaking (docs/designs/2026-11-11-claims-check.md): once a reply of the agent model has
 * been said, the decision model reads it against the business information and the call's own actions and
 * what they returned, and answers three questions, each a probability: does the reply state something they
 * say otherwise (contradicted), does it say something was done that the actions do not show as done
 * (notDone), and does it commit the business to something the business information does not address (gap).
 * A reply read as contradicted or not done goes back to the agent model with a note (checkNote), so it puts
 * the slip right for the caller; a gap is recorded for the business's owner to answer in agent.yaml's
 * `questions`. The questions are the goal and the full context, never a procedure for the words.
 */

/** The three questions, in one request. */
export const CLAIM_QUESTIONS: QuestionMap = {
  contradicted: {
    type: 'noul',
    instructions: 'The line, an automated assistant answering for the business, has just said reply to a caller. business is the business\'s own information, today the business\'s date, and actions every action the line has called on this call, in order, with what each returned. Does the reply state something that the business information, or the call\'s actions and what they returned, say otherwise?',
    criteria: {
      true: 'Something the reply states (a price, a time, a day, availability, a service, a policy, a fact about the business or about what an action returned) differs from what the business information or an action\'s result says',
      false: 'Everything the reply states agrees with the business information and the actions\' results, or they say nothing on it',
    },
  },
  notDone: {
    type: 'noul',
    instructions: 'The line, an automated assistant answering for the business, has just said reply to a caller. business is the business\'s own information, today the business\'s date, and actions every action the line has called on this call, in order, with what each returned. Does the reply tell the caller that something was booked, sent, recorded, noted, held, changed or confirmed that the call\'s actions do not show as done?',
    criteria: {
      true: 'The reply says or implies that something has been done for the caller, and no action\'s result on this call shows it done',
      false: 'Whatever the reply says was done, an action\'s result shows done; or the reply says nothing was done, or only what will be done once the caller agrees',
    },
  },
  gap: {
    type: 'noul',
    instructions: 'The line, an automated assistant answering for the business, has just said reply to a caller. business is the business\'s own information, today the business\'s date, and actions every action the line has called on this call, in order, with what each returned. Does the reply commit the business to a price, a time, a policy or what happens next that neither the business information nor an action\'s result addresses?',
    criteria: {
      true: 'The reply answers for the business on something (a cost, when someone will call back, what to bring, what a change costs, what happens next) that the business information and the actions\' results say nothing on',
      false: 'Every commitment in the reply is one the business information or an action\'s result makes, or the reply commits the business to nothing',
    },
  },
};

/** The decision model's reading of a reply: each question's probability. */
export interface ClaimsReading {
  contradicted: number;
  notDone: number;
  gap: number;
}

/** One action called on the call, as the decision model is sent it: its name, the model's arguments, and what came back. */
export interface CallAction {
  action: string;
  args: Record<string, unknown>;
  result: string;
  /** What came back was a refusal or a failure: the action was not run, or failed. */
  error?: true;
}

/**
 * The call's actions so far, from the conversation (ConverseState.messages): each call the agent model made,
 * in order, with the result it was sent (a refusal or a failure marked as an error), a change read back and
 * waiting for the caller's yes said to be not done yet, and a call with no result said to be not done.
 */
export function actionsOfCall(st: ConverseState): CallAction[] {
  const results = new Map<string, { content: string; isError?: boolean }>();
  for (const m of st.messages) for (const c of m.content) if (c.type === 'tool_result') results.set(c.id, c);
  const out: CallAction[] = [];
  for (const m of st.messages) {
    for (const c of m.content) {
      if (c.type !== 'tool_call') continue;
      const r = results.get(c.id);
      if (r !== undefined) out.push({ action: c.name, args: c.args, result: r.content, ...(r.isError === true ? { error: true as const } : {}) });
      else if (st.pending?.id === c.id) out.push({ action: c.name, args: c.args, result: `Not done yet: read back to the caller ("${st.pending.text}"), waiting for their yes.` });
      else out.push({ action: c.name, args: c.args, result: 'Not done: no result came back.' });
    }
  }
  return out;
}

/** A day as the decision model is sent it: "Wednesday, November 11, 2026 (2026-11-11)". */
function dayWords(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(d)} (${iso})`;
}

/**
 * What the decision model is sent to read a reply: the business information (as the agent model is given it),
 * the business's day, the call's actions with what came back (as the agent model was sent them: its own
 * arguments, never the caller's whole number, which only the actions' code gets), and the reply as said.
 */
export function claimsState(b: AgentBusiness, st: ConverseState, todayIso: string, reply: string): JsonValue {
  return { business: businessText(b), today: dayWords(todayIso), actions: actionsOfCall(st) as unknown as JsonValue, reply };
}

/**
 * The decision model's reading of a reply, in one request with the read-back's timeout and abort. Null (an
 * unread check: nothing is corrected) when the model errs, gives no probability to a question, or has not
 * answered within `timeoutMs`. It never throws.
 */
export async function readClaims(jev: JevClient, state: JsonValue, timeoutMs: number): Promise<ClaimsReading | null> {
  const answers = await askWithin(jev, state, CLAIM_QUESTIONS, timeoutMs);
  if (answers === null) return null;
  const contradicted = probabilityOf(answers.contradicted);
  const notDone = probabilityOf(answers.notDone);
  const gap = probabilityOf(answers.gap);
  return contradicted === null || notDone === null || gap === null ? null : { contradicted, notDone, gap };
}

/**
 * How a note from the line's own check begins. The agent model's instructions (prompt.ts) say a message that
 * begins so comes from the line itself, never from the caller.
 */
export const CHECK_NOTE_MARK = '[The line\'s own check, not the caller:';

/**
 * The note the agent model is sent where a reply it said was read as wrong: the reply as said, what it was
 * read as, in plain words, and the goal: to put it right for the caller now, briefly and naturally.
 */
export function checkNote(reply: string, reading: ClaimsReading, correctAt: number): string {
  const read: string[] = [];
  if (reading.contradicted >= correctAt) read.push('it states something that the business information or what the call\'s actions returned say otherwise');
  if (reading.notDone >= correctAt) read.push('it tells the caller something was done that the call\'s actions do not show as done');
  return `${CHECK_NOTE_MARK} your reply has been said to the caller, and the decision model read it after: "${reply}". It reads as wrong: ${read.join('; and ')}. Put it right for the caller now, in a sentence or two, naturally, as a person would after a slip; where something is not done, say so, and offer what can be done.]`;
}
