import { checkApp, formatProblem } from 'dialogwright';
import { describe, expect, it } from 'vitest';
import { APP_DIR, Systems, TOOLS, app, code } from './app';

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

describe('identity', () => {
  it('verifies a caller with an account number and a date of birth, and the booking needs them (level 1)', () => {
    expect(app.identity).toMatchObject({ subjectKind: 'customer', factorSlots: ['accountId', 'dob'], verifyTool: 'verifyCustomer' });
    expect(app.policy.toolLevel).toMatchObject({ verifyCustomer: 0, findAccount: 1, bookService: 1 });
  });

  it('verifies only when both factors match one account', async () => {
    const verify = (params: Record<string, string>) => TOOLS.verifyCustomer!.run({ tool: 'verifyCustomer', params }, new Systems(), {} as never);
    expect(await verify({ accountId: '55501234', dob: '1980-04-12' })).toMatchObject({ value: { ok: true, principal: { kind: 'customer', level: 1, first: 'Avery' } } });
    expect(await verify({ accountId: '55501234', dob: '1975-06-14' })).toMatchObject({ value: { ok: false } });
    expect(await verify({ accountId: '55509999', dob: '1980-04-12' })).toMatchObject({ value: { ok: false } });
  });
});
