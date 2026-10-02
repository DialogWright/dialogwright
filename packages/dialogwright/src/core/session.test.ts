import { describe, expect, it } from 'vitest';
import { useTestkit } from '../testing/apps';
import { accountFact } from '../testing/testkit/domain/facts';
import { newSession, bucketAttempt, bucketElapsed, bucketPriorCalls, missingSlots, currentAttempts, setForm, cloneSession, closeForm } from './session';
import { CUSTOMERS } from '../testing/testkit/domain/data';
import { customerPrincipal } from '../testing/testkit/domain/principals';
import { ANONYMOUS } from '../gate/principal';
import { defaultAppId } from './app/registry';
import { VOICE_RELAY } from '../channel/caps';

useTestkit();

describe('session', () => {
  it('carries the id of its app, which survives a clone and a JSON round trip', () => {
    expect(newSession('s', 0, VOICE_RELAY).appId).toBe(defaultAppId());
    const s = newSession('s', 0, VOICE_RELAY, ANONYMOUS, 'testkit');
    expect(s.appId).toBe('testkit');
    expect(cloneSession(s).appId).toBe('testkit');
    expect(JSON.parse(JSON.stringify(s)).appId).toBe('testkit');
  });

  it('starts with no form and empty slots', () => {
    const s = newSession('s1', 1000, VOICE_RELAY);
    expect(s.form).toBeNull();
    expect(s.slots.accountId).toEqual({ value: null, display: null, confirmed: false, attempts: 0, window: null, helped: [] });
    expect(s.turnIndex).toBe(0);
  });

  it('starts anonymous, with no facts, no step-up, no entry and no confirmation armed', () => {
    const s = newSession('s1', 1000, VOICE_RELAY);
    expect(s.principal).toEqual({ kind: 'anonymous', level: 0 });
    expect(s.facts).toEqual({ account: null, parcels: null });
    expect(s.stepUp).toBeNull();
    expect(s.entered).toBeNull();
    expect(s.identityAttempts).toEqual({ factors: 0, code: 0 });
    expect(s.pendingHash).toBeNull();
    expect(s.confirmedHash).toBeNull();
    expect(s.pendingService).toBeNull();
  });

  it('copies the facts, the step-up and the identity attempts when cloning', () => {
    const s = newSession('s1', 0, VOICE_RELAY);
    s.facts.account = { id: '55501234', first: 'Alex', depotId: 'D1' };
    s.stepUp = { call: { tool: 'listParcels', params: { accountId: '' } }, need: 2 };
    const c = cloneSession(s);
    Object.assign(accountFact(c.facts)!, { first: 'changed' });
    c.stepUp!.call = { ...c.stepUp!.call, purpose: 'x' };
    c.identityAttempts.factors = 2;
    expect(accountFact(s.facts)!.first).toBe('Alex');
    expect(s.stepUp.call.purpose).toBeUndefined();
    expect(c.stepUp!.call.params).not.toBe(s.stepUp.call.params);
    expect(s.identityAttempts.factors).toBe(0);
    expect(c.facts.account).not.toBe(s.facts.account);
  });

  it('buckets attempts, elapsed time and prior calls', () => {
    expect(bucketAttempt(0)).toBe('first');
    expect(bucketAttempt(1)).toBe('second');
    expect(bucketAttempt(5)).toBe('third_or_more');
    expect(bucketElapsed(10_000)).toBe('under_30s');
    expect(bucketElapsed(90_000)).toBe('under_2m');
    expect(bucketElapsed(200_000)).toBe('over_2m');
    expect(bucketPriorCalls(0)).toBe('none');
    expect(bucketPriorCalls(1)).toBe('one');
    expect(bucketPriorCalls(3)).toBe('several');
  });

  it('lists missing slots for the active form in priority order, never the identity factors', () => {
    const s = setForm(newSession('s1', 0, VOICE_RELAY), 'report_missing');
    expect(missingSlots(s)).toEqual(['missingNote', 'expectedDate']);
    s.slots.missingNote!.value = 'a small brown box';
    expect(missingSlots(s)).toEqual(['expectedDate']);
  });

  it('reports the attempts of whatever was last prompted', () => {
    const s = setForm(newSession('s1', 0, VOICE_RELAY), 'track_parcel');
    s.promptedFor = 'accountId';
    s.slots.accountId!.attempts = 2;
    expect(currentAttempts(s)).toBe(2);
    s.promptedFor = 'intent';
    s.intentAttempts = 1;
    expect(currentAttempts(s)).toBe(1);
    // The keypad code has a ladder of its own.
    s.promptedFor = 'otp';
    s.codeReasks = 2;
    expect(currentAttempts(s)).toBe(2);
  });

  it('drops the step-up, the code ladder and the summary hash when a form is entered', () => {
    const s = newSession('s', 0, VOICE_RELAY);
    s.stepUp = { call: { tool: 'getAccount', params: { accountId: '' } }, need: 1 };
    s.codeReasks = 2;
    s.pendingHash = 'abc';
    const t = setForm(s, 'track_parcel');
    expect(t.stepUp).toBeNull();
    expect(t.codeReasks).toBe(0);
    expect(t.pendingHash).toBeNull();
  });

  it('closes a form: its own slots, entry and parcels go; identity, the account and the caller\'s level stay', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'track_parcel');
    s.principal = customerPrincipal(CUSTOMERS[0]!, 2);
    s.slots.accountId!.value = '55501234';
    s.slots.parcelSelect!.value = '7101';
    s.entered = 'track_parcel';
    s.facts.parcels = [];
    s.facts.account = { id: '55501234', first: 'Alex', depotId: 'D1' };
    s.confirmedHash = 'x';
    closeForm(s);
    expect(s.form).toBeNull();
    expect(s.entered).toBeNull();
    expect(s.slots.parcelSelect!.value).toBeNull();
    expect(s.slots.accountId!.value).toBe('55501234');
    expect(s.facts.parcels).toBeNull();
    expect(s.facts.account).not.toBeNull();
    expect(s.confirmedHash).toBeNull();
    expect(s.principal.level).toBe(2);
  });

  it('cloneSession copies slot windows and help lists', () => {
    const s = newSession('s1', 0, VOICE_RELAY);
    s.slots.dob!.window = { kind: 'dob', month: 3, day: 5 };
    s.slots.parcelSelect!.helped = ['parcel_help'];
    const clone = cloneSession(s);
    clone.slots.dob!.window!.day = 6;
    expect(s.slots.dob!.window.day).toBe(5);
    expect(clone.slots.dob!.window).not.toBe(s.slots.dob!.window);
    expect(clone.slots.parcelSelect!.helped).toEqual(s.slots.parcelSelect!.helped);
    expect(clone.slots.parcelSelect!.helped).not.toBe(s.slots.parcelSelect!.helped);
  });

  it('starts with no frustrated turns and the transfer offer never declined', () => {
    const s = newSession('s1', 0, VOICE_RELAY);
    expect(s.frustratedTurns).toBe(0);
    expect(s.transferDeclined).toBe(false);
  });

  it('cloneSession copies the transfer offer, attempts and all, by value', () => {
    const s = newSession('s1', 0, VOICE_RELAY);
    s.pendingConfirmation = { target: 'transfer', attempts: 1 };
    s.frustratedTurns = 2;
    const clone = cloneSession(s);
    clone.pendingConfirmation = { target: 'transfer', attempts: 2 };
    clone.frustratedTurns = 3;
    expect(s.pendingConfirmation).toEqual({ target: 'transfer', attempts: 1 });
    expect(s.frustratedTurns).toBe(2);
  });

  it('counts no attempts against the transfer offer', () => {
    const s = newSession('s1', 0, VOICE_RELAY);
    s.promptedFor = 'confirm';
    s.pendingConfirmation = { target: 'transfer', attempts: 1 };
    // The offer's own silences are counted on the pending object, not on the intent ladder.
    expect(currentAttempts(s)).toBe(0);
  });

  it('has seven slots: the two identity factors and the forms\' own', () => {
    const s = newSession('s1', 0, VOICE_RELAY);
    expect(Object.keys(s.slots).sort()).toEqual(['accountId', 'deliveryDay', 'deliveryPart', 'dob', 'expectedDate', 'missingNote', 'parcelSelect']);
  });

  it('cloneSession copies a dob partial by value', () => {
    const s = newSession('s1', 0, VOICE_RELAY);
    s.slots.dob!.window = { kind: 'dob', month: 3, day: 5 };
    const clone = cloneSession(s);
    clone.slots.dob!.window = { kind: 'dob', month: 3, day: 6 };
    expect(s.slots.dob!.window).toEqual({ kind: 'dob', month: 3, day: 5 });
    expect(clone.slots.dob!.window).not.toBe(s.slots.dob!.window);
  });

  it('starts with nothing queued or completed and clones both', () => {
    const s = newSession('s', 0, VOICE_RELAY);
    expect(s.queued).toEqual([]);
    expect(s.completed).toEqual([]);
    s.queued.push('track_parcel');
    s.completed.push('delivery_window');
    const c = cloneSession(s);
    c.queued.push('report_missing');
    expect(s.queued).toEqual(['track_parcel']);
    expect(c.completed).toEqual(['delivery_window']);
  });

  describe('confirm target', () => {
    it('reports the form confirmation attempts as the current attempts', () => {
      const s = newSession('s', 0, VOICE_RELAY);
      s.promptedFor = 'confirm';
      s.pendingConfirmation = { target: 'form', form: 'report_missing', attempts: 2 };
      expect(currentAttempts(s)).toBe(2);
      expect(cloneSession(s).pendingConfirmation).toEqual({ target: 'form', form: 'report_missing', attempts: 2 });
    });
  });
});
