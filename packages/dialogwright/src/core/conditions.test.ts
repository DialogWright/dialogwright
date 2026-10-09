import { describe, expect, it } from 'vitest';
import { allHold, alwaysHolds, conditionFrom, conditionHolds, conditionProblems, CONDITION_KINDS, describeWhen, sameNumber, subjectsOf, valueHolds, whenFrom, yamlConditionIssues, type Condition } from './conditions';
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
    expect(conditionProblems({ kind: 'weather' })).toEqual(['has kind "weather", which is not one of reason, form, callData, fact, slot, level, hours, called, named']);
    expect(Object.keys(CONDITION_KINDS)).toEqual(['reason', 'form', 'callData', 'fact', 'slot', 'level', 'hours', 'called', 'named']);
  });

  it('a point with no call data reads every key as absent: present: false holds, every other test fails', () => {
    expect(conditionHolds({ kind: 'callData', key: 'tier', test: { present: false } }, {})).toBe(true);
    expect(conditionHolds({ kind: 'callData', key: 'tier', test: { notIn: ['basic'] } }, {})).toBe(false);
  });
});

describe('the subjects routes add (design 2026-10-09-routes, decision 4)', () => {
  it('fact: a value in the facts, by a dotted path; null is absent, a list or a record is present and equals nothing', () => {
    const facts = { pastDue: true, tier: 'gold', account: { balance: 12, notes: ['a'] }, gone: null };
    const fact = (key: string, test: Record<string, unknown>) => conditionHolds({ kind: 'fact', key, test } as Condition, { facts });
    expect(fact('pastDue', { is: true })).toBe(true);
    expect(fact('pastDue', { is: 'true' })).toBe(true);
    expect(fact('tier', { in: ['gold', 'vip'] })).toBe(true);
    expect(fact('account.balance', { is: 12 })).toBe(true);
    expect(fact('account.notes', { present: true })).toBe(true);
    expect(fact('account.notes', { is: 'a' })).toBe(false);
    expect(fact('account', { notIn: ['x'] })).toBe(false);
    expect(fact('gone', { present: false })).toBe(true);
    expect(fact('missing.deeper', { present: false })).toBe(true);
    expect(fact('tier.length', { present: true })).toBe(false);
    expect(fact('toString', { present: true })).toBe(false);
    expect(conditionHolds({ kind: 'fact', key: 'pastDue', test: { is: true } }, {})).toBe(false);
  });

  it('slot: the value held, an empty slot absent', () => {
    const slots = { severity: 'danger', note: null };
    expect(conditionHolds({ kind: 'slot', key: 'severity', test: { is: 'danger' } }, { slots })).toBe(true);
    expect(conditionHolds({ kind: 'slot', key: 'note', test: { present: false } }, { slots })).toBe(true);
    expect(conditionHolds({ kind: 'slot', key: 'note', test: { notIn: ['x'] } }, { slots })).toBe(false);
  });

  it('level: at least the level named, never with no level known', () => {
    expect(conditionHolds({ kind: 'level', level: 1 }, { level: 2 })).toBe(true);
    expect(conditionHolds({ kind: 'level', level: 2 }, { level: 1 })).toBe(false);
    expect(conditionHolds({ kind: 'level', level: 1 }, { level: 0 })).toBe(false);
    expect(conditionHolds({ kind: 'level', level: 1 }, {})).toBe(false);
  });

  it('hours: open or closed as the hours say, a named schedule\'s, neither with no clock or no such hours', () => {
    const hoursOpen = (s: string | undefined): boolean | null => (s === undefined ? false : s === 'billing' ? true : null);
    expect(conditionHolds({ kind: 'hours', open: false }, { hoursOpen })).toBe(true);
    expect(conditionHolds({ kind: 'hours', open: true }, { hoursOpen })).toBe(false);
    expect(conditionHolds({ kind: 'hours', open: true, schedule: 'billing' }, { hoursOpen })).toBe(true);
    expect(conditionHolds({ kind: 'hours', open: false, schedule: 'other' }, { hoursOpen })).toBe(false);
    expect(conditionHolds({ kind: 'hours', open: true, schedule: 'other' }, { hoursOpen })).toBe(false);
    expect(conditionHolds({ kind: 'hours', open: false }, {})).toBe(false);
  });

  it('called: the number called is a variable\'s value, by its digits; never with an unset variable or no number', () => {
    const env = (name: string): string | undefined => ({ SPANISH_LINE: '+15555550188', BLANK: ' ' } as Record<string, string>)[name];
    const c: Condition = { kind: 'called', variables: ['MAIN_LINE', 'SPANISH_LINE'] };
    expect(conditionHolds(c, { calledNumber: '+15555550188', env })).toBe(true);
    expect(conditionHolds(c, { calledNumber: '5555550188', env })).toBe(true);
    expect(conditionHolds(c, { calledNumber: '+15555550100', env })).toBe(false);
    expect(conditionHolds(c, { env })).toBe(false);
    expect(conditionHolds(c, { calledNumber: '+15555550188' })).toBe(false);
    expect(conditionHolds({ kind: 'called', variables: ['BLANK'] }, { calledNumber: '+15555550188', env })).toBe(false);
    expect(sameNumber('+44 20 5555 0100', '+442055550100')).toBe(true);
    expect(sameNumber('555-0100', '+15555550100')).toBe(false);
  });

  it('named: the app\'s predicate, false where there is none', () => {
    expect(conditionHolds({ kind: 'named', predicate: 'vip' }, { predicate: (n) => n === 'vip' })).toBe(true);
    expect(conditionHolds({ kind: 'named', predicate: 'other' }, { predicate: (n) => n === 'vip' })).toBe(false);
    expect(conditionHolds({ kind: 'named', predicate: 'vip' }, {})).toBe(false);
  });

  it('reads each from YAML, says it in words, and names its subjects (never a value)', () => {
    const when = whenFrom([
      { fact: 'account.pastDue', is: true }, { slot: 'severity', in: ['danger'] }, { level: 1 },
      { hours: 'closed', schedule: 'billing' }, { hours: 'open' }, { called: ['env.MAIN_LINE', 'env.SPANISH_LINE'] }, { named: 'vip' },
    ]);
    expect(when).toEqual([
      { kind: 'fact', key: 'account.pastDue', test: { is: true } },
      { kind: 'slot', key: 'severity', test: { in: ['danger'] } },
      { kind: 'level', level: 1 },
      { kind: 'hours', open: false, schedule: 'billing' },
      { kind: 'hours', open: true },
      { kind: 'called', variables: ['MAIN_LINE', 'SPANISH_LINE'] },
      { kind: 'named', predicate: 'vip' },
    ]);
    expect(describeWhen(when)).toBe('fact account.pastDue is true and slot severity is danger and the caller is verified to level 1 and the billing hours are closed and the hours are open and the number called is MAIN_LINE or SPANISH_LINE and vip holds (in code)');
    expect(subjectsOf(when)).toEqual(['fact.account.pastDue', 'slot.severity', 'level', 'hours.billing', 'hours', 'called', 'named.vip']);
    for (const c of when) expect(conditionProblems(c), JSON.stringify(c)).toEqual([]);
  });

  it('the engine\'s shape of each, checked', () => {
    expect(conditionProblems({ kind: 'level', level: 3 })).toEqual(['is a level condition whose level is not 1 or 2']);
    expect(conditionProblems({ kind: 'hours', open: 'yes' })).toEqual(['is an hours condition whose open is not true or false']);
    expect(conditionProblems({ kind: 'called', variables: ['env.MAIN'] })).toEqual(['is a called condition whose variables are not all environment variable names (capitals, digits and underscores)']);
    expect(conditionProblems({ kind: 'named' })).toEqual(['is a named condition whose predicate is not a name']);
    expect(conditionProblems({ kind: 'fact', key: 'x', test: {} })).toEqual(['is a fact condition whose test has none of is, in, notIn and present, and takes exactly one']);
  });

  it('YAML: a test on a subject with one value, and schedule on anything but hours, refused', () => {
    const messages = (raw: unknown) => yamlConditionIssues(raw).map((i) => `${i.path.join('.')}: ${i.message}`);
    expect(messages({ level: 1, is: 2 })).toEqual(['is: level takes no is: it names its one value itself']);
    expect(messages({ fact: 'x', schedule: 'billing', is: 1 })).toEqual(['schedule: fact takes no schedule: only hours does']);
    expect(messages({ slot: 'x' })).toEqual([': slot needs a test beside it']);
    expect(messages({ hours: 'open', schedule: 'billing' })).toEqual([]);
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
      { fact: 'pastDue', is: true },
      { fact: 'account.tier', in: ['gold'] },
      { slot: 'severity', is: 'danger' },
      { level: 1 },
      { hours: 'closed' },
      { hours: 'open', schedule: 'billing' },
      { called: 'env.MAIN_LINE' },
      { called: ['env.MAIN_LINE', 'env.SPANISH_LINE'] },
      { named: 'vip' },
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
    expect(messages(conditionSchema.safeParse({ level: 3 }))).toEqual(['level: must be 1 or 2']);
    expect(messages(conditionSchema.safeParse({ hours: 'shut' }))[0]).toMatch(/^hours: /);
    expect(messages(conditionSchema.safeParse({ called: '+15555550100' }))).toEqual(['called: is not an environment variable']);
    expect(messages(conditionSchema.safeParse({ fact: 'a..b', is: 1 }))[0]).toMatch(/^fact: is not a fact's name/);
    expect(messages(conditionSchema.safeParse({ named: 'vip', is: true }))).toEqual(['is: named takes no is: it names its one value itself']);
  });
});
