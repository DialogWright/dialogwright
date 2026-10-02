import { describe, expect, it } from 'vitest';
import { keyEvents, speechEvent, startEvent, textEvent } from './events';
import { endAction, sayAction, sayText, transferAction } from './actions';
import { VOICE_RELAY, WEB_CHAT } from './caps';

describe('channel model', () => {
  it('builds events', () => {
    expect(speechEvent('hello')).toEqual({ type: 'user.speech', text: 'hello', final: true, lang: 'en-US' });
    expect(speechEvent('hel', false).final).toBe(false);
    expect(textEvent('hi')).toEqual({ type: 'user.text', text: 'hi' });
    expect(keyEvents('12')).toEqual([{ type: 'user.key', digit: '1' }, { type: 'user.key', digit: '2' }]);
    expect(startEvent({ callSid: 'CA1' })).toEqual({ type: 'session.start', provider: { callSid: 'CA1' } });
  });
  it('joins what is said', () => {
    const actions = [sayAction([{ text: 'one' }, { audio: 'https://x/a.mp3' }, { text: 'two' }], true), endAction(['track_parcel'])];
    expect(sayText(actions)).toBe('one two');
  });
  it('separates an ending from a transfer', () => {
    expect(endAction(['delivery_window'])).toEqual({ type: 'end', completed: ['delivery_window'] });
    expect(transferAction('live-agent', [], ['report_missing'], { dob: 'verified' })).toEqual({
      type: 'transfer', reason: 'live-agent', completed: [], queued: ['report_missing'], slots: { dob: 'verified' },
    });
  });
  it('declares voice and chat by capability', () => {
    expect(VOICE_RELAY.caps).toEqual({ speech: true, keypad: true, bargeIn: true, recordedAudio: true, richUi: false, signIn: false, async: false });
    expect(WEB_CHAT.caps).toEqual({ speech: false, keypad: false, bargeIn: false, recordedAudio: false, richUi: true, signIn: true, async: false });
    expect([VOICE_RELAY.kind, WEB_CHAT.kind]).toEqual(['voice', 'chat']);
  });
});
