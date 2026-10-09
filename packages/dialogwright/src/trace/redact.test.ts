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

  it('masks the line the turn before said, as the model was given it (node.promptJustPlayed), idempotently', () => {
    const said = (slots: TraceRecord['slots'], pc: unknown): TraceRecord => ({
      ...record(), slots, pendingConfirmation: null,
      turnState: { ...record().turnState!, slots: {}, pendingConfirmation: pc, node: { id: 'confirm_accountId', promptJustPlayed: 'I have 5550 1234, born April 12th, 1985. Is that right?', options: ['yes', 'no'] } },
    } as unknown as TraceRecord);
    // The values the turn left on the slots, and the readback the model was shown though a no then emptied the slot.
    for (const r of [said(SLOTS, null), said({ ...SLOTS, accountId: emptySlot() } as unknown as TraceRecord['slots'], { target: 'accountId', value: '5550 1234' })]) {
      for (const mode of ['keep', 'length'] as const) {
        const out = redactRecordSlots(r, mode);
        expect(out.turnState!.node.promptJustPlayed, mode).toBe('I have ...1234, born ••/••/1985. Is that right?');
        expect(redactRecordSlots(out, mode)).toEqual(out);
      }
    }
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

describe('a short secret (four digits or fewer)', () => {
  /** A four-digit PIN by its last four (a digits slot's default), one by its length (a digits slot's redact: length), and a statement. */
  const app = {
    slots: {
      pinLast4: { id: 'pinLast4', redact: 'last4' },
      pin: { id: 'pin', redact: 'length', statement: false },
      note: { id: 'note', redact: 'length' },
    },
  } as unknown as Parameters<typeof redactRecordSlots>[2];
  const slots = {
    pinLast4: { ...emptySlot(), value: '4821', display: '4821' },
    pin: { ...emptySlot(), value: '7395', display: '73 95' },
    note: { ...emptySlot(), value: 'left at the side gate', display: 'your note' },
  } as unknown as TraceRecord['slots'];
  const handed = { pinLast4: '4821', pin: '73 95', note: 'your note' };
  const shortRecord = (): TraceRecord =>
    ({
      slots,
      turnState: { slots: { pinLast4: { value: '4821', confirmed: true }, pin: { value: '73 95', confirmed: true } }, pendingConfirmation: null },
      decision: { kind: 'handoff', reason: 'identity', promptId: 'handoff_identity', acks: [], completed: [], queued: [], slots: handed },
      actions: [sayAction([{ text: 'I have 4 8 2 1 and 7 3 9 5. Is that right?' }], true), transferAction('identity', [], [], handed)],
      pendingConfirmation: null,
    }) as unknown as TraceRecord;

  it('masks a last4 value of four digits or fewer to bullets, whatever its spelling, and a longer one as before, idempotently', () => {
    expect(['4821', '48 21', '482', '••••'].map(maskAccountId)).toEqual(['••••', '••••', '••••', '••••']);
    expect(['55501234', '...1234', '55505', '...5505'].map(maskAccountId)).toEqual(['...1234', '...1234', '...5505', '...5505']);
  });

  it('records a last4 value of four digits or fewer as bullets everywhere a record carries it, the live console too', () => {
    for (const mode of ['length', 'keep'] as const) {
      const r = redactRecordSlots(shortRecord(), mode, app);
      expect(r.slots.pinLast4, mode).toMatchObject({ value: '••••', display: '••••' });
      expect((r.turnState!.slots as Record<string, unknown>).pinLast4, mode).toEqual({ value: '••••', confirmed: true });
      expect(r.decision, mode).toMatchObject({ slots: { pinLast4: '••••' } });
      expect(r.actions[1], mode).toMatchObject({ slots: { pinLast4: '••••' } });
      expect(JSON.stringify(r), mode).not.toContain('4821');
      expect(JSON.stringify(r), mode).not.toContain('4 8 2 1');
      expect(redactRecordSlots(r, mode, app), mode).toEqual(r);
    }
  });

  it('records a digits slot by its length (statement: false) by its length everywhere, its display and the live console too', () => {
    for (const mode of ['length', 'keep'] as const) {
      const r = redactRecordSlots(shortRecord(), mode, app);
      expect(r.slots.pin, mode).toMatchObject({ value: '<4 chars>', display: '<5 chars>' });
      expect((r.turnState!.slots as Record<string, unknown>).pin, mode).toEqual({ value: '<5 chars>', confirmed: true });
      expect(r.decision, mode).toMatchObject({ slots: { pin: '<5 chars>' } });
      expect(r.actions[1], mode).toMatchObject({ slots: { pin: '<5 chars>' } });
      expect((r.actions[0] as { parts: { text: string }[] }).parts[0]!.text, mode).toBe('I have •••• and <4 chars>. Is that right?');
      for (const secret of ['7395', '73 95', '7 3 9 5']) expect(JSON.stringify(r), `${mode} ${secret}`).not.toContain(secret);
      expect(redactRecordSlots(r, mode, app), mode).toEqual(r);
    }
    const data = JSON.parse(redactHandoffData(endFrame('identity', [], [], handed).handoffData, 'keep', app)) as { slots: Record<string, string> };
    expect(data.slots).toEqual({ pinLast4: '••••', pin: '<5 chars>', note: 'your note' });
  });

  it('keeps a statement as before: its display a stand-in, its words on the live console', () => {
    expect(redactRecordSlots(shortRecord(), 'keep', app).slots.note).toMatchObject({ value: 'left at the side gate', display: 'your note' });
    expect(redactRecordSlots(shortRecord(), 'length', app).slots.note).toMatchObject({ value: '<21 chars>', display: 'your note' });
  });
});
