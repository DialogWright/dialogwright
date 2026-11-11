import { describe, expect, it } from 'vitest';
import { SentenceBuffer } from './sentences';

/** A reply leaves in whole sentences. */

const split = (...deltas: string[]): { said: string[]; rest: string } => {
  const b = new SentenceBuffer();
  const said = deltas.flatMap((d) => b.push(d));
  return { said, rest: b.rest() };
};

describe('SentenceBuffer', () => {
  it('gives a sentence once the space after it comes, across deltas', () => {
    expect(split('Sure. Let me ch', 'eck that for you.')).toEqual({ said: ['Sure. '], rest: 'Let me check that for you.' });
    expect(split('Sure.', ' Next?', ' Yes! And')).toEqual({ said: ['Sure. ', 'Next? ', 'Yes! '], rest: 'And' });
  });

  it('keeps a decimal, an abbreviation and an initial inside the sentence', () => {
    expect(split('It is $1.50 each. Dr. Lee and J. Doe come at 9 a.m. tomorrow, e.g. Friday. Ok')).toEqual({
      said: ['It is $1.50 each. ', 'Dr. Lee and J. Doe come at 9 a.m. tomorrow, e.g. Friday. '],
      rest: 'Ok',
    });
  });

  it('ends a sentence after closing quotes and repeated marks', () => {
    expect(split('He said "fine." Then?! ok')).toEqual({ said: ['He said "fine." ', 'Then?! '], rest: 'ok' });
  });

  it('empties itself on rest', () => {
    const b = new SentenceBuffer();
    b.push('Half a');
    expect(b.rest()).toBe('Half a');
    expect(b.rest()).toBe('');
  });
});
