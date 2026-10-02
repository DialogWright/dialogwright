import { describe, expect, it } from 'vitest';
import { choice, describeDay, noul, resolveTurn, speechEvent, type AnswerMap, type TurnResult } from 'dialogwright';
import {
  ADDING, ANSWERING, DOB, HIGH, NAME, NO, TODAY, UNANSWERED, YES, answers, calls, heard, intent, key, provider,
  rescheduleAtSummary, rescheduleToDay, say, silence, started, tc, timeOfDay, turnContext, weekday,
} from '../testing/turns';
import { DAYPART_ORDER, DemoDirectory, daypartOf, type AppointmentDirectory, type Booking, type Daypart } from './directory';
import { ClinicSystems } from './tools';
import { factsOf } from './facts';
import { buildOffer, describeWhen } from './scheduling';

const dir = new DemoDirectory(TODAY);
const ME = ['morgan ellis', '1975-06-14'] as const;
// The demo seed gives Dr. Chen 8:30 AM, 10:00 AM and 12:30 PM on Tuesday 2026-09-22: two mornings
// and a midday, nothing in the afternoon.
const TUESDAY = '2026-09-22';
const CHEN_TUESDAY = dir.openings('chen', TUESDAY);

const varsOf = (r: TurnResult): Record<string, string> => (r.decision.kind === 'prompt' || r.decision.kind === 'complete' ? r.decision.vars : {});
const offerOf = (r: TurnResult) => factsOf(r.session).offer!;
const indexAt = (r: TurnResult): number => offerOf(r).index;
const whenAt = (r: TurnResult): string => describeWhen(offerOf(r).date, offerOf(r).times[offerOf(r).index]!);

/** Says the name, then the birthday. */
function identify(r: TurnResult): TurnResult {
  const named = say(r.session, 'morgan ellis', { intentChange: ANSWERING, ...NAME });
  return say(named.session, 'june fourteenth nineteen seventy five', { intentChange: ANSWERING, ...DOB });
}
const confirmWithChen = (): TurnResult => identify(say(started(), 'confirm my appointment with dr chen', { ...intent('confirm_appointment'), ...provider('chen') }));
const cancelWithPatel = (): TurnResult => identify(say(started(), 'cancel with dr patel', { ...intent('cancel'), ...provider('patel') }));

/** At the summary, a time preference: neither a yes nor a clear no (the unanswered path), or with a clear no (the rejected path). */
const pref = (r: TurnResult, text: string, timePreference: AnswerMap[string], over: AnswerMap = {}): TurnResult => say(r.session, text, { ...UNANSWERED, timePreference, ...over });
const noPref = (r: TurnResult, text: string, timePreference: AnswerMap[string]): TurnResult => say(r.session, text, { ...NO, timePreference });
const LATER = choice({ later: 0.9, none: 0.1 });
const EARLIER = choice({ earlier: 0.9, none: 0.1 });
const DIFFERENT = choice({ different: 0.9, none: 0.1 });
/** "Not that doctor, make it Dr. Alvarez" at a summary. */
const TO_ALVAREZ: AnswerMap = { ...NO, changeSlot: choice({ provider: 0.85, none: 0.15 }), ...provider('alvarez') };

describe('buildOffer', () => {
  it('opens inside the part of the day, or at the nearest by clock distance', () => {
    expect(buildOffer('chen', '2026-10-06', ['9:15 AM', '11:15 AM', '1:00 PM'], 'afternoon')).toEqual({ offer: { provider: 'chen', date: '2026-10-06', times: ['9:15 AM', '11:15 AM', '1:00 PM'], index: 2 }, nearest: true });
    expect(buildOffer('chen', '2026-10-06', ['11:15 AM', '2:45 PM', '4:15 PM'], 'morning')).toEqual({ offer: { provider: 'chen', date: '2026-10-06', times: ['11:15 AM', '2:45 PM', '4:15 PM'], index: 0 }, nearest: true });
    expect(buildOffer('chen', '2026-10-06', ['9:15 AM', '2:45 PM', '4:15 PM'], 'afternoon')).toMatchObject({ offer: { index: 1 }, nearest: false });
    expect(buildOffer('chen', '2026-10-06', ['9:15 AM', '2:45 PM'], null)).toMatchObject({ offer: { index: 0 }, nearest: false });
  });
});

describe('bookings', () => {
  it('reads the found booking back on a confirm summary, looked up through the gate', () => {
    const r = confirmWithChen();
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_appointment_details', target: 'confirm' });
    const found = dir.find(...ME, 'chen');
    expect(factsOf(r.session).existing).toEqual(found);
    expect(varsOf(r).existing).toBe(describeWhen(found.date, found.time));
    expect(heard(r)).toContain(`It's on ${describeDay(found.date)} at ${found.time}, for Morgan Ellis`);
    expect(calls(r)).toEqual(['findAppointment:ALLOW']);
    const done = say(r.session, 'yes', YES);
    expect(done.decision).toMatchObject({ kind: 'complete', promptId: 'appointment_details' });
    expect(calls(done)).toEqual([]);
  });

  it("offers the day's first opening on a reschedule summary", () => {
    const r = rescheduleAtSummary();
    expect(offerOf(r)).toEqual({ provider: 'chen', date: TUESDAY, times: CHEN_TUESDAY, index: 0 });
    expect(varsOf(r)).toMatchObject({ when: `Tuesday, September 22 at ${CHEN_TUESDAY[0]}`, time: CHEN_TUESDAY[0] });
    expect(CHEN_TUESDAY).toEqual(['8:30 AM', '10:00 AM', '12:30 PM']);
  });

  it('opens the offer inside a part of the day said on the opener, or at the nearest with a line', () => {
    const opener = (part: Daypart) => say(started(), `reschedule with dr chen in the ${part}`, { ...intent('reschedule'), ...provider('chen'), ...timeOfDay(part) });
    const atSummary = (part: Daypart) => say(identify(opener(part)).session, 'tuesday', { intentChange: ANSWERING, ...weekday('tuesday') });
    const midday = atSummary('midday');
    expect(factsOf(midday.session).daypart).toBe('midday');
    expect(daypartOf(CHEN_TUESDAY[indexAt(midday)]!)).toBe('midday');
    expect(midday.decision).toMatchObject({ acks: [] });
    const afternoon = atSummary('afternoon');
    expect(afternoon.decision).toMatchObject({ promptId: 'confirm_reschedule', acks: [{ promptId: 'slot_nearest', vars: { daypart: 'afternoon', time: '12:30 PM' } }] });
    expect(heard(afternoon)).toMatch(/^The closest I have to the afternoon is 12:30 PM\. Your appointment with Dr\. Chen/);
  });

  it("keeps the opener's part of the day through an explicit intent check, and a yes that names one wins", () => {
    const opener = say(started(), 'maybe reschedule with dr chen in the morning', { intent: choice({ reschedule: 0.5, none: 0.5 }), ...provider('chen'), ...timeOfDay('morning') });
    expect(opener.decision).toMatchObject({ promptId: 'confirm_intent_explicit' });
    const plain = say(opener.session, 'yes', { confirmsYes: noul(0.9), confirmsNo: noul(0.1) });
    expect(plain.session.form).toBe('reschedule');
    expect(factsOf(plain.session).daypart).toBe('morning');
    const afternoon = say(opener.session, 'yes, in the afternoon', { confirmsYes: noul(0.9), confirmsNo: noul(0.1), ...timeOfDay('afternoon') });
    expect(afternoon.session.form).toBe('reschedule');
    expect(factsOf(afternoon.session).daypart).toBe('afternoon');
  });

  it('takes no part of the day from side speech or a held partial', () => {
    const inForm = say(started(), 'reschedule with dr chen', { ...intent('reschedule'), ...provider('chen') }).session;
    const aside = say(inForm, 'honey, the afternoon is no good', { addressedToSystem: noul(0.1), ...timeOfDay('afternoon') });
    expect(aside.decision).toEqual({ kind: 'ignore' });
    expect(factsOf(aside.session).daypart).toBeNull();
    const held = resolveTurn(inForm, speechEvent('the morn', false), answers({ utteranceComplete: noul(0.2), ...timeOfDay('morning') }), tc);
    expect(held.decision).toEqual({ kind: 'hold' });
    expect(factsOf(held.session).daypart).toBeNull();
  });

  it('rebuilds the offer when a correction moves the day', () => {
    const r = say(rescheduleAtSummary().session, 'no, Thursday', { ...NO, ...weekday('thursday') });
    expect(offerOf(r)).toMatchObject({ date: '2026-09-24', index: 0 });
    expect(varsOf(r).when).toContain('Thursday, September 24 at');
  });

  it('clears the offer and the booking for a chained form, and carries the caller and the part of the day', () => {
    const s = rescheduleAtSummary().session;
    factsOf(s).daypart = 'afternoon';
    const r = say(s, 'yes, and also my bill', { ...YES, intentChange: ADDING, intent: choice({ billing: 0.9, none: 0.1 }) });
    expect(r.session.form).toBe('billing');
    // The completion line was rendered before the reset, so it still names the booked opening.
    expect(heard(r)).toContain(`Your appointment is moved to Tuesday, September 22 at ${CHEN_TUESDAY[0]}.`);
    expect(r.decision).toMatchObject({ promptId: 'ask_memberId', acks: [{ promptId: 'reschedule_confirmed' }, { promptId: 'bridge_next', vars: { intentLabel: 'talk to billing' } }] });
    expect(factsOf(r.session)).toMatchObject({ offer: null, existing: null, summaryHeard: null, daypart: 'afternoon' });
    expect(r.session.slots.name).toMatchObject({ value: 'morgan ellis' });
    expect(r.session.slots.dob).toMatchObject({ value: '1975-06-14' });
    expect(r.session.slots.provider).toMatchObject({ value: null });
  });

  it('asks only for the provider on a second appointment task: the caller carried over', () => {
    const r = say(rescheduleAtSummary().session, 'yes, and cancel my other one', { ...YES, intentChange: ADDING, intent: choice({ cancel: 0.9, none: 0.1 }) });
    expect(r.session.form).toBe('cancel');
    expect(r.decision).toMatchObject({ promptId: 'ask_provider' });
    const summary = say(r.session, 'dr patel', { intentChange: ANSWERING, ...provider('patel') });
    expect(summary.decision).toMatchObject({ promptId: 'confirm_cancel', vars: { name: 'Morgan Ellis', provider: 'Dr. Patel' } });
  });
});

describe('bookings follow corrections', () => {
  it("reads the corrected doctor back with that doctor's booking and openings", () => {
    const r = say(rescheduleAtSummary().session, 'not that doctor, make it Dr. Alvarez', TO_ALVAREZ);
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_reschedule' });
    expect(factsOf(r.session).existing).toEqual(dir.find(...ME, 'alvarez'));
    expect(offerOf(r)).toEqual({ provider: 'alvarez', date: TUESDAY, times: dir.openings('alvarez', TUESDAY), index: 0 });
    // The doctor and the day in one breath.
    const both = say(rescheduleAtSummary().session, 'no, Thursday with Dr. Alvarez', { ...NO, ...provider('alvarez'), ...weekday('thursday') });
    expect(offerOf(both)).toMatchObject({ provider: 'alvarez', date: '2026-09-24', times: dir.openings('alvarez', '2026-09-24') });
  });

  it("reads the corrected doctor's booking back on a confirm summary", () => {
    const r = say(confirmWithChen().session, 'not that doctor, make it Dr. Alvarez', TO_ALVAREZ);
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_appointment_details' });
    const found = dir.find(...ME, 'alvarez');
    expect(varsOf(r)).toMatchObject({ provider: 'Dr. Alvarez', existing: describeWhen(found.date, found.time) });
  });

  it('completes on the keypad 1 with the offered opening', () => {
    const r = key(rescheduleAtSummary().session, '1');
    expect(r.decision).toMatchObject({ kind: 'complete', promptId: 'reschedule_confirmed' });
    expect(heard(r)).toContain(`Your appointment is moved to Tuesday, September 22 at ${CHEN_TUESDAY[0]}.`);
    expect(calls(r)).toEqual(['moveAppointment:ALLOW']);
  });

  it('offers no opening on a cancel summary, and cancels the booking read back on yes', () => {
    const r = cancelWithPatel();
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_cancel' });
    expect(factsOf(r.session).offer).toBeNull();
    expect(varsOf(r)).toMatchObject({ when: '', time: '' });
    expect(varsOf(r).existing).not.toBe('');
    const done = say(r.session, 'yes', YES);
    expect(done.decision).toMatchObject({ kind: 'complete', promptId: 'cancel_confirmed' });
    const found = dir.find(...ME, 'patel');
    expect(done.gateEvents[0]!.decision.call).toMatchObject({ tool: 'cancelAppointment', params: { provider: 'patel', date: found.date, time: found.time } });
  });

  it('builds the offer for a summary a transfer offer displaced, once two silences decline it', () => {
    const s = rescheduleToDay().session;
    s.frustratedTurns = 1;
    const offered = say(s, 'ugh, come on, Tuesday', { intentChange: ANSWERING, frustration: HIGH, ...weekday('tuesday') });
    expect(offered.decision).toMatchObject({ kind: 'prompt', promptId: 'offer_transfer' });
    expect(offered.session.slots.date!.value).toBe(TUESDAY);
    expect(factsOf(offered.session).offer).toBeNull();
    expect(calls(offered)).toEqual([]);
    const two = silence(silence(offered.session).session);
    expect(two.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_reschedule' });
    expect(offerOf(two)).toMatchObject({ provider: 'chen', date: TUESDAY });
  });

  it('builds no offer before the summary, and keeps a built one across a keypad 2, then a spoken day', () => {
    expect(factsOf(rescheduleToDay().session).offer).toBeNull();
    const asked = rescheduleAtSummary();
    const change = key(asked.session, '2');
    expect(change.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_change', vars: {} });
    expect(factsOf(change.session).offer).toEqual(offerOf(asked));
    const moved = say(change.session, 'Thursday', { ...UNANSWERED, ...weekday('thursday') });
    expect(moved.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_time' });
    expect(offerOf(moved)).toMatchObject({ provider: 'chen', date: '2026-09-24' });
  });

  it('reads the summary again, not books, when the yes carries a new day (R3)', () => {
    const r = say(rescheduleAtSummary().session, 'yes, but Thursday', { ...YES, ...weekday('thursday') });
    expect(calls(r)).toEqual(['moveAppointment:BLOCK', 'findAppointment:ALLOW', 'listOpenings:ALLOW']);
    expect(r.gateEvents[0]!.decision).toMatchObject({ verdict: 'BLOCK', reason: 'confirmation' });
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_time', target: 'confirm' });
    expect(heard(r)).toBe(`Thursday, September 24 at ${dir.openings('chen', '2026-09-24')[0]}. Does that work?`);
    const done = say(r.session, 'yes', YES);
    expect(done.decision).toMatchObject({ kind: 'complete', promptId: 'reschedule_confirmed', vars: { date: 'Thursday, September 24' } });
    expect(calls(done)).toEqual(['moveAppointment:ALLOW']);
  });
});

describe('nothing to act on', () => {
  /** A directory that finds no booking for anyone, and has nothing open on Tuesday (another day, the demo's openings). */
  class SparseDirectory implements AppointmentDirectory {
    find(): Booking | null {
      return null;
    }
    openings(provider: string, date: string): string[] {
      return date === TUESDAY ? [] : dir.openings(provider, date);
    }
  }
  class SparseSystems extends ClinicSystems {
    override directory(): AppointmentDirectory {
      return new SparseDirectory();
    }
  }
  const sparse = () => {
    const base = turnContext();
    return { ...base, tools: { ...base.tools, sys: new SparseSystems() } };
  };
  const at = (ctx: ReturnType<typeof sparse>, opener: string, form: string, who: string): TurnResult => {
    let r = say(started(ctx), opener, { ...intent(form), ...provider(who) }, ctx);
    r = say(r.session, 'morgan ellis', { intentChange: ANSWERING, ...NAME }, ctx);
    return say(r.session, 'june fourteenth nineteen seventy five', { intentChange: ANSWERING, ...DOB }, ctx);
  };
  const writes = (r: TurnResult) => calls(r).filter((c) => /^(book|move|cancel)Appointment/.test(c));

  it('says no booking was found on a confirm or cancel summary, and hands a yes to a person without writing', () => {
    for (const [form, summary] of [['confirm_appointment', 'confirm_appointment_details'], ['cancel', 'confirm_cancel']] as const) {
      const ctx = sparse();
      const r = at(ctx, `${form} with dr chen`, form, 'chen');
      expect(r.decision, form).toMatchObject({ kind: 'prompt', promptId: 'no_appointment_found', target: 'confirm' });
      expect(r.decision, form).not.toMatchObject({ promptId: summary });
      expect(heard(r)).toBe("I couldn't find an appointment with Dr. Chen for Morgan Ellis, born June 14th, 1975. Are those details right?");
      expect(calls(r)).toEqual(['findAppointment:ALLOW']);
      const yes = say(r.session, 'yes', YES, ctx);
      expect(yes.decision, form).toMatchObject({ kind: 'handoff', reason: 'needs-human' });
      expect(writes(yes), form).toEqual([]);
      // The keypad's 1 is a yes to the same line.
      const keyed = key(r.session, '1', ctx);
      expect(keyed.decision, form).toMatchObject({ kind: 'handoff', reason: 'needs-human' });
      expect(writes(keyed), form).toEqual([]);
    }
  });

  it('says no booking was found on a reschedule summary, before any opening, and writes nothing on yes', () => {
    const ctx = sparse();
    const r = say(at(ctx, 'reschedule with dr chen', 'reschedule', 'chen').session, 'Wednesday', { intentChange: ANSWERING, ...weekday('wednesday') }, ctx);
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'no_appointment_found' });
    const yes = say(r.session, 'yes', YES, ctx);
    expect(yes.decision).toMatchObject({ kind: 'handoff', reason: 'needs-human' });
    expect(writes(yes)).toEqual([]);
  });

  it('says a full day has no openings, takes another day on a no, and books nothing on yes', () => {
    const ctx = sparse();
    const r = say(at(ctx, 'book with dr chen', 'schedule_new', 'chen').session, 'Tuesday', { intentChange: ANSWERING, ...weekday('tuesday') }, ctx);
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'no_openings', target: 'confirm' });
    expect(heard(r)).toBe('Dr. Chen has no openings on Tuesday, September 22. Is that the day you wanted?');
    expect(calls(r)).toEqual(['listOpenings:ALLOW']);
    const yes = say(r.session, 'yes', YES, ctx);
    expect(yes.decision).toMatchObject({ kind: 'handoff', reason: 'needs-human' });
    expect(writes(yes)).toEqual([]);
    // A no and another day: the full summary with that day's first opening.
    const no = say(r.session, 'no', NO, ctx);
    expect(no.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_change' });
    const thursday = say(no.session, 'Thursday', { ...UNANSWERED, ...weekday('thursday') }, ctx);
    expect(thursday.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_schedule' });
    expect(whenAt(thursday)).toBe(`Thursday, September 24 at ${dir.openings('chen', '2026-09-24')[0]}`);
    const booked = say(thursday.session, 'yes', YES, ctx);
    expect(booked.decision).toMatchObject({ kind: 'complete', promptId: 'schedule_confirmed' });
    expect(writes(booked)).toEqual(['bookAppointment:ALLOW']);
  });
});

describe('moving the offer', () => {
  describe('the short re-read', () => {
    it('reads the whole summary once, then only the day and time as the offer moves', () => {
      const first = rescheduleAtSummary();
      expect(heard(first)).toContain('for Morgan Ellis, born June 14th, 1975');
      const moved = pref(first, 'later', LATER);
      expect(moved.decision).toMatchObject({ promptId: 'confirm_time', target: 'confirm', options: ['yes', 'no'] });
      expect(heard(moved)).toBe(`${whenAt(moved)}. Does that work?`);
      expect(moved.session.pendingConfirmation).toMatchObject({ target: 'form', readAs: 'confirm_time' });
    });

    it('puts the edge line in front of the short re-read', () => {
      const r = pref(rescheduleAtSummary(), 'earlier', EARLIER);
      expect(heard(r)).toBe(`That's the earliest opening that day. ${whenAt(r)}. Does that work?`);
    });

    it('reads the whole summary again when the doctor changes', () => {
      const r = say(pref(rescheduleAtSummary(), 'later', LATER).session, 'not that doctor, make it Dr. Alvarez', TO_ALVAREZ);
      expect(r.session.slots.provider!.value).toBe('alvarez');
      expect(r.decision).toMatchObject({ promptId: 'confirm_reschedule' });
      expect(heard(r)).toContain('Your appointment with Dr. Alvarez is on');
    });

    it('books on yes, and on keypad 1, from the short re-read', () => {
      const moved = pref(rescheduleAtSummary(), 'later', LATER);
      const yes = say(moved.session, 'yes', YES);
      expect(yes.decision).toMatchObject({ kind: 'complete', promptId: 'reschedule_confirmed' });
      expect(heard(yes)).toContain(`Your appointment is moved to ${whenAt(moved)}.`);
      expect(calls(yes)).toEqual(['moveAppointment:ALLOW']);
      expect(key(moved.session, '1').decision).toMatchObject({ kind: 'complete', promptId: 'reschedule_confirmed' });
    });

    it('keeps a cancel summary whole on every re-read', () => {
      const r = say(cancelWithPatel().session, 'hmm', { ...UNANSWERED, confirmsNo: noul(0.1) });
      expect(r.decision).toMatchObject({ promptId: 'confirm_cancel' });
    });
  });

  it('moves later and earlier one opening at a time, re-arming the summary (unanswered path)', () => {
    let r = pref(rescheduleAtSummary(), 'later', LATER);
    expect(r.verdict?.kind).toBe('confirm_unanswered');
    expect(indexAt(r)).toBe(1);
    expect(r.decision).toMatchObject({ promptId: 'confirm_time', acks: [] });
    expect(varsOf(r).when).toContain(CHEN_TUESDAY[1]!);
    expect(r.session.pendingConfirmation).toMatchObject({ target: 'form', attempts: 0 });
    r = pref(r, 'earlier please', EARLIER);
    expect(indexAt(r)).toBe(0);
  });

  it('moves on a clear no as well (rejected path)', () => {
    const r = noPref(rescheduleAtSummary(), 'no, later', LATER);
    expect(r.verdict?.kind).toBe('rejected');
    expect(indexAt(r)).toBe(1);
    expect(r.decision).toMatchObject({ promptId: 'confirm_time' });
    expect(r.session.pendingConfirmation).toMatchObject({ target: 'form', attempts: 0 });
  });

  it('says so at an edge and counts the turn on the summary ladder', () => {
    let r = pref(rescheduleAtSummary(), 'earlier', EARLIER);
    expect(indexAt(r)).toBe(0);
    expect(r.decision).toMatchObject({ promptId: 'confirm_time', acks: [{ promptId: 'slot_edge_earlier', vars: {} }] });
    expect(r.session.pendingConfirmation).toMatchObject({ target: 'form', attempts: 1 });
    r = pref(r, 'earlier', EARLIER);
    expect(r.decision).toMatchObject({ promptId: 'confirm_dtmf' });
  });

  it('takes the next opening on "that time does not work", and stops at the last rather than wrapping', () => {
    let r = pref(rescheduleAtSummary(), 'that time does not work', DIFFERENT);
    expect(indexAt(r)).toBe(1);
    r = pref(r, 'no good', DIFFERENT);
    expect(indexAt(r)).toBe(2);
    expect(r.session.pendingConfirmation).toMatchObject({ target: 'form', attempts: 0 });
    r = pref(r, 'not that one', DIFFERENT);
    expect(indexAt(r)).toBe(2);
    expect(r.decision).toMatchObject({ promptId: 'confirm_time', acks: [{ promptId: 'slot_edge_later', vars: {} }] });
    expect(r.session.pendingConfirmation).toMatchObject({ target: 'form', attempts: 1 });
  });

  it('still takes a preference said with a part of the day the offer already sits in', () => {
    const r = pref(rescheduleAtSummary(), 'later, in the morning', LATER, timeOfDay('morning'));
    expect(factsOf(r.session).daypart).toBe('morning');
    expect(indexAt(r)).toBe(1);
    expect(r.decision).toMatchObject({ promptId: 'confirm_time', acks: [] });
    expect(r.session.pendingConfirmation).toMatchObject({ target: 'form', attempts: 0 });
  });

  it('moves to a part of the day named at the summary, or the nearest with one line', () => {
    const r0 = rescheduleAtSummary();
    const inside = say(r0.session, 'no, midday', { ...NO, ...timeOfDay('midday') });
    expect(factsOf(inside.session).daypart).toBe('midday');
    expect(daypartOf(CHEN_TUESDAY[indexAt(inside)]!)).toBe('midday');
    expect(inside.session.pendingConfirmation).toMatchObject({ attempts: 0 });
    expect(inside.decision).toMatchObject({ promptId: 'confirm_time', acks: [] });

    const missing = DAYPART_ORDER.find((p) => !CHEN_TUESDAY.some((t) => daypartOf(t) === p))!;
    expect(missing).toBe('afternoon');
    const closest = say(r0.session, 'no, the afternoon', { ...NO, ...timeOfDay('afternoon') });
    expect(closest.decision).toMatchObject({ promptId: 'confirm_time', acks: [{ promptId: 'slot_nearest', vars: { daypart: 'afternoon', time: '12:30 PM' } }] });
    expect(closest.session.pendingConfirmation).toMatchObject({ target: 'form', attempts: 0 });
    // Asked again from the nearest opening, the offer stays: the line said once more, a turn on the ladder.
    const again = say(closest.session, 'no, the afternoon', { ...NO, ...timeOfDay('afternoon') });
    expect(indexAt(again)).toBe(indexAt(closest));
    expect(again.decision).toMatchObject({ promptId: 'confirm_time', acks: [{ promptId: 'slot_nearest', vars: { daypart: 'afternoon', time: '12:30 PM' } }] });
    expect(again.session.pendingConfirmation).toMatchObject({ target: 'form', attempts: 1 });
  });

  it('restarts the offer on a new day, honouring a remembered part of the day', () => {
    let r = say(rescheduleAtSummary().session, 'no, the afternoon', { ...NO, ...timeOfDay('afternoon') });
    r = say(r.session, 'no, Thursday', { ...NO, ...weekday('thursday') });
    expect(offerOf(r).date).toBe('2026-09-24');
    const times = offerOf(r).times;
    const inside = times.findIndex((t) => daypartOf(t) === 'afternoon');
    if (inside >= 0) expect(indexAt(r)).toBe(inside);
    else expect(r.decision).toMatchObject({ acks: [{ promptId: 'slot_nearest', vars: { daypart: 'afternoon', time: times[indexAt(r)] } }] });
  });

  it('remembers a part of the day said mid-form and opens the first offer inside it', () => {
    let r = say(started(), 'reschedule with dr chen', { ...intent('reschedule'), ...provider('chen') });
    r = say(r.session, 'morgan ellis, mornings are best', { intentChange: ANSWERING, ...NAME, ...timeOfDay('morning') });
    expect(factsOf(r.session).daypart).toBe('morning');
    r = say(r.session, 'june fourteenth nineteen seventy five', { intentChange: ANSWERING, ...DOB });
    r = say(r.session, 'thursday', { intentChange: ANSWERING, ...weekday('thursday') });
    expect(r.decision).toMatchObject({ promptId: 'confirm_reschedule' });
    const times = offerOf(r).times;
    const inside = times.findIndex((t) => daypartOf(t) === 'morning');
    if (inside >= 0) expect(indexAt(r)).toBe(inside);
    else expect(r.decision).toMatchObject({ acks: [{ promptId: 'slot_nearest', vars: { daypart: 'morning', time: times[indexAt(r)] } }] });
  });

  it('ignores a preference on a cancel summary', () => {
    const r = say(cancelWithPatel().session, 'later', { ...UNANSWERED, timePreference: LATER });
    expect(r.decision).toMatchObject({ promptId: 'confirm_cancel' });
    expect(r.session.pendingConfirmation).toMatchObject({ attempts: 1 });
    expect(factsOf(r.session).offer).toBeNull();
  });

  it('keeps the day when "a later time that day" names it, and moves the time instead', () => {
    const r = say(rescheduleAtSummary().session, 'do you have anything later that day', { ...UNANSWERED, changeSlot: choice({ date: 0.8, none: 0.2 }), timePreference: LATER });
    expect(r.rows.find((row) => row.gate === 'changeSlot')).toMatchObject({ outcome: 'kept' });
    expect(r.session.slots.date!.value).toBe(TUESDAY);
    expect(indexAt(r)).toBe(1);
    expect(r.decision).toMatchObject({ promptId: 'confirm_time' });
    // Naming a new day as well, it is the day to change.
    const day = say(rescheduleAtSummary().session, 'later, on another day', { ...UNANSWERED, changeSlot: choice({ date: 0.8, none: 0.2 }), timePreference: LATER, dateMode: choice({ weekday: 0.8, none: 0.2 }) });
    expect(day.rows.find((row) => row.gate === 'changeSlot')).toMatchObject({ outcome: 'change:date' });
  });

  it('moves only as surely as TIME_PREFERENCE says, an override in the run winning', () => {
    const strict = { ...tc, thresholds: { ...tc.thresholds, TIME_PREFERENCE: 0.95 } };
    const r = say(rescheduleAtSummary(strict).session, 'later', { ...UNANSWERED, timePreference: LATER }, strict);
    expect(indexAt(r)).toBe(0);
    // Not moved: the summary is read again (short, since it was heard whole), a turn on its ladder.
    expect(r.decision).toMatchObject({ promptId: 'confirm_time', acks: [] });
    expect(r.session.pendingConfirmation).toMatchObject({ attempts: 1 });
  });
});

describe('billing', () => {
  it('collects the member ID, reads it back, and hands off to billing by its last four', () => {
    const opener = say(started(), 'I have a question about my bill', intent('billing'));
    expect(opener.decision).toMatchObject({ promptId: 'ask_memberId' });
    const r = say(opener.session, 'five five five zero seven seven eight eight', {
      intentChange: ANSWERING, containsMemberId: noul(0.95), memberIdComplete: noul(0.9),
      memberIdSpan: choice({ 'five five five zero seven seven eight eight': 0.9, none: 0.1 }),
    });
    expect(r.decision).toMatchObject({ kind: 'handoff', reason: 'billing', promptId: 'handoff_billing', slots: { memberId: '...7788' } });
    expect(heard(r)).toBe('Connecting you to billing now.');
  });
});

describe('a turn that sets no offer', () => {
  it('keeps a moved offer while the day stands, and drops it once the day is emptied, even if the same day comes back', () => {
    const later = pref(rescheduleAtSummary(), 'later', LATER);
    expect(indexAt(later)).toBe(1);
    const change = say(later.session, 'the day is wrong', { ...NO, changeSlot: choice({ date: 0.85, none: 0.15 }) });
    expect(change.decision).toMatchObject({ promptId: 'ask_date' });
    expect(factsOf(change.session).offer).toMatchObject({ index: 1 });
    // The next spoken turn sees the day emptied: the offer goes, and the same day comes back fresh.
    const same = say(change.session, 'tuesday', { intentChange: ANSWERING, ...weekday('tuesday') });
    expect(offerOf(same)).toMatchObject({ date: TUESDAY, index: 0 });
  });
});

describe('the provider question', () => {
  const atProvider = (): TurnResult => identify(say(started(), 'I want to cancel an appointment', intent('cancel')));

  it('reads the roster once to a caller who does not know the name, then walks the ladder', () => {
    const asked = atProvider();
    expect(asked.decision).toMatchObject({ promptId: 'ask_provider' });
    const dunno = { intentChange: ANSWERING, provider: choice({ none: 0.9, chen: 0.1 }), providerNameStatus: choice({ no_name: 0.85, neither: 0.1, has_name: 0.05 }) };
    const list = say(asked.session, "I don't know their name", dunno);
    expect(list.decision).toMatchObject({ promptId: 'provider_list' });
    expect(heard(list)).toContain('Our providers are Dr. Chen, Dr. Cheng, Dr. Patel');
    expect(say(list.session, "I really don't know", dunno).decision).toMatchObject({ promptId: 'ask_provider_retry' });
  });

  it('asks for the name from a caller who says they have it, and which of two close names', () => {
    const asked = atProvider();
    const has = say(asked.session, 'yes I do', { intentChange: ANSWERING, provider: choice({ none: 0.9, chen: 0.1 }), providerNameStatus: choice({ has_name: 0.85, neither: 0.1, no_name: 0.05 }) });
    expect(heard(has)).toBe('Which doctor is it with?');
    const close = say(has.session, 'doctor chen', { intentChange: ANSWERING, provider: choice({ chen: 0.48, cheng: 0.42, none: 0.1 }) });
    expect(close.decision).toMatchObject({ promptId: 'disambiguate_provider', options: ['Dr. Chen', 'Dr. Cheng'] });
    expect(heard(close)).toBe('Was that Dr. Chen, or Dr. Cheng?');
  });

  it('reads a hedged name back before the summary', () => {
    const hedged = say(atProvider().session, 'I think it was Dr. Kim', { intentChange: ANSWERING, ...provider('kim'), providerUnsure: noul(0.8) });
    expect(hedged.decision).toMatchObject({ promptId: 'confirm_cancel', acks: [{ promptId: 'ack_provider', vars: { provider: 'Dr. Kim' } }] });
    expect(heard(hedged)).toMatch(/^With Dr\. Kim\. Your appointment with Dr\. Kim is on/);
  });
});
