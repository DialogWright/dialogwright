import { describe, expect, it } from 'vitest';
import { testkitApp } from '../testing/testkit';
import { useTestkit } from '../testing/apps';
import type { App, HandoffData } from '../core/app/types';
import type { HandoffDecision } from '../core/decision';
import { decisionToActions } from '../prompts/render';
import { actionsToFrames } from '../channel/relay/map';
import { actionsToChatMessages } from '../channel/chat/protocol';
import { validateApp } from '../core/app/validate';
import { handoffDataProblems, handoffDataSlots, handoffDataUnconfirmed, handoffSendOf } from './data';

useTestkit();

/** The testkit with its handoff data set to `data`. */
function withData(data: HandoffData | undefined, base: App = testkitApp): App {
  const { data: _old, ...wording } = base.handoff ?? {};
  return { ...base, handoff: data === undefined ? wording : { ...wording, data } };
}

/**
 * The testkit, with its date of birth no identity factor (the app verifies with the account ID
 * alone) and handed over as said: the birth date is then a slot the app only redacts.
 */
const dobNotAFactor: App = {
  ...testkitApp,
  identity: { ...testkitApp.identity!, factorSlots: ['accountId'] },
  slots: { ...testkitApp.slots, dob: { ...testkitApp.slots.dob!, handoff: undefined } },
};

/** What a handoff decision holds for a verified caller who reported a missing parcel (core/decision.ts handoff). */
const COLLECTED = { accountId: '...1234', dob: 'verified', missingNote: 'your description', expectedDate: 'Wednesday, September 16' };

const handoffDecision = (slots: Record<string, string>): HandoffDecision =>
  ({ kind: 'handoff', reason: 'live-agent', promptId: 'handoff_live_agent', acks: [], completed: [], queued: [], slots });

describe('handoff data: the default', () => {
  it('omits every identity factor, and sends any other slot as it is', () => {
    expect(handoffDataSlots(testkitApp, COLLECTED)).toEqual({ missingNote: 'your description', expectedDate: 'Wednesday, September 16' });
  });

  it('omits the date of birth when it is a factor, even one handed over as said', () => {
    const app: App = { ...testkitApp, slots: { ...testkitApp.slots, dob: { ...testkitApp.slots.dob!, handoff: undefined } } };
    expect(handoffDataSlots(app, { dob: 'April 12th, 1980', expectedDate: 'Wednesday, September 16' })).toEqual({ expectedDate: 'Wednesday, September 16' });
  });

  it('masks a slot the app redacts, as the trace masks it', () => {
    expect(handoffDataSlots(dobNotAFactor, { accountId: '...1234', dob: 'April 12th, 1980', missingNote: 'your description' }))
      .toEqual({ dob: '••/••/1980', missingNote: 'your description' });
    expect(handoffSendOf(dobNotAFactor, 'dob')).toBe('masked');
    expect(handoffSendOf(dobNotAFactor, 'accountId')).toBe('omit');
    expect(handoffSendOf(dobNotAFactor, 'expectedDate')).toBe('as-is');
  });

  it('leaves out a name that is not one of the app\'s slots', () => {
    expect(handoffDataSlots(testkitApp, { notASlot: 'x' })).toEqual({});
  });
});

describe('handoff data: the app\'s option', () => {
  it('sends exactly the slots an explicit list names', () => {
    const app = withData({ slots: ['accountId', 'missingNote'], send: { accountId: 'masked' } });
    expect(handoffDataSlots(app, COLLECTED)).toEqual({ accountId: '...1234', missingNote: 'your description' });
  });

  it('sends none with slots: none', () => {
    expect(handoffDataSlots(withData({ slots: 'none' }), COLLECTED)).toEqual({});
  });

  it('sends a slot named as-is in the clear', () => {
    const app = withData({ send: { dob: 'as-is' } }, dobNotAFactor);
    expect(handoffDataSlots(app, { dob: 'April 12th, 1980' })).toEqual({ dob: 'April 12th, 1980' });
  });

  it('sends a factor masked when the app says so: an identifier by its last four, a factor handed over as verified by that alone', () => {
    const app = withData({ send: { accountId: 'masked', dob: 'masked' } });
    expect(handoffDataSlots(app, { accountId: '5550 1234', dob: 'verified' })).toEqual({ accountId: '...1234', dob: 'verified' });
  });

  it('omits a slot named omit', () => {
    expect(handoffDataSlots(withData({ send: { expectedDate: 'omit' } }), COLLECTED)).toEqual({ missingNote: 'your description' });
  });
});

describe('handoff data: the values the caller never confirmed (unconfirmed)', () => {
  const UNCONFIRMED = ['missingNote'];

  it('send, the default: every value goes, and nothing is named', () => {
    for (const app of [testkitApp, withData({ unconfirmed: 'send' })]) {
      expect(handoffDataSlots(app, COLLECTED, UNCONFIRMED)).toEqual({ missingNote: 'your description', expectedDate: 'Wednesday, September 16' });
      expect(handoffDataUnconfirmed(app, handoffDataSlots(app, COLLECTED, UNCONFIRMED), UNCONFIRMED)).toBeUndefined();
    }
  });

  it('omit leaves them out, after the identity factors are left out as ever', () => {
    const app = withData({ unconfirmed: 'omit' });
    expect(handoffDataSlots(app, COLLECTED, UNCONFIRMED)).toEqual({ expectedDate: 'Wednesday, September 16' });
    expect(handoffDataSlots(app, COLLECTED, [])).toEqual({ missingNote: 'your description', expectedDate: 'Wednesday, September 16' });
    expect(handoffDataUnconfirmed(app, {}, UNCONFIRMED)).toBeUndefined();
  });

  it('mark keeps them and names those the data sends, in their order', () => {
    const app = withData({ unconfirmed: 'mark' });
    const sent = handoffDataSlots(app, COLLECTED, ['expectedDate', 'missingNote', 'accountId']);
    expect(sent).toEqual({ missingNote: 'your description', expectedDate: 'Wednesday, September 16' });
    // A factor is left out of the data, so it is not named either.
    expect(handoffDataUnconfirmed(app, sent, ['expectedDate', 'missingNote', 'accountId'])).toEqual(['expectedDate', 'missingNote']);
    expect(handoffDataUnconfirmed(app, sent, [])).toEqual([]);
  });

  it('on the end frame: an unconfirmed list beside the slots with mark, none with send or omit', () => {
    const decision = { ...handoffDecision({ missingNote: 'your description', expectedDate: 'Wednesday, September 16' }), unconfirmed: ['expectedDate'] };
    const end = (app: App) => actionsToFrames(decisionToActions(app, decision)).at(-1);
    expect(end(withData({ unconfirmed: 'mark' }))).toEqual({ type: 'end', handoffData: '{"reasonCode":"live-agent","slots":{"missingNote":"your description","expectedDate":"Wednesday, September 16"},"unconfirmed":["expectedDate"]}' });
    expect(end(withData({ unconfirmed: 'omit' }))).toEqual({ type: 'end', handoffData: '{"reasonCode":"live-agent","slots":{"missingNote":"your description"}}' });
    expect(end(testkitApp)).toEqual({ type: 'end', handoffData: '{"reasonCode":"live-agent","slots":{"missingNote":"your description","expectedDate":"Wednesday, September 16"}}' });
    // Everything confirmed: no list at all, as an empty completed or queued has none.
    expect(actionsToFrames(decisionToActions(withData({ unconfirmed: 'mark' }), { ...decision, unconfirmed: [] })).at(-1))
      .toEqual({ type: 'end', handoffData: '{"reasonCode":"live-agent","slots":{"missingNote":"your description","expectedDate":"Wednesday, September 16"}}' });
  });

  it('a chat\'s transfer is unchanged: its reason alone', () => {
    const decision = { ...handoffDecision({ expectedDate: 'Wednesday, September 16' }), unconfirmed: ['expectedDate'] };
    expect(actionsToChatMessages(decisionToActions(withData({ unconfirmed: 'mark' }), decision), 'en-US').at(-1)).toEqual({ type: 'transfer', reason: 'live-agent' });
  });

  it('refuses a value it does not have, for an app built in code too', () => {
    const problems = handoffDataProblems({ unconfirmed: 'flag' as never }, testkitApp.slots, testkitApp.identity?.factorSlots ?? []);
    expect(problems.map((p) => `${p.path.join('.')}: ${p.message}`)).toEqual(['unconfirmed: "flag" is not one of "send", "mark", "omit"']);
    expect(() => validateApp(withData({ unconfirmed: 'flag' as never }))).toThrow(/handoff data: "flag" is not one of "send", "mark", "omit" \(handoff\.data\.unconfirmed\)/);
    for (const how of ['send', 'mark', 'omit'] as const) expect(() => validateApp(withData({ unconfirmed: how }))).not.toThrow();
  });
});

describe('handoff data on the channels', () => {
  it('the voice relay\'s end frame carries the handoff data, with no factor in it', () => {
    const frames = actionsToFrames(decisionToActions(testkitApp, handoffDecision({ accountId: '...1234', dob: 'April 12th, 1980', expectedDate: 'Wednesday, September 16' })));
    expect(frames.at(-1)).toEqual({ type: 'end', handoffData: '{"reasonCode":"live-agent","slots":{"expectedDate":"Wednesday, September 16"}}' });
  });

  it('an end frame with nothing left to send has no slots at all', () => {
    const frames = actionsToFrames(decisionToActions(testkitApp, handoffDecision({ accountId: '...1234', dob: 'verified' })));
    expect(frames.at(-1)).toEqual({ type: 'end', handoffData: '{"reasonCode":"live-agent"}' });
  });

  it('a chat\'s transfer is unchanged: its reason, never a collected value', () => {
    const app = withData({ send: { dob: 'as-is' } }, dobNotAFactor);
    const messages = actionsToChatMessages(decisionToActions(app, handoffDecision({ dob: 'April 12th, 1980', expectedDate: 'Wednesday, September 16' })), 'en-US');
    expect(messages.at(-1)).toEqual({ type: 'transfer', reason: 'live-agent' });
    expect(JSON.stringify(messages)).not.toContain('1980');
    expect(JSON.stringify(messages)).not.toContain('September');
  });
});

describe('handoff data: what is refused', () => {
  const problems = (data: unknown, app: App = testkitApp) =>
    handoffDataProblems(data as HandoffData, app.slots, app.identity?.factorSlots ?? []).map((p) => `${p.path.join('.')}: ${p.message}`);

  it('accepts the default and every well-formed option', () => {
    expect(problems(undefined)).toEqual([]);
    expect(problems({})).toEqual([]);
    expect(problems({ slots: 'all', send: { dob: 'masked', expectedDate: 'as-is' } })).toEqual([]);
    expect(problems({ slots: ['missingNote', 'accountId'], send: { accountId: 'masked' } })).toEqual([]);
  });

  it('refuses a slot that is not one, in the list or under send', () => {
    expect(problems({ slots: ['acountId'] })).toEqual(['slots.0: slot "acountId" is not defined']);
    expect(problems({ send: { birthday: 'as-is' } })).toEqual(['send.birthday: slot "birthday" is not defined']);
  });

  it('refuses a way of sending that is not one of the three', () => {
    expect(problems({ send: { dob: 'clear' } })).toEqual(['send.dob: "clear" is not one of "omit", "masked", "as-is"']);
    expect(problems({ slots: 'some' })).toEqual(['slots: "some" is not "all", "none" or a list of slots']);
  });

  it('refuses a slot named twice in the list', () => {
    expect(problems({ slots: ['missingNote', 'missingNote'] })).toEqual(['slots.1: slot "missingNote" is listed twice']);
  });

  it('refuses a listed factor with no way of sending it, since a factor is left out unless send says how', () => {
    expect(problems({ slots: ['accountId'] })).toEqual(['slots.0: the slot "accountId" is listed, but as an identity factor it is omitted unless send says how it goes']);
    expect(problems({ slots: ['missingNote'], send: { missingNote: 'omit' } })).toEqual(['send.missingNote: the slot "missingNote" is listed, but send omits it']);
  });

  it('refuses a send for a slot that is never sent', () => {
    expect(problems({ slots: 'none', send: { dob: 'as-is' } })).toEqual(['send.dob: the slot "dob" is never sent, since slots is none']);
    expect(problems({ slots: ['missingNote'], send: { dob: 'masked' } })).toEqual(['send.dob: the slot "dob" is never sent, since slots does not list it']);
  });

  it('refuses masked for a slot with nothing to mask it by, which would send it as it is', () => {
    expect(problems({ send: { expectedDate: 'masked' } })).toEqual(['send.expectedDate: the slot "expectedDate" has no redact setting (or handoff: last4 or verified), so masked would send it as it is']);
  });

  it('validateApp refuses the same for an app built in code', () => {
    expect(() => validateApp(withData({ send: { birthday: 'as-is' } }))).toThrow(/handoff data: slot "birthday" is not defined/);
    expect(() => validateApp(withData({ slots: ['accountId'] }))).toThrow(/handoff data: the slot "accountId" is listed/);
    expect(() => validateApp(withData({ slots: ['missingNote'], send: { accountId: 'masked' } }))).toThrow(/never sent/);
    expect(() => validateApp(withData({ send: { dob: 'as-is' } }))).not.toThrow();
  });
});
