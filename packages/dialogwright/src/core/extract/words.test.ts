import { describe, expect, it } from 'vitest';
import { hasWords, sameWords, wordsOf } from './words';

describe('words', () => {
  it('compares in NFC', () => {
    expect(hasWords('soy María', 'maría')).toBe(true);
    expect(sameWords('maría', 'María')).toBe(true);
  });
  it('joins a digit run said in parts with the same digits written whole', () => {
    expect(hasWords('call 555-555-0142 now', '5555550142')).toBe(true);
    expect(hasWords('call 5555550142 now', '555 555 0142')).toBe(true);
    expect(hasWords('call 555-555-0142 now', '5555550143')).toBe(false);
  });
  it('never reads number words as digits, nor part of a digit run', () => {
    expect(hasWords('five five five', '555')).toBe(false);
    expect(hasWords('a 2023 edition', '3')).toBe(false);
    expect(wordsOf('Don’t, 555-0144!')).toEqual(['dont', '555', '0144']);
  });
});
