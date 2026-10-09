import { describe, expect, it } from 'vitest';
import { allHold, alwaysHolds, conditionFrom, conditionHolds, conditionProblems, describeWhen, valueHolds, whenFrom, type Condition } from './conditions';
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

  it('refuses a condition with no subject, two subjects, a missing or extra test, or a test on a subject that takes none', () => {
    expect(conditionProblems({})).toEqual(['names no subject: write one of reason, form, callData']);
    expect(conditionProblems({ reason: 'x', form: 'y' })[0]).toContain('one subject');
    expect(conditionProblems({ callData: 'queue' })).toEqual(['callData needs a test: is, in, notIn or present']);
    expect(conditionProblems({ callData: 'queue', is: 'a', in: ['b'] })).toEqual(['callData takes one test, and this has is and in']);
    expect(conditionProblems({ reason: 'x', is: 'y' })).toEqual(['reason takes no is: it names its values itself']);
    expect(conditionProblems({ callData: 'q', in: [] })).toEqual(['in must be a list of values']);
    expect(() => conditionFrom({ callData: 'queue' })).toThrow('callData needs a test');
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
