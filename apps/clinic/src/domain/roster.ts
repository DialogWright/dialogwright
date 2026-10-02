/**
 * The practice's providers, in keypad order (1 to 8). Surnames only, common ones; Chen and Cheng
 * are kept side by side on purpose, since telling them apart by ear is the case disambiguation is for.
 */
export interface Provider {
  key: string;
  name: string;
}

export const PROVIDERS: readonly Provider[] = [
  { key: 'chen', name: 'Chen' },
  { key: 'cheng', name: 'Cheng' },
  { key: 'patel', name: 'Patel' },
  { key: 'okafor', name: 'Okafor' },
  { key: 'nguyen', name: 'Nguyen' },
  { key: 'rossi', name: 'Rossi' },
  { key: 'kim', name: 'Kim' },
  { key: 'alvarez', name: 'Alvarez' },
];

/** "Dr. Chen" for a roster key; the key itself for anything else. */
export function providerDisplay(key: string): string {
  const p = PROVIDERS.find((x) => x.key === key);
  return p ? `Dr. ${p.name}` : key;
}

/**
 * Words that disqualify a span from being the caller's own name: every word of the roster and the
 * titles that mark a name as a doctor's. The cost: a caller who shares a surname with one of the
 * practice's doctors cannot give their name by voice, and the keypad-less name slot walks its
 * retry ladder to a person, which is the safer of the two failures.
 */
export const EXCLUDED_NAME_TOKENS: ReadonlySet<string> = new Set([
  'dr', 'doctor',
  ...PROVIDERS.flatMap((p) => [p.key, ...p.name.toLowerCase().split(/\s+/)]),
]);
