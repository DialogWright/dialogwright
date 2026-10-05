import { fileURLToPath } from 'node:url';
import { ANONYMOUS, checkApp, formatProblem } from 'dialogwright';
import { danglingReferences, expectAppMap, expectPolicyCard, expectPolicyMatrix, policyInvariants, runRuleExamples } from 'dialogwright/testing';
import { describe, expect, it } from 'vitest';
import { APP_DIR, Systems, TOOLS, app, code, scopeOf } from './app';

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
    expect(Object.keys(app.intents)).toEqual(['book_service', 'agent', 'repeat_prompt', 'done', 'other', 'none']);
    expect(app.intents.book_service!.kind).toBe('form');
  });

  it('understands a caller who is done: "done" ends the call with the goodbye (the scripted call done-after-a-request-it-cannot-handle)', () => {
    expect(app.intents.done).toMatchObject({ kind: 'control', label: 'finish up' });
    expect(app.prompts.manifest.goodbye).toBeDefined();
  });

  it('has an action in policy.yaml for every tool, and no other', () => {
    expect(Object.keys(app.policy.toolLevel).sort()).toEqual(Object.keys(code.tools).sort());
  });
});

describe('the policy read back', () => {
  // The three pages beside policy.yaml are generated, reviewed and committed with it: after a change
  // to policy.yaml, identity.yaml or the forms, run the command a failure names, read the diff as a change
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

describe('identity', () => {
  it('verifies a caller with an account number and a date of birth, and the booking needs them (level 1)', () => {
    expect(app.identity).toMatchObject({ subjectKind: 'customer', factorSlots: ['accountId', 'dob'], verifyTool: 'verifyCustomer' });
    expect(app.policy.toolLevel).toMatchObject({ verifyCustomer: 0, findAccount: 1, bookService: 1 });
  });

  it('lets a verified customer name their own account, and no one else any account (the scope rule)', () => {
    expect(scopeOf({ kind: 'customer', level: 1, id: '55501234', first: 'Avery' })).toEqual(['55501234']);
    expect(scopeOf(ANONYMOUS)).toEqual([]);
  });

  it('verifies only when both factors match one account', async () => {
    const verify = (params: Record<string, string>) => TOOLS.verifyCustomer!.run({ tool: 'verifyCustomer', params }, new Systems(), {} as never);
    expect(await verify({ accountId: '55501234', dob: '1980-04-12' })).toMatchObject({ value: { ok: true, principal: { kind: 'customer', level: 1, first: 'Avery' } } });
    expect(await verify({ accountId: '55501234', dob: '1975-06-14' })).toMatchObject({ value: { ok: false } });
    expect(await verify({ accountId: '55509999', dob: '1980-04-12' })).toMatchObject({ value: { ok: false } });
  });
});
