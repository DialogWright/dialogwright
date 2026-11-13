import { isChoice, type AnswerMap, type JsonValue, type QuestionMap } from '../jev/types';
import type { AgentBusiness } from './business/schema';
import { probabilityOf } from './confirm';
import type { ConverseState, JourneyState } from './state';

/**
 * Journeys, routing: which task a caller turn is about, worked out from the decision model's typed answers
 * by code (docs/designs/2026-11-12-journeys.md, "Routing"). Pure: no request is made here.
 */

export type RouteOutcome = 'start' | 'carry' | 'switch' | 'return' | 'root' | 'dropped' | 'again';
/** The decision model's reading of a turn: `task`'s probabilities by option, and the yes/no probabilities. Null: not asked or not answered. */
export interface RouteReading {
  task: Record<string, number> | null;
  drops: number | null;
  again: number | null;
  /** In a working journey: that the turn gives what the line just asked for, or carries on with the task. Null: not asked or not answered. */
  fits: number | null;
}
export interface Route {
  outcome: RouteOutcome;
  next: JourneyState;
  /**
   * The line could not follow the turn (docs/designs/2026-11-12-journeys.md, "Amendment (2026-11-13)"): `next.unclear` is the
   * count of such turns in a row. Absent: the turn was not unclear, and `next.unclear` is absent too (none in a row).
   */
  unclear?: true;
  /** The older paused journey a switch dropped. */
  droppedPaused?: string;
}

/** The `task` option for a turn that asks for none of the journeys. */
export const NONE_TASK = 'none';
const NONE_WHEN = 'none of these: unclear, unrelated, or something the line does not do';
/** The `task` option for a question about the business, which the line answers whichever task it is in. */
export const QUESTION_TASK = 'question';
const QUESTION_WHEN = 'a question about the business: its hours, prices, where it is, what it does or doesn\'t do';
/** Below this, a turn does not give what the line just asked for (a working journey's `fits`). */
const FITS_AT = 0.5;

/** Whether the line could not follow the turn. */
export function isUnclear(r: Route): boolean {
  return r.unclear === true;
}

/** A journey state with no unclear turns in a row. */
function calm(j: JourneyState): JourneyState {
  const { unclear: _unclear, ...rest } = j;
  return rest;
}

type Caller = ConverseState['caller'];

export function hasJourneys(b: AgentBusiness): boolean {
  return b.journeys !== undefined && Object.keys(b.journeys).length > 0;
}

/** The journeys open to the caller, by their `for`, in the business's order. A recognised account is a non-null `caller.account`. */
export function openJourneys(b: AgentBusiness, caller: Caller): string[] {
  const recognised = caller.account !== undefined && caller.account !== null;
  return Object.entries(b.journeys ?? {})
    .filter(([, j]) => j.for === undefined || (j.for.account === 'recognised') === recognised)
    .map(([id]) => id);
}

/** Where a call begins: the journey whose `start` fits the caller, else the root. */
export function initialJourney(b: AgentBusiness, caller: Caller): JourneyState {
  const recognised = caller.account !== undefined && caller.account !== null;
  const open = openJourneys(b, caller);
  const starter = Object.entries(b.journeys ?? {}).find(([id, j]) => j.start?.account === 'recognised' && recognised && open.includes(id));
  return { active: starter?.[0] ?? null, phase: 'working', paused: null, done: [] };
}

/** What the line helps with once a journey is done: its `after`, else the goal and that it is done. */
export function afterLine(b: AgentBusiness, id: string): string {
  const spec = b.journeys?.[id];
  if (spec === undefined) return '';
  return spec.after ?? `${spec.goal}: done on this call. Answer the caller's questions about it.`;
}

/**
 * The actions the model is offered in a state (the follow-ons are never offered; the runtime runs them).
 * No journeys, or no state: every action. At the root: its lookups. In a working journey: its actions.
 * In a finished one: its lookups only, so nothing that changes is offered again.
 */
export function offeredActions(b: AgentBusiness, j: JourneyState | undefined): string[] {
  const followed = new Set<string>();
  for (const a of Object.values(b.actions)) for (const t of a.then ?? []) followed.add(t);
  const all = Object.keys(b.actions).filter((n) => !followed.has(n));
  if (!hasJourneys(b) || j === undefined) return all;
  const spec = j.active === null ? undefined : b.journeys?.[j.active];
  const named = spec === undefined ? (b.root?.actions ?? []) : spec.actions;
  const chosen = all.filter((n) => named.includes(n));
  return spec !== undefined && j.phase === 'after' ? chosen.filter((n) => b.actions[n]?.kind === 'lookup') : chosen;
}

const whenOf = (b: AgentBusiness, id: string | null): string | null => (id === null ? null : (b.journeys?.[id]?.when ?? null));

/** The questions put to the decision model for a turn: `task` always, `drops` and `fits` in a working journey, `again` in a finished one. */
export function routeQuestions(b: AgentBusiness, j: JourneyState, caller: Caller): QuestionMap {
  const criteria: Record<string, string | null> = {};
  for (const id of openJourneys(b, caller)) criteria[id] = whenOf(b, id);
  criteria[QUESTION_TASK] = QUESTION_WHEN;
  criteria[NONE_TASK] = NONE_WHEN;
  const questions: QuestionMap = {
    task: {
      type: 'choice',
      instructions: 'Read said, with lastReply for context. Which of these tasks does the caller want done now, as opposed to something they only ask about?',
      criteria,
    },
  };
  const active = j.active === null ? undefined : b.journeys?.[j.active];
  if (active !== undefined && j.phase === 'working') {
    questions.drops = { type: 'noul', instructions: 'Read said and active. Has the caller said they no longer want to go on with the active task?' };
    questions.fits = { type: 'noul', instructions: 'Read said and lastReply. Does the caller\'s turn give what the line just asked for, or carry on with this task?' };
  }
  if (active !== undefined && j.phase === 'after') {
    questions.again = { type: 'noul', instructions: `Read said and finished. Does the caller want another one, a new one, of this: ${active.goal}` };
  }
  return questions;
}

/** The state the decision model reads the questions against. */
export function routeState(b: AgentBusiness, j: JourneyState, said: string, lastReply: string | null): JsonValue {
  const state: { [key: string]: JsonValue } = { said, lastReply, active: whenOf(b, j.active), paused: whenOf(b, j.paused) };
  if (j.phase === 'after' && j.active !== null) state.finished = b.journeys?.[j.active]?.goal ?? null;
  return state;
}

/** The answers as a reading; all null where the decision model gave none. */
export function readRoute(answers: AnswerMap | null): RouteReading {
  if (answers === null) return { task: null, drops: null, again: null, fits: null };
  const task = answers.task;
  return {
    task: isChoice(task) ? task.probabilities : null,
    drops: probabilityOf(answers.drops),
    again: probabilityOf(answers.again),
    fits: probabilityOf(answers.fits),
  };
}

/** The open option the reading rates highest, the question and none among them (the first of a tie, in that order). */
function topOption(task: Record<string, number>, open: string[]): string | null {
  let top: string | null = null;
  let best = -1;
  for (const id of [...open, QUESTION_TASK, NONE_TASK]) {
    const p = task[id];
    if (typeof p === 'number' && p > best) {
      top = id;
      best = p;
    }
  }
  return top;
}

/** The count of unclear turns in a row, one more. */
const moreUnclear = (j: JourneyState): JourneyState => ({ ...j, unclear: (j.unclear ?? 0) + 1 });

/**
 * What the turn does, from the reading and the state (the design's table and its 2026-11-13 amendment). Ignores any option
 * not in `open`. A null reading never changes the count and is never unclear; a turn that is not unclear clears the count.
 */
export function decideRoute(b: AgentBusiness, j: JourneyState, r: RouteReading, open: string[]): Route {
  const bar = b.routing.switchAt;
  const above = (p: number | null): boolean => p !== null && p >= bar;
  if (r.task === null) return { outcome: 'carry', next: j };
  const top = topOption(r.task, open);

  // The journey the caller most wants at or above a bar, if it is open.
  const wantedAt = (at: number): string | null => {
    let wanted: string | null = null;
    let best = -1;
    for (const id of open) {
      const p = r.task![id];
      if (typeof p === 'number' && p >= at && p > best) {
        wanted = id;
        best = p;
      }
    }
    return wanted;
  };

  if (j.active === null) {
    // From the root a journey starts only at the stricter bar; the question is answered, anything else is unclear.
    const starts = wantedAt(b.routing.startAt);
    if (starts !== null) {
      // The journey set aside (a drop that kept it) comes back: a return, not a fresh start.
      if (starts === j.paused) return { outcome: 'return', next: { ...calm(j), active: starts, phase: 'working', paused: null } };
      return { outcome: 'start', next: { ...calm(j), active: starts, phase: 'working' } };
    }
    if (top === QUESTION_TASK) return { outcome: 'root', next: calm(j) };
    return { outcome: 'root', next: moreUnclear(j), unclear: true };
  }

  const wanted = wantedAt(bar);
  const finished = j.phase === 'after';
  const decided = (route: Route): Route => ({ ...route, next: calm(route.next) });
  if (!finished && above(r.drops)) {
    if (wanted === null || wanted === j.active) return decided({ outcome: 'dropped', next: { ...j, active: null, phase: 'working' } });
    if (wanted === j.paused) return decided({ outcome: 'return', next: { ...j, active: wanted, phase: 'working', paused: null } });
    return decided({ outcome: 'switch', next: { ...j, active: wanted, phase: 'working' } });
  }
  if (wanted === null || wanted === j.active) {
    // A working turn that does not fit what was asked, switches nowhere and is no question is one the line cannot follow.
    if (!finished && r.fits !== null && r.fits < FITS_AT && top !== QUESTION_TASK) return { outcome: 'carry', next: moreUnclear(j), unclear: true };
    if (wanted === null) return decided({ outcome: 'carry', next: j });
    return finished && above(r.again) ? decided({ outcome: 'again', next: { ...j, phase: 'working' } }) : decided({ outcome: 'carry', next: j });
  }
  // A finished journey has nothing to resume, so it is not set aside.
  const setAside = finished ? j.paused : j.active;
  if (wanted === j.paused) return decided({ outcome: 'return', next: { ...j, active: wanted, phase: 'working', paused: finished ? null : setAside } });
  const route: Route = { outcome: 'switch', next: { ...j, active: wanted, phase: 'working', paused: setAside } };
  if (!finished && j.paused !== null) route.droppedPaused = j.paused;
  return decided(route);
}

/** The change actions whose confirmed run ends a journey: its `completes`, else every change it names that is not a follow-on. */
function completingActions(b: AgentBusiness, id: string): string[] {
  const spec = b.journeys?.[id];
  if (spec === undefined) return [];
  if (spec.completes !== undefined) return spec.completes;
  const followed = new Set<string>();
  for (const a of Object.values(b.actions)) for (const t of a.then ?? []) followed.add(t);
  return spec.actions.filter((n) => b.actions[n]?.kind === 'change' && !followed.has(n));
}

/** A confirmed `action` ran: if it completes the active journey, the journey is in its after phase and recorded done. */
export function completeJourney(b: AgentBusiness, j: JourneyState, action: string): JourneyState {
  if (j.active === null || !completingActions(b, j.active).includes(action)) return j;
  return { ...j, phase: 'after', done: [...j.done, j.active] };
}
