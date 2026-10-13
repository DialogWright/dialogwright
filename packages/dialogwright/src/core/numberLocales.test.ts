import { describe, expect, it } from 'vitest';
import { envReferencesIn, calledReferencePaths } from './app/envReference';
import { clashingNumbers, localeOfNumber, numberLocalesOf } from './numberLocales';

/**
 * The locale a call starts in by the number called (app.yaml's voice.numbers): a number written out, or
 * env.<NAME>, the number in the app's settings, read where the call is answered.
 */

const env = (values: Record<string, string>) => (name: string): string | undefined => (Object.hasOwn(values, name) ? values[name] : undefined);

describe('voice.numbers, read', () => {
  it('keeps a number written out, reads env.<NAME> from the settings (trimmed), in the order written, and names a variable unset or blank', () => {
    const voice = { numbers: { 'env.SPANISH_LINE': 'es', '+15555550142': 'fr', 'env.GERMAN_LINE': 'de', 'env.BLANK_LINE': 'it', '555-0142': 'pt' } };
    expect(numberLocalesOf(voice, env({ SPANISH_LINE: ' +15555550188 ', BLANK_LINE: '  ' }))).toEqual({
      numbers: [{ number: '+15555550188', variable: 'SPANISH_LINE', locale: 'es' }, { number: '+15555550142', locale: 'fr' }],
      unset: ['GERMAN_LINE', 'BLANK_LINE'],
      invalid: ['555-0142'],
    });
    expect(numberLocalesOf(undefined, env({}))).toEqual({ numbers: [], unset: [], invalid: [] });
  });

  it('finds the locale of the number called: written as listed first, else the same number by its digits, as a called condition compares', () => {
    const numbers = [{ number: '+15555550188', variable: 'SPANISH_LINE', locale: 'es' }, { number: '+15555550142', locale: 'fr' }];
    expect(localeOfNumber(numbers, '+15555550188')).toBe('es');
    expect(localeOfNumber(numbers, '+15555550142')).toBe('fr');
    // As a carrier may write it: no plus, a national number, a SIP address's user part.
    expect(localeOfNumber(numbers, '15555550188')).toBe('es');
    expect(localeOfNumber(numbers, '5555550188')).toBe('es');
    expect(localeOfNumber(numbers, 'sip:+15555550142@pbx.example.com:5060')).toBe('fr');
    // Another country's number with the same last ten digits is another number.
    expect(localeOfNumber(numbers, '+75555550188')).toBeUndefined();
    for (const none of ['+15555550100', '', undefined, null]) expect(localeOfNumber(numbers, none)).toBeUndefined();
  });

  it('names two entries that are one number and start in different locales; the same locale twice is harmless', () => {
    const a = { number: '+15555550188', variable: 'SPANISH_LINE', locale: 'es' };
    expect(clashingNumbers([a, { number: '15555550188', locale: 'fr' }])).toEqual([[a, { number: '15555550188', locale: 'fr' }]]);
    expect(clashingNumbers([a, { number: '+15555550188', locale: 'es' }])).toEqual([]);
    expect(clashingNumbers([a, { number: '+15555550142', locale: 'fr' }])).toEqual([]);
  });

  it('finds env.<NAME> among voice.numbers\' keys, at voice.numbers, and counts it a number callers dial', () => {
    const appYaml = { id: 'x', startParameters: { line: 'env.LINE_ID' }, voice: { numbers: { 'env.SPANISH_LINE': 'es', '+15555550142': 'fr' }, hints: ['env.NOT_A_KEY_PLACE'] } };
    expect(envReferencesIn(appYaml)).toEqual([
      { path: 'startParameters.line', variable: 'LINE_ID' },
      { path: 'voice.numbers', variable: 'SPANISH_LINE' },
      { path: 'voice.hints.0', variable: 'NOT_A_KEY_PLACE' },
    ]);
    expect(calledReferencePaths('app.yaml', appYaml).has('voice.numbers')).toBe(true);
    // A map's keys elsewhere are never read as references; a value under voice.numbers is a locale, not one.
    expect(envReferencesIn({ startParameters: { 'env.KEY': 'x' } })).toEqual([]);
    expect(calledReferencePaths('routes.yaml', appYaml).has('voice.numbers')).toBe(false);
  });
});
