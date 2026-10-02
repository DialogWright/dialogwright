import { describe, expect, it } from 'vitest';
import { candidateWordSpans, choice, noul, testSlotContext as ctx, type SlotSpec } from 'dialogwright';
import { clinicApp } from '../../app';
import { nameSlot as handWritten, titleCase } from './name';

/** The same expectations of the hand-written slot and of the library `name` slot slots.yaml builds in its place. */
describe.each<[string, SlotSpec]>([
  ['the hand-written nameSlot', handWritten],
  ['the library name slot (slots.yaml)', clinicApp.slots.name!],
])('%s', (_name, nameSlot) => {
  const spanKeys = (text: string) => Object.keys((nameSlot.questions(ctx(text)).nameSpan as { criteria: Record<string, string | null> }).criteria);

  it('asks for a name check and a span choice over the word candidates', () => {
    const q = nameSlot.questions(ctx('my name is Morgan Ellis'));
    expect(q.nameGiven?.type).toBe('noul');
    expect(spanKeys('my name is Morgan Ellis')).toEqual([...candidateWordSpans('my name is Morgan Ellis'), 'none']);
  });

  it('fills the chosen span, title-cased for display, silently', () => {
    const r = nameSlot.fill({ nameGiven: noul(0.95), nameSpan: choice({ 'morgan ellis': 0.9, none: 0.1 }) }, ctx('my name is Morgan Ellis'));
    expect(r).toMatchObject({ kind: 'filled', value: 'morgan ellis', display: 'Morgan Ellis', confirm: 'none' });
  });

  it('accepts a single-word name', () => {
    const r = nameSlot.fill({ nameGiven: noul(0.9), nameSpan: choice({ cher: 0.9, none: 0.1 }) }, ctx("it's Cher"));
    expect(r).toMatchObject({ kind: 'filled', display: 'Cher' });
  });

  it('is absent below the detect threshold and invalid when no span is chosen', () => {
    expect(nameSlot.fill({ nameGiven: noul(0.2), nameSpan: choice({ none: 1 }) }, ctx('x')).kind).toBe('absent');
    expect(nameSlot.fill({ nameGiven: noul(0.9), nameSpan: choice({ none: 0.9, x: 0.1 }) }, ctx('x'))).toMatchObject({ kind: 'invalid', reason: 'no_span' });
  });

  it('does not let a literal "none" word span collide with the sentinel', () => {
    const criteria = (nameSlot.questions(ctx('none of your business')).nameSpan as { criteria: Record<string, string | null> }).criteria;
    expect(candidateWordSpans('none of your business')).toContain('none');
    expect(criteria.none).toMatch(/caller/);
  });

  it('never offers a span that contains a provider name', () => {
    // The whole correction is candidate material, and the doctor being corrected is not the caller.
    expect(candidateWordSpans('not Chen, Cheng')).toEqual(['not', 'not chen', 'not chen cheng', 'chen', 'chen cheng', 'cheng']);
    expect(spanKeys('not Chen, Cheng')).toEqual(['not', 'none']);
  });

  it("keeps the caller's own name in words that also name the doctor", () => {
    const keys = spanKeys('this is Morgan Ellis, seeing Dr. Chen');
    expect(keys).toContain('morgan ellis');
    expect(keys).not.toContain('dr chen');
    expect(keys).not.toContain('chen');
    expect(keys.filter((k) => k.split(' ').some((w) => w === 'dr' || w === 'doctor'))).toEqual([]);
  });

  it('leaves a caller whose surname is no provider untouched', () => {
    const text = 'my name is Dana Whitfield';
    expect(spanKeys(text)).toEqual([...candidateWordSpans(text), 'none']);
  });

  it('refuses a chosen span the question never offered', () => {
    const r = nameSlot.fill({ nameGiven: noul(0.9), nameSpan: choice({ 'chen cheng': 0.8, not: 0.2 }) }, ctx('not Chen, Cheng'));
    expect(r).toMatchObject({ kind: 'invalid', reason: 'no_span' });
  });

  it('has no keypad rung, is read back at the summary, and is detected', () => {
    expect(nameSlot.dtmf).toBeUndefined();
    expect(nameSlot).toMatchObject({ spokenConfirm: 'summary', detect: true });
  });

  it('title-cases each word', () => {
    expect(nameSlot.display('mary kate o neil')).toBe('Mary Kate O Neil');
  });
});

describe('titleCase', () => {
  it('title-cases each word', () => {
    expect(titleCase('mary kate o neil')).toBe('Mary Kate O Neil');
  });
});
