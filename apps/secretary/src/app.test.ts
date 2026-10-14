import { fileURLToPath } from 'node:url';
import { checkApp, formatProblem, type ToolCall, type ToolDef } from 'dialogwright';
import { danglingReferences, expectAppMap, expectPolicyCard, expectPolicyMatrix, policyInvariants, runRuleExamples } from 'dialogwright/testing';
import { describe, expect, it } from 'vitest';
import { APP_DIR, Systems, TOOLS, app, code } from './app';

describe('the app folder', () => {
  it('passes dialogwright check: the folder, the code and the corpus agree', async () => {
    expect((await checkApp(APP_DIR, { code })).map(formatProblem)).toEqual([]);
  });

  it('is Example Front Desk, in en-US', () => {
    expect(app.id).toBe('secretary');
    expect(app.brand?.name).toBe('Example Front Desk');
    expect(app.locales).toMatchObject({ default: 'en-US' });
  });

  it('has its intents and the engine\'s control intents', () => {
    expect(Object.keys(app.intents)).toEqual(['take_message', 'urgent', 'studio_hours', 'studio_address', 'whereabouts', 'agent', 'repeat_prompt', 'done', 'other', 'none']);
    expect(app.intents.take_message!.kind).toBe('form');
    expect(app.intents.urgent!.priority).toBeTruthy();
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

describe('the read-back and the inbox', () => {
  it('generates only the summary inside the read-back: every other line is said word for word', () => {
    const lines = app.generated?.lines ?? {};
    expect(Object.keys(lines)).toEqual(['confirm_take_message']);
    expect(lines.confirm_take_message!.spans).toEqual({
      // Spoken to the caller: their "I" said as "you", the recipient's name allowed for a pronoun that means them.
      summary: { from: 'message', goal: "Fill in the blank for this text with the summary, repeating the caller's words back to them in a way that reflects a secretary reading back the message they left.", words: 30, speaks: 'to-caller', names: ['recipient'] },
    });
    expect(app.generated?.prescribed).toContain('message_taken');
  });

  it('delivers the message word for word, once for a repeated write', () => {
    const sys = new Systems();
    const call: ToolCall = { tool: 'leaveMessage', params: { recipient: 'sam', caller: 'Alex Rivera', phone: '5555550142', message: 'the logo files are ready for review' } };
    const run = (key: string) => (TOOLS.leaveMessage as ToolDef).run(call, sys, { idempotencyKey: key } as unknown as Parameters<ToolDef['run']>[2]);
    const first = run('k-1');
    const again = run('k-1');
    expect(again.ref).toBe(first.ref);
    expect(sys.inbox).toEqual([{ ref: 'M101', inbox: 'sam@example.com', recipient: 'sam', caller: 'Alex Rivera', phone: '5555550142', message: 'the logo files are ready for review' }]);
    expect(run('k-2').ref).toBe('M102');
  });
});
