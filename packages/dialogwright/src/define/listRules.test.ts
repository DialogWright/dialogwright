import { describe, expect, it } from 'vitest';
import { sourceOf } from '../gate/compiled';
import { choiceType } from '../slots/choice';
import { AppDefinitionError } from './defineApp';
import { definePolicy } from './definePolicy';
import { slotChoicesOf } from './policyFile';
import type { Problem } from './problems';
import { screenedApp } from '../testing/screened/app';

/**
 * The list rules from the file's side: policy.yaml's oneOf and noneOf, checked (their shape, the
 * param they read, a choice slot's option ids) and compiled to the gate with their parameters.
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

const TOOLS = { bookVisit: { params: ['ownership', 'town', 'note'] } };
const book = (rules: unknown[]) => ({ actions: { bookVisit: { level: 0, rules } }, audit: { ownership: 'keep', town: 'keep', note: 'keep' } });
const policyWith = (rules: unknown[], slots?: Record<string, unknown>): string[] => problemsOf(() => definePolicy(book(rules), { tools: TOOLS, ...(slots ? { slots } : {}) }));

describe('policy.yaml: the list rules checked', () => {
  it('a valid rule compiles under its name, with its parameters', () => {
    const rules = [
      { oneOf: { field: 'town', values: ['millbrook', 'ashford'], reason: 'out-of-area' } },
      { noneOf: { field: 'ownership', values: ['rent'], verdict: 'NEEDS_HUMAN' } },
    ];
    expect(policyWith(rules)).toEqual([]);
    const tables = definePolicy(book(rules), { tools: TOOLS });
    expect(tables.rulesFor.bookVisit).toEqual(['oneOf', 'noneOf']);
    expect(sourceOf(tables)?.actions.bookVisit?.rules).toEqual([
      { rule: 'oneOf', field: 'town', values: ['millbrook', 'ashford'], reason: 'out-of-area' },
      { rule: 'noneOf', field: 'ownership', values: ['rent'], verdict: 'NEEDS_HUMAN' },
    ]);
    // One rule of a kind per param: two params may each have one, the same param twice is listed twice.
    expect(policyWith([{ oneOf: { field: 'town', values: ['ashford'] } }, { oneOf: { field: 'ownership', values: ['own'] } }])).toEqual([]);
    expect(policyWith([{ oneOf: { field: 'town', values: ['ashford'] } }, { oneOf: { field: 'town', values: ['riverton'] } }])).toEqual([
      'actions.bookVisit.rules[1]: the rule "oneOf: town" is listed twice -> delete one of the two: a rule runs once per action',
    ]);
  });

  it('refuses an empty list, a value listed twice, a value that is not text, and a key it does not have', () => {
    expect(policyWith([{ oneOf: { field: 'town', values: [] } }])).toEqual(['actions.bookVisit.rules[0].oneOf.values: "values" must list at least one value -> give it a value, or delete the key']);
    expect(policyWith([{ noneOf: { field: 'town', values: ['ashford', 'ashford'] } }])).toEqual(['actions.bookVisit.rules[0].noneOf.values[1]: value "ashford" is listed twice -> delete one of the two "ashford" entries']);
    expect(policyWith([{ oneOf: { field: 'town', values: [1, true, ''] } }])).toEqual([
      'actions.bookVisit.rules[0].oneOf.values[0]: "values[0]" must be text, but is a number (1) -> write it as text, in quotes: "1"',
      'actions.bookVisit.rules[0].oneOf.values[1]: "values[1]" must be text, but is true or false (true) -> write it as text, in quotes: "true"',
      'actions.bookVisit.rules[0].oneOf.values[2]: "values[2]" must not be empty -> give it a value, or delete the key',
    ]);
    expect(policyWith([{ oneOf: { field: 'town', value: ['ashford'] } }])).toEqual(['actions.bookVisit.rules[0].oneOf.value: unknown key "value" under actions.bookVisit.rules[0].oneOf -> rename "value" to "values"']);
    expect(policyWith([{ oneOf: { values: ['ashford'] } }]).join('\n')).toMatch(/oneOf\.field: required key "field" is missing/);
    expect(policyWith([{ oneOf: { field: 'town', values: ['ashford'], verdict: 'STEP_UP' } }])).toEqual([
      'actions.bookVisit.rules[0].oneOf.verdict: "verdict" is "STEP_UP", which is not allowed here; it must be one of "BLOCK", "NEEDS_HUMAN" -> use one of "BLOCK", "NEEDS_HUMAN"',
    ]);
    expect(policyWith(['oneOf'])).toEqual(['actions.bookVisit.rules[0]: the oneOf rule takes parameters, so it is written as a map -> write "oneOf: { field: town, values: [millbrook, ashford] }"']);
  });

  it('refuses a param the action does not send', () => {
    expect(policyWith([{ oneOf: { field: 'twn', values: ['ashford'] } }])).toEqual([
      'actions.bookVisit.rules[0].oneOf.field: "twn" is not a param "bookVisit" sends (its tool lists ownership, town, note) -> rename it to "town", or name one of those, or add "twn" to code.tools.bookVisit.params',
    ]);
  });

  it('holds a list for a choice slot\'s param to its option ids, and suggests the closest', () => {
    const slots = { town: { type: 'choice', config: { options: { millbrook: { say: 'Millbrook' }, cedar_falls: { say: 'Cedar Falls' }, ashford: { say: 'Ashford' } } } }, note: { type: 'text', config: {} } };
    expect(policyWith([{ oneOf: { field: 'town', values: ['millbrook', 'cedar falls', 'Ashford'] } }], slots)).toEqual([
      'actions.bookVisit.rules[0].oneOf.values[1]: "cedar falls" is not an option of the choice slot "town" (millbrook, cedar_falls, ashford), so the param never carries it -> rename it to "cedar_falls", or list the option\'s id as slots.yaml has it, or add "cedar falls" to the slot\'s options',
      'actions.bookVisit.rules[0].oneOf.values[2]: "Ashford" is not an option of the choice slot "town" (millbrook, cedar_falls, ashford), so the param never carries it -> rename it to "ashford", or list the option\'s id as slots.yaml has it, or add "Ashford" to the slot\'s options',
    ]);
    // A param that is not a choice slot's takes any text.
    expect(policyWith([{ noneOf: { field: 'note', values: ['anything at all'] } }], slots)).toEqual([]);
  });

  it('reads a choice slot\'s option ids off the built slots, and nothing off any other type', () => {
    expect(slotChoicesOf(screenedApp.slots)).toEqual({
      problem: ['leak', 'crack', 'draft'],
      ownership: ['own', 'rent'],
      town: ['millbrook', 'cedar_falls', 'ashford', 'riverton', 'elsewhere'],
      howUrgent: ['routine', 'soon', 'urgent'],
      visitDay: ['monday', 'wednesday', 'saturday'],
      timeOfDay: ['morning', 'afternoon'],
    });
    expect(screenedApp.slots.town).toMatchObject({ type: choiceType.type });
    expect(slotChoicesOf({ a: null, b: { type: 'choice' }, c: { type: 'choice', config: { options: [] } }, d: { type: 'text', config: { options: { x: {} } } } })).toEqual({});
  });
});
