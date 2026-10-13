import type { App, FormId, PredicateContext, RouteOutcome, RoutePoint, RouteRule, Routes } from './app/types';
import { ROUTE_POINTS, ROUTE_THEN, ROUTE_THEN_AT } from './app/types';
import { allHold, alwaysHolds, conditionProblems, conditionRefProblems, CONDITION_SHAPES, subjectsOf, type Condition, type ConditionFacts, type ConditionValue, type ConditionWorld, type ValueTest } from './conditions';
import { hoursOpen, scheduleNames } from './hours';
import type { Session } from './session';
import { callDataOf } from './callData';
import type { TransferWorld } from './transfer';
import { topLevelOf } from './app/lookup';

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
  /** The rule taken, by its number in the point's list as people count (the first is 1), or `else`. Every record and display says this same number. */
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

/** What the turn knows beside the session: its clock, the environment `called` reads, and the app's settings its predicates read (TurnContext.settings). */
export interface ConditionClock {
  readonly nowMs: number;
  readonly todayIso: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly settings?: (name: string) => string | undefined;
}

/**
 * Everything a condition may read on this call, at this moment: the form open (or, with none, the last
 * completed), the call data, the facts, the slots' values, the caller's level, the hours at the turn's
 * clock, the number called, the environment and the app's predicates (each given the session read-only:
 * a copy, so what one writes is lost; and the app's settings, by name; one that throws is false). With no clock (null), what only the
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
      try {
        const settings = clock.settings;
        const ctx: PredicateContext = { s: structuredClone(s), nowMs: clock.nowMs, todayIso: clock.todayIso, env: (name) => settings?.(name) };
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
    rule: taken.rule.else === true ? 'else' : taken.index + 1,
    outcome: taken.rule.outcome.then,
    subjects: taken.rule.else === true ? [] : subjectsOf(taken.rule.when),
  };
}

/**
 * The facts' names an app declares: the keys its facts start with (FactsConfig.initial), or null where
 * it declares none (no facts, an initial value that is not a record, or a hook that throws), so a fact
 * condition is not checked against them.
 */
export function declaredFacts(facts: { initial(): unknown } | undefined): string[] | null {
  try {
    const initial = facts?.initial();
    return typeof initial === 'object' && initial !== null && !Array.isArray(initial) ? Object.keys(initial) : null;
  } catch {
    return null;
  }
}

/** What the app has that its conditions may name (ConditionWorld, but where it is judged). */
export function conditionWorldOf(app: App): TransferWorld {
  const facts = declaredFacts(app.facts);
  return {
    forms: Object.keys(app.forms),
    slots: Object.keys(app.slots),
    ...(app.callData !== undefined ? { callData: app.callData } : {}),
    facts,
    hours: app.hours === undefined ? null : { schedules: scheduleNames(app.hours) },
    predicates: Object.keys(app.predicates ?? {}),
    calledKept: app.callerNumber?.called === true,
    maxLevel: app.identity === undefined ? 0 : topLevelOf(app.identity),
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
      if (typeof rule !== 'object' || rule === null) {
        add(here, 'is not a rule ({ when, outcome } or the else)', 'write { when: [Condition, ...], outcome: { then, ... } }, or { when: [], outcome, else: true } last');
        return;
      }
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
    lostSwitches(rules as RouteRule[], at);
  };
  // A rule that says a line and goes on (`continue`) above a `locale` rule: a call both hold for is taken
  // by the first and never switched, so its line and the rest of the call are in the default language
  // (live: an outage notice above the Spanish line's rule greeted a Spanish call in English). Warned only
  // where both can hold (not where they cannot both hold: exclusive), and not where a rule above the
  // first already does both (the combined rule, the fix).
  const lostSwitches = (rules: readonly RouteRule[], at: readonly (string | number)[]): void => {
    const plain = (r: unknown): r is RouteRule => typeof r === 'object' && r !== null && (r as RouteRule).else !== true && Array.isArray((r as RouteRule).when) && typeof (r as RouteRule).outcome === 'object' && (r as RouteRule).outcome !== null;
    const key = (c: Condition): string => JSON.stringify(c);
    rules.forEach((rule, i) => {
      if (!plain(rule) || rule.outcome.then !== 'continue' || rule.outcome.say === undefined) return;
      const j = rules.findIndex((later, k) => k > i && plain(later) && later.outcome.then === 'locale'
        && !exclusive(rule.when, later.when)
        && !rules.slice(0, i).some((above) => plain(above) && above.outcome.then === 'locale' && above.outcome.locale === (later.outcome as { locale: string }).locale
          && [...rule.when, ...later.when].every((c) => above.when.some((a) => key(a) === key(c)))));
      if (j < 0) return;
      const locale = (rules[j]!.outcome as { locale: string }).locale;
      add([...at, i], `says ${rule.outcome.say} and goes on, so a call it takes is never switched to ${locale}, even where rule ${j + 1} (then: locale) holds too: the first rule that holds is taken, and the rules after it are not looked at`,
        `above this rule, add one that does both: when both rules' conditions hold, say: ${rule.outcome.say}, then: locale, locale: ${locale} (the line is said in the new language); or move rule ${j + 1} above this one, if its callers need not hear ${rule.outcome.say}`, { warning: true });
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
    if ((o as { goodbye?: unknown }).goodbye !== undefined && o.then !== 'end') add([...at, 'goodbye'], `goodbye says whether the goodbye follows the line a call ends on, and this route does not end the call (then: ${o.then})`, 'delete "goodbye", or write "then: end"');
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

/**
 * Whether two rules' conditions can never all hold on one call, as far as their own words say: two
 * `called` conditions with no variable in common (a call dials one number), or one subject (a fact, a
 * call data key, a slot) tested for values that exclude each other, or the same hours open and closed.
 * Anything else may hold together (a predicate, a level, two different facts).
 */
export function exclusive(a: readonly Condition[], b: readonly Condition[]): boolean {
  return a.some((x) => b.some((y) => excludes(x, y)));
}

/** Whether conditions `x` and `y` can never both hold (exclusive). */
function excludes(x: Condition, y: Condition): boolean {
  if (x.kind === 'called' && y.kind === 'called') return !x.variables.some((v) => y.variables.includes(v));
  if (x.kind === 'hours' && y.kind === 'hours') return x.schedule === y.schedule && x.open !== y.open;
  if ((x.kind === 'fact' || x.kind === 'callData' || x.kind === 'slot') && y.kind === x.kind && y.key === x.key) return testsExclude(x.test, y.test) || testsExclude(y.test, x.test);
  return false;
}

/** Whether a value passing test `t` can never pass `u` (each of is, in, notIn, present; values compared by their spelling, as call data is, so `1` and `"1"` are the same). */
function testsExclude(t: ValueTest, u: ValueTest): boolean {
  const same = (p: ConditionValue, q: ConditionValue): boolean => String(p) === String(q);
  if ('present' in t && 'present' in u) return t.present !== u.present;
  if ('present' in t && !t.present) return 'is' in u || 'in' in u;
  if ('is' in t) {
    if ('is' in u) return !same(t.is, u.is);
    if ('in' in u) return !u.in.some((v) => same(v, t.is));
    if ('notIn' in u) return u.notIn.some((v) => same(v, t.is));
  }
  if ('in' in t && 'in' in u) return !t.in.some((v) => u.in.some((w) => same(v, w)));
  return false;
}

/**
 * The environment variables the app's `called` conditions name (routes.yaml's rules and app.yaml's
 * transfer targets), each once, in the order they are written: what the server reads as it starts.
 */
export function calledVariables(app: Pick<App, 'routes' | 'transfer'>): string[] {
  const out: string[] = [];
  const rules: { readonly when: readonly Condition[] }[] = [
    ...(app.routes?.start ?? []), ...(app.routes?.afterIdentity ?? []), ...Object.values(app.routes?.afterForm ?? {}).flat(), ...(app.transfer?.targets ?? []),
  ];
  for (const r of rules) for (const c of r.when) if (c.kind === 'called') for (const v of c.variables) if (!out.includes(v)) out.push(v);
  return out;
}

/** A route as routes.yaml writes it: a rule with its outcome beside `when`, or the else with its outcome under `else`. */
export interface WrittenRoute {
  readonly else?: 'continue' | { readonly then?: string; readonly say?: string; readonly reason?: string; readonly form?: string; readonly locale?: string; readonly goodbye?: boolean };
  readonly then?: string;
  readonly goodbye?: boolean;
  readonly say?: string;
  readonly reason?: string;
  readonly form?: string;
  readonly locale?: string;
}

/**
 * The outcome a route as written takes, wherever it is written: beside `when`, or under `else` (null
 * for `else: continue`, which says and enters nothing), with the path from the rule to it.
 */
export function writtenOutcome(rule: WrittenRoute): { outcome: Omit<WrittenRoute, 'else'>; at: readonly string[] } | null {
  if (rule.else === undefined) return { outcome: rule, at: [] };
  return rule.else === 'continue' ? null : { outcome: rule.else, at: ['else'] };
}

/** The forms each form's routes after it enter (afterForm `then: form`), by form: moves between forms, for the loop check (core/app/next.ts moveCycles). */
export function routeFormEdges(routes: Routes | undefined): Record<FormId, FormId[]> {
  const out: Record<FormId, FormId[]> = {};
  for (const [form, rules] of Object.entries(routes?.afterForm ?? {})) {
    const to = rules.flatMap((r) => (r.outcome?.then === 'form' ? [r.outcome.form] : []));
    if (to.length > 0) out[form] = [...new Set(to)];
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
