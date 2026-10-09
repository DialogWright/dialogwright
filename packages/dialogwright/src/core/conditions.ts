import type { FormId } from './app/types';

/**
 * Conditions: what an app's declarative choices are made on, one small fixed set, never an expression
 * language. A rule's `when` is a list of conditions, and it holds when every one of them holds (an empty
 * list always holds). Written once, here, for every place that chooses by condition: app.yaml's transfer
 * targets now (core/transfer.ts), and routes.yaml's points later, whose conditions (a fact, a slot, the
 * caller's identity level, business hours, the number called, a named predicate in code) are added as
 * kinds: a row of CONDITION_KINDS (which owns the shape rules for YAML and for an app built in code
 * alike), a case of the Condition union, and a case in conditionHolds and describeCondition.
 *
 * In YAML a condition names its subject by its key, with a value test beside it where the subject has
 * a value (define/schema/condition.ts holds it to this, conditionFrom reads it into the engine's shape):
 * - `{ reason: emergency }` or `{ reason: [emergency, security] }`: the handoff's reason is one of these;
 * - `{ form: payment }` or `{ form: [billing_question, payment] }`: the form the caller is in (or, with
 *   none open, the last one completed on the call) is one of these;
 * - `{ callData: queue, is: vip }`, `in: [...]`, `notIn: [...]`, `present: true | false`: a key of the
 *   call data (callDataOf). A key the call came without fails `is`, `in` and `notIn` alike (nothing is
 *   compared), and holds only `present: false`, so a rule never routes on a value that is not there.
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

/** One condition, discriminated on its subject (`kind`). */
export type Condition =
  | { readonly kind: 'reason'; readonly reasons: readonly string[] }
  | { readonly kind: 'form'; readonly forms: readonly FormId[] }
  | { readonly kind: 'callData'; readonly key: string; readonly test: ValueTest };

/**
 * Each kind of condition, by the key YAML names it with (which is its `kind`): the one place its shape is
 * said. `names`: YAML writes one name or a list, the engine keeps the list in `field`. `key`: YAML names
 * one key, the engine keeps it in `key`, beside one value test (`is`, `in`, `notIn` or `present`).
 * `words` is what the messages call it.
 */
export const CONDITION_KINDS = {
  reason: { value: 'names', field: 'reasons', words: 'a reason condition' },
  form: { value: 'names', field: 'forms', words: 'a form condition' },
  callData: { value: 'key', words: 'a callData condition' },
} as const satisfies Record<Condition['kind'], { value: 'names'; field: string; words: string } | { value: 'key'; words: string }>;

/** The subjects a condition may name, by the key YAML writes them under. */
export const CONDITION_SUBJECTS = Object.keys(CONDITION_KINDS) as readonly Condition['kind'][];
export type ConditionSubject = Condition['kind'];

/** The subjects that take a value test beside them (`is`, `in`, `notIn`, `present`). */
export const TESTED_SUBJECTS: readonly ConditionSubject[] = CONDITION_SUBJECTS.filter((k) => CONDITION_KINDS[k].value === 'key');

/**
 * What the conditions are judged against at the point a choice is made. A subject with one value per
 * point (the reason, the form) holds no condition where the point has none: a `reason` condition never
 * holds where there is no handoff reason, nor a `form` condition with no form. Call data is a set of
 * keys: a point that has none reads every key as absent, so `present: false` holds there and every
 * other test fails, as on a call that came with none.
 */
export interface ConditionFacts {
  readonly reason?: string;
  /** The form the condition reads (see `form` above); null when there is none. */
  readonly form?: FormId | null;
  /** The call data (callDataOf); absent, none: every key absent. */
  readonly callData?: Readonly<Record<string, string>>;
}

/** Whether `value` (absent when the subject has none) passes `test`. */
export function valueHolds(test: ValueTest, value: string | undefined): boolean {
  if ('present' in test) return test.present === (value !== undefined);
  if (value === undefined) return false;
  if ('is' in test) return String(test.is) === value;
  if ('in' in test) return test.in.some((v) => String(v) === value);
  return !test.notIn.some((v) => String(v) === value);
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
  }
}

/** Whether every condition of a `when` holds; an empty `when` always does. */
export function allHold(when: readonly Condition[], facts: ConditionFacts): boolean {
  return when.every((c) => conditionHolds(c, facts));
}

/** A value as the docs and the read-back pages write it. */
function shown(v: ConditionValue): string {
  return typeof v === 'string' ? v : String(v);
}

/** One condition in words, for the app map and messages ("callData queue is vip"). */
export function describeCondition(c: Condition): string {
  switch (c.kind) {
    case 'reason':
      return `the reason is ${c.reasons.join(' or ')}`;
    case 'form':
      return `the form is ${c.forms.join(' or ')}`;
    case 'callData': {
      const t = c.test;
      if ('present' in t) return `callData ${c.key} is ${t.present ? 'present' : 'absent'}`;
      if ('is' in t) return `callData ${c.key} is ${shown(t.is)}`;
      if ('in' in t) return `callData ${c.key} is ${t.in.map(shown).join(' or ')}`;
      return `callData ${c.key} is not ${t.notIn.map(shown).join(' or ')}`;
    }
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

/**
 * What is wrong with the shape of a condition as YAML writes it, read from CONDITION_KINDS: no subject,
 * two, a test on a subject that takes none, none or two on one that takes one. The types of the values
 * are the schema's own fields (define/schema/condition.ts, whose check reports these).
 */
export function yamlConditionIssues(raw: unknown): ConditionIssue[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [{ path: [], message: 'is not a condition', fix: 'write { reason: ... }, { form: ... } or { callData: <key>, is: ... }' }];
  const o = raw as Record<string, unknown>;
  const subjects = CONDITION_SUBJECTS.filter((s) => o[s] !== undefined);
  const tests = VALUE_TESTS.filter((t) => o[t] !== undefined);
  if (subjects.length === 0) return [{ path: [], message: 'names no subject', fix: `write one of ${CONDITION_SUBJECTS.join(', ')} (for example { reason: emergency }, or { callData: queue, is: vip })` }];
  if (subjects.length > 1) return [{ path: [], message: `names ${subjects.join(' and ')}, and a condition has one subject`, fix: `write a list of conditions, which all hold: [${subjects.map((s) => `{ ${s}: ... }`).join(', ')}]` }];
  const subject = subjects[0]!;
  if (CONDITION_KINDS[subject].value === 'names') {
    return tests.map((t) => ({ path: [t], message: `${subject} takes no ${t}: it lists its values itself`, fix: `delete "${t}", and write the values as ${subject}: [a, b]` }));
  }
  if (tests.length === 0) return [{ path: [], message: `${subject} needs a test beside it`, fix: 'add one of is: <value>, in: [values], notIn: [values] or present: true' }];
  if (tests.length > 1) return [{ path: [tests[1]!], message: `${subject} takes one test, and this has ${tests.join(' and ')}`, fix: 'keep one; for two tests write a list of conditions, which all hold' }];
  return [];
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

/**
 * What is wrong with a condition in the engine's shape (Condition: an app built in code, or anything
 * validateApp is handed), each a sentence in the engine's terms; empty when it is one. Read from
 * CONDITION_KINDS, so a new kind is checked by its row.
 */
export function conditionProblems(c: unknown): string[] {
  if (typeof c !== 'object' || c === null || Array.isArray(c)) return ['is not a condition object ({ kind, ... })'];
  const o = c as Record<string, unknown>;
  if (typeof o.kind !== 'string' || !Object.hasOwn(CONDITION_KINDS, o.kind)) return [`has kind ${JSON.stringify(o.kind)}, which is not one of ${CONDITION_SUBJECTS.join(', ')}`];
  const spec = CONDITION_KINDS[o.kind as Condition['kind']];
  if (spec.value === 'names') {
    return isNameList(o[spec.field]) ? [] : [`is ${spec.words} whose ${spec.field} is not a list of one or more names`];
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
