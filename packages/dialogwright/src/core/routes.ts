import type { App, FormId, PredicateContext, RouteOutcome, RoutePoint, RouteRule, Routes } from './app/types';
import { ROUTE_POINTS, ROUTE_THEN, ROUTE_THEN_AT } from './app/types';
import { allHold, alwaysHolds, conditionProblems, conditionRefProblems, CONDITION_SHAPES, subjectsOf, type ConditionFacts, type ConditionWorld } from './conditions';
import { hoursOpen, scheduleNames } from './hours';
import type { Session } from './session';
import { callDataOf } from './callData';
import type { TransferWorld } from './transfer';

/**
 * Routes (routes.yaml, App.routes; design 2026-10-09-routes): ordered rules at three points of a call,
 * the first whose conditions all hold taken, an `else` last. They decide only there: intents, priority
 * intents and the agent intent still decide every turn. This module judges a point's rules and checks
 * them; core/turn.ts acts on the outcome taken.
 */

/** The handoff reason of a route that hands off without naming one. */
export const ROUTE_HANDOFF_REASON = 'needs-human';

/** What the records say of a route taken: the point, the form (afterForm), the rule, what followed, and the subjects it read (never their values). */
export interface RouteTaken {
  readonly point: RoutePoint;
  /** The form that completed, for afterForm. */
  readonly form?: FormId;
  /** The rule taken, by its index in the point's list (from 0), or `else`. */
  readonly rule: number | 'else';
  readonly outcome: RouteOutcome['then'];
  /** The subjects the rule read (conditions.ts subjectsOf): `hours`, `fact.pastDue`, ...; none for `else`. */
  readonly subjects: readonly string[];
}

/** The rules of `point` (of `form`, for afterForm); none where the app writes none. */
export function rulesAt(app: Pick<App, 'routes'>, point: RoutePoint, form?: FormId): readonly RouteRule[] {
  const routes = app.routes;
  if (routes === undefined) return [];
  if (point === 'afterForm') return form !== undefined && routes.afterForm !== undefined && Object.hasOwn(routes.afterForm, form) ? routes.afterForm[form]! : [];
  return routes[point] ?? [];
}

/** The rule taken among `rules` on these facts: the first whose conditions all hold; null when none does (no rules). */
export function routeTaken(rules: readonly RouteRule[], facts: ConditionFacts): { rule: RouteRule; index: number } | null {
  const index = rules.findIndex((r) => allHold(r.when, facts));
  return index < 0 ? null : { rule: rules[index]!, index };
}

/** What the turn knows beside the session: its clock and the environment `called` reads. */
export interface ConditionClock {
  readonly nowMs: number;
  readonly todayIso: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Everything a condition may read on this call, at this moment: the form open (or, with none, the last
 * completed), the call data, the facts, the slots' values, the caller's level, the hours at the turn's
 * clock, the number called, the environment and the app's predicates (each given the session read-only:
 * a copy, so what one writes is lost; one that throws is false). With no clock (null), what only the
 * turn knows is not known: no hours, no environment and no predicate holds.
 */
export function sessionConditionFacts(app: App, s: Session, clock: ConditionClock | null, reason?: string): ConditionFacts {
  const base: ConditionFacts = {
    ...(reason !== undefined ? { reason } : {}),
    form: s.form ?? s.completed.at(-1) ?? null,
    callData: callDataOf(s),
    facts: s.facts,
    slots: Object.fromEntries(Object.entries(s.slots).map(([id, st]) => [id, st.value])),
    level: s.principal.level,
    ...(s.calledNumber !== undefined ? { calledNumber: s.calledNumber } : {}),
  };
  if (clock === null) return base;
  const env = clock.env;
  const predicates = app.predicates;
  return {
    ...base,
    hoursOpen: (schedule) => hoursOpen(app.hours, clock.nowMs, schedule),
    ...(env !== undefined ? { env: (name: string) => (Object.hasOwn(env, name) ? env[name] : undefined) } : {}),
    predicate: (name) => {
      const p = predicates !== undefined && Object.hasOwn(predicates, name) ? predicates[name] : undefined;
      if (typeof p !== 'function') return false;
      const ctx: PredicateContext = { s: structuredClone(s), nowMs: clock.nowMs, todayIso: clock.todayIso };
      try {
        return p(ctx) === true;
      } catch {
        return false;
      }
    },
  };
}

/** The route taken at a point, for the records. */
export function routeRecord(point: RoutePoint, taken: { rule: RouteRule; index: number }, form?: FormId): RouteTaken {
  return {
    point,
    ...(form !== undefined ? { form } : {}),
    rule: taken.rule.else === true ? 'else' : taken.index,
    outcome: taken.rule.outcome.then,
    subjects: taken.rule.else === true ? [] : subjectsOf(taken.rule.when),
  };
}

/** What the app has that its conditions may name (ConditionWorld, but where it is judged). */
export function conditionWorldOf(app: App): TransferWorld {
  let facts: string[] | null = null;
  try {
    const initial = app.facts?.initial();
    if (typeof initial === 'object' && initial !== null && !Array.isArray(initial)) facts = Object.keys(initial);
  } catch {
    facts = null;
  }
  return {
    forms: Object.keys(app.forms),
    slots: Object.keys(app.slots),
    ...(app.callData !== undefined ? { callData: app.callData } : {}),
    facts,
    hours: app.hours === undefined ? null : { schedules: scheduleNames(app.hours) },
    predicates: Object.keys(app.predicates ?? {}),
    calledKept: app.callerNumber?.called === true,
  };
}

/** One thing wrong with an app's routes, at its path (engine terms: a point's list, a rule's index, its `when` a list). */
export interface RouteProblem {
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly fix: string;
  readonly warning?: true;
  /** A slot named that is not one of the app's, so a folder's check can give its own fix. */
  readonly unknownSlot?: string;
}

/** What else the routes' checks need to know of the app. */
export interface RouteWorld extends TransferWorld {
  /** The locales the app speaks, the default first. */
  readonly locales: readonly string[];
  /** Whether the app's default locale has a line; absent, lines are not checked (check.ts checks them in every locale). */
  readonly hasLine?: (id: string) => boolean;
}

/**
 * Everything wrong with an app's routes (`pnpm check` for a folder, with the warnings; validateApp, the
 * refusals, for an app built in code): a point's list that does not end with its `else`, or has one
 * before its end; a condition or an outcome that names what the app does not have; a `then` its point
 * does not take; an afterForm route entering the form that just completed; and, as warnings, a rule after
 * one that always holds, and the condition warnings (an undeclared fact).
 */
export function routeProblems(routes: Routes | undefined, world: RouteWorld): RouteProblem[] {
  if (routes === undefined) return [];
  const out: RouteProblem[] = [];
  const add = (path: readonly (string | number)[], message: string, fix: string, extra: Partial<RouteProblem> = {}): void => void out.push({ path, message, fix, ...extra });
  const list = (rules: unknown, at: readonly (string | number)[], point: RoutePoint, form?: FormId): void => {
    if (!Array.isArray(rules)) {
      add(at, 'is not a list of rules', 'write a list: - when: ..., then: ... and last - else: continue');
      return;
    }
    if (rules.length === 0) add(at, 'has no rules, not even its else', 'write the rules, and last - else: continue; or delete the point');
    let always: number | null = null;
    (rules as RouteRule[]).forEach((rule, i) => {
      const here = [...at, i];
      const last = i === rules.length - 1;
      const after = rules.length - 1 - i;
      if (rule.else === true && !last) add(here, `is the else, and ${after === 1 ? '1 rule follows' : `${after} rules follow`} it, which ${after === 1 ? 'is' : 'are'} never taken`, 'move the else to the end, after every rule');
      if (last && rule.else !== true) add(here, 'is the last rule, and the point ends with no else', 'add - else: continue (or another outcome) after it, for a call no rule takes');
      if (rule.else !== true) {
        if (!Array.isArray(rule.when)) add([...here, 'when'], 'is not a list of conditions', `write when: [Condition, ...] (core/conditions.ts): ${CONDITION_SHAPES}`);
        else {
          rule.when.forEach((c, j) => {
            const shape = conditionProblems(c);
            if (shape.length > 0) {
              for (const problem of shape) add([...here, 'when', j], problem, `write a Condition (core/conditions.ts): ${CONDITION_SHAPES}`);
              return;
            }
            for (const p of conditionRefProblems(c, { ...world, at: point })) add([...here, 'when', j, p.key], p.message, p.fix, { ...(p.warning ? { warning: true as const } : {}), ...(p.unknownSlot !== undefined ? { unknownSlot: p.unknownSlot } : {}) });
          });
          if (always !== null) add(here, `is never taken: rule ${always + 1} before it always holds`, 'move it above that rule, or give that rule a when', { warning: true });
          else if (alwaysHolds(rule.when)) always = i;
        }
      }
      outcomeProblems(rule.outcome, here, point, form);
    });
  };
  const outcomeProblems = (o: RouteOutcome | undefined, at: readonly (string | number)[], point: RoutePoint, form?: FormId): void => {
    if (typeof o !== 'object' || o === null) {
      add(at, 'has no outcome', `write then: ${ROUTE_THEN_AT[point].join(' | ')}`);
      return;
    }
    if (!(ROUTE_THEN as readonly string[]).includes(o.then)) {
      add([...at, 'then'], `"${String(o.then)}" is not something a route does`, `write one of ${ROUTE_THEN_AT[point].join(', ')}`);
      return;
    }
    if (!ROUTE_THEN_AT[point].includes(o.then)) add([...at, 'then'], `then: ${o.then} is not taken at ${point}: nothing has been asked yet, so there is no "anything else?" to go on to`, `write one of ${ROUTE_THEN_AT[point].join(', ')}`);
    if ((o.then === 'end' || o.then === 'anything-else') && o.say === undefined) add(at, `then: ${o.then} says a line first, and this route names none`, 'add "say: <a prompt id in prompts.yaml>"');
    if (o.say !== undefined && world.hasLine !== undefined && !world.hasLine(o.say)) add([...at, 'say'], `prompt "${o.say}" is not in prompts.yaml`, `add "${o.say}:" to prompts.yaml, or name a line that is there`);
    if (o.then === 'form') {
      if (!world.forms.includes(o.form)) add([...at, 'form'], `form "${o.form}" is not defined`, `name one of ${world.forms.join(', ')}`);
      else if (point === 'afterForm' && o.form === form) add([...at, 'form'], `a route after "${form}" enters "${form}" again, which goes round in a loop and sends the call to a person`, 'enter another form, or go on (continue)');
    }
    if (o.then === 'locale' && !world.locales.includes(o.locale)) add([...at, 'locale'], `"${o.locale}" is not a locale of this app`, `add locale/${o.locale}/ or use one of ${world.locales.join(', ')}`);
  };
  for (const point of ROUTE_POINTS) {
    if (point === 'afterForm') {
      const byForm = routes.afterForm;
      if (byForm === undefined) continue;
      for (const [form, rules] of Object.entries(byForm)) {
        if (!world.forms.includes(form)) add(['afterForm', form], `form "${form}" is not defined`, `name one of ${world.forms.join(', ')}`);
        list(rules, ['afterForm', form], 'afterForm', form);
      }
    } else if (routes[point] !== undefined) {
      list(routes[point], [point], point);
    }
  }
  return out;
}

/** The forms a route enters (`then: form`), each with the routes' points that enter it: what reaches an internal form. */
export function formsEnteredByRoutes(routes: Routes | undefined): Map<FormId, string[]> {
  const out = new Map<FormId, string[]>();
  const note = (rules: readonly RouteRule[] | undefined, where: string): void => {
    for (const r of rules ?? []) if (r.outcome?.then === 'form') out.set(r.outcome.form, [...new Set([...(out.get(r.outcome.form) ?? []), where])]);
  };
  note(routes?.start, 'start');
  note(routes?.afterIdentity, 'afterIdentity');
  for (const [form, rules] of Object.entries(routes?.afterForm ?? {})) note(rules, `after ${form}`);
  return out;
}
