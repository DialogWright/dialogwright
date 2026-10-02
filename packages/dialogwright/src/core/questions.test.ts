import { describe, expect, it } from 'vitest';
import { buildQuestions, ALWAYS_ON_IDS } from './questions';
import { newSession, setForm } from './session';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { useTestkit } from '../testing/apps';
import { testkitApp } from '../testing/testkit';
import { CUSTOMERS, PARCELS } from '../testing/testkit/domain/data';
import { FORM_INTENTS } from '../testing/testkit/domain/intents';
import { customerPrincipal } from '../testing/testkit/domain/principals';
import { ALL_SLOTS } from '../testing/testkit/domain/slots';
import type { SlotContext } from './slots/types';
import { VOICE_RELAY } from '../channel/caps';

useTestkit();

const ctx: SlotContext = {
  text: 'hi', candidateSpans: [], candidateWordSpans: [], todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS },
  window: null, current: null, records: [], prompted: false,
};
const verified = () => ({ ...newSession('s', 0, VOICE_RELAY), principal: customerPrincipal(CUSTOMERS[0]!, 2) });
const criteriaOf = (q: unknown): string[] => Object.keys((q as { criteria: Record<string, unknown> }).criteria);

describe('buildQuestions', () => {
  it('always includes the routing, control, caller and guard questions', () => {
    const q = buildQuestions(newSession('s', 0, VOICE_RELAY), ctx);
    for (const id of ALWAYS_ON_IDS) expect(q).toHaveProperty(id);
    expect(q.intent!.type).toBe('choice');
    expect(q.frustration!.type).toBe('score');
    expect(q.intelligible!.type).toBe('noul');
  });

  it('includes every slot fragment when no form is active, identity included for an anonymous caller', () => {
    const q = buildQuestions(newSession('s', 0, VOICE_RELAY), ctx);
    expect(q).toHaveProperty('containsAccountId');
    expect(q).toHaveProperty('dobGiven');
    expect(q).toHaveProperty('deliveryPart');
    expect(q).toHaveProperty('expectedDateMode');
    expect(q).toHaveProperty('describesParcel');
    // A verified caller is not asked for identity again.
    const v = buildQuestions(verified(), ctx);
    expect(v).not.toHaveProperty('containsAccountId');
    expect(v).not.toHaveProperty('dobGiven');
    expect(v).toHaveProperty('deliveryPart');
  });

  it('passes each slot its own pending partial into questions(), not the base context\'s window (which is always null from turn.ts)', () => {
    const s = newSession('s', 0, VOICE_RELAY);
    s.slots.dob!.window = { kind: 'dob', month: 4, day: 12 };
    const q = buildQuestions(s, ctx);
    expect((q.dobYear as { instructions: string }).instructions).toMatch(/asked for the year of their birth/);
  });

  it('includes only the active form slots, and the identity factors while the caller is anonymous', () => {
    const q = buildQuestions(setForm(verified(), 'report_missing'), ctx);
    expect(q).toHaveProperty('describesParcel');
    expect(q).toHaveProperty('expectedDateMode');
    expect(q).not.toHaveProperty('containsAccountId');
    expect(q).not.toHaveProperty('deliveryPart');
    const anon = buildQuestions(setForm(newSession('s', 0, VOICE_RELAY), 'report_missing'), ctx);
    expect(anon).toHaveProperty('containsAccountId');
    expect(anon).toHaveProperty('describesParcel');
  });

  it('asks nothing of a slot at the code prompt: a spoken turn there may be the code itself', () => {
    const s = setForm(verified(), 'track_parcel');
    s.promptedFor = 'otp';
    const q = buildQuestions(s, { ...ctx, text: 'one two three four five six, parcel 7101' });
    for (const id of ['containsAccountId', 'dobGiven', 'parcelChoice', 'deliveryPart', 'describesParcel', 'expectedDateMode']) expect(q, id).not.toHaveProperty(id);
    expect(q).toHaveProperty('intent');
  });

  it('offers parcels only once they are known or a number is said', () => {
    const s = setForm(verified(), 'track_parcel');
    expect(buildQuestions(s, ctx)).not.toHaveProperty('parcelChoice');
    const parcels = PARCELS.filter((p) => p.owner === CUSTOMERS[0]!.id);
    const listed = buildQuestions(s, { ...ctx, records: parcels });
    expect(criteriaOf(listed.parcelChoice)).toEqual(['parcel_7101', 'parcel_7102', 'parcel_7103', 'none']);
    const said = buildQuestions(s, { ...ctx, text: 'parcel 7201' });
    expect(criteriaOf(said.parcelChoice)).toEqual(['parcel_7201', 'none']);
  });

  it('adds confirmation questions when a confirmation is pending', () => {
    const s = newSession('s', 0, VOICE_RELAY);
    s.pendingConfirmation = { target: 'intent', intent: 'report_missing', answers: {}, text: '' };
    const q = buildQuestions(s, ctx);
    expect(q).toHaveProperty('confirmsYes');
    expect(q).toHaveProperty('confirmsNo');
  });

  it('adds the menu question when the dtmf menu is active', () => {
    const s = newSession('s', 0, VOICE_RELAY);
    s.menuActive = true;
    const q = buildQuestions(s, ctx).menuNumberSaid!;
    expect(q.type).toBe('choice');
    // JS objects always order integer-like string keys ascending before non-numeric keys,
    // regardless of insertion order (ECMAScript OrdinaryOwnPropertyKeys): 0 comes first.
    if (q.type === 'choice') expect(Object.keys(q.criteria)).toEqual(['0', '1', '2', '3', 'none']);
  });
});

describe('question redesign', () => {
  it('asks intentTentative always and never intentSecondary', () => {
    const q = buildQuestions(newSession('s', 0, VOICE_RELAY), ctx);
    expect(q.intentTentative?.type).toBe('noul');
    expect(q.intentSecondary).toBeUndefined();
    expect(q.intentChange).toBeUndefined();
  });

  it('asks intentChange only inside a form, with answering first', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'report_missing');
    const q = buildQuestions(s, ctx);
    expect(q.intentChange?.type).toBe('choice');
    if (q.intentChange?.type === 'choice') expect(Object.keys(q.intentChange.criteria)).toEqual(['answering', 'adding', 'replacing']);
  });

  it('asks which detail to change only while a form confirmation is pending', () => {
    const s = setForm(verified(), 'report_missing');
    expect(buildQuestions(s, ctx).changeSlot).toBeUndefined();
    s.pendingConfirmation = { target: 'form', form: 'report_missing', attempts: 0 };
    const q = buildQuestions(s, ctx);
    expect(q.changeSlot?.type).toBe('choice');
    expect(criteriaOf(q.changeSlot)).toEqual(['missingNote', 'expectedDate', 'none']);
    expect(q.confirmsYes).toBeDefined();
    expect(q.describesParcel).toBeDefined();
    expect(q.expectedDateMode).toBeDefined();
  });

  it('orders every slot of every form that reads a summary, so none is lost from the question', () => {
    const order = testkitApp.wording!.changeSlot!.order!;
    for (const form of Object.values(testkitApp.forms)) {
      if (form.summaryPromptId) for (const slot of form.slots) expect(order, slot).toContain(slot);
    }
    for (const slot of order) expect(ALL_SLOTS, slot).toContain(slot);
  });

  it('has a change-slot line for exactly the slots in the order', () => {
    const { order, text } = testkitApp.wording!.changeSlot!;
    expect(Object.keys(text!).sort()).toEqual([...order!].sort());
  });

  it('limits changeSlot to the slots on the pending form (never the identity factors, which no form lists)', () => {
    const s = setForm(verified(), 'report_missing');
    s.pendingConfirmation = { target: 'form', form: 'report_missing', attempts: 0 };
    const criteria = criteriaOf(buildQuestions(s, ctx).changeSlot);
    expect(criteria).not.toContain('accountId');
    expect(criteria).not.toContain('dob');
    expect(criteria).not.toContain('parcelSelect');
  });

  it('does not ask changeSlot for a slot-target confirmation', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'track_parcel');
    s.pendingConfirmation = { target: 'slot', slot: 'parcelSelect', value: '7101', display: '7101' };
    expect(buildQuestions(s, ctx).changeSlot).toBeUndefined();
  });

  it('asks for a second task only outside a form', () => {
    const s = newSession('s', 0, VOICE_RELAY);
    const q = buildQuestions(s, ctx);
    expect(q.secondIntent?.type).toBe('choice');
    expect(criteriaOf(q.secondIntent)).toEqual([...FORM_INTENTS, 'none']);
    setForm(s, 'report_missing');
    expect(buildQuestions(s, ctx).secondIntent).toBeUndefined();
  });

  it('asks the transfer offer\'s yes and no, and no detail to change', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'track_parcel');
    s.pendingConfirmation = { target: 'transfer', attempts: 0 };
    const q = buildQuestions(s, ctx);
    expect(q.confirmsYes).toBeDefined();
    expect(q.changeSlot).toBeUndefined();
  });
});
