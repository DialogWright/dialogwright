import { describe, expect, it } from 'vitest';
import { candidateSpans, choice, noul, testSlotContext as ctx, type SlotSpec } from 'dialogwright';
import { clinicApp } from '../../app';
import { dobSlot as handWritten } from './dob';

const pending = (text: string) => ({ ...ctx(text), window: { kind: 'dob', month: 6, day: 14 } });

/** The same expectations of the hand-written slot and of the library `birthdate` slot slots.yaml builds in its place. */
describe.each<[string, SlotSpec]>([
  ['the hand-written dobSlot', handWritten],
  ['the library dob slot (slots.yaml)', clinicApp.slots.dob!],
])('%s', (_name, dobSlot) => {
  it('asks given, month, day, and a year span over the number candidates', () => {
    const q = dobSlot.questions(ctx('june fourteenth nineteen seventy five'));
    expect(Object.keys(q)).toEqual(['dobGiven', 'dobMonth', 'dobDay', 'dobYear']);
    expect(Object.keys((q.dobYear as { criteria: Record<string, unknown> }).criteria)).toEqual([...candidateSpans('june fourteenth nineteen seventy five'), 'none']);
  });

  it('still asks all four with a month and day pending, the year asked as the year alone', () => {
    const q = dobSlot.questions(pending('nineteen seventy five'));
    expect(Object.keys(q)).toEqual(['dobGiven', 'dobMonth', 'dobDay', 'dobYear']);
    expect((q.dobYear as { instructions: string }).instructions).toMatch(/asked for the year of their birth/);
  });

  it('fills a full date', () => {
    const r = dobSlot.fill({ dobGiven: noul(0.95), dobMonth: choice({ june: 0.9 }), dobDay: choice({ '14': 0.9 }), dobYear: choice({ 'nineteen seventy five': 0.9, none: 0.1 }) }, ctx('june fourteenth nineteen seventy five'));
    expect(r).toMatchObject({ kind: 'filled', value: '1975-06-14', display: 'June 14th, 1975', confirm: 'none' });
  });

  it('narrows to the year when a month and day come without one', () => {
    const r = dobSlot.fill({ dobGiven: noul(0.95), dobMonth: choice({ june: 0.9 }), dobDay: choice({ '14': 0.9 }), dobYear: choice({ none: 0.9 }) }, ctx('june fourteenth'));
    expect(r).toMatchObject({ kind: 'window', window: { kind: 'dob', month: 6, day: 14 } });
  });

  it('completes from a year alone when a month and day are pending', () => {
    const r = dobSlot.fill({ dobGiven: noul(0.6), dobMonth: choice({ none: 0.9 }), dobDay: choice({ none: 0.9 }), dobYear: choice({ 'nineteen seventy five': 0.9 }) }, pending('nineteen seventy five'));
    expect(r).toMatchObject({ kind: 'filled', value: '1975-06-14' });
  });

  it('is invalid (no_year) for a year alone with nothing pending', () => {
    const r = dobSlot.fill({ dobGiven: noul(0.95), dobMonth: choice({ none: 0.9 }), dobDay: choice({ none: 0.9 }), dobYear: choice({ 'seventy five': 0.9 }) }, ctx('seventy five'));
    expect(r).toMatchObject({ kind: 'invalid', reason: 'no_year' });
  });

  it('rejects a future date, an impossible date, and a year before 1900', () => {
    const f = (m: string, d: string, y: string) => dobSlot.fill({ dobGiven: noul(0.95), dobMonth: choice({ [m]: 0.9 }), dobDay: choice({ [d]: 0.9 }), dobYear: choice({ [y]: 0.9 }) }, ctx(`${m} ${d} ${y}`));
    expect(f('december', '25', 'twenty thirty')).toMatchObject({ kind: 'invalid', reason: 'future' });
    expect(f('february', '30', 'nineteen seventy five')).toMatchObject({ kind: 'invalid', reason: 'impossible' });
    expect(f('june', '14', 'eighteen fifty')).toMatchObject({ kind: 'invalid', reason: 'impossible' });
  });

  it('parses the keypad as MMDDYYYY with the same rules', () => {
    expect(dobSlot.dtmf!.parse('06141975', ctx(''))).toEqual({ value: '1975-06-14', display: 'June 14th, 1975' });
    expect(dobSlot.dtmf!.parse('02301975', ctx(''))).toBeNull();
    expect(dobSlot.dtmf!.parse('06142030', ctx(''))).toBeNull();
    expect(dobSlot.dtmf!.length).toBe(8);
  });

  it('is absent when no part is read, so a pending month and day are not replayed as progress', () => {
    const r = dobSlot.fill({ dobGiven: noul(0.9), dobMonth: choice({ none: 0.9 }), dobDay: choice({ none: 0.9 }), dobYear: choice({ none: 0.9 }) }, pending('uh let me think'));
    expect(r).toEqual({ kind: 'absent' });
  });

  it('ignores a part below the choice threshold rather than averaging it into the confidence', () => {
    const r = dobSlot.fill(
      { dobGiven: noul(0.95), dobMonth: choice({ june: 0.9 }), dobDay: choice({ '14': 0.88 }), dobYear: choice({ 'nineteen seventy five': 0.3, none: 0.7 }) },
      pending('june fourteenth'),
    );
    expect(r).toMatchObject({ kind: 'window', confidence: 0.88 });
  });

  it('is masked, a date, detected, read back at the summary, with its own question for the year', () => {
    expect(dobSlot).toMatchObject({ spokenConfirm: 'summary', redact: 'mask', valueKind: 'date', detect: true, partialPromptId: 'ask_dob_year' });
  });
});
