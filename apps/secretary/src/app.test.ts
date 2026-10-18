import { fileURLToPath } from 'node:url';
import { checkApp, formatProblem, type ToolCall, type ToolDef, type ToolReply } from 'dialogwright';
import { danglingReferences, expectAppMap, expectPolicyCard, expectPolicyMatrix, policyInvariants, runRuleExamples } from 'dialogwright/testing';
import { describe, expect, it } from 'vitest';
import { APP_DIR, Systems, TOOLS, app, code, statusLine } from './app';

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
    // Whether someone is in is a form now: the person, then their status and an offer (routes.yaml).
    expect(app.intents.whereabouts!.kind).toBe('form');
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
    const run = (key: string) => (TOOLS.leaveMessage as ToolDef).run(call, sys, { idempotencyKey: key } as unknown as Parameters<ToolDef['run']>[2]) as ToolReply;
    const first = run('k-1');
    const again = run('k-1');
    expect(again.ref).toBe(first.ref);
    expect(sys.inbox).toEqual([{ ref: 'M101', inbox: 'sam@example.com', recipient: 'sam', caller: 'Alex Rivera', phone: '5555550142', message: 'the logo files are ready for review' }]);
    expect(run('k-2').ref).toBe('M102');
  });
});

describe('a person\'s status', () => {
  const read = (sys: Systems, person: string) => (TOOLS.personStatus as ToolDef).run({ tool: 'personStatus', params: { person } }, sys, {} as unknown as Parameters<ToolDef['run']>[2]) as ToolReply;

  it('reads each person\'s status from the calendar, and its reply passes the tool\'s check', () => {
    const sys = new Systems();
    expect(read(sys, 'riley').value).toEqual({ status: 'available', back: null });
    expect(read(sys, 'sam').value).toEqual({ status: 'out_of_office', back: 'Monday' });
    expect(read(sys, 'jordan').value).toEqual({ status: 'in_training', back: null });
    for (const person of ['riley', 'sam', 'jordan']) expect(TOOLS.personStatus!.check!(read(sys, person).value)).toBe(true);
    // The team has no calendar (and the gate refuses it before the tool runs: policy.yaml's oneOf).
    expect(() => read(sys, 'anyone')).toThrow();
  });

  it('checks the calendar\'s reply against the closed lists: a status or a day it does not list is never used', () => {
    const check = TOOLS.personStatus!.check!;
    expect(check({ status: 'in_a_meeting', back: null })).toBe(true);
    expect(check({ status: 'on a beach, call his mobile', back: null })).toBe(false);
    expect(check({ status: 'out_of_office', back: 'next week' })).toBe(false);
    expect(check({ status: 'available' })).toBe(false);
  });

  it('says each status in its own fixed line, chosen by code, the day only where the note gives one', () => {
    expect(statusLine({ status: 'available', back: null }, 'Riley Moreno')).toEqual({ promptId: 'status_available', vars: { recipient: 'Riley Moreno' } });
    expect(statusLine({ status: 'out_of_office', back: 'Monday' }, 'Sam Okafor')).toEqual({ promptId: 'status_out_of_office', vars: { recipient: 'Sam Okafor', back: 'Monday' } });
    expect(statusLine({ status: 'out_of_office', back: null }, 'Sam Okafor')).toEqual({ promptId: 'status_out_of_office_no_day', vars: { recipient: 'Sam Okafor' } });
    expect(statusLine({ status: 'in_training', back: null }, 'Jordan Lee')).toEqual({ promptId: 'status_in_training', vars: { recipient: 'Jordan Lee' } });
    expect(statusLine({ status: 'in_a_meeting', back: null }, 'Jordan Lee')).toEqual({ promptId: 'status_in_a_meeting', vars: { recipient: 'Jordan Lee' } });
    for (const id of ['status_available', 'status_out_of_office', 'status_out_of_office_no_day', 'status_in_training', 'status_in_a_meeting', 'status_team', 'status_unknown']) expect(app.prompts.manifest[id]).toBeDefined();
  });

  it('generates no status line: each is said word for word', () => {
    const generated = Object.keys(app.generated?.lines ?? {});
    expect(generated.filter((id) => id.startsWith('status_'))).toEqual([]);
  });
});
