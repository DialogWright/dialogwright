import { describe, expect, it } from 'vitest';
import { repliesOf, withReplies } from './replies';
import { decisionToActions } from '../prompts/render';
import type { App } from './app/types';
import type { PromptDecision } from './decision';
import { testkitApp } from '../testing/testkit';
import { testSlotContext } from '../testing/slots';
import { defineSlot } from '../slots/defineSlot';

/** Answer buttons on a chat (app.yaml's chat.replies; docs/designs/2026-10-18-chat-replies.md). */

const speed = defineSlot('speed', { type: 'choice', options: { standard: 'standard delivery', express: { say: 'express delivery', button: 'Express' } } });
const app = (over: Partial<App> = {}): App => ({ ...testkitApp, slots: { ...testkitApp.slots, speed }, chat: { replies: 'on' }, ...over });
const ask = (target: PromptDecision['target'], options: string[] = []): PromptDecision => ({ kind: 'prompt', promptId: 'x', vars: {}, acks: [], target, options });
const ctx = () => testSlotContext('');

describe('the answer buttons under a chat\'s question', () => {
  it('are Yes and No for a yes-or-no question, in the app\'s own words where it gives them', () => {
    expect(repliesOf(app(), ask('confirm', ['yes', 'no']), undefined, ctx)).toEqual(['Yes', 'No']);
    const own = app({ prompts: { ...testkitApp.prompts, manifest: { ...testkitApp.prompts.manifest, reply_yes: { text: 'Yes, please', interruptible: true }, reply_no: { text: 'No, thanks', interruptible: true } } } });
    expect(repliesOf(own, ask('confirm', ['yes', 'no']), 'en-US', ctx)).toEqual(['Yes, please', 'No, thanks']);
    // In another language with no words of the app's own: none, rather than English buttons.
    expect(repliesOf(app(), ask('confirm', ['yes', 'no']), 'es', ctx)).toBeNull();
  });

  it('are a slot\'s own answers at its question, never an identity factor\'s, and none for a question without a set', () => {
    expect(repliesOf(app(), ask('speed'), undefined, ctx)).toEqual(['Standard delivery', 'Express']);
    const factor = app().identity!.factorSlots[0]!;
    expect(repliesOf(app({ slots: { ...testkitApp.slots, speed, [factor]: speed } }), ask(factor), undefined, ctx)).toBeNull();
    expect(repliesOf(app(), ask('intent'), undefined, ctx)).toBeNull();
    expect(repliesOf(app(), ask('confirm', ['1', '2']), undefined, ctx)).toBeNull();
  });

  it('are none without chat.replies: on, and none for one answer or more than eight', () => {
    expect(repliesOf(app({ chat: undefined }), ask('confirm', ['yes', 'no']), undefined, ctx)).toBeNull();
    const many = defineSlot('many', { type: 'choice', options: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`o${i}`, `option ${i}`])) });
    expect(repliesOf(app({ slots: { ...testkitApp.slots, many } }), ask('many'), undefined, ctx)).toBeNull();
    const one = defineSlot('one', { type: 'choice', options: { only: 'the only one' } });
    expect(repliesOf(app({ slots: { ...testkitApp.slots, one } }), ask('one'), undefined, ctx)).toBeNull();
  });

  it('go on the line that asks, on a chat only', () => {
    const decision: PromptDecision = { kind: 'prompt', promptId: 'offer_transfer', vars: {}, acks: [{ promptId: 'nomatch_open', vars: {} }], target: 'confirm', options: ['yes', 'no'] };
    const lines = () => decisionToActions(app(), decision, null, undefined, { shown: true });
    const chat = withReplies(app(), decision, lines(), { shown: true, locale: undefined, ctx });
    expect(chat.map((a) => (a.type === 'say' ? a.replies : undefined))).toEqual([undefined, ['Yes', 'No']]);
    const call = withReplies(app(), decision, lines(), { shown: false, locale: undefined, ctx });
    expect(call.some((a) => a.type === 'say' && a.replies !== undefined)).toBe(false);
  });
});
