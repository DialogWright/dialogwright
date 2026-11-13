import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { requestKey } from '../jev/cassette';
import type { AnswerMap, JevClient, JsonValue, QuestionMap } from '../jev/types';
import { loadPersonas } from '../eval/personas';
import type { AgentBusiness } from './business/schema';
import { askWithin } from './confirm';
import { completeJourney, decideRoute, initialJourney, NONE_TASK, openJourneys, readRoute, routeQuestions, routeState, type RouteOutcome, type RouteReading } from './journeys';
import type { JourneyState } from './state';

/**
 * Measuring routing offline (`dialogwright converse:route-eval`, docs/designs/2026-11-12-journeys.md,
 * "Measuring it"): the caller turns of calls an evaluation kept, a label a person gave each (the task it asked
 * for), and the decision model's reading of each, scored through the runtime's own `decideRoute`. The report
 * holds case ids and figures, never a caller's words.
 */

/** A call of an eval's results.jsonl (`call.turns`). */
export interface RouteCall {
  id: string;
  /** The caller is a recognised account (their persona calls from an account's number). */
  account: boolean;
  turns: { who: 'line' | 'caller'; text: string }[];
}

/** What a person said of a caller turn. */
export interface RouteLabel {
  /** The call's id: `<results folder>/<persona>-<run>`. */
  id: string;
  /** The caller turn's index among the call's caller turns, 0-based. */
  turn: number;
  /** The journey the caller wants done now, or `none`. */
  task: string;
  /** The caller said they no longer want to go on with the active task. */
  drops?: boolean;
  /** The caller wants another one of the finished task. */
  again?: boolean;
  /** The turn is a yes to a read-back that ran this action: no case is made of it. */
  confirms?: string;
}

export interface RouteCase {
  /** `<call id>#<turn>`. */
  id: string;
  /** The state exactly as routing is sent it. */
  state: JsonValue;
  questions: QuestionMap;
  expected: RouteLabel;
  /** Where the call was before this turn, had routing been right so far. */
  journey: JourneyState;
}

const CALLER_NUMBER = '+15555550100';
const ACCOUNT_NAME = 'Example Account';

/** The reading a perfect decision model would give a labelled turn. */
function perfectReading(b: AgentBusiness, j: JourneyState, label: RouteLabel, open: string[]): RouteReading {
  const task: Record<string, number> = { [NONE_TASK]: 0 };
  for (const id of open) task[id] = 0;
  task[label.task] = 1;
  const active = j.active !== null;
  return { task, drops: active && j.phase === 'working' ? (label.drops === true ? 1 : 0) : null, again: active && j.phase === 'after' ? (label.again === true ? 1 : 0) : null };
}

const callerOf = (c: RouteCall): { number: string; account: string | null } => ({ number: CALLER_NUMBER, account: c.account ? ACCOUNT_NAME : null });

/** The cases, and what was left out of them. */
export function routeCaseSet(b: AgentBusiness, calls: readonly RouteCall[], labels: readonly RouteLabel[]): { cases: RouteCase[]; unlabelledTurns: number; unlabelledCalls: number; orphanLabels: number; unknownTasks: string[] } {
  const byKey = new Map(labels.map((l) => [`${l.id}#${l.turn}`, l]));
  const cases: RouteCase[] = [];
  const used = new Set<string>();
  let unlabelledTurns = 0;
  let unlabelledCalls = 0;
  const unknownTasks: string[] = [];
  for (const call of calls) {
    const caller = callerOf(call);
    const open = openJourneys(b, caller);
    let journey = initialJourney(b, caller);
    let lastReply: string | null = null;
    let index = 0;
    let any = false;
    for (const t of call.turns) {
      if (t.who === 'line') {
        lastReply = t.text;
        continue;
      }
      const key = `${call.id}#${index++}`;
      const label = byKey.get(key);
      if (label === undefined) {
        unlabelledTurns += 1;
        continue;
      }
      any = true;
      used.add(key);
      // A task that is no journey of the business (and not `none`) is listed, never read as `none`; the call stops here, as its later states would be wrong.
      if (label.confirms === undefined && label.task !== NONE_TASK && b.journeys?.[label.task] === undefined) {
        unknownTasks.push(key);
        break;
      }
      if (label.confirms !== undefined) {
        journey = completeJourney(b, journey, label.confirms);
        continue;
      }
      cases.push({ id: key, state: routeState(b, journey, t.text, lastReply), questions: routeQuestions(b, journey, caller), expected: label, journey });
      journey = decideRoute(b, journey, perfectReading(b, journey, label, open), open).next;
    }
    if (!any) unlabelledCalls += 1;
  }
  return { cases, unlabelledTurns, unlabelledCalls, unknownTasks, orphanLabels: labels.filter((l) => !used.has(`${l.id}#${l.turn}`)).length };
}

export function routeCases(b: AgentBusiness, calls: readonly RouteCall[], labels: readonly RouteLabel[]): RouteCase[] {
  return routeCaseSet(b, calls, labels).cases;
}

/** The calls of results.jsonl files, ids `<folder>/<persona>-<run>`; an account where the persona names a number it calls from. */
export function loadRouteCalls(files: readonly string[], personasFile?: string): RouteCall[] {
  const calling = new Set<string>();
  if (personasFile !== undefined) for (const p of loadPersonas(personasFile)) if (p.callingFrom !== undefined) calling.add(p.id);
  const out: RouteCall[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const folder = basename(dirname(resolve(file)));
    readFileSync(file, 'utf8').split('\n').forEach((raw, i) => {
      if (raw.trim() === '') return;
      let line: { persona?: unknown; run?: unknown; call?: { turns?: unknown } | null };
      try {
        line = JSON.parse(raw) as typeof line;
      } catch {
        throw new Error(`${file} line ${i + 1}: not JSON`);
      }
      if (typeof line.persona !== 'string' || line.call === null || line.call === undefined || !Array.isArray(line.call.turns)) return;
      const id = `${folder}/${line.persona}-${String(line.run)}`;
      if (seen.has(id)) throw new Error(`${file} line ${i + 1}: the call id ${id} is not unique; the files' folders must have different names`);
      seen.add(id);
      const turns = (line.call.turns as Array<{ who?: unknown; text?: unknown }>)
        .filter((t): t is { who: 'line' | 'caller'; text: string } => (t.who === 'line' || t.who === 'caller') && typeof t.text === 'string')
        .map((t) => ({ who: t.who, text: t.text }));
      out.push({ id, account: calling.has(line.persona), turns });
    });
  }
  return out;
}

/** The labels file's labels. */
export function loadRouteLabels(file: string): RouteLabel[] {
  const out: RouteLabel[] = [];
  readFileSync(file, 'utf8').split('\n').forEach((raw, i) => {
    if (raw.trim() === '') return;
    let l: Partial<RouteLabel>;
    try {
      l = JSON.parse(raw) as Partial<RouteLabel>;
    } catch {
      throw new Error(`${file} line ${i + 1}: not JSON`);
    }
    if (typeof l.id !== 'string' || !Number.isInteger(l.turn) || (l.turn as number) < 0 || typeof l.task !== 'string') throw new Error(`${file} line ${i + 1}: expected a label with id, turn (0 or more) and task`);
    out.push({
      id: l.id,
      turn: l.turn as number,
      task: l.task,
      ...(l.drops === true ? { drops: true } : {}),
      ...(l.again === true ? { again: true } : {}),
      ...(typeof l.confirms === 'string' ? { confirms: l.confirms } : {}),
    });
  });
  return out;
}

/** Asks routing's questions of each case, a few at a time, through `jev` (the cassette). Never throws: an unanswered case is null. */
export async function askRoutes(jev: JevClient, cases: readonly RouteCase[], o: { timeoutMs: number; concurrency?: number; progress?: (done: number, of: number) => void }): Promise<Map<string, AnswerMap | null>> {
  const out = new Map<string, AnswerMap | null>();
  const inFlight = new Map<string, Promise<AnswerMap | null>>();
  const ask = (c: RouteCase): Promise<AnswerMap | null> => {
    const key = requestKey({ state: c.state, questions: c.questions });
    let p = inFlight.get(key);
    if (p === undefined) {
      p = askWithin(jev, c.state, c.questions, o.timeoutMs);
      inFlight.set(key, p);
    }
    return p;
  };
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const c = cases[next++];
      if (c === undefined) return;
      out.set(c.id, await ask(c));
      o.progress?.(++done, cases.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 4) }, worker));
  return out;
}

export interface BarRow {
  bar: number;
  correct: number;
  accuracy: number | null;
  wrongSwitches: number;
  missedSwitches: number;
  wrongJourney: number;
}

export interface RouteEvalReport {
  cases: number;
  /** Caller turns with no label, skipped. */
  unlabelledTurns: number;
  /** Calls none of whose turns has a label, skipped. */
  unlabelledCalls: number;
  /** Labels naming no caller turn. */
  orphanLabels: number;
  /** Labels whose task is no journey of the business, by case id; each call is skipped from that turn on. */
  unknownTasks: string[];
  /** Cases the decision model gave no answer for; read as carry, as a call would. */
  unanswered: number;
  /** At the business's own `routing.switchAt`. */
  switchAt: number;
  correct: number;
  accuracy: number | null;
  /** Jev's start, switch or return where the label is carry, none or the root. */
  wrongSwitches: number;
  /** A label asks for a move and Jev's route makes none. */
  missedSwitches: number;
  /** Both make a move, but to a different journey or phase. */
  wrongJourney: number;
  byBar: BarRow[];
  /** The live requests' times (absent where all were recorded). */
  latency: { requests: number; p50Ms: number; p95Ms: number } | null;
  /** Each case routed wrongly at the business's bar: ids and outcomes, no words of the call. */
  wrongCases: Array<{ id: string; expected: RouteOutcome; got: RouteOutcome; label: string }>;
}

/** The outcomes that change the journey or its phase. */
const MOVES: readonly RouteOutcome[] = ['start', 'switch', 'return', 'dropped', 'again'];
const STAYS: readonly RouteOutcome[] = ['carry', 'root'];

export function latencyOf(times: readonly number[]): RouteEvalReport['latency'] {
  if (times.length === 0) return null;
  const s = [...times].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
  return { requests: s.length, p50Ms: at(0.5), p95Ms: at(0.95) };
}

/** Routes each case through the runtime's `decideRoute` at each bar, against the route a perfect reading gives it. */
export function scoreRoutes(b: AgentBusiness, cases: readonly RouteCase[], answers: ReadonlyMap<string, AnswerMap | null>, bars: readonly number[]): RouteEvalReport {
  const at = (bar: number) => {
    const biz: AgentBusiness = { ...b, routing: { ...b.routing, switchAt: bar } };
    let correct = 0;
    let wrong = 0;
    let missed = 0;
    let wrongJourney = 0;
    const misses: RouteEvalReport['wrongCases'] = [];
    for (const c of cases) {
      const open = Object.keys((c.questions.task as { criteria: Record<string, string | null> }).criteria).filter((k) => k !== NONE_TASK);
      const expected = decideRoute(biz, c.journey, perfectReading(biz, c.journey, c.expected, open), open);
      const got = decideRoute(biz, c.journey, readRoute(answers.get(c.id) ?? null), open);
      const same = got.next.active === expected.next.active && got.next.phase === expected.next.phase;
      if (same) correct += 1;
      else misses.push({ id: c.id, expected: expected.outcome, got: got.outcome, label: c.expected.task });
      if (MOVES.includes(got.outcome) && STAYS.includes(expected.outcome)) wrong += 1;
      if (MOVES.includes(expected.outcome) && !MOVES.includes(got.outcome)) missed += 1;
      if (MOVES.includes(expected.outcome) && MOVES.includes(got.outcome) && !same) wrongJourney += 1;
    }
    return { correct, wrong, missed, wrongJourney, misses };
  };
  const ratio = (a: number): number | null => (cases.length === 0 ? null : a / cases.length);
  const own = at(b.routing.switchAt);
  return {
    cases: cases.length,
    unlabelledTurns: 0,
    unlabelledCalls: 0,
    orphanLabels: 0,
    unknownTasks: [],
    unanswered: cases.filter((c) => (answers.get(c.id) ?? null) === null).length,
    switchAt: b.routing.switchAt,
    correct: own.correct,
    accuracy: ratio(own.correct),
    wrongSwitches: own.wrong,
    missedSwitches: own.missed,
    wrongJourney: own.wrongJourney,
    byBar: bars.map((bar) => {
      const r = at(bar);
      return { bar, correct: r.correct, accuracy: ratio(r.correct), wrongSwitches: r.wrong, missedSwitches: r.missed, wrongJourney: r.wrongJourney };
    }),
    latency: null,
    wrongCases: own.misses,
  };
}

/** What the figures mean. */
export const ROUTE_DEFINITIONS = [
  'Accuracy: the share of turns where the journey and phase Jev routes to are those the label gives.',
  'Wrong switch: Jev moves the call (starts, switches, returns, drops or goes again) where the label stays (carry or root).',
  'Missed switch: the label moves the call (a start, switch, return, drop or again) and Jev makes no move.',
  'Switched to the wrong journey: both move the call, but to a different journey or phase.',
];

const pct = (n: number | null): string => (n === null ? '-' : n.toFixed(2));

/** The report as Markdown lines. */
export function formatRouteEval(r: RouteEvalReport): string[] {
  const out: string[] = ['# Routing, measured', ''];
  out.push(`${r.cases} caller turns routed (${r.unlabelledTurns} without a label skipped, ${r.unlabelledCalls} calls without any label${r.orphanLabels > 0 ? `, ${r.orphanLabels} labels naming no turn` : ''}), ${r.unanswered} unanswered (read as carry).`, '');
  out.push(`At the business's bar, ${r.switchAt}: accuracy ${pct(r.accuracy)} (${r.correct} of ${r.cases}), ${r.wrongSwitches} wrong switches, ${r.missedSwitches} missed switches, ${r.wrongJourney} switched to the wrong journey.`, '');
  out.push('| bar | accuracy | correct | wrong switches | missed switches | wrong journey |', '| --- | --- | --- | --- | --- | --- |');
  for (const x of r.byBar) out.push(`| ${x.bar} | ${pct(x.accuracy)} | ${x.correct} | ${x.wrongSwitches} | ${x.missedSwitches} | ${x.wrongJourney} |`);
  out.push('');
  out.push(...ROUTE_DEFINITIONS, '');
  if (r.unknownTasks.length > 0) out.push(`Labels naming a task that is no journey (the call is skipped from that turn on): ${r.unknownTasks.join(', ')}.`, '');
  out.push(r.latency !== null ? `Jev: ${r.latency.requests} live requests, p50 ${Math.round(r.latency.p50Ms)} ms, p95 ${Math.round(r.latency.p95Ms)} ms (latency: recorded run only).` : 'Jev latency: recorded run only (this report has none).', '');
  out.push('## Turns routed wrongly at the business\'s bar', '');
  if (r.wrongCases.length === 0) out.push('None.');
  else {
    out.push('| id | labelled | expected route | got |', '| --- | --- | --- | --- |');
    for (const c of r.wrongCases) out.push(`| ${c.id} | ${c.label} | ${c.expected} | ${c.got} |`);
  }
  out.push('');
  return out;
}
