import { describe, expect, it } from 'vitest';
import { maskToYear as maskDob, maskLast4 as maskAccountId, redactHandoffData, redactRecordSlots, redactTurnState } from './redact';
import { emptySlot } from '../core/session';
import type { TraceRecord } from './types';
import { endFrame } from '../channel/relay/frames';
import { endAction, sayAction, transferAction } from '../channel/actions';
import { IDENTITY_VERIFIED } from '../core/decision';
import { useTestkit } from '../testing/apps';

useTestkit();

const SLOTS = {
  accountId: { ...emptySlot(), value: '55501234', display: '5550 1234' },
  dob: { ...emptySlot(), value: '1985-04-12', display: 'April 12th, 1985' },
  missingNote: { ...emptySlot(), value: 'a small brown box left at the side gate', display: 'your description' },
  expectedDate: { ...emptySlot(), value: '2026-09-15', display: 'Tuesday, September 15' },
} as unknown as TraceRecord['slots'];

function record(): TraceRecord {
  return {
    slots: SLOTS,
    turnState: { slots: { accountId: { value: '5550 1234', confirmed: true }, dob: { value: 'April 12th, 1985', confirmed: true } }, pendingConfirmation: null },
    decision: { kind: 'handoff', reason: 'identity', promptId: 'handoff_identity', acks: [], completed: [], queued: [], slots: { accountId: '5550 1234', dob: 'April 12th, 1985', missingNote: 'your description' } },
    actions: [transferAction('identity', [], [], { accountId: '5550 1234', dob: 'April 12th, 1985' })],
    pendingConfirmation: null,
  } as unknown as TraceRecord;
}

describe('redact', () => {
  it('masks an account ID to its last four and a date of birth to its year, in every spelling, idempotently', () => {
    expect(['55501234', '5550 1234', '...1234'].map(maskAccountId)).toEqual(['...1234', '...1234', '...1234']);
    expect(['1985-04-12', 'April 12th, 1985', '••/••/1985'].map(maskDob)).toEqual(['••/••/1985', '••/••/1985', '••/••/1985']);
  });

  it('masks every copy of the identity slots a record carries, and the description by its length in the trace', () => {
    const r = redactRecordSlots(record(), 'length');
    expect(r.slots.accountId).toMatchObject({ value: '...1234', display: '...1234' });
    expect(r.slots.dob).toMatchObject({ value: '••/••/1985', display: '••/••/1985' });
    expect(r.slots.missingNote).toMatchObject({ value: '<39 chars>', display: 'your description' });
    expect(r.slots.expectedDate).toEqual(SLOTS.expectedDate);
    const all = JSON.stringify(r);
    for (const secret of ['55501234', '5550 1234', '1985-04-12', 'April 12th', 'brown box']) expect(all).not.toContain(secret);
    // Twice is the same as once: the dashboard redacts a record the writer already has.
    expect(redactRecordSlots(r, 'length')).toEqual(r);
  });

  it("masks the description in the depot effect's params, keeping the other fields, idempotently", () => {
    const params = { report: '9001', missingNote: 'a small brown box left at the side gate', expectedDate: '2026-09-15' };
    const r = redactRecordSlots({ ...record(), effects: [{ kind: 'service', service: 'depot', params }] }, 'length');
    expect(r.effects).toEqual([{ kind: 'service', service: 'depot', params: { ...params, missingNote: '<39 chars>' } }]);
    expect(JSON.stringify(r)).not.toContain('brown box');
    expect(redactRecordSlots(r, 'length')).toEqual(r);
    // A record written before effects existed stays without them.
    expect('effects' in redactRecordSlots(record(), 'length')).toBe(false);
  });

  it('keeps the description for the console', () => {
    expect(redactRecordSlots(record(), 'keep').slots.missingNote!.value).toBe('a small brown box left at the side gate');
  });

  it('masks a part-given date of birth, and the turn state the model saw', () => {
    const r = redactRecordSlots({ ...record(), slots: { ...SLOTS, dob: { ...emptySlot(), window: { kind: 'dob', month: 4, day: 12 } } } }, 'keep');
    expect(r.slots.dob!.window).toEqual({ kind: 'dob', month: 0, day: 0 });
    expect(redactTurnState(record().turnState, 'keep')!.slots).toEqual({ accountId: { value: '...1234', confirmed: true }, dob: { value: '••/••/1985', confirmed: true } });
  });

  it('leaves handoff data it cannot read as it is', () => {
    expect(redactHandoffData('not json', 'keep')).toBe('not json');
    expect(redactHandoffData('{"reasonCode":"x"}', 'keep')).toBe('{"reasonCode":"x"}');
  });

  it("masks a transfer's slots as the end frame's handoff data was masked, and leaves every other action as it is", () => {
    const slots = { accountId: '5550 1234', dob: IDENTITY_VERIFIED, expectedDate: 'Tuesday, September 15', missingNote: 'a small brown box left at the side gate' };
    const say = sayAction([{ text: 'Connecting you now.' }], false);
    for (const mode of ['keep', 'length'] as const) {
      const r = redactRecordSlots({ ...record(), actions: [say, transferAction('needs-human', ['track_parcel'], ['report_missing'], slots)] }, mode);
      const before = JSON.parse(redactHandoffData(endFrame('needs-human', ['track_parcel'], ['report_missing'], slots).handoffData, mode)) as { slots: Record<string, string> };
      expect(r.actions).toEqual([say, transferAction('needs-human', ['track_parcel'], ['report_missing'], before.slots)]);
      expect(r.actions[1]).toMatchObject({ slots: { accountId: '...1234', dob: IDENTITY_VERIFIED, missingNote: slots.missingNote } });
      expect(redactRecordSlots(r, mode)).toEqual(r);
    }
    const ended = { ...record(), actions: [endAction(['track_parcel'])] };
    expect(redactRecordSlots(ended, 'length').actions).toEqual([endAction(['track_parcel'])]);
  });
});

describe('what a turn said aloud', () => {
  /** A record whose turn said `text`, with the testkit's slots and a readback of the account ID pending. */
  const said = (text: string, extra: Partial<TraceRecord> = {}): TraceRecord =>
    ({ ...record(), decision: { kind: 'prompt', promptId: 'confirm_slot', vars: { accountId: '5550 1234' }, acks: [], target: 'confirm', options: [] }, actions: [sayAction([{ text }], true)], ...extra }) as unknown as TraceRecord;
  const text = (r: TraceRecord): string => (r.actions[0] as { parts: { text: string }[] }).parts[0]!.text;

  it('masks a redacted slot read back in the say text: its value, its display, and its digits however spaced', () => {
    for (const line of ['I have 5550 1234. Is that right?', 'I have 55501234. Is that right?', 'I have 5 5 5 0, 1 2 3 4. Is that right?', 'I have 5550-1234. Is that right?']) {
      expect(text(redactRecordSlots(said(line), 'length')), line).toBe('I have ...1234. Is that right?');
    }
    expect(text(redactRecordSlots(said('Born April 12th, 1985, or 1985-04-12?'), 'length'))).toBe('Born ••/••/1985, or ••/••/1985?');
    // A statement: by its length in the trace, as said on the live console; a slot with no redact setting, as said.
    const note = 'You said: a small brown box left at the side gate. Expected Tuesday, September 15.';
    expect(text(redactRecordSlots(said(note), 'length'))).toBe('You said: <39 chars>. Expected Tuesday, September 15.');
    expect(text(redactRecordSlots(said(note), 'keep'))).toBe(note);
    // Twice is the same as once.
    const r = redactRecordSlots(said('I have 5550 1234. Is that right?'), 'length');
    expect(redactRecordSlots(r, 'length')).toEqual(r);
  });

  it('masks a value only the readback or the decision carries, and the part of our line an interruption heard', () => {
    const pending = { target: 'slot', slot: 'accountId', value: '55509876', display: '5550 9876' } as TraceRecord['pendingConfirmation'];
    const r = redactRecordSlots(said('I have 5550 9876. Is that right?', { slots: {} as TraceRecord['slots'], pendingConfirmation: pending }), 'length');
    expect(text(r)).toBe('I have ...9876. Is that right?');
    const interrupted = redactRecordSlots(said('', { event: { type: 'user.interrupt', heard: 'I have 5 5 5 0, 1 2', afterMs: 900 } }), 'length');
    // Cut off mid-number: the digits heard so far are the start of the value, and are masked too.
    expect(interrupted.event).toEqual({ type: 'user.interrupt', heard: 'I have ...1234', afterMs: 900 });
    const early = redactRecordSlots(said('', { event: { type: 'user.interrupt', heard: 'I have 5 5', afterMs: 400 } }), 'length');
    expect(early.event).toEqual({ type: 'user.interrupt', heard: 'I have 5 5', afterMs: 400 });
    const whole = redactRecordSlots(said('', { event: { type: 'user.interrupt', heard: 'I have 5 5 5 0, 1 2 3 4, is', afterMs: 900 } }), 'length');
    expect(whole.event).toEqual({ type: 'user.interrupt', heard: 'I have ...1234, is', afterMs: 900 });
  });

  it('leaves a line with no redacted value, and words a value only resembles, as they are', () => {
    const line = 'Your parcel 5550 is due on 2026-09-15; call 555 0123.';
    expect(text(redactRecordSlots(said(line), 'length'))).toBe(line);
  });
});
