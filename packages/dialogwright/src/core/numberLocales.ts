import type { VoiceConfig } from './app/types';
import { envVariableOf } from './app/envReference';
import { digitsOf, sameNumber } from './conditions';

/**
 * The locale a call starts in, by the number called (app.yaml's voice.numbers, VoiceConfig.numbers).
 * Each key is a number written out (E.164, in quotes) or `env.<NAME>`, the number in the app's own
 * settings, as every other number in its YAML is; each value one of the app's locales. A server reads
 * the variables as it starts (server/transfer.ts voiceNumbersFrom, per app under a host file); a
 * scripted call from its own `env` (harness-text/runner.ts). The number called is compared with each as
 * a `called` condition compares (core/conditions.ts sameNumber), a number digit for digit first.
 */

/**
 * An E.164 number as the engine holds one: a + and 8 to 15 digits. A number written out as a key of
 * voice.numbers, and every number a variable holds (server/transfer.ts reads its numbers by this one).
 */
export const E164 = /^\+\d{8,15}$/;

/** One entry of voice.numbers, read: its number, the variable it was read from (absent for a number written out), the locale its calls start in. */
export interface NumberLocale {
  readonly number: string;
  readonly variable?: string;
  readonly locale: string;
}

/**
 * The entries of voice.numbers, in the order written: a number written out as it is, an `env.<NAME>`
 * by `env` (its value trimmed). A variable unset or blank is left out of `numbers` and named in `unset`;
 * a key that is neither form is in `invalid` (the schema and validateApp refuse one before this runs).
 */
export function numberLocalesOf(voice: Pick<VoiceConfig, 'numbers'> | undefined, env: (name: string) => string | undefined): { numbers: NumberLocale[]; unset: string[]; invalid: string[] } {
  const numbers: NumberLocale[] = [];
  const unset: string[] = [];
  const invalid: string[] = [];
  for (const [key, locale] of Object.entries(voice?.numbers ?? {})) {
    const variable = envVariableOf(key);
    if (variable === null) {
      if (E164.test(key)) numbers.push({ number: key, locale });
      else invalid.push(key);
      continue;
    }
    const value = env(variable)?.trim();
    if (value === undefined || value === '') unset.push(variable);
    else numbers.push({ number: value, variable, locale });
  }
  return { numbers, unset, invalid };
}

/**
 * The locale a call to `called` starts in, matched as host.yaml's numbers are (server/host.ts appFor):
 * digit for digit first (`+1 (555) 555-0188`, or a SIP address's user part), and a ten-digit national
 * number's match (sameNumber) only when none is exact; undefined when none matches, or no number was called.
 */
export function localeOfNumber(numbers: readonly NumberLocale[], called: string | null | undefined): string | undefined {
  if (called === null || called === undefined || called.trim() === '') return undefined;
  const digits = digitsOf(called);
  return (numbers.find((n) => digitsOf(n.number) === digits) ?? numbers.find((n) => sameNumber(called, n.number)))?.locale;
}

/**
 * Two entries that are one number by their digits (sameNumber) and start calls in different locales,
 * each pair once, in the order written: a call to that number could start in either, so the server
 * refuses to start. Two that start in the same locale are harmless and not named.
 */
export function clashingNumbers(numbers: readonly NumberLocale[]): [NumberLocale, NumberLocale][] {
  const out: [NumberLocale, NumberLocale][] = [];
  numbers.forEach((a, i) => {
    for (const b of numbers.slice(i + 1)) if (a.locale !== b.locale && sameNumber(a.number, b.number)) out.push([a, b]);
  });
  return out;
}

