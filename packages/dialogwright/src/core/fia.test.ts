import { describe, expect, it } from 'vitest';
import { fillSlots, nextPrompt, pendingSlotConfirmation, retryStep, applyDtmf, slotCtx } from './fia';
import { newSession, setForm, type Session } from './session';
import { DEFAULT_THRESHOLDS, withOverrides } from './thresholds';
import type { SlotContext, SlotSpec } from './slots/types';
import { useTestkit } from '../testing/apps';
import { testkitApp } from '../testing/testkit';
import { CUSTOMERS } from '../testing/testkit/domain/data';
import { ALL_SLOTS, SLOTS, type TestkitSlot } from '../testing/testkit/domain/slots';
import type { ParcelRef } from '../testing/testkit/domain/slots/parcelSelect';
import { choice, noul } from '../testing/answers';
import { candidateSpans, candidateWordSpans } from './spans';
import { customerPrincipal } from '../testing/testkit/domain/principals';
import { VOICE_RELAY } from '../channel/caps';

useTestkit();

const T = { ...DEFAULT_THRESHOLDS };
const PARCELS: ParcelRef[] = [
  { number: '7101', item: 'a box of books', day: '2026-09-21' },
  { number: '7103', item: 'a desk lamp', day: '2026-09-18' },
];
function ctx(text = '', parcels: readonly ParcelRef[] = []): SlotContext {
  return { text, candidateSpans: candidateSpans(text), candidateWordSpans: candidateWordSpans(text), todayIso: '2026-09-18', thresholds: T, window: null, current: null, records: parcels, prompted: false };
}
/** Alex, verified to level 2, in `form`. */
function verified(form: Parameters<typeof setForm>[1]): Session {
  return setForm({ ...newSession('s', 0, VOICE_RELAY), principal: customerPrincipal(CUSTOMERS[0]!, 2) }, form);
}
/** The slot specs of one of the testkit's forms. */
const slotsFor = (form: string): SlotSpec[] => testkitApp.forms[form]!.slots.map((id) => SLOTS[id as TestkitSlot]);

describe('retryStep', () => {
  it('goes open, dtmf, agent', () => {
    expect(retryStep(1, T)).toBe('open');
    expect(retryStep(2, T)).toBe('dtmf');
    expect(retryStep(3, T)).toBe('agent');
  });

  it('stays monotonic under overrides', () => {
    const t5 = withOverrides({ MAX_ATTEMPTS: 5 });
    expect([1, 2, 3, 4, 5].map((n) => retryStep(n, t5))).toEqual(['open', 'open', 'open', 'dtmf', 'agent']);

    const t2 = withOverrides({ MAX_ATTEMPTS: 2 });
    expect([1, 2].map((n) => retryStep(n, t2))).toEqual(['dtmf', 'agent']);
  });
});

describe('fillSlots', () => {
  it('fills over-answered slots silently: the summary, not an ack, reads them back', () => {
    const s = verified('report_missing');
    const text = 'it was a small box left at the gate on saturday';
    const r = fillSlots(s, {
      expectedDateMode: choice({ weekday: 0.9, none: 0.1 }),
      expectedDateWeekday: choice({ saturday: 0.9, none: 0.1 }),
      describesParcel: noul(0.9),
    }, ctx(text), slotsFor('report_missing'));
    expect(r.session.slots.expectedDate).toMatchObject({ value: '2026-09-12', display: 'Saturday, September 12', confirmed: false });
    // The description is the caller's own words, verbatim.
    expect(r.session.slots.missingNote!.value).toBe(text);
    expect(r.acks).toEqual([]);
    expect(r.progress).toBe(true);
    expect(r.disambiguate).toBeNull();
  });

  it('reports no progress when nothing fills', () => {
    const s = verified('report_missing');
    const r = fillSlots(s, { expectedDateMode: choice({ none: 0.9 }), describesParcel: noul(0.1) }, ctx('um'), slotsFor('report_missing'));
    expect(r.progress).toBe(false);
  });

  it('surfaces a disambiguation', () => {
    const s = verified('track_parcel');
    const r = fillSlots(s, { parcelChoice: choice({ parcel_7101: 0.48, parcel_7103: 0.42, none: 0.1 }) }, ctx('the books one or was it the lamp', PARCELS), slotsFor('track_parcel'));
    expect(r.disambiguate).toMatchObject({ slot: 'parcelSelect', a: { value: '7101' }, b: { value: '7103' } });
    expect(r.progress).toBe(true);
  });

  it('records invalid extraction as no progress with the reason', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'track_parcel');
    const text = 'five five five';
    const r = fillSlots(s, {
      containsAccountId: noul(0.9), accountIdSpan: choice({ 'five five five': 0.9, none: 0.1 }), accountIdComplete: noul(0.9),
    }, ctx(text), [SLOTS.accountId]);
    expect(r.progress).toBe(false);
    expect(r.events).toEqual([{ slot: 'accountId', outcome: { kind: 'invalid', reason: 'mask', raw: '555' } }]);
  });

  it('keeps a confirmed slot confirmed when re-filled with the same value', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'track_parcel');
    s.slots.accountId!.value = '55501234';
    s.slots.accountId!.confirmed = true;
    const r = fillSlots(s, {
      containsAccountId: noul(0.9), accountIdSpan: choice({ '55501234': 0.9, none: 0.1 }), accountIdComplete: noul(0.9),
    }, ctx('55501234'), [SLOTS.accountId]);
    expect(r.session.slots.accountId).toMatchObject({ value: '55501234', confirmed: true });
  });

  it('unconfirms a confirmed slot when re-filled with a different value', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'track_parcel');
    s.slots.accountId!.value = '55501234';
    s.slots.accountId!.confirmed = true;
    const r = fillSlots(s, {
      containsAccountId: noul(0.9), accountIdSpan: choice({ '55505678': 0.9, none: 0.1 }), accountIdComplete: noul(0.9),
    }, ctx('55505678'), [SLOTS.accountId]);
    expect(r.session.slots.accountId).toMatchObject({ value: '55505678', confirmed: false });
  });
});

describe('one calendar day heard twice', () => {
  /** What the dob questions come back with for a spoken month and day, with or without a year. */
  function dobAnswers(year?: string): Record<string, ReturnType<typeof choice> | ReturnType<typeof noul>> {
    return {
      dobGiven: noul(0.9),
      dobMonth: choice({ april: 0.9, none: 0.1 }),
      dobDay: choice({ '12': 0.9, none: 0.1 }),
      dobYear: year ? choice({ [year]: 0.9, none: 0.1 }) : choice({ none: 0.9 }),
    };
  }

  /** What the expectedDate questions come back with when they read the same "april twelfth" as the day a parcel was due. */
  const dueAprilTwelfth = {
    expectedDateMode: choice({ absolute: 0.9, none: 0.1 }),
    expectedDateMonth: choice({ april: 0.9, none: 0.1 }),
    expectedDateDay: choice({ '12': 0.9, none: 0.1 }),
  };
  /** A step-up in a missing-parcel report: the identity factors and the form's own slots all listen. */
  const specs = () => [SLOTS.accountId, SLOTS.dob, ...slotsFor('report_missing')];

  it('drops a due date that repeats the birthday the caller was just asked for', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'report_missing');
    s.promptedFor = 'dob';
    const r = fillSlots(s, { ...dobAnswers(), ...dueAprilTwelfth }, ctx('april twelfth'), specs());
    expect(r.session.slots.dob!.window).toEqual({ kind: 'dob', month: 4, day: 12 });
    expect(r.session.slots.expectedDate).toMatchObject({ value: null, window: null });
    expect(r.events.map((e) => e.slot)).toEqual(['dob']);
  });

  it('drops it when the birthday is complete, year and all', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'report_missing');
    s.promptedFor = 'dob';
    const r = fillSlots(s, { ...dobAnswers('nineteen eighty five'), ...dueAprilTwelfth }, ctx('april twelfth nineteen eighty five'), specs());
    expect(r.session.slots.dob!.value).toBe('1985-04-12');
    expect(r.session.slots.expectedDate!.value).toBeNull();
  });

  it('drops it when the birthday itself was rejected (a birthday in the future is still a birthday)', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'report_missing');
    s.promptedFor = 'dob';
    const r = fillSlots(s, {
      dobGiven: noul(0.9),
      dobMonth: choice({ december: 0.9, none: 0.1 }),
      dobDay: choice({ '25': 0.9, none: 0.1 }),
      dobYear: choice({ 'twenty thirty': 0.9, none: 0.1 }),
      expectedDateMode: choice({ absolute: 0.9, none: 0.1 }),
      expectedDateMonth: choice({ december: 0.9, none: 0.1 }),
      expectedDateDay: choice({ '25': 0.9, none: 0.1 }),
    }, ctx('december twenty fifth twenty thirty'), specs());
    expect(r.events).toEqual([{ slot: 'dob', outcome: { kind: 'invalid', reason: 'future', raw: '2030-12-25' } }]);
    expect(r.session.slots.expectedDate!.value).toBeNull();
  });

  it('keeps a due date that is a different day (a real over-answer)', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'report_missing');
    s.promptedFor = 'dob';
    const r = fillSlots(s, {
      ...dobAnswers(),
      expectedDateMode: choice({ weekday: 0.9, none: 0.1 }),
      expectedDateWeekday: choice({ saturday: 0.9, none: 0.1 }),
    }, ctx('april twelfth, and it was due last saturday'), specs());
    expect(r.session.slots.dob!.window).toEqual({ kind: 'dob', month: 4, day: 12 });
    expect(r.session.slots.expectedDate!.value).toBe('2026-09-12');
  });

  it('fills the due date when that is what was asked: the prompted slot is the one that wins', () => {
    const s = verified('report_missing');
    s.slots.dob!.value = '1985-04-12';
    s.slots.dob!.display = 'April 12th, 1985';
    s.promptedFor = 'expectedDate';
    const r = fillSlots(s, { ...dobAnswers(), ...dueAprilTwelfth }, ctx('april twelfth'), specs());
    expect(r.session.slots.expectedDate!.value).toBe('2026-04-12');
    expect(r.session.slots.dob!.value).toBe('1985-04-12');
  });

  it('leaves both alone when the prompt was not a slot\'s', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'report_missing');
    s.promptedFor = 'intent';
    const r = fillSlots(s, { ...dobAnswers(), ...dueAprilTwelfth }, ctx('april twelfth'), specs());
    expect(r.session.slots.dob!.window).toEqual({ kind: 'dob', month: 4, day: 12 });
    expect(r.session.slots.expectedDate!.value).toBe('2026-04-12');
  });
});

describe('per-spec context', () => {
  /** A spec that fills nothing; it only records the context it was handed, for inspection. */
  function echoSpec(id: TestkitSlot, seen: Record<string, SlotContext>): SlotSpec {
    return {
      id,
      spokenConfirm: 'summary',
      questions: () => ({}),
      fill: (_answers, c) => { seen[id] = c; return { kind: 'absent' }; },
      display: (v) => v,
    };
  }

  it('slotCtx substitutes only the named slot\'s own pending partial, value and prompt', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'report_missing');
    s.slots.dob!.window = { kind: 'dob', month: 4, day: 12 };
    s.slots.deliveryPart!.value = 'morning';
    s.promptedFor = 'expectedDate';
    const base = ctx('');
    expect(slotCtx(s, base, 'dob').window).toEqual(s.slots.dob!.window);
    expect(slotCtx(s, base, 'expectedDate').window).toBeNull();
    expect(slotCtx(s, base, 'expectedDate').prompted).toBe(true);
    expect(slotCtx(s, base, 'dob').prompted).toBe(false);
    expect(slotCtx(s, base, 'deliveryPart').current).toBe('morning');
    // A correcting fill hides the value, so the slot can replace what is there.
    expect(slotCtx(s, base, 'deliveryPart', { correcting: true }).current).toBeNull();
  });

  it('gives each spec in fillSlots its own slot\'s window, never another spec\'s (slotContext once sent one slot\'s window to every spec)', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'report_missing');
    s.slots.dob!.window = { kind: 'dob', month: 4, day: 12 };
    const seen: Record<string, SlotContext> = {};
    // The base context's own window is deliberately wrong-looking, so this only passes if
    // fillSlots substitutes per spec rather than forwarding the base context.
    const wrongBase = { ...ctx(''), window: s.slots.dob!.window };
    fillSlots(s, {}, wrongBase, [echoSpec('expectedDate', seen), echoSpec('dob', seen)]);
    expect(seen.dob!.window).toEqual(s.slots.dob!.window);
    expect(seen.expectedDate!.window).toBeNull();
  });
});

describe('nextPrompt', () => {
  it('asks for the highest-priority missing slot, then completes', () => {
    const s = verified('report_missing');
    expect(nextPrompt(s)).toEqual({ kind: 'ask', slot: 'missingNote', window: null });
    s.slots.missingNote!.value = 'a small brown box';
    expect(nextPrompt(s)).toEqual({ kind: 'ask', slot: 'expectedDate', window: null });
    s.slots.expectedDate!.value = '2026-09-12';
    expect(nextPrompt(s)).toEqual({ kind: 'complete' });
  });
});

describe('applyDtmf', () => {
  it('fills the prompted slot once enough digits arrive', () => {
    const s = verified('track_parcel');
    s.promptedFor = 'parcelSelect';
    expect(applyDtmf(s, '710', ctx())).toEqual({ kind: 'collecting' });
    expect(applyDtmf(s, '7101', ctx())).toEqual({ kind: 'filled', slot: 'parcelSelect', display: '7101' });
    expect(s.slots.parcelSelect).toMatchObject({ value: '7101', confirmed: true });
  });

  it('fills an identity factor a step-up asked for, keyed', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'delivery_window');
    s.promptedFor = 'accountId';
    expect(applyDtmf(s, '55501234', ctx())).toEqual({ kind: 'filled', slot: 'accountId', display: '5550 1234' });
    expect(s.slots.accountId).toMatchObject({ value: '55501234', confirmed: true });
  });

  it('rejects invalid digits', () => {
    const s = verified('delivery_window');
    s.promptedFor = 'deliveryPart';
    expect(applyDtmf(s, '9', ctx())).toEqual({ kind: 'invalid', slot: 'deliveryPart' });
  });

  it('ignores a target not on the active form, and an identity factor once the caller is verified', () => {
    const s = verified('delivery_window');
    s.promptedFor = 'expectedDate';
    expect(applyDtmf(s, '0912', ctx())).toEqual({ kind: 'no_target' });
    expect(s.slots.expectedDate).toMatchObject({ value: null, display: null, confirmed: false });
    s.promptedFor = 'accountId';
    expect(applyDtmf(s, '55501234', ctx())).toEqual({ kind: 'no_target' });
  });

  it('ignores the confirm target and the code (the summary keypad and the code are handled elsewhere)', () => {
    const s = verified('report_missing');
    s.promptedFor = 'confirm';
    expect(applyDtmf(s, '1', ctx())).toEqual({ kind: 'no_target' });
    s.promptedFor = 'otp';
    expect(applyDtmf(s, '123456', ctx())).toEqual({ kind: 'no_target' });
  });

  it('treats a slot with no dtmf as no_target, distinct from a target that is simply off the form', () => {
    // `missingNote` is on the report form and has no keypad rung, so the activeSlots gate passes
    // and the missing-`dtmf` branch is what produces the result.
    expect(SLOTS.missingNote.dtmf).toBeUndefined();
    const s = verified('report_missing');
    s.promptedFor = 'missingNote';
    expect(testkitApp.forms.report_missing!.slots).toContain('missingNote');
    expect(applyDtmf(s, '1', ctx())).toEqual({ kind: 'no_target' });
  });
});

describe('pendingSlotConfirmation', () => {
  it('owes no readback for a filled, unconfirmed slot: no slot uses the always policy now', () => {
    const s = verified('delivery_window');
    expect(pendingSlotConfirmation(s)).toBeNull();
    s.slots.deliveryPart = { value: 'morning', display: 'the morning', confirmed: false, attempts: 0, window: null, helped: [] };
    expect(pendingSlotConfirmation(s)).toBeNull();
    s.slots.deliveryDay = { value: '2026-09-19', display: 'Saturday, September 19', confirmed: false, attempts: 0, window: null, helped: [] };
    expect(pendingSlotConfirmation(s)).toBeNull();
    for (const id of ALL_SLOTS) expect(SLOTS[id].spokenConfirm, id).not.toBe('always');
  });
});

describe('fillSlots account ID policy', () => {
  const answers = {
    containsAccountId: noul(0.95), accountIdComplete: noul(0.95),
    accountIdSpan: choice({ 'five five five zero one two three four': 0.9, none: 0.1 }),
  };
  const spoken = ctx('five five five zero one two three four');

  it('leaves a spoken account ID unconfirmed and silent: verification, not a readback, settles it', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'track_parcel');
    const r = fillSlots(s, answers, spoken, [SLOTS.accountId]);
    expect(r.session.slots.accountId).toMatchObject({ value: '55501234', display: '5550 1234', confirmed: false });
    expect(r.acks).toEqual([]);
  });

  it('keeps a confirmed account ID confirmed when the caller repeats it unchanged', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'track_parcel');
    s.slots.accountId = { value: '55501234', display: '5550 1234', confirmed: true, attempts: 0, window: null, helped: [] };
    const r = fillSlots(s, answers, spoken, [SLOTS.accountId]);
    expect(r.session.slots.accountId!.confirmed).toBe(true);
    expect(r.acks).toEqual([]);
  });

  it('fills a summary-policy slot silently: no ack, not confirmed, no readback owed', () => {
    const spec = { ...SLOTS.accountId, spokenConfirm: 'summary' as const };
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'track_parcel');
    const r = fillSlots(s, answers, spoken, [spec]);
    expect(r.acks).toEqual([]);
    expect(s.slots.accountId).toMatchObject({ value: '55501234', confirmed: false });
    expect(pendingSlotConfirmation(s)).toBeNull();
  });

  // Contrasts with the summary-policy test above: passing a spec whose spokenConfirm differs from
  // SLOTS.accountId's own 'summary' policy must change fillSlots' behavior, proving it reads the
  // policy off the spec it is given rather than off the global SLOTS registry.
  it('fills a by-confidence-policy spec with an implicit ack and stays unconfirmed', () => {
    const spec = { ...SLOTS.accountId, spokenConfirm: 'by-confidence' as const };
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'track_parcel');
    const r = fillSlots(s, answers, spoken, [spec]);
    expect(r.acks).toEqual([{ promptId: 'ack_accountId', vars: { accountId: '5550 1234' } }]);
    expect(s.slots.accountId).toMatchObject({ value: '55501234', confirmed: false });
  });
});

describe('fillSlots correcting a filled slot', () => {
  const aprilThirteenth = { dobGiven: noul(0.9), dobMonth: choice({ april: 0.9, none: 0.1 }), dobDay: choice({ '13': 0.9, none: 0.1 }), dobYear: choice({ none: 0.9 }) };
  const filled = (): Session => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'track_parcel');
    s.slots.dob = { value: '1985-04-12', display: 'April 12th, 1985', confirmed: true, attempts: 0, window: null, helped: [] };
    return s;
  };

  it('leaves a filled slot alone when a partial is heard mid-form', () => {
    const s = filled();
    const r = fillSlots(s, aprilThirteenth, ctx('april thirteenth'), [SLOTS.dob]);
    expect(s.slots.dob).toMatchObject({ value: '1985-04-12', window: null });
    expect(r.progress).toBe(false);
  });

  it('reopens a filled slot for narrowing when the partial corrects it', () => {
    const s = filled();
    const r = fillSlots(s, aprilThirteenth, ctx('april thirteenth'), [SLOTS.dob], { correcting: true });
    expect(s.slots.dob).toMatchObject({ value: null, display: null, confirmed: false, window: { kind: 'dob', month: 4, day: 13 } });
    expect(r.progress).toBe(true);
  });
});

describe('fillSlots help', () => {
  /**
   * No testkit slot answers with help today; the mechanism stays for one that will. This spec
   * says the caller does not know the parcel number.
   */
  const helpSpec: SlotSpec = { ...SLOTS.parcelSelect, fill: () => ({ kind: 'help', promptId: 'parcel_help' }) };

  it('carries help for the prompted slot when not yet played, as progress', () => {
    const s = verified('track_parcel');
    s.promptedFor = 'parcelSelect';
    const first = fillSlots(s, {}, ctx(), [helpSpec]);
    expect(first.help).toEqual({ slot: 'parcelSelect', promptId: 'parcel_help' });
    expect(first.progress).toBe(true);
    expect(first.events).toEqual([{ slot: 'parcelSelect', outcome: { kind: 'help', promptId: 'parcel_help' } }]);
    // fillSlots only reads `helped`; recording it is turn.ts' `bookkeep`, once the decision that
    // plays the prompt is the one actually spoken (escalate can still replace it).
    expect(s.slots.parcelSelect!.helped).toEqual([]);
    s.slots.parcelSelect!.helped.push('parcel_help');
    const again = fillSlots(s, {}, ctx(), [helpSpec]);
    expect(again.help).toBeNull();
    expect(again.progress).toBe(false);
  });

  it('ignores help for a slot that was not asked, and records no event for it', () => {
    const s = verified('track_parcel');
    s.promptedFor = 'intent';
    const r = fillSlots(s, {}, ctx(), [helpSpec]);
    expect(r.help).toBeNull();
    expect(r.progress).toBe(false);
    expect(r.events).toEqual([]);
    expect(s.slots.parcelSelect!.helped).toEqual([]);
  });
});
