import { fileURLToPath } from 'node:url';
import { checkApp, formatProblem } from 'dialogwright';
import { danglingReferences, expectAppMap, expectPolicyCard, expectPolicyMatrix, policyInvariants, runRuleExamples } from 'dialogwright/testing';
import { describe, expect, it } from 'vitest';
import { APP_DIR, app, code } from './app';

describe('the app folder', () => {
  it('passes dialogwright check: the folder, the code and the corpus agree', async () => {
    expect((await checkApp(APP_DIR, { code })).map(formatProblem)).toEqual([]);
  });

  it('is {{display}}, in en-US', () => {
    expect(app.id).toBe('{{name}}');
    expect(app.brand?.name).toBe('{{display}}');
    expect(app.locales).toMatchObject({ default: 'en-US' });
  });

  it('has the example intent and the engine\'s control intents', () => {
    expect(Object.keys(app.intents)).toEqual(['book_service', 'agent', 'repeat_prompt', 'other', 'none']);
    expect(app.intents.book_service!.kind).toBe('form');
  });

  it('has an action in policy.yaml for every tool, and no other', () => {
    expect(Object.keys(app.policy.toolLevel).sort()).toEqual(Object.keys(code.tools).sort());
  });
});

describe('the policy read back', () => {
  // The three pages beside policy.yaml are generated, reviewed and committed with it: after a change
  // to policy.yaml or the forms, run the command a failure names, read the diff as a change
  // in what the agent may do, and commit it. Never rewrite one only to make a test pass.
  const page = (file: string): string => fileURLToPath(new URL(`../${file}`, import.meta.url));

  it('holds to the policy invariants on the gate grid', () => expect(policyInvariants(app).violations).toEqual([]));

  it('has no custom rule whose examples the gate disagrees with', () => expect(runRuleExamples(app)).toEqual([]));

  it('policy.matrix is what the gate decides', () => {
    expectPolicyMatrix(app, page('policy.matrix'), `pnpm policy:matrix ${APP_DIR}`);
  });

  it('POLICY.md is the policy card the app generates', () => {
    expectPolicyCard(app, page('POLICY.md'), `pnpm policy:card ${APP_DIR}`);
  });

  it('APP-MAP.md is the app map the app generates', () => {
    expectAppMap(app, page('APP-MAP.md'), `pnpm app:diagram ${APP_DIR}`);
  });

  it('has no dangling reference: every form is started by an intent and every action is reached', () => {
    expect(danglingReferences(app)).toEqual([]);
  });
});
