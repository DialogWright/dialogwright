import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { libraryApp } from '../define/fixture/app';
import { defineRule } from '../gate/defineRule';
import type { App } from '../core/app/types';
import { useTestkit } from './apps';
import { expectPolicyMatrix, lineDiff, policyMatrixText, ruleExampleResults, runRuleExamples, RuleExampleError } from './policyMatrix';
import { testkitApp } from './testkit';
import { TESTKIT_CUSTOM_RULES } from './testkit/domain/policy';

/**
 * The reviewed policy matrices of the testkit and the library fixture: each is what the app's gate
 * decides today, and a difference fails with a diff a reviewer can read. Then the matrix runner's
 * own tests: the custom rules' examples run through the compiled gate, an example the gate does not
 * decide as it says fails (with the action and the reason), and a change to a role shows as the
 * lines it changes.
 */

useTestkit();

const TESTKIT_MATRIX = fileURLToPath(new URL('./testkit/policy.matrix', import.meta.url));
const LIBRARY_MATRIX = fileURLToPath(new URL('../define/fixture/policy.matrix', import.meta.url));

describe('the policy matrix goldens', () => {
  it('testkit: policy.matrix is what its gate decides', () => {
    expectPolicyMatrix(testkitApp, TESTKIT_MATRIX, 'pnpm policy:matrix packages/dialogwright/src/testing/testkit');
  });

  it('library fixture: policy.matrix is what its gate decides', () => {
    expectPolicyMatrix(libraryApp, LIBRARY_MATRIX, 'pnpm policy:matrix packages/dialogwright/src/define/fixture');
  });
});

/**
 * The testkit with the viewer allowed to file a report: a policy change the matrix must show. Tables
 * changed by hand are their own policy (the gate reads them through programFromTables).
 */
function viewerMayReport(): App {
  const policy = { ...testkitApp.policy, roles: { ...testkitApp.policy.roles, createReport: { viewer: 'allow' as const, clerk: 'person' as const } } };
  return { ...testkitApp, policy };
}

describe('the policy matrix', () => {
  it('fails on a change with a diff of the lines it changes, and the command to accept it', () => {
    let message = '';
    try {
      expectPolicyMatrix(viewerMayReport(), TESTKIT_MATRIX, 'pnpm policy:matrix packages/dialogwright/src/testing/testkit');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('is not what the gate of "testkit" decides');
    expect(message).toMatch(/^- {3}delegate:viewer +BLOCK role$/m);
    expect(message).toMatch(/^\+ {3}delegate:viewer +subject own, fields exact, confirmed none\|mismatch +BLOCK confirmation$/m);
    expect(message).toMatch(/^\+ {20}subject inScope, fields exact, confirmed match, params due\|delivered +ALLOW$/m);
    // The subject's own lines did not move.
    expect(message).not.toMatch(/^[-+] {3}subject@2/m);
    expect(message).toContain('write it with `pnpm policy:matrix packages/dialogwright/src/testing/testkit`');
  });

  it('says so when there is no matrix yet, and never writes one', () => {
    expect(() => expectPolicyMatrix(testkitApp, '/nonexistent/policy.matrix', 'pnpm policy:matrix x')).toThrow(/there is no policy matrix at \/nonexistent\/policy.matrix: write it with `pnpm policy:matrix x`/);
  });

  it('a line diff shows each change with its context and where it is', () => {
    expect(lineDiff('a\nb\nc\nd\ne\nf\ng', 'a\nb\nc\nD\ne\nf\ng', 1)).toBe('@@ line 3\n  c\n- d\n+ D\n  e');
    expect(lineDiff('a\nb', 'a\nb\nc', 0)).toBe('@@ line 3\n+ c');
  });

  it('says every caller once when all decide alike, and a caller who decides as another by name', () => {
    const text = policyMatrixText(testkitApp);
    expect(text).toContain('(unlisted) · not in the policy\n  every caller     BLOCK unknown-tool\n');
    expect(text).toContain('  subject@1        as anonymous\n');
    expect(text).toContain('createReport · level 2 · identity, role(viewer refuse, clerk person), scope(accountId), confirmed(accountId, missingNote, expectedDate), custom R8\n');
  });
});

describe('the custom rules\' examples', () => {
  it('each runs through the compiled gate in every action that names its rule, and holds', () => {
    const results = runRuleExamples(testkitApp);
    expect(results.map((r) => [r.rule, r.tool, r.example, r.expected])).toEqual([
      ['R8', 'createReport', 'due on a day nothing of theirs was delivered', 'ALLOW'],
      ['R8', 'createReport', 'due on the day their boots were delivered', 'NEEDS_HUMAN delivered'],
      ['R8', 'createReport', 'due on no date at all', 'BLOCK unchecked'],
      ['R8', 'createReport', 'lookups that cannot say', 'BLOCK unchecked'],
    ]);
    expect(runRuleExamples(libraryApp).map((r) => r.decision.verdict)).toEqual(['ALLOW', 'BLOCK', 'BLOCK']);
  });

  it('an example the gate decides otherwise fails, naming the rule, the example, the action and why', () => {
    const R8 = TESTKIT_CUSTOM_RULES.R8 as ReturnType<typeof defineRule>;
    const [allow, delivered] = [R8.examples[0]!, R8.examples[1]!];
    const wrong = defineRule({
      id: 'R8',
      description: R8.description,
      run: () => ({ pass: true, compared: 'always' }),
      examples: [
        allow,
        delivered,
        // Stopped by the scope rule before R8 runs: a refusal that is not the rule's.
        { ...delivered, name: 'another customer\'s report', call: { params: { ...delivered.call.params, accountId: '55509999' } }, expect: { verdict: 'BLOCK', reason: 'scope' } },
      ],
    });
    const app: App = { ...testkitApp, policy: { ...testkitApp.policy, customRules: { R8: wrong } } };
    const problems = ruleExampleResults(app).results.map((r) => r.problem);
    expect(problems).toEqual([
      null,
      'custom rule "R8" example "due on the day their boots were delivered" in createReport: expected NEEDS_HUMAN delivered, got ALLOW',
      'custom rule "R8" example "another customer\'s report" in createReport: got BLOCK scope, and the gate stopped at scope before the rule ran',
    ]);
    expect(() => runRuleExamples(app)).toThrow(RuleExampleError);
    expect(() => policyMatrixText(app)).toThrow(/2 custom rule example problem/);
  });

  it('a plain function cannot be run: there is nothing to run', () => {
    const app: App = { ...testkitApp, policy: { ...testkitApp.policy, customRules: { R8: (c) => TESTKIT_CUSTOM_RULES.R8!(c) } } };
    expect(ruleExampleResults(app).unrunnable).toEqual(['custom rule "R8" is a plain function, with no examples: define it with defineRule']);
    expect(() => runRuleExamples(app)).toThrow(/custom rule "R8" is a plain function/);
    expect(policyMatrixText(app)).toContain('  R8: (a plain function, with no examples)\n');
  });
});
