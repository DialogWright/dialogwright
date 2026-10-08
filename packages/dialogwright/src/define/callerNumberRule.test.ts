import { describe, expect, it } from 'vitest';
import { sourceOf } from '../gate/compiled';
import { AppDefinitionError } from './defineApp';
import { definePolicy } from './definePolicy';
import type { Problem } from './problems';

/**
 * The callerNumber rule from the file's side: policy.yaml's `callerNumber: { field, else }`, checked
 * (its shape, the param it reads, the confirmed rule `else: confirmed` needs) and compiled to the gate
 * with its parameters.
 */

const problemsOf = (build: () => unknown): string[] => {
  try {
    build();
  } catch (error) {
    if (!(error instanceof AppDefinitionError)) throw error;
    return error.problems.map((p: Problem) => `${p.path}: ${p.message} -> ${p.fix}`);
  }
  return [];
};

const TOOLS = { sendUpdates: { params: ['topic', 'textTo'] } };
const send = (rules: unknown[]) => ({ actions: { sendUpdates: { level: 0, rules } }, audit: { topic: 'keep', textTo: 'last4' } });
const policyWith = (rules: unknown[]): string[] => problemsOf(() => definePolicy(send(rules), { tools: TOOLS }));

describe('policy.yaml: the callerNumber rule checked', () => {
  it('a valid rule compiles under its name, with its parameters; else defaults to refuse', () => {
    expect(policyWith([{ callerNumber: { field: 'textTo' } }])).toEqual([]);
    expect(sourceOf(definePolicy(send([{ callerNumber: { field: 'textTo' } }]), { tools: TOOLS }))?.actions.sendUpdates?.rules).toEqual([{ rule: 'callerNumber', field: 'textTo' }]);
    const rules = ['identity', { callerNumber: { field: 'textTo', else: 'confirmed' } }, { confirmed: ['topic', 'textTo'] }];
    expect(policyWith(rules)).toEqual([]);
    const tables = definePolicy(send(rules), { tools: TOOLS });
    expect(tables.rulesFor.sendUpdates).toEqual(['R1', 'callerNumber', 'R3']);
    expect(sourceOf(tables)?.actions.sendUpdates?.rules[1]).toEqual({ rule: 'callerNumber', field: 'textTo', else: 'confirmed' });
    expect(policyWith([{ callerNumber: { field: 'textTo', else: 'refuse' } }])).toEqual([]);
  });

  it('refuses a rule with no field, an else it does not know, a key it does not have, and the bare name', () => {
    expect(policyWith([{ callerNumber: {} }]).join('\n')).toMatch(/callerNumber\.field: required key "field" is missing/);
    expect(policyWith([{ callerNumber: { field: 'textTo', else: 'person' } }])).toEqual([
      'actions.sendUpdates.rules[0].callerNumber.else: "else" is "person", which is not allowed here; it must be one of "refuse", "confirmed" -> use one of "refuse", "confirmed"',
    ]);
    expect(policyWith([{ callerNumber: { field: 'textTo', reason: 'x' } }]).join('\n')).toMatch(/unknown key "reason"/);
    expect(policyWith(['callerNumber'])).toEqual(['actions.sendUpdates.rules[0]: the callerNumber rule takes parameters, so it is written as a map -> write "callerNumber: { field: textTo }"']);
    expect(policyWith([{ callerNumber: { field: 'textTo' } }, { callerNumber: { field: 'textTo' } }])).toEqual([
      'actions.sendUpdates.rules[1]: the rule "callerNumber: textTo" is listed twice -> delete one of the two: a rule runs once per action',
    ]);
  });

  it('refuses a field the action does not send', () => {
    expect(policyWith([{ callerNumber: { field: 'phone' } }])).toEqual([
      'actions.sendUpdates.rules[0].callerNumber.field: "phone" is not a param "sendUpdates" sends (its tool lists topic, textTo) -> name one of those, or add "phone" to code.tools.sendUpdates.params',
    ]);
  });

  it('refuses else: confirmed with no confirmed rule, or one that does not name the field', () => {
    expect(policyWith([{ callerNumber: { field: 'textTo', else: 'confirmed' } }])).toEqual([
      'actions.sendUpdates.rules[0].callerNumber.else: the callerNumber rule of "sendUpdates" passes a number the caller confirmed, but the action has no confirmed rule, so no number but the caller\'s own ever passes -> add "- confirmed: [..., textTo]" to the action, with the fields its summary reads back, or delete "else: confirmed"',
    ]);
    // A confirmed rule closes the params the action sends: one that leaves the field out says so once.
    expect(policyWith([{ callerNumber: { field: 'textTo', else: 'confirmed' } }, { confirmed: ['topic'] }])).toEqual([
      'actions.sendUpdates.rules[0].callerNumber.field: "textTo" is not a param "sendUpdates" sends (its confirmed rule lists topic) -> name one of those, or add "textTo" to its confirmed rule',
    ]);
  });
});
