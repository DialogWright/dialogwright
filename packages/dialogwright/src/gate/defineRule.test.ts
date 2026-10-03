import { describe, expect, it } from 'vitest';
import { validateApp } from '../core/app/validate';
import { AppDefinitionError, defineApp, type AppCode } from '../define/defineApp';
import { definePolicy } from '../define/definePolicy';
import { libraryCode, LIBRARY_DIR } from '../define/fixture/app';
import { formatProblem } from '../define/problems';
import { useTestkit } from '../testing/apps';
import { testkitApp } from '../testing/testkit';
import { TESTKIT_CUSTOM_RULES } from '../testing/testkit/domain/policy';
import { compileGate, type PolicySource } from './compiled';
import { defineRule, isDefinedRule, ruleDefinitionProblems, type RuleDefinition, type RuleExample } from './defineRule';
import type { GateFacts, GateLookups, Party, RuleContext } from './types';

/**
 * defineRule: an app's own rule with the examples that say what it does. The rule it makes is the
 * function the gate runs, recorded under its id with its description; `check` (definePolicy,
 * defineApp) refuses a custom rule that is a plain function or whose examples do not include a call
 * the gate allows and one it refuses; validateApp holds a defined rule to the same and still runs a
 * plain function in an App built by hand.
 */

useTestkit();

const ALEX: Party = { kind: 'customer', level: 2, id: '55501234', first: 'Alex' };
const facts: GateFacts = { attempts: 0, confirmedHash: null, todayIso: '2026-09-18' };
const lookups: GateLookups = { ownerOf: () => null, scopeOf: () => [] };

const ALLOWS: RuleExample = { name: 'an even number', call: { params: { n: '2' } }, principal: ALEX, expect: { verdict: 'ALLOW' } };
const REFUSES: RuleExample = { name: 'an odd number', call: { params: { n: '3' } }, principal: ALEX, expect: { verdict: 'BLOCK', reason: 'odd' } };
const EVEN: RuleDefinition = {
  id: 'even',
  description: 'The number is even',
  run: (c) => (Number(c.call.params.n) % 2 === 0 ? { pass: true, compared: 'even' } : { pass: false, compared: 'odd', verdict: 'BLOCK', reason: 'odd' }),
  examples: [ALLOWS, REFUSES],
};

/** A gate whose one action runs only `rule`. */
function gateWith(rule: (c: RuleContext) => unknown): PolicySource {
  return { actions: { act: { level: 0, rules: [{ rule: 'custom', id: 'even' }] } }, purposes: {}, maxAttempts: 3, customRules: { even: rule as never } };
}
const decide = (rule: (c: RuleContext) => unknown, n: string) => {
  const source = gateWith(rule);
  return compileGate(source, { toolLevel: {}, purposeLevel: {}, rulesFor: {}, serviceFields: {}, confirmedFields: [], maxAttempts: 3, subjects: {} }, 'customer')
    .evaluate({ tool: 'act', params: { n } }, ALEX, facts, lookups);
};

describe('defineRule', () => {
  it('makes the function the gate runs, recording its line under its id with its description', () => {
    const rule = defineRule(EVEN);
    expect(isDefinedRule(rule)).toBe(true);
    expect(isDefinedRule(EVEN.run)).toBe(false);
    expect([rule.id, rule.description, rule.examples]).toEqual(['even', 'The number is even', [ALLOWS, REFUSES]]);
    expect(decide(rule, '2')).toEqual({ call: { tool: 'act', params: { n: '2' } }, verdict: 'ALLOW', rules: [{ id: 'even', description: 'The number is even', compared: 'even', pass: true }] });
    expect(decide(rule, '3')).toMatchObject({ verdict: 'BLOCK', reason: 'odd', rules: [{ id: 'even', description: 'The number is even', compared: 'odd', pass: false }] });
  });

  it('a run that answers what the gate cannot take BLOCKs, and one that throws BLOCKs', () => {
    const answers = [null, { pass: false, compared: 'no verdict' }, { pass: 'yes', compared: 'x' }, { pass: true }, { pass: false, compared: 'x', verdict: 'ALLOW' }];
    for (const answer of answers) {
      const rule = defineRule({ ...EVEN, run: () => answer as never });
      expect(decide(rule, '2')).toMatchObject({ verdict: 'BLOCK', reason: 'rule-invalid' });
    }
    const thrower = defineRule({ ...EVEN, run: () => { throw new Error('down'); } });
    expect(decide(thrower, '2')).toMatchObject({ verdict: 'BLOCK', reason: 'rule-error' });
  });

  it('the testkit\'s R8 answers as the plain function it replaced did, line for line', () => {
    const R8 = TESTKIT_CUSTOM_RULES.R8!;
    const call = (expectedDate: string) => ({ tool: 'createReport', params: { accountId: ALEX.id, missingNote: 'a box', expectedDate } });
    const lk = testkitApp.systems().lookups;
    const description = 'No parcel of the customer\'s was delivered on the day it was due';
    const ctx = (expectedDate: string, l: GateLookups = lk): RuleContext => ({ call: call(expectedDate), p: ALEX, facts, lk: l, policy: testkitApp.policy, subjectKind: 'customer' });
    expect(R8(ctx('2026-09-21'))).toEqual({ result: { id: 'R8', description, compared: 'due 2026-09-21: nothing delivered that day', pass: true } });
    expect(R8(ctx('2026-09-16'))).toEqual({ result: { id: 'R8', description, compared: 'due 2026-09-16: a parcel delivered that day', pass: false }, fail: { verdict: 'NEEDS_HUMAN', reason: 'delivered' } });
    expect(R8(ctx('soon'))).toEqual({ result: { id: 'R8', description, compared: 'due soon not checkable', pass: false }, fail: { verdict: 'BLOCK', reason: 'unchecked' } });
    expect(R8(ctx('', lookups))).toEqual({ result: { id: 'R8', description, compared: 'due (none) not checkable', pass: false }, fail: { verdict: 'BLOCK', reason: 'unchecked' } });
  });
});

describe('what check says about a custom rule', () => {
  const at = 'code.customRules.even';
  const problems = (rule: unknown): string[] => ruleDefinitionProblems('even', rule, at).map((p) => `${p.message} -> ${p.fix}`);

  it('a rule with an example the gate allows and one it refuses has no problem', () => {
    expect(problems(defineRule(EVEN))).toEqual([]);
  });

  it('a plain function: define it with defineRule', () => {
    expect(problems(EVEN.run)).toEqual([
      'custom rule "even" is a plain function, with no examples of what it allows and refuses -> define code.customRules.even with defineRule({ id: \'even\', description, run, examples }) from "dialogwright/policy", with an example call the gate allows and one it refuses',
    ]);
  });

  it('no example the gate allows, none it refuses, or none at all', () => {
    expect(problems(defineRule({ ...EVEN, examples: [REFUSES] }))).toEqual([
      'custom rule "even" has no example the gate allows -> add to code.customRules.even\'s examples a call the rule lets through, with expect: { verdict: \'ALLOW\' }',
    ]);
    expect(problems(defineRule({ ...EVEN, examples: [ALLOWS] }))).toEqual([
      'custom rule "even" has no example the gate refuses -> add to code.customRules.even\'s examples a call the rule stops, with expect: { verdict: \'BLOCK\' } (or NEEDS_HUMAN, STEP_UP) and its reason',
    ]);
    expect(problems(defineRule({ ...EVEN, examples: [] }))).toHaveLength(2);
  });

  it('a rule under another id, with no description, or with examples that are not examples', () => {
    const bad = [
      { ...ALLOWS, name: '' },
      { ...REFUSES },
      { ...REFUSES },
      { name: 'no params', call: {}, principal: ALEX, expect: { verdict: 'BLOCK' } },
      { name: 'no one', call: { params: {} }, principal: { kind: 'customer', level: 2, id: '' }, expect: { verdict: 'BLOCK' } },
      { name: 'a reason to allow', call: { params: {} }, principal: ALEX, expect: { verdict: 'ALLOW', reason: 'fine' } },
      { name: 'no verdict', call: { params: {} }, principal: ALEX, expect: { verdict: 'MAYBE' } },
    ] as unknown as RuleExample[];
    expect(problems(defineRule({ ...EVEN, id: 'odd', description: ' ', examples: bad }))).toEqual([
      'custom rule "even" is defined with the id "odd" -> give code.customRules.even the id "even", or register it under "odd" and name that in policy.yaml\'s custom: rules',
      'custom rule "even" has no description -> say in code.customRules.even\'s description, in plain English, what the rule holds',
      'custom rule "even"\'s example 1 has no name -> name it in a few words, in code.customRules.even\'s examples[0]',
      'custom rule "even"\'s example "an odd number" has the name of another example -> give each example its own name, in code.customRules.even\'s examples[2]',
      'custom rule "even"\'s example "no params" has no call params, or a param that is not a string -> write call: { params: { <param>: \'<value>\' } }, in code.customRules.even\'s examples[3]',
      'custom rule "even"\'s example "no one" has no principal -> give the principal who makes the call (an anonymous caller, or a party the app\'s verifier or sign-in would make), in code.customRules.even\'s examples[4]',
      'custom rule "even"\'s example "a reason to allow" expects a reason with ALLOW, or a reason that is not a string -> give a reason only for a refusal, in code.customRules.even\'s examples[5]',
      'custom rule "even"\'s example "no verdict" expects no verdict -> write expect: { verdict: \'ALLOW\' } or a refusal (BLOCK, STEP_UP, NEEDS_HUMAN) with its reason, in code.customRules.even\'s examples[6]',
    ]);
  });

  it('definePolicy refuses a plain function, and one without a refusal, at the rule in the code', () => {
    const file = { actions: { act: { level: 0, rules: [{ custom: 'even' }] } } };
    const thrown = (customRules: Record<string, never>): string[] => {
      try {
        definePolicy(file, { tools: { act: {} }, customRules });
      } catch (error) {
        if (error instanceof AppDefinitionError) return error.problems.map((p) => `${p.path}: ${p.message}`);
        throw error;
      }
      return [];
    };
    expect(thrown({ even: EVEN.run as never })).toEqual(['code.customRules.even: custom rule "even" is a plain function, with no examples of what it allows and refuses']);
    expect(thrown({ even: defineRule({ ...EVEN, examples: [ALLOWS] }) as never })).toEqual(['code.customRules.even: custom rule "even" has no example the gate refuses']);
    expect(thrown({ even: defineRule(EVEN) as never })).toEqual([]);
  });

  it('check (defineApp) refuses the library\'s rule as a plain function, pointing at defineRule', () => {
    const plain = (c: RuleContext) => libraryCode.customRules!['known-branch']!(c);
    const code: AppCode = { ...libraryCode, customRules: { 'known-branch': plain } };
    let lines: string[] = [];
    try {
      defineApp(LIBRARY_DIR, code);
    } catch (error) {
      if (!(error instanceof AppDefinitionError)) throw error;
      lines = error.problems.map(formatProblem);
    }
    expect(lines).toEqual([
      'app.ts  code.customRules["known-branch"]  custom rule "known-branch" is a plain function, with no examples of what it allows and refuses  ->  define app.ts (code.customRules["known-branch"]) with defineRule({ id: \'known-branch\', description, run, examples }) from "dialogwright/policy", with an example call the gate allows and one it refuses',
    ]);
  });
});

describe('validateApp', () => {
  it('still runs a plain function in an App built by hand, and holds a defined rule to its examples', () => {
    const plain = { ...testkitApp, policy: { ...testkitApp.policy, customRules: { R8: (c: RuleContext) => TESTKIT_CUSTOM_RULES.R8!(c) } } };
    expect(() => validateApp(plain)).not.toThrow();
    const R8 = TESTKIT_CUSTOM_RULES.R8 as ReturnType<typeof defineRule>;
    const noRefusal = defineRule({ id: 'R8', description: R8.description, run: () => ({ pass: true, compared: 'x' }), examples: [R8.examples[0]!] });
    expect(() => validateApp({ ...testkitApp, policy: { ...testkitApp.policy, customRules: { R8: noRefusal } } }))
      .toThrow('app "testkit": policy\'s custom rule "R8" has no example the gate refuses');
  });
});
