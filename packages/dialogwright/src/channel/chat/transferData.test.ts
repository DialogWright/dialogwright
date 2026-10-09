import { beforeEach, describe, expect, it } from 'vitest';
import { registerApp, resetAppsForTest } from '../../core/app/registry';
import { newSession, type Session } from '../../core/session';
import { WEB_CHAT } from '../caps';
import { callbackApp } from '../../testing/callback/app';
import { testkitApp } from '../../testing/testkit';
import { handoff } from '../../core/decision';
import { decisionToActions } from '../../prompts/render';
import { actionsToChatMessages } from './protocol';

/**
 * A chat's transfer message (design 2026-10-09-call-data-and-transfers, 2b decision 6): `data`, what the
 * app's transfer sends a chat (app.yaml's transfer.send.chat), beside the reason, only when written.
 */

beforeEach(() => {
  resetAppsForTest();
  registerApp(callbackApp);
  registerApp(testkitApp);
});

function session(over: Partial<Session> = {}): Session {
  return { ...newSession('s', 0, WEB_CHAT, undefined, callbackApp.id), ...over };
}

describe('the chat transfer message', () => {
  it('a chat\'s transfer message carries the data, and only when the app writes it', () => {
    const s = session({ callData: { page: '/orders/1042' } });
    const messages = actionsToChatMessages(decisionToActions(callbackApp, handoff(s, 'live-agent')), 'en-US');
    expect(messages.find((m) => m.type === 'transfer')).toEqual({ type: 'transfer', reason: 'live-agent', data: { reason: 'live-agent', page: '/orders/1042' } });
    const plain = newSession('t', 0, WEB_CHAT, undefined, testkitApp.id);
    expect(actionsToChatMessages(decisionToActions(testkitApp, handoff(plain, 'live-agent')), 'en-US').find((m) => m.type === 'transfer')).toEqual({ type: 'transfer', reason: 'live-agent' });
  });

});
