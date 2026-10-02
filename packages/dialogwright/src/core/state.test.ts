import { describe, expect, it } from 'vitest';
import { buildTurnState } from './state';
import { newSession, setForm } from './session';
import { useTestkit } from '../testing/apps';
import { CUSTOMERS } from '../testing/testkit/domain/data';
import { customerPrincipal } from '../testing/testkit/domain/principals';
import { VOICE_RELAY } from '../channel/caps';

useTestkit();

describe('buildTurnState', () => {
  it('buckets numbers, trims history and exposes candidate spans', () => {
    const s = setForm(newSession('s1', 0, VOICE_RELAY), 'track_parcel');
    s.promptedFor = 'accountId';
    s.slots.accountId!.attempts = 1;
    s.lastPromptId = 'ask_accountId';
    s.lastPromptText = "What's your account ID?";
    s.history = [1, 2, 3, 4].map((i) => ({ node: `n${i}`, intent: 'none', outcome: 'prompt' }));

    const ts = buildTurnState(s, { text: 'it is five five five zero', isFinal: true, dtmf: null }, 45_000);

    expect(ts.turn).toEqual({ attempt: 'second', elapsed: 'under_2m' });
    expect(ts.node).toEqual({ id: 'ask_accountId', promptJustPlayed: "What's your account ID?", options: [] });
    expect(ts.history.map((h) => h.node)).toEqual(['n2', 'n3', 'n4']);
    expect(ts.asr).toEqual({ text: 'it is five five five zero', isFinal: true, bargeIn: false, dtmf: null });
    expect(ts.candidateSpans).toContain('five five five zero');
    expect(ts.slots.accountId).toEqual({ value: null, confirmed: false });
    expect(ts.activeForm).toBe('track_parcel');
    expect(ts.pendingConfirmation).toBeNull();
  });

  it('shows the caller\'s assurance level, never who they are', () => {
    const s = newSession('s', 0, VOICE_RELAY);
    expect(buildTurnState(s, { text: 'x', isFinal: true, dtmf: null }, 0).caller).toEqual({ verified: false, level: 0, priorCalls: 0 });
    s.principal = customerPrincipal(CUSTOMERS[0]!, 2);
    const caller = buildTurnState(s, { text: 'x', isFinal: true, dtmf: null }, 0).caller;
    expect(caller).toEqual({ verified: true, level: 2, priorCalls: 0 });
    expect(JSON.stringify(caller)).not.toContain('55501234');
  });

  it('keeps a keypad buffer from the model at the code prompt, and shows it anywhere else', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'track_parcel');
    s.promptedFor = 'otp';
    expect(buildTurnState(s, { text: 'x', isFinal: true, dtmf: '123' }, 0).asr.dtmf).toBeNull();
    s.promptedFor = 'parcelSelect';
    expect(buildTurnState(s, { text: 'x', isFinal: true, dtmf: '47' }, 0).asr.dtmf).toBe('47');
  });

  it('exposes the spoken label of the active form', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'track_parcel');
    expect(buildTurnState(s, { text: 'x', isFinal: true, dtmf: null }, 0).activeFormLabel).toBe('track a parcel');
    expect(buildTurnState(newSession('s', 0, VOICE_RELAY), { text: 'x', isFinal: true, dtmf: null }, 0).activeFormLabel).toBeNull();
  });

  it('reports a pending slot confirmation by slot and spoken value', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'track_parcel');
    s.pendingConfirmation = { target: 'slot', slot: 'parcelSelect', value: '7101', display: '7101' };
    expect(buildTurnState(s, { text: 'x', isFinal: true, dtmf: null }, 0).pendingConfirmation).toEqual({ target: 'parcelSelect', value: '7101' });
  });

  it('shows the transfer offer to the model as what a yes buys', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'report_missing');
    s.pendingConfirmation = { target: 'transfer', attempts: 0 };
    expect(buildTurnState(s, { text: 'yes', isFinal: true, dtmf: null }, 0).pendingConfirmation)
      .toEqual({ target: 'transfer', value: 'connect you to a person' });
  });

  it('shows a form confirmation to the model as the form label', () => {
    const s = newSession('s', 0, VOICE_RELAY);
    s.form = 'report_missing';
    s.pendingConfirmation = { target: 'form', form: 'report_missing', attempts: 0 };
    expect(buildTurnState(s, { text: 'yes', isFinal: true, dtmf: null }, 0).pendingConfirmation).toEqual({ target: 'form', value: 'report a missing parcel' });
  });
});
