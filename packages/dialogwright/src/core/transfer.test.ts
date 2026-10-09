import { beforeEach, describe, expect, it } from 'vitest';
import { registerApp, resetAppsForTest } from './app/registry';
import { emptySlot, newSession, type Session } from './session';
import { VOICE_RELAY, WEB_CHAT } from '../channel/caps';
import { callbackApp } from '../testing/callback/app';
import { testkitApp } from '../testing/testkit';
import { handoff } from './decision';
import { chooseTransfer, resolveSend, sendOf, sentCallData, transferHeaderNames, transferValueOf, transferVariables } from './transfer';
import { decisionToActions } from '../prompts/render';
import { actionsToFrames } from '../channel/relay/map';
import { auditDrafts } from './audit';
import { speechEvent } from '../channel/events';
import { maskCollectedSlot, redactHandoffData, redactRecordSlots } from '../trace/redact';
import type { App } from './app/types';
import type { TraceRecord } from '../trace/types';

/**
 * Transfer targets and the data sent (design 2026-10-09-call-data-and-transfers, 2b decisions 1, 3, 4,
 * 6 and 7): the engine chooses the target on the reason, the form and the call data, in the app's
 * order, and resolves what goes with it as the records would have it; the choice rides the handoff
 * decision, the transfer action and the end frame by the variable's name, never the number. On
 * Example Callbacks (src/testing/callback), whose transfer routes the priority queue, the callback
 * desk and security.
 */

beforeEach(() => {
  resetAppsForTest();
  registerApp(callbackApp);
  registerApp(testkitApp);
});

function session(over: Partial<Session> = {}, channel = VOICE_RELAY): Session {
  return { ...newSession('s', 0, channel, undefined, callbackApp.id), ...over };
}

function withReason(s: Session, value: string, display: string): Session {
  s.slots.reason = { ...emptySlot(), value, display };
  return s;
}

describe('the value grammar', () => {
  it('reads reason, form, callData.<key> and slot.<id> as references, anything else as a constant', () => {
    expect(transferValueOf('reason')).toEqual({ kind: 'reason' });
    expect(transferValueOf('form')).toEqual({ kind: 'form' });
    expect(transferValueOf('callData.queue')).toEqual({ kind: 'callData', key: 'queue' });
    expect(transferValueOf('slot.reason')).toEqual({ kind: 'slot', slot: 'reason' });
    expect(transferValueOf('ivr')).toEqual({ kind: 'constant', value: 'ivr' });
    expect(transferValueOf('1')).toEqual({ kind: 'constant', value: '1' });
    expect(transferValueOf('callData.')).toEqual({ kind: 'constant', value: 'callData.' });
  });

  it('sends a call data key as its redact records it, floored by its source\'s name, a secret one never', () => {
    expect(sentCallData({ from: 'param.queue', redact: 'keep' }, 'priority')).toBe('priority');
    expect(sentCallData({ from: 'param.accountRef', redact: 'last4' }, 'AC-55501234')).toBe('...1234');
    expect(sentCallData({ from: 'param.accountRef' }, 'AC-55501234')).toBe('•');
    expect(sentCallData({ from: 'param.accountRef', redact: 'length' }, 'AC-55501234')).toBe('<11 chars>');
    expect(sentCallData({ from: 'param.accountRef', redact: 'secret' }, 'AC-55501234')).toBeNull();
    // Kept whole by its redact, but its source is named for a number: never more than the records keep.
    expect(sentCallData({ from: 'setup.forwardedFrom', redact: 'keep' }, '+15555550102')).toBe('…0102');
  });

  it('merges a rule\'s send over the top-level one, its own names winning', () => {
    const t = callbackApp.transfer!;
    expect(sendOf(t, 0).headers).toEqual({ 'X-Account-Ref': 'callData.accountRef', 'X-Reason': 'reason', 'X-Form': 'form', 'X-About': 'slot.reason', 'X-Source': 'ivr', 'X-Queue': 'callData.queue' });
    expect(sendOf(t, null).headers).not.toHaveProperty('X-Queue');
    expect(sendOf({ ...t, send: { headers: { 'X-Priority': '3' } } }, 2).headers).toEqual({ 'X-Priority': '1' });
    // A header's name is not case-sensitive: a rule's own replaces the top-level one, as the rule spells it, where it stood.
    expect(sendOf({ targets: [{ when: [], to: 'env.X', send: { headers: { 'x-reason': 'own' } } }], default: 'env.Y', send: { headers: { 'X-Reason': 'reason', 'X-Source': 'ivr' } } }, 0).headers)
      .toEqual({ 'x-reason': 'own', 'X-Source': 'ivr' });
    expect(Object.keys(sendOf({ targets: [{ when: [], to: 'env.X', send: { headers: { 'x-reason': 'own' } } }], default: 'env.Y', send: { headers: { 'X-Reason': 'reason', 'X-Source': 'ivr' } } }, 0).headers!)).toEqual(['x-reason', 'X-Source']);
    expect(transferVariables(t)).toEqual(['PRIORITY_LINE', 'CALLBACK_DESK', 'SECURITY_DESK', 'MAIN_LINE']);
    expect([...transferHeaderNames(t)]).toEqual(['x-account-ref', 'x-reason', 'x-form', 'x-about', 'x-source', 'x-queue', 'x-priority']);
  });

  it('leaves out a reference with nothing to send', () => {
    expect(resolveSend(callbackApp, { 'X-Form': 'form', 'X-Ref': 'callData.accountRef', 'X-About': 'slot.reason', 'X-Reason': 'reason' }, { reason: 'live-agent', form: null, callData: {}, slots: {} })).toEqual({ 'X-Reason': 'live-agent' });
  });
});

describe('the choice, in the app\'s order', () => {
  it('a call from the priority queue goes to the priority line whatever it is about, with its headers', () => {
    const s = withReason(session({ callData: { queue: 'priority', accountRef: 'AC-55501234' }, form: 'request_callback' }), 'bill', 'a bill');
    expect(handoff(s, 'max-attempts').transfer).toEqual({
      target: 'PRIORITY_LINE',
      rule: 0,
      headers: { 'X-Account-Ref': '...1234', 'X-Reason': 'max-attempts', 'X-Form': 'request_callback', 'X-About': 'a bill', 'X-Source': 'ivr', 'X-Queue': 'priority' },
      data: { reason: 'max-attempts' },
    });
  });

  it('a caller the callback form could not get through goes to the callback desk: both conditions hold', () => {
    const s = session({ form: 'request_callback' });
    expect(handoff(s, 'max-attempts').transfer).toMatchObject({ target: 'CALLBACK_DESK', rule: 1, headers: { 'X-Reason': 'max-attempts', 'X-Form': 'request_callback', 'X-Source': 'ivr' } });
    // One condition alone does not take the rule.
    expect(handoff(session({ form: 'request_callback' }), 'live-agent').transfer).toMatchObject({ target: 'MAIN_LINE', rule: null });
    expect(handoff(session(), 'max-attempts').transfer).toMatchObject({ target: 'MAIN_LINE', rule: null });
  });

  it('reads the last form completed when none is open', () => {
    expect(handoff(session({ completed: ['request_callback'] }), 'max-attempts').transfer).toMatchObject({ target: 'CALLBACK_DESK', headers: { 'X-Form': 'request_callback' } });
  });

  it('security goes to the security desk with its own header; anything else to the default', () => {
    expect(handoff(session(), 'security').transfer).toEqual({ target: 'SECURITY_DESK', rule: 2, headers: { 'X-Reason': 'security', 'X-Source': 'ivr', 'X-Priority': '1' }, data: { reason: 'security' } });
    expect(handoff(session(), 'live-agent').transfer).toEqual({ target: 'MAIN_LINE', rule: null, headers: { 'X-Reason': 'live-agent', 'X-Source': 'ivr' }, data: { reason: 'live-agent' } });
  });

  it('a slot goes as the handoff data sends it: left out when the data leaves it out', () => {
    const app: App = { ...callbackApp, handoff: { data: { slots: ['caller'] } } };
    expect(chooseTransfer(app, { reason: 'live-agent', form: null, callData: {}, slots: {} })?.headers).not.toHaveProperty('X-About');
    const s = withReason(session(), 'bill', 'a bill');
    expect(handoff(s, 'live-agent').transfer?.headers).toHaveProperty('X-About', 'a bill');
  });

  it('chooses nothing for an app without transfer: its handoff is as it was', () => {
    const s = newSession('t', 0, VOICE_RELAY, undefined, testkitApp.id);
    expect(handoff(s, 'live-agent')).not.toHaveProperty('transfer');
  });
});

describe('the choice travels by the variable\'s name, never the number', () => {
  it('on the transfer action and the end frame, with the headers', () => {
    const s = withReason(session({ callData: { queue: 'priority', accountRef: 'AC-55501234' } }), 'bill', 'a bill');
    const decision = handoff(s, 'live-agent');
    const actions = decisionToActions(callbackApp, decision);
    expect(actions.at(-1)).toMatchObject({ type: 'transfer', target: 'PRIORITY_LINE', headers: { 'X-Queue': 'priority', 'X-Account-Ref': '...1234' }, data: { reason: 'live-agent' } });
    const end = actionsToFrames(actions).at(-1)!;
    expect(end.type).toBe('end');
    const data = JSON.parse((end as { handoffData: string }).handoffData) as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(['reasonCode', 'slots', 'target', 'headers']);
    expect(data.target).toBe('PRIORITY_LINE');
    expect(data.headers).toEqual({ 'X-Account-Ref': '...1234', 'X-Reason': 'live-agent', 'X-About': 'a bill', 'X-Source': 'ivr', 'X-Queue': 'priority' });
  });

  it('an app without transfer sends the end frame it always did', () => {
    const plain = newSession('t', 0, VOICE_RELAY, undefined, testkitApp.id);
    const end = actionsToFrames(decisionToActions(testkitApp, handoff(plain, 'live-agent'))).at(-1) as { handoffData: string };
    expect(end.handoffData).toBe('{"reasonCode":"live-agent"}');
  });
});

describe('the records', () => {
  it('the audit\'s handoff row names the target and what was sent, by name only', () => {
    const s = session({ callData: { queue: 'priority', accountRef: 'AC-55501234' } });
    const input = { before: s, after: s, event: speechEvent('x'), gateEvents: [], kb: null, screen: null, quarantined: false };
    expect(auditDrafts({ ...input, decision: handoff(s, 'live-agent') })[0]).toEqual({
      type: 'handoff',
      detail: { reason: 'live-agent', completed: [], queued: [], target: 'PRIORITY_LINE', headers: ['X-Account-Ref', 'X-Reason', 'X-Source', 'X-Queue'] },
    });
    const chat = session({ callData: { page: '/orders/1042' } }, WEB_CHAT);
    expect(auditDrafts({ ...input, before: chat, after: chat, decision: handoff(chat, 'live-agent') })[0]?.detail).toEqual({ reason: 'live-agent', completed: [], queued: [], target: 'MAIN_LINE', data: ['reason', 'page'] });
  });

  it('a record masks a header sent from a redacted slot as it masks the slot', () => {
    const app: App = { ...callbackApp, slots: { ...callbackApp.slots, reason: { ...callbackApp.slots.reason!, redact: 'mask' } }, handoff: { data: { send: { reason: 'as-is' } } } };
    const masked = maskCollectedSlot(app, 'reason', 'a bill');
    expect(masked).not.toBe('a bill');
    const data = JSON.stringify({ reasonCode: 'live-agent', target: 'HANDOFF_NUMBER', headers: { 'X-About': 'a bill', 'X-Source': 'ivr' } });
    expect(JSON.parse(redactHandoffData(data, 'length', app))).toEqual({ reasonCode: 'live-agent', target: 'HANDOFF_NUMBER', headers: { 'X-About': masked, 'X-Source': 'ivr' } });
    // The trace's copy of the decision and the transfer action, the same.
    resetAppsForTest();
    registerApp(app);
    const s = withReason(session(), 'bill', 'a bill');
    const decision = handoff(s, 'live-agent');
    expect(decision.transfer?.headers?.['X-About']).toBe('a bill');
    const record = { decision, actions: decisionToActions(app, decision), slots: s.slots, event: speechEvent('x') } as unknown as TraceRecord;
    const redacted = redactRecordSlots(record, 'length', app);
    expect((redacted.decision as { transfer: { headers: Record<string, string> } }).transfer.headers['X-About']).toBe(masked);
    expect((redacted.decision as { transfer: { rule: number | null } }).transfer.rule).toBeNull();
    expect((redacted.actions.at(-1) as { headers: Record<string, string> }).headers['X-About']).toBe(masked);
  });
});
