import { describe, expect, it } from 'vitest';
import { candidateSpans } from '../core/spans';
import { birthYearSpan, digitSpanLabel, dobParts, relativeDaySaid, saysDob, saysExplicitYear } from './heuristicKit';

const TODAY = '2026-09-18';

describe('the heuristic kit in Spanish (es, es-*), for an app\'s heuristic stub', () => {
  it('picks the span that reads as a number of the length asked', () => {
    const text = 'mi tarjeta es el cinco cinco cinco dos cero cuatro uno siete';
    expect(digitSpanLabel([...candidateSpans(text, 'es'), 'none'], 8, 'es')).toBe('cinco cinco cinco dos cero cuatro uno siete');
    expect(digitSpanLabel([...candidateSpans(text, 'es'), 'none'], 8)).toBeNull();
  });

  it('reads a birth date said in pieces: the month as the questions\' English label, the day, the year span', () => {
    const text = 'nací el veintidós de noviembre de mil novecientos noventa y uno';
    const parts = dobParts(text, TODAY, 'es');
    expect(parts).toEqual({ month: 'november', day: '22', year: 'mil novecientos noventa y uno' });
    expect(saysDob(text, parts, 'es')).toBe(true);
    expect(dobParts('el primero de marzo', TODAY, 'es')).toMatchObject({ month: 'march', day: '1' });
    expect(birthYearSpan(candidateSpans('noventa y uno', 'es'), TODAY, 'es')).toBe('noventa y uno');
    expect(saysExplicitYear('fue en dos mil veinticinco', TODAY, 'es')).toBe(true);
    expect(saysExplicitYear('el veintidós de marzo', TODAY, 'es')).toBe(false);
  });

  it('hears the relative days: hoy, mañana, pasado mañana; ayer, anteayer', () => {
    expect(relativeDaySaid('puede ser hoy', 'future', 'es')).toBe('today');
    expect(relativeDaySaid('mañana por favor', 'future', 'es')).toBe('tomorrow');
    expect(relativeDaySaid('pasado mañana', 'future', 'es-US')).toBe('day_after_tomorrow');
    expect(relativeDaySaid('fue ayer', 'past', 'es')).toBe('yesterday');
    expect(relativeDaySaid('fue anteayer', 'past', 'es')).toBe('day_before_yesterday');
    expect(relativeDaySaid('antes de ayer', 'past', 'es')).toBe('day_before_yesterday');
    expect(relativeDaySaid('el martes', 'future', 'es')).toBeNull();
    // English, for no locale
    expect(relativeDaySaid('the day after tomorrow', 'future')).toBe('day_after_tomorrow');
    expect(relativeDaySaid('yesterday', 'past', 'en-US')).toBe('yesterday');
    expect(relativeDaySaid('mañana', 'future')).toBeNull();
  });
});
