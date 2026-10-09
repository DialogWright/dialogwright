import { describe, expect, it } from 'vitest';
import { allHold, alwaysHolds, conditionFrom, conditionHolds, conditionProblems, CONDITION_KINDS, describeWhen, valueHolds, whenFrom, yamlConditionIssues, type Condition } from './conditions';
import { conditionSchema, whenSchema } from '../define/schema/condition';

/**
 * The conditions a declarative choice is made on (design 2026-10-09-call-data-and-transfers, 2b
 * decision 1): `reason`, `form` and `callData` now, one evaluator shared with routes.yaml later.
 */

const messages = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }): string[] =>
  r.success ? [] : r.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`);

describe('value tests', () => {
  it('is, in and notIn compare a value that is there, by the scalar\'s spelling', () => {
    expect(valueHolds({ is: 'vip' }, 'vip')).toBe(true);
    expect(valueHolds({ is: 'vip' }, 'VIP')).toBe(false);
    expect(valueHolds({ is: 1 }, '1')).toBe(true);
    expect(valueHolds({ is: true }, 'true')).toBe(true);
    expect(valueHolds({ in: ['gold', 'vip'] }, 'gold')).toBe(true);
    expect(valueHolds({ in: ['gold', 'vip'] }, 'basic')).toBe(false);
    expect(valueHolds({ notIn: ['basic'] }, 'gold')).toBe(true);
    expect(valueHolds({ notIn: ['basic'] }, 'basic')).toBe(false);
  });

  it('a value that is not there fails is, in and notIn, and holds only present: false', () => {
    expect(valueHolds({ is: 'vip' }, undefined)).toBe(false);
    expect(valueHolds({ in: ['vip'] }, undefined)).toBe(false);
    expect(valueHolds({ notIn: ['basic'] }, undefined)).toBe(false);
    expect(valueHolds({ present: false }, undefined)).toBe(true);
    expect(valueHolds({ present: true }, undefined)).toBe(false);
    expect(valueHolds({ present: true }, 'x')).toBe(true);
  });
});

describe('conditions', () => {
  const vip: Condition = { kind: 'callData', key: 'queue', test: { is: 'vip' } };
  const billing: Condition = { kind: 'form', forms: ['billing_question', 'payment'] };
  const emergency: Condition = { kind: 'reason', reasons: ['emergency'] };

  it('each subject holds on its own fact, and never where the point has none', () => {
    expect(conditionHolds(vip, { callData: { queue: 'vip' } })).toBe(true);
    expect(conditionHolds(vip, {})).toBe(false);
    expect(conditionHolds(billing, { form: 'payment' })).toBe(true);
    expect(conditionHolds(billing, { form: null })).toBe(false);
    expect(conditionHolds(billing, {})).toBe(false);
    expect(conditionHolds(emergency, { reason: 'emergency' })).toBe(true);
    expect(conditionHolds(emergency, { reason: 'live-agent' })).toBe(false);
    expect(conditionHolds(emergency, {})).toBe(false);
  });

  it('a when holds when all its conditions do; an empty one always does', () => {
    expect(allHold([vip, billing], { callData: { queue: 'vip' }, form: 'payment' })).toBe(true);
    expect(allHold([vip, billing], { callData: { queue: 'vip' }, form: 'other' })).toBe(false);
    expect(allHold([], {})).toBe(true);
    expect(alwaysHolds([])).toBe(true);
    expect(alwaysHolds([vip])).toBe(false);
  });

  it('reads the YAML shapes into the engine\'s, a single condition or a list', () => {
    expect(conditionFrom({ callData: 'queue', is: 'vip' })).toEqual(vip);
    expect(conditionFrom({ form: ['billing_question', 'payment'] })).toEqual(billing);
    expect(conditionFrom({ reason: 'emergency' })).toEqual(emergency);
    expect(conditionFrom({ callData: 'tier', notIn: ['basic'] })).toEqual({ kind: 'callData', key: 'tier', test: { notIn: ['basic'] } });
    expect(conditionFrom({ callData: 'tier', present: false })).toEqual({ kind: 'callData', key: 'tier', test: { present: false } });
    expect(whenFrom({ reason: 'emergency' })).toEqual([emergency]);
    expect(whenFrom([{ reason: 'emergency' }, { form: ['billing_question', 'payment'] }])).toEqual([emergency, billing]);
    expect(whenFrom(undefined)).toEqual([]);
  });

  it('says them in words', () => {
    expect(describeWhen([vip, billing])).toBe('callData queue is vip and the form is billing_question or payment');
    expect(describeWhen([{ kind: 'callData', key: 'tier', test: { notIn: ['basic'] } }])).toBe('callData tier is not basic');
    expect(describeWhen([{ kind: 'callData', key: 'tier', test: { present: true } }])).toBe('callData tier is present');
    expect(describeWhen([])).toBe('always');
  });

  it('YAML: refuses a condition with no subject, two subjects, a missing or extra test, or a test on a subject that takes none', () => {
    const messages = (raw: unknown) => yamlConditionIssues(raw).map((i) => `${i.path.join('.')}: ${i.message}`);
    expect(messages({})).toEqual([': names no subject']);
    expect(messages({ reason: 'x', form: 'y' })).toEqual([': names reason and form, and a condition has one subject']);
    expect(messages({ callData: 'queue' })).toEqual([': callData needs a test beside it']);
    expect(messages({ callData: 'queue', is: 'a', in: ['b'] })).toEqual(['in: callData takes one test, and this has is and in']);
    expect(messages({ reason: 'x', is: 'y' })).toEqual(['is: reason takes no is: it lists its values itself']);
    expect(() => conditionFrom({ callData: 'queue' })).toThrow('callData needs a test beside it');
  });

  it('the engine\'s shape (an app built in code): a kind it has, its list or its key, and exactly one test, said in the engine\'s terms', () => {
    expect(conditionProblems({ kind: 'callData', key: 'tier', test: { notIn: ['basic'] } })).toEqual([]);
    expect(conditionProblems({ kind: 'reason', reasons: ['emergency'] })).toEqual([]);
    expect(conditionProblems({ kind: 'callData', key: 'tier', test: {} })).toEqual(['is a callData condition whose test has none of is, in, notIn and present, and takes exactly one']);
    expect(conditionProblems({ kind: 'callData', key: 'tier', test: { is: 'a', present: true } })).toEqual(['is a callData condition whose test has is and present of is, in, notIn and present, and takes exactly one']);
    expect(conditionProblems({ kind: 'callData', test: { in: [] } })).toEqual(['is a callData condition with no key', 'is a callData condition whose test\'s in is not a list of one or more values']);
    expect(conditionProblems({ kind: 'callData', key: 'tier' })).toEqual(['is a callData condition with no test ({ is }, { in }, { notIn } or { present })']);
    expect(conditionProblems({ kind: 'form', forms: [] })).toEqual(['is a form condition whose forms is not a list of one or more names']);
    expect(conditionProblems({ kind: 'reason', reason: 'x' })).toEqual(['is a reason condition whose reasons is not a list of one or more names']);
    expect(conditionProblems({ kind: 'hours' })).toEqual(['has kind "hours", which is not one of reason, form, callData']);
    expect(Object.keys(CONDITION_KINDS)).toEqual(['reason', 'form', 'callData']);
  });

  it('a point with no call data reads every key as absent: present: false holds, every other test fails', () => {
    expect(conditionHolds({ kind: 'callData', key: 'tier', test: { present: false } }, {})).toBe(true);
    expect(conditionHolds({ kind: 'callData', key: 'tier', test: { notIn: ['basic'] } }, {})).toBe(false);
  });
});

describe('the condition schema', () => {
  it('takes each shape the plan writes', () => {
    for (const value of [
      { callData: 'queue', is: 'vip' },
      { callData: 'queue', in: ['vip', 'gold'] },
      { callData: 'queue', notIn: ['basic'] },
      { callData: 'queue', present: true },
      { form: ['billing_question', 'payment'] },
      { form: 'payment' },
      { reason: ['emergency'] },
      { reason: 'live-agent' },
    ]) {
      expect(messages(conditionSchema.safeParse(value)), JSON.stringify(value)).toEqual([]);
      expect(messages(whenSchema.safeParse(value)), JSON.stringify(value)).toEqual([]);
    }
    expect(messages(whenSchema.safeParse([{ reason: 'emergency' }, { callData: 'queue', is: 'vip' }]))).toEqual([]);
  });

  it('refuses what is no condition, each with its own message', () => {
    expect(messages(conditionSchema.safeParse({}))).toEqual([': names no subject']);
    expect(messages(conditionSchema.safeParse({ reason: 'x', form: 'y' }))).toEqual([': names reason and form, and a condition has one subject']);
    expect(messages(conditionSchema.safeParse({ callData: 'queue' }))).toEqual([': callData needs a test beside it']);
    expect(messages(conditionSchema.safeParse({ callData: 'queue', is: 'a', present: true }))).toEqual(['present: callData takes one test, and this has is and present']);
    expect(messages(conditionSchema.safeParse({ form: 'x', in: ['y'] }))).toEqual(['in: form takes no in: it lists its values itself']);
    expect(conditionSchema.safeParse({ callData: 'queue', is: 'vip', hours: 'open' }).success).toBe(false);
    expect(whenSchema.safeParse([]).success).toBe(false);
  });
});
