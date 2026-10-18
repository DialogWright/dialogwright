import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runSlotConformance } from '../conformance/run';
import { defineSlot, slotTypeJsonSchema } from '../defineSlot';
import { testSlotContext } from '../../testing/slots';
import { referenceType } from './index';
import { readReference, referenceSpans, tokensOf } from './read';

/** The `reference` type: the conformance kit over its examples, then what the kit does not cover. */
runSlotConformance(referenceType, { describe, it, locales: ['en-US', 'es'] });

const NO_LOOKALIKES = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const read = (text: string, alphabet = NO_LOOKALIKES, locale?: string): string | null => readReference(tokensOf(text), alphabet, locale);

describe('reading a reference out of the words', () => {
  it('reads typed, spelled, named and spelling-alphabet characters, digit words, and double and triple', () => {
    expect(read('KEVHUD')).toBe('KEVHUD');
    expect(read('k e v h u d')).toBe('KEVHUD');
    expect(read('kay ee vee aitch you dee')).toBe('KEVHUD');
    expect(read('kilo echo victor hotel uniform delta')).toBe('KEVHUD');
    expect(read('K as in kilo E as in echo V H U D')).toBe('KEVHUD');
    expect(read('k seven m four q x')).toBe('K7M4QX');
    expect(read('double a three')).toBe('AA3');
    expect(read('triple seven')).toBe('777');
    expect(read('x ray double you')).toBe('XW');
  });

  it('reads a look-alike as the one the alphabet holds', () => {
    expect(read('oh', '0123456789')).toBe('0');
    expect(read('oh')).toBe('O');
    expect(read('i', '0123456789')).toBe('1');
  });

  it('reads Spanish letter names and digits for es', () => {
    expect(read('ka siete eme cuatro cu equis', NO_LOOKALIKES, 'es')).toBe('K7M4QX');
    expect(read('uve doble i griega', NO_LOOKALIKES, 'es-US')).toBe('WY');
  });

  it('offers the spans of the slot\'s length from its alphabet, shortest first, and nothing else', () => {
    // A word that happens to spell one is offered too ("thanks" is six letters of this alphabet): the model chooses.
    expect(referenceSpans('my code is KEVHUD thanks', 6, NO_LOOKALIKES)).toEqual(['kevhud', 'thanks']);
    expect(referenceSpans('it is k seven m four q x', 6, NO_LOOKALIKES)).toEqual(['k seven m four q x']);
    // L, I and O are not in this alphabet: a word made of them is no reference.
    expect(referenceSpans('hello', 5, NO_LOOKALIKES)).toEqual([]);
    expect(referenceSpans('I want to cancel my booking', 6, NO_LOOKALIKES)).toEqual([]);
  });
});

describe('a reference slot', () => {
  const code = defineSlot('bookingCode', { type: 'reference', noun: 'booking code', length: 6, alphabet: NO_LOOKALIKES });

  it('asks whether a code is stated, and which span it is, with the spans as the choices', () => {
    expect(code.questionIds).toEqual(['bookingCodeGiven', 'bookingCodeSpan']);
    const q = code.questions(testSlotContext('it is KEVHUD'));
    expect(Object.keys((q.bookingCodeSpan as { criteria: Record<string, unknown> }).criteria)).toEqual(['kevhud', 'none']);
  });

  it('is masked by its length, and said one character at a time', () => {
    expect(code.redact).toBe('length');
    expect(code.display('KEVHUD')).toBe('K E V H U D');
  });

  it('needs a noun, and an alphabet of capital letters and digits once each', () => {
    expect(() => defineSlot('x', { type: 'reference', length: 6 })).toThrow(/noun/);
    expect(() => defineSlot('x', { type: 'reference', noun: 'code', length: 6, alphabet: 'abc' })).toThrow(/capital letters/);
    expect(() => defineSlot('x', { type: 'reference', noun: 'code', length: 6, alphabet: 'AAB' })).toThrow(/twice/);
  });

  it('the docs page names every option and every text part', () => {
    const page = readFileSync(new URL('../../../../../docs/slots/reference.md', import.meta.url), 'utf8');
    const options = Object.keys((slotTypeJsonSchema(referenceType).properties ?? {}) as object).filter((k) => k !== 'type');
    for (const option of [...options, 'text.given', 'text.span', 'text.none', 'ids.given', 'ids.span']) expect(page, option).toContain(`\`${option}\``);
  });
});
