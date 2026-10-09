import type { FormId } from './app/types';

/**
 * Conditions: what an app's declarative choices are made on, one small fixed set, never an expression
 * language. A rule's `when` is a list of conditions, and it holds when every one of them holds (an empty
 * list always holds). Written once, here, for every place that chooses by condition: app.yaml's transfer
 * targets now (core/transfer.ts), and routes.yaml's points later, whose conditions (a fact, a slot, the
 * caller's identity level, business hours, the number called, a named predicate in code) are added as
 * kinds of this union, read by the same evaluator, with the same value tests.
 *
 * In YAML a condition names its subject by its key, with a value test beside it where the subject has
 * a value (define/schema/condition.ts reads it into this shape):
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

/** The subjects a condition may name, by the key YAML writes them under. */
export const CONDITION_SUBJECTS = ['reason', 'form', 'callData'] as const;
export type ConditionSubject = (typeof CONDITION_SUBJECTS)[number];

/** The subjects that take a value test beside them (`is`, `in`, `notIn`, `present`). */
export const TESTED_SUBJECTS: readonly ConditionSubject[] = ['callData'];

/**
 * What the conditions are judged against at the point a choice is made. A subject the point does not
 * have (absent here) holds no condition on it: a `reason` condition never holds where there is no
 * handoff reason.
 */
export interface ConditionFacts {
  readonly reason?: string;
  /** The form the condition reads (see `form` above); null when there is none. */
  readonly form?: FormId | null;
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
 * Whether a `when` holds whatever the call: an empty one, or one whose every condition does (a
 * `present` test on both sides of the same key never comes up alone, so only the empty list counts).
 * A rule after one that always holds is never reached (`pnpm check` warns).
 */
export function alwaysHolds(when: readonly Condition[]): boolean {
  return when.length === 0;
}

/**
 * A condition as YAML writes it (define/schema/condition.ts has held it to one subject and, for a
 * tested subject, one test) in the engine's shape. Throws on a shape the schema refuses, so an app
 * written in code meets the same rules (conditionProblems says what is wrong without throwing).
 */
export function conditionFrom(raw: Readonly<Record<string, unknown>>): Condition {
  const problem = conditionProblems(raw)[0];
  if (problem !== undefined) throw new Error(`condition ${JSON.stringify(raw)}: ${problem}`);
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

/**
 * What is wrong with a condition as written (YAML's shape), each as a sentence with no fix; empty when
 * it is one. Shared by the schema (which adds the fixes) and conditionFrom.
 */
export function conditionProblems(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return ['is not a condition: write { reason: ... }, { form: ... } or { callData: <key>, is: ... }'];
  const o = raw as Record<string, unknown>;
  const out: string[] = [];
  const subjects = CONDITION_SUBJECTS.filter((s) => o[s] !== undefined);
  const tests = VALUE_TESTS.filter((t) => o[t] !== undefined);
  const unknown = Object.keys(o).filter((k) => !(CONDITION_SUBJECTS as readonly string[]).includes(k) && !(VALUE_TESTS as readonly string[]).includes(k));
  for (const k of unknown) out.push(`"${k}" is not a subject or a test of a condition`);
  if (subjects.length === 0) out.push(`names no subject: write one of ${CONDITION_SUBJECTS.join(', ')}`);
  if (subjects.length > 1) out.push(`names ${subjects.join(' and ')}: a condition has one subject (write a list of conditions, which all hold)`);
  const subject = subjects[0];
  if (subject === undefined || subjects.length > 1) return out;
  const tested = TESTED_SUBJECTS.includes(subject);
  if (!tested && tests.length > 0) out.push(`${subject} takes no ${tests.join(' or ')}: it names its values itself`);
  if (tested && tests.length === 0) out.push(`${subject} needs a test: is, in, notIn or present`);
  if (tested && tests.length > 1) out.push(`${subject} takes one test, and this has ${tests.join(' and ')}`);
  const value = o[subject];
  if (subject === 'reason' || subject === 'form') {
    const list = Array.isArray(value) ? value : [value];
    if (list.length === 0) out.push(`${subject} lists nothing`);
    if (list.some((v) => typeof v !== 'string' || v === '')) out.push(`${subject} must be a name or a list of names`);
  } else if (typeof value !== 'string' || value === '') out.push(`${subject} must name a key`);
  if (o.is !== undefined && !isScalar(o.is)) out.push('is must be one value');
  for (const t of ['in', 'notIn'] as const) {
    if (o[t] !== undefined && (!Array.isArray(o[t]) || (o[t] as unknown[]).length === 0 || !(o[t] as unknown[]).every(isScalar))) out.push(`${t} must be a list of values`);
  }
  if (o.present !== undefined && typeof o.present !== 'boolean') out.push('present must be true or false');
  return out;
}
