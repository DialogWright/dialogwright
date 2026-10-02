import { fileURLToPath } from 'node:url';
import { defineSlots, type ChoiceOptions, type LibrarySlotSpec } from 'dialogwright';

/**
 * The practice's providers, in keypad order (1 to 8). The list is written once, in slots.yaml, as
 * the options of the provider slot (a library `choice` slot): each option's key is the provider's
 * key and its display ("Dr. Chen") names them. These are read from the slot built from it, for the
 * places that need the roster as data: the name slot's excluded words (EXCLUDED_NAME_TOKENS), the
 * directory, the corpus check and the tests. Surnames only, common ones; Chen and Cheng are kept
 * side by side on purpose, since telling them apart by ear is the case disambiguation is for.
 */
export interface Provider {
  key: string;
  name: string;
}

/** The clinic's slots.yaml, whose provider slot's options are the roster. */
const SLOTS_YAML = fileURLToPath(new URL('../../slots.yaml', import.meta.url));

/**
 * The provider slot, built from slots.yaml as defineApp builds it (every clinic slot is a library
 * slot, so no code slots are given). Built here rather than read from the app, which imports this
 * module.
 */
export const providerLibrarySlot = defineSlots(SLOTS_YAML, {}).provider as LibrarySlotSpec<ChoiceOptions>;

const TITLE = 'Dr. ';

export const PROVIDERS: readonly Provider[] = Object.freeze(
  Object.entries(providerLibrarySlot.config.options).map(([key, option]) => {
    if (!option.say.startsWith(TITLE)) throw new Error(`slots.yaml: the provider "${key}" is said as "${option.say}", which does not start with "${TITLE}"`);
    return Object.freeze({ key, name: option.say.slice(TITLE.length) });
  }),
);

/** "Dr. Chen" for a roster key; the key itself for anything else (the provider slot's own display). */
export function providerDisplay(key: string): string {
  return providerLibrarySlot.display(key);
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
