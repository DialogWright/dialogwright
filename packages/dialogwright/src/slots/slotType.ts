import type { SlotType } from './types';

/** A type's name: what an app writes after `type:`. */
export const SLOT_TYPE_NAME = /^[a-z][a-z0-9-]*$/;

/** The key no options schema has, offered to see that an unknown one is refused. */
const PROBE_KEY = '__notAnOption__';

/**
 * A slot type, checked: its name is a plain lower-case word, and its options schema refuses a key it
 * does not know (a strict object), so a misspelt option is an error rather than a default silently
 * kept. Returns `def` itself, so a lazy `examples` getter stays lazy.
 */
export function defineSlotType<O>(def: SlotType<O>): SlotType<O> {
  if (!SLOT_TYPE_NAME.test(def.type)) {
    throw new Error(`the slot type name "${def.type}" must be lower-case letters, digits and hyphens, starting with a letter`);
  }
  if (!refusesUnknownKeys(def)) {
    throw new Error(`the "${def.type}" type's options must refuse unknown keys: build them with z.strictObject`);
  }
  return def;
}

/** Whether a type's options schema refuses a key it does not know. */
export function refusesUnknownKeys(def: Pick<SlotType<unknown>, 'options'>): boolean {
  const result = def.options.safeParse({ [PROBE_KEY]: true });
  return !result.success && result.error.issues.some((issue) => issue.code === 'unrecognized_keys' && issue.keys.includes(PROBE_KEY));
}
