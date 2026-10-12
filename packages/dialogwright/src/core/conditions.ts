import type { FormId, SlotId } from './app/types';

/**
 * Conditions: what an app's declarative choices are made on, one small fixed set, never an expression
 * language. A rule's `when` is a list of conditions, and it holds when every one of them holds (an empty
 * list always holds). Written once, here, for every place that chooses by condition: app.yaml's transfer
 * targets (core/transfer.ts) and routes.yaml's points (core/routes.ts). A new kind is a row of
 * CONDITION_KINDS (which owns the shape rules for YAML and for an app built in code alike), a case of the
 * Condition union, and a case in conditionHolds, describeCondition and conditionFrom.
 *
 * In YAML a condition names its subject by its key, with a value test beside it where the subject has
 * a value (define/schema/condition.ts holds it to this, conditionFrom reads it into the engine's shape):
 * - `{ reason: emergency }` or `{ reason: [emergency, security] }`: the handoff's reason is one of these
 *   (only where a handoff is being chosen: a transfer target);
 * - `{ form: payment }` or `{ form: [billing_question, payment] }`: the form the caller is in (or, with
 *   none open, the last one completed on the call) is one of these;
 * - `{ callData: queue, is: vip }`, `in: [...]`, `notIn: [...]`, `present: true | false`: a key of the
 *   call data (callDataOf). A key the call came without fails `is`, `in` and `notIn` alike (nothing is
 *   compared), and holds only `present: false`, so a rule never routes on a value that is not there;
 * - `{ fact: pastDue, is: true }` (a dotted path for a nested one, `account.tier`), with the same tests:
 *   a value in the session's facts (FactsConfig). A fact that is not a string, a number or a true or
 *   false (a list, a record) is present, and fails `is`, `in` and `notIn`; one that is null is absent;
 * - `{ slot: severity, is: danger }`, with the same tests: a slot's value as the session holds it;
 * - `{ level: 1 }`: the caller is verified to at least this level (1 or 2);
 * - `{ hours: open }` or `{ hours: closed }`, with `schedule: <name>` for a named one: app.yaml's hours
 *   (core/hours.ts) at the turn's clock;
 * - `{ called: env.MAIN_LINE }` or a list: the number called is the value of one of these environment
 *   variables (the numbers stay out of YAML);
 * - `{ named: vip }`: a predicate the app writes in code (App.predicates), given the session, read-only.
 */

/** A value a test compares with, as YAML writes it after `is`. A value read (call data) is a string, compared with the scalar's own spelling. */
export type ConditionValue = string | number | boolean;

/** How a subject's value is tested: equal to one, one of a list, none of a list, or there at all. */
export type ValueTest =
  | { readonly is: ConditionValue }
  | { readonly in: readonly ConditionValue[] }
  | { readonly notIn: readonly ConditionValue[] }
  | { readonly present: boolean };

/** The value tests, by the key YAML writes them under, in the order the docs list them. */
export const VALUE_TESTS = ['is', 'in', 'notIn', 'present'] as const;
export type ValueTestName = (typeof VALUE_TESTS)[number];

/** The levels a `level` condition may name: 1 (verified) and 2 (the one-time code too). */
export const CONDITION_LEVELS = [1, 2] as const;

/** One condition, discriminated on its subject (`kind`). */
export type Condition =
  | { readonly kind: 'reason'; readonly reasons: readonly string[] }
  | { readonly kind: 'form'; readonly forms: readonly FormId[] }
  | { readonly kind: 'callData'; readonly key: string; readonly test: ValueTest }
  | { readonly kind: 'fact'; readonly key: string; readonly test: ValueTest }
  | { readonly kind: 'slot'; readonly key: SlotId; readonly test: ValueTest }
  | { readonly kind: 'level'; readonly level: number }
  | { readonly kind: 'hours'; readonly open: boolean; readonly schedule?: string }
  | { readonly kind: 'called'; readonly variables: readonly string[] }
  | { readonly kind: 'named'; readonly predicate: string };

/**
 * Each kind of condition, by the key YAML names it with (which is its `kind`): the one place its shape is
 * said. `names`: YAML writes one name or a list, the engine keeps the list in `field`. `key`: YAML names
 * one key, the engine keeps it in `key`, beside one value test (`is`, `in`, `notIn` or `present`).
 * `one`: YAML writes one value and no test, the engine keeps it in `field`. `extra` names the keys a
 * kind takes beside its subject (an `hours` condition's `schedule`). `words` is what the messages call it.
 */
export const CONDITION_KINDS = {
  reason: { value: 'names', field: 'reasons', words: 'a reason condition' },
  form: { value: 'names', field: 'forms', words: 'a form condition' },
  callData: { value: 'key', words: 'a callData condition' },
  fact: { value: 'key', words: 'a fact condition' },
  slot: { value: 'key', words: 'a slot condition' },
  level: { value: 'one', field: 'level', words: 'a level condition' },
  hours: { value: 'one', field: 'open', words: 'an hours condition', extra: ['schedule'] },
  called: { value: 'names', field: 'variables', words: 'a called condition' },
  named: { value: 'one', field: 'predicate', words: 'a named condition' },
} as const satisfies Record<Condition['kind'], { value: 'names' | 'one'; field: string; words: string; extra?: readonly string[] } | { value: 'key'; words: string }>;

/** The subjects a condition may name, by the key YAML writes them under. */
export const CONDITION_SUBJECTS = Object.keys(CONDITION_KINDS) as readonly Condition['kind'][];
export type ConditionSubject = Condition['kind'];

/** The subjects that take a value test beside them (`is`, `in`, `notIn`, `present`). */
export const TESTED_SUBJECTS: readonly ConditionSubject[] = CONDITION_SUBJECTS.filter((k) => CONDITION_KINDS[k].value === 'key');

/** The keys a kind takes beside its subject (an `hours` condition's `schedule`). */
function extrasOf(k: ConditionSubject): readonly string[] {
  return (CONDITION_KINDS[k] as { extra?: readonly string[] }).extra ?? [];
}

/** Every key some kind takes beside its subject. */
const EXTRA_KEYS: readonly string[] = [...new Set(CONDITION_SUBJECTS.flatMap(extrasOf))];

/**
 * What the conditions are judged against at the point a choice is made. A subject with one value per
 * point (the reason, the form, the level, the hours, the number called, a predicate) holds no condition
 * where the point has none: a `reason` condition never holds where there is no handoff reason, nor a
 * `form` condition with no form, nor an `hours` condition where the app has no such hours. Call data,
 * facts and slots are sets of keys: a point that has none reads every key as absent, so `present: false`
 * holds there and every other test fails, as on a call that came with none.
 */
export interface ConditionFacts {
  readonly reason?: string;
  /** The form the condition reads (see `form` above); null when there is none. */
  readonly form?: FormId | null;
  /** The call data (callDataOf); absent, none: every key absent. */
  readonly callData?: Readonly<Record<string, string>>;
  /** The session's facts (Session.facts); absent, none. */
  readonly facts?: unknown;
  /** The slots' values as the session holds them, null for an empty one; absent, none. */
  readonly slots?: Readonly<Record<SlotId, string | null>>;
  /** The caller's identity level (0 anonymous); absent, unknown: a level condition never holds. */
  readonly level?: number;
  /** Whether the hours (a named schedule's, or the default's) are open now; null for hours the app does not have. Absent: no clock, so an hours condition never holds. */
  readonly hoursOpen?: (schedule: string | undefined) => boolean | null;
  /** The number called (Session.calledNumber); absent, none. */
  readonly calledNumber?: string;
  /** An environment variable's value, for `called`; absent, none set. */
  readonly env?: (name: string) => string | undefined;
  /** Whether the app's predicate holds; absent, none does. */
  readonly predicate?: (name: string) => boolean;
}

/** Whether `value` (absent when the subject has none) passes `test`. */
export function valueHolds(test: ValueTest, value: string | undefined): boolean {
  if ('present' in test) return test.present === (value !== undefined);
  if (value === undefined) return false;
  if ('is' in test) return String(test.is) === value;
  if ('in' in test) return test.in.some((v) => String(v) === value);
  return !test.notIn.some((v) => String(v) === value);
}

/**
 * Whether a value read from the facts passes `test`: null and undefined are absent; a string, a number
 * or a true or false is compared by its spelling; anything else (a list, a record) is present, and is
 * never equal to a value.
 */
export function rawValueHolds(test: ValueTest, raw: unknown): boolean {
  if (raw === undefined || raw === null) return valueHolds(test, undefined);
  if (isScalar(raw)) return valueHolds(test, String(raw));
  return 'present' in test ? test.present : false;
}

/** The value at a dotted path in the facts (`account.tier`), own keys only; undefined where the path goes nowhere. */
export function factAt(facts: unknown, path: string): unknown {
  let at: unknown = facts;
  for (const part of path.split('.')) {
    if (typeof at !== 'object' || at === null || Array.isArray(at) || !Object.hasOwn(at, part)) return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

/**
 * The digits of a number as a carrier or a variable writes it: `+1 (555) 555-0100` is `15555550100`. A
 * SIP address (`sip:+15555550100@pbx.example.com:5060;transport=udp`) is its user part's, so the host's
 * address and port are never read as part of the number.
 */
export function digitsOf(n: string): string {
  const sip = /^sips?:([^@;]*)/i.exec(n.trim());
  return (sip ? sip[1]! : n).replace(/\D/g, '');
}

/**
 * Whether the number called is `wanted` (a variable's value): the same digits; or, where only one of
 * them carries a country code (the other is exactly ten digits, a national number written without it),
 * the longer one ending in the shorter. Two numbers that both carry a country code are the same only
 * digit for digit (+15551234567 is not +75551234567).
 */
export function sameNumber(called: string, wanted: string): boolean {
  const a = digitsOf(called);
  const b = digitsOf(wanted);
  if (a === '' || b === '') return false;
  if (a === b) return true;
  if (a.length === b.length) return false;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length === 10 && long.endsWith(short);
}

/** Whether one condition holds. */
export function conditionHolds(c: Condition, facts: ConditionFacts): boolean {
  switch (c.kind) {
    case 'reason':
      return facts.reason !== undefined && c.reasons.includes(facts.reason);
    case 'form':
      return facts.form !== undefined && facts.form !== null && c.forms.includes(facts.form);
    case 'callData': {
      const data = facts.callData ?? {};
      return valueHolds(c.test, Object.hasOwn(data, c.key) ? data[c.key] : undefined);
    }
    case 'fact':
      return rawValueHolds(c.test, factAt(facts.facts, c.key));
    case 'slot': {
      const slots = facts.slots ?? {};
      const v = Object.hasOwn(slots, c.key) ? slots[c.key] : undefined;
      return valueHolds(c.test, v === null ? undefined : v);
    }
    case 'level':
      return facts.level !== undefined && facts.level >= c.level;
    case 'hours': {
      const open = facts.hoursOpen?.(c.schedule);
      return open !== undefined && open !== null && open === c.open;
    }
    case 'called': {
      const called = facts.calledNumber;
      if (called === undefined || facts.env === undefined) return false;
      return c.variables.some((name) => {
        const v = facts.env!(name);
        return v !== undefined && v.trim() !== '' && sameNumber(called, v);
      });
    }
    case 'named':
      return facts.predicate?.(c.predicate) === true;
  }
}

/** Whether every condition of a `when` holds; an empty `when` always does. */
export function allHold(when: readonly Condition[], facts: ConditionFacts): boolean {
  return when.every((c) => conditionHolds(c, facts));
}

/**
 * The subjects a `when` reads, as a record names them, never with a value: `hours`, `hours.billing`,
 * `fact.pastDue`, `slot.severity`, `callData.queue`, `level`, `called`, `named.vip`, `reason`, `form`.
 */
export function subjectsOf(when: readonly Condition[]): string[] {
  const out: string[] = [];
  for (const c of when) {
    const s = c.kind === 'callData' || c.kind === 'fact' || c.kind === 'slot' ? `${c.kind}.${c.key}`
      : c.kind === 'hours' ? (c.schedule !== undefined ? `hours.${c.schedule}` : 'hours')
        : c.kind === 'named' ? `named.${c.predicate}`
          : c.kind;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** A value as the docs and the read-back pages write it. */
function shown(v: ConditionValue): string {
  return typeof v === 'string' ? v : String(v);
}

/** A value test in words, after its subject ("is vip", "is not basic", "is present"). */
function testWords(t: ValueTest): string {
  if ('present' in t) return `is ${t.present ? 'present' : 'absent'}`;
  if ('is' in t) return `is ${shown(t.is)}`;
  if ('in' in t) return `is ${t.in.map(shown).join(' or ')}`;
  return `is not ${t.notIn.map(shown).join(' or ')}`;
}

/** One condition in words, for the app map and messages ("callData queue is vip"). */
export function describeCondition(c: Condition): string {
  switch (c.kind) {
    case 'reason':
      return `the reason is ${c.reasons.join(' or ')}`;
    case 'form':
      return `the form is ${c.forms.join(' or ')}`;
    case 'callData':
    case 'fact':
    case 'slot':
      return `${c.kind} ${c.key} ${testWords(c.test)}`;
    case 'level':
      return `the caller is verified to level ${c.level}`;
    case 'hours':
      return `${c.schedule !== undefined ? `the ${c.schedule} hours are` : 'the hours are'} ${c.open ? 'open' : 'closed'}`;
    case 'called':
      return `the number called is ${c.variables.join(' or ')}`;
    case 'named':
      return `${c.predicate} holds (in code)`;
  }
}

/** A `when` in words: its conditions joined by "and", or "always" for an empty one. */
export function describeWhen(when: readonly Condition[]): string {
  return when.length === 0 ? 'always' : when.map(describeCondition).join(' and ');
}

/**
 * Whether a `when` holds whatever the call: an empty one (a rule written with no `when`). A rule after
 * one that always holds is never reached (`pnpm check` warns).
 */
export function alwaysHolds(when: readonly Condition[]): boolean {
  return when.length === 0;
}

/** One thing wrong with a condition's shape as YAML writes it, at its path within the condition, with its fix. */
export interface ConditionIssue {
  readonly path: readonly string[];
  readonly message: string;
  readonly fix: string;
}

const EXAMPLES = '{ reason: ... }, { form: ... }, { callData: <key>, is: ... }, { fact: <name>, is: ... }, { slot: <id>, is: ... }, { level: 1 }, { hours: closed }, { called: env.<NAME> } or { named: <predicate> }';

/**
 * What is wrong with the shape of a condition as YAML writes it, read from CONDITION_KINDS: no subject,
 * two, a test on a subject that takes none, none or two on one that takes one, a key beside a subject
 * that does not take it. The types of the values are the schema's own fields (define/schema/condition.ts,
 * whose check reports these).
 */
export function yamlConditionIssues(raw: unknown): ConditionIssue[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [{ path: [], message: 'is not a condition', fix: `write ${EXAMPLES}` }];
  const o = raw as Record<string, unknown>;
  const subjects = CONDITION_SUBJECTS.filter((s) => o[s] !== undefined);
  const tests = VALUE_TESTS.filter((t) => o[t] !== undefined);
  if (subjects.length === 0) return [{ path: [], message: 'names no subject', fix: `write one of ${CONDITION_SUBJECTS.join(', ')} (for example { reason: emergency }, { callData: queue, is: vip } or { hours: closed })` }];
  if (subjects.length > 1) return [{ path: [], message: `names ${subjects.join(' and ')}, and a condition has one subject`, fix: `write a list of conditions, which all hold: [${subjects.map((s) => `{ ${s}: ... }`).join(', ')}]` }];
  const subject = subjects[0]!;
  const out: ConditionIssue[] = [];
  for (const extra of EXTRA_KEYS) {
    if (o[extra] !== undefined && !extrasOf(subject).includes(extra)) {
      const owners = CONDITION_SUBJECTS.filter((k) => extrasOf(k).includes(extra));
      out.push({ path: [extra], message: `${subject} takes no ${extra}: only ${owners.join(' and ')} does`, fix: `delete "${extra}"` });
    }
  }
  if (CONDITION_KINDS[subject].value !== 'key') {
    const lists = CONDITION_KINDS[subject].value === 'names';
    return [...out, ...tests.map((t) => ({ path: [t], message: lists ? `${subject} takes no ${t}: it lists its values itself` : `${subject} takes no ${t}: it names its one value itself`, fix: lists ? `delete "${t}", and write the values as ${subject}: [a, b]` : `delete "${t}"` }))];
  }
  if (tests.length === 0) return [...out, { path: [], message: `${subject} needs a test beside it`, fix: 'add one of is: <value>, in: [values], notIn: [values] or present: true' }];
  if (tests.length > 1) return [...out, { path: [tests[1]!], message: `${subject} takes one test, and this has ${tests.join(' and ')}`, fix: 'keep one; for two tests write a list of conditions, which all hold' }];
  return out;
}

/**
 * A condition as YAML writes it (define/schema/condition.ts has held it to the schema) in the engine's
 * shape. Throws on a shape yamlConditionIssues refuses.
 */
export function conditionFrom(raw: Readonly<Record<string, unknown>>): Condition {
  const issue = yamlConditionIssues(raw)[0];
  if (issue !== undefined) throw new Error(`condition ${JSON.stringify(raw)}: ${issue.message}`);
  if (raw.reason !== undefined) return { kind: 'reason', reasons: listOf(raw.reason) };
  if (raw.form !== undefined) return { kind: 'form', forms: listOf(raw.form) };
  if (raw.fact !== undefined) return { kind: 'fact', key: raw.fact as string, test: testOf(raw) };
  if (raw.slot !== undefined) return { kind: 'slot', key: raw.slot as string, test: testOf(raw) };
  if (raw.level !== undefined) return { kind: 'level', level: raw.level as number };
  if (raw.hours !== undefined) return { kind: 'hours', open: raw.hours === 'open', ...(raw.schedule !== undefined ? { schedule: raw.schedule as string } : {}) };
  // `env.NAME` is kept as the variable's name: the value is read where the condition is judged.
  if (raw.called !== undefined) return { kind: 'called', variables: listOf(raw.called).map((r) => (r.startsWith('env.') ? r.slice('env.'.length) : r)) };
  if (raw.named !== undefined) return { kind: 'named', predicate: raw.named as string };
  return { kind: 'callData', key: raw.callData as string, test: testOf(raw) };
}

/** A `when` as YAML writes it: one condition, or a list of them. */
export function whenFrom(raw: unknown): Condition[] {
  if (raw === undefined) return [];
  return (Array.isArray(raw) ? raw : [raw]).map((c) => conditionFrom(c as Record<string, unknown>));
}

function listOf(v: unknown): string[] {
  return (Array.isArray(v) ? v : [v]).map(String);
}

function testOf(raw: Readonly<Record<string, unknown>>): ValueTest {
  if (raw.is !== undefined) return { is: raw.is as ConditionValue };
  if (raw.in !== undefined) return { in: [...(raw.in as ConditionValue[])] };
  if (raw.notIn !== undefined) return { notIn: [...(raw.notIn as ConditionValue[])] };
  return { present: raw.present as boolean };
}

const isScalar = (v: unknown): v is ConditionValue => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const isNameList = (v: unknown): boolean => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x !== '');

/** An environment variable's name, as `env.<NAME>` names it (core/app/envReference.ts). */
const VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * What is wrong with a condition in the engine's shape (Condition: an app built in code, or anything
 * validateApp is handed), each a sentence in the engine's terms; empty when it is one. Read from
 * CONDITION_KINDS, so a new kind is checked by its row.
 */
export function conditionProblems(c: unknown): string[] {
  if (typeof c !== 'object' || c === null || Array.isArray(c)) return ['is not a condition object ({ kind, ... })'];
  const o = c as Record<string, unknown>;
  if (typeof o.kind !== 'string' || !Object.hasOwn(CONDITION_KINDS, o.kind)) return [`has kind ${JSON.stringify(o.kind)}, which is not one of ${CONDITION_SUBJECTS.join(', ')}`];
  const kind = o.kind as Condition['kind'];
  const spec = CONDITION_KINDS[kind];
  if (spec.value === 'names') {
    if (!isNameList(o[spec.field])) return [`is ${spec.words} whose ${spec.field} is not a list of one or more names`];
    if (kind === 'called' && !(o.variables as string[]).every((v) => VARIABLE_NAME.test(v))) return [`is ${spec.words} whose variables are not all environment variable names (capitals, digits and underscores)`];
    return [];
  }
  if (spec.value === 'one') {
    if (kind === 'level') return (CONDITION_LEVELS as readonly unknown[]).includes(o.level) ? [] : [`is ${spec.words} whose level is not ${CONDITION_LEVELS.join(' or ')}`];
    if (kind === 'hours') {
      const out = typeof o.open === 'boolean' ? [] : [`is ${spec.words} whose open is not true or false`];
      if (o.schedule !== undefined && (typeof o.schedule !== 'string' || o.schedule === '')) out.push(`is ${spec.words} whose schedule is not a name`);
      return out;
    }
    return typeof o.predicate === 'string' && o.predicate !== '' ? [] : [`is ${spec.words} whose predicate is not a name`];
  }
  const out: string[] = [];
  if (typeof o.key !== 'string' || o.key === '') out.push(`is ${spec.words} with no key`);
  const test = o.test;
  if (typeof test !== 'object' || test === null || Array.isArray(test)) return [...out, `is ${spec.words} with no test ({ is }, { in }, { notIn } or { present })`];
  const t = test as Record<string, unknown>;
  const named = VALUE_TESTS.filter((n) => t[n] !== undefined);
  if (named.length !== 1) return [...out, `is ${spec.words} whose test has ${named.length === 0 ? 'none' : named.join(' and ')} of is, in, notIn and present, and takes exactly one`];
  const n = named[0]!;
  if (n === 'is' && !isScalar(t.is)) out.push(`is ${spec.words} whose test's is is not one value`);
  if ((n === 'in' || n === 'notIn') && !(Array.isArray(t[n]) && (t[n] as unknown[]).length > 0 && (t[n] as unknown[]).every(isScalar))) out.push(`is ${spec.words} whose test's ${n} is not a list of one or more values`);
  if (n === 'present' && typeof t.present !== 'boolean') out.push(`is ${spec.words} whose test's present is not true or false`);
  return out;
}

/** The engine's shape of a condition, written as a fix names it. */
export const CONDITION_SHAPES = "{ kind: 'reason', reasons: [...] }, { kind: 'form', forms: [...] }, { kind: 'callData' | 'fact' | 'slot', key, test: { is } | { in } | { notIn } | { present } }, { kind: 'level', level: 1 | 2 }, { kind: 'hours', open, schedule? }, { kind: 'called', variables: [...] } or { kind: 'named', predicate }";

/** What the app has that a condition may name, for checking one (`pnpm check`, validateApp). */
export interface ConditionWorld {
  readonly forms: readonly FormId[];
  readonly slots: readonly SlotId[];
  /** The call data keys (App.callData). */
  readonly callData?: Readonly<Record<string, unknown>>;
  /** The facts' names the app declares (FactsConfig.initial's keys); null or absent: not declared, so a fact is not checked. */
  readonly facts?: readonly string[] | null;
  /** Whether the app has hours (app.yaml's `hours`), and its named schedules. */
  readonly hours?: { readonly schedules: readonly string[] } | null;
  /** The app's predicates (App.predicates); null or absent: not known (a folder checked without its code), so a name is not checked. */
  readonly predicates?: readonly string[] | null;
  /** Whether the app keeps the number called (app.yaml's callerNumber `called: true`). */
  readonly calledKept?: boolean;
  /** The highest identity level the app's callers can reach (0 with no identity, 1, or 2 with a one-time code); absent, not checked. */
  readonly maxLevel?: number;
  /** Whether a handoff for `reason` has its line (handoff_<reason>); absent, not asked. */
  readonly hasReasonLine?: (reason: string) => boolean;
  /** Where the condition is judged: a handoff (a transfer target, where a reason is known), or a route's point. */
  readonly at: 'handoff' | 'start' | 'afterIdentity' | 'afterForm';
}

/** One thing a condition names that the app does not have, at its path within the condition (its YAML key). */
export interface ConditionRefProblem {
  readonly key: string;
  readonly message: string;
  readonly fix: string;
  readonly warning?: true;
  /** A slot named that is not one of the app's, so a folder's check can give its own fix. */
  readonly unknownSlot?: string;
}

/**
 * What a condition (well-shaped: conditionProblems has none) names that the app does not have, or that
 * can never hold where it is judged: a form, a call data key, a slot, a schedule, a predicate that is not
 * the app's; hours with none; the number called where the app does not keep it; a reason anywhere but a
 * handoff; a form at call start. As warnings: a fact the app does not declare (where it declares them:
 * a hook may add one), and a reason no handoff has a line for.
 */
export function conditionRefProblems(c: Condition, world: ConditionWorld): ConditionRefProblem[] {
  const out: ConditionRefProblem[] = [];
  switch (c.kind) {
    case 'reason':
      if (world.at !== 'handoff') {
        out.push({ key: 'reason', message: 'a reason condition holds only where a handoff is being chosen (a transfer target), and never in a route', fix: 'delete it; a route decides before any handoff' });
      } else if (world.hasReasonLine !== undefined) {
        for (const reason of c.reasons) {
          if (!world.hasReasonLine(reason)) out.push({ key: 'reason', message: `no handoff has the reason "${reason}" (prompts.yaml has no handoff_${reason.replace(/-/g, '_')}), so this condition never holds`, fix: `name a reason the app hands off for, or add its line handoff_${reason.replace(/-/g, '_')}`, warning: true });
        }
      }
      break;
    case 'form':
      if (world.at === 'start') out.push({ key: 'form', message: 'a form condition never holds at start: no form has been opened or completed yet', fix: 'delete it, or move the rule to afterIdentity or afterForm' });
      for (const form of c.forms) if (!world.forms.includes(form)) out.push({ key: 'form', message: `form "${form}" is not defined`, fix: `name one of ${world.forms.join(', ')}` });
      break;
    case 'callData': {
      const keys = world.callData ?? {};
      if (!Object.hasOwn(keys, c.key)) out.push({ key: 'callData', message: `callData key "${c.key}" is not defined`, fix: `add "${c.key}" under callData in app.yaml, or name one of ${Object.keys(keys).join(', ') || 'its keys'}` });
      break;
    }
    case 'fact': {
      const declared = world.facts;
      const head = c.key.split('.')[0]!;
      if (declared !== undefined && declared !== null && declared.length > 0 && !declared.includes(head)) {
        out.push({ key: 'fact', message: `the facts' initial value has no "${head}", so this fact is set only if the app's code adds it`, fix: `name one of ${declared.join(', ')}, or add "${head}" to facts.initial() in the code`, warning: true });
      }
      break;
    }
    case 'slot':
      if (!world.slots.includes(c.key)) out.push({ key: 'slot', message: `slot "${c.key}" is not defined`, fix: 'name one of the app\'s slots', unknownSlot: c.key });
      // The start routes run before anything is asked or proposed (the caller-ID question, a proposal at
      // the greeting and the consent to text all come after them), so no slot holds a value yet.
      else if (world.at === 'start') out.push({ key: 'slot', message: `no slot holds a value at start, before anything is asked, so this condition holds only as present: false`, fix: 'move the rule to afterIdentity or afterForm, or read what the start hook or the call data says', warning: true });
      break;
    case 'level':
      if (world.maxLevel !== undefined && c.level > world.maxLevel) out.push({ key: 'level', message: `no caller reaches level ${c.level}: the app's identity ${world.maxLevel === 0 ? 'is not there (identity.yaml)' : `stops at level ${world.maxLevel}`}, so this condition never holds`, fix: world.maxLevel === 0 ? 'add identity.yaml, or delete the condition' : `use level ${world.maxLevel} or below, or add the level to identity.yaml`, warning: true });
      break;
    case 'hours':
      if (world.hours === undefined || world.hours === null) out.push({ key: 'hours', message: 'app.yaml has no hours, so this condition never holds', fix: 'add hours to app.yaml: { timezone, weekly: { mon-fri: ["08:00-18:00"] }, closed: [dates] }' });
      else if (c.schedule !== undefined && !world.hours.schedules.includes(c.schedule)) out.push({ key: 'schedule', message: `schedule "${c.schedule}" is not one of app.yaml's hours.schedules`, fix: world.hours.schedules.length > 0 ? `name one of ${world.hours.schedules.join(', ')}` : `add it under hours.schedules in app.yaml, or delete "schedule" for the default hours` });
      break;
    case 'called':
      if (world.calledKept !== true) out.push({ key: 'called', message: 'the app does not keep the number called, so this condition never holds', fix: 'add callerNumber: { use: hint, called: true } to app.yaml' });
      break;
    case 'named':
      if (world.predicates !== undefined && world.predicates !== null && !world.predicates.includes(c.predicate)) {
        out.push({ key: 'named', message: `the code has no predicate "${c.predicate}"`, fix: world.predicates.length > 0 ? `name one of ${world.predicates.join(', ')}, or add "${c.predicate}" to the code's predicates` : `add predicates: { ${c.predicate}: ({ s }) => ... } to the code` });
      }
      break;
  }
  return out;
}
