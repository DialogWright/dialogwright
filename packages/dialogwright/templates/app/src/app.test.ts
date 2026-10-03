import { checkApp, formatProblem } from 'dialogwright';
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
