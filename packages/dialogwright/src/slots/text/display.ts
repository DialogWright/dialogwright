import type { TextOptions } from './options';

/**
 * How a text slot's value is said: the stand-in (`say`) when it has one, the words otherwise. The
 * same in every locale; a per-locale stand-in comes with the locale's slot texts.
 */
export function textDisplay(o: Pick<TextOptions, 'say'>): (value: string, locale?: string) => string {
  return (value) => o.say ?? value;
}
