import type { SlotType } from './types';
import { LISTEN_OPTION, OFFER_AT_OPTION, OFFER_OPTION } from '../define/schema/slots';

/** A type's name: what an app writes after `type:`. */
export const SLOT_TYPE_NAME = /^[a-z][a-z0-9-]*$/;

/** The key no options schema has, offered to see that an unknown one is refused. */
const PROBE_KEY = '__notAnOption__';

/**
 * A slot type, checked: its name is a plain lower-case word, and its options schema refuses a key it
 * does not know (a strict object), so a misspelt option is an error rather than a default silently
 * kept. Returns `def` itself, so a lazy `examples` getter stays lazy.
 */
export function defineSlotType<O, W = unknown>(def: SlotType<O, W>): SlotType<O, W> {
  if (!SLOT_TYPE_NAME.test(def.type)) {
    throw new Error(`the slot type name "${def.type}" must be lower-case letters, digits and hyphens, starting with a letter`);
  }
  if (!refusesUnknownKeys(def)) {
    throw new Error(`the "${def.type}" type's options must refuse unknown keys: build them with z.strictObject`);
  }
  if (!refusesUnknownKeys(def, LISTEN_OPTION)) {
    throw new Error(`the "${def.type}" type has an option "${LISTEN_OPTION}", which every slot takes beside its type's options (SlotSpec.listen): give the option another name`);
  }
  if (!refusesUnknownKeys(def, OFFER_OPTION)) {
    throw new Error(`the "${def.type}" type has an option "${OFFER_OPTION}", which every slot takes beside its type's options (SlotSpec.offer): give the option another name`);
  }
  if (!refusesUnknownKeys(def, OFFER_AT_OPTION)) {
    throw new Error(`the "${def.type}" type has an option "${OFFER_AT_OPTION}", which every slot takes beside its type's options (SlotSpec.offerAt): give the option another name`);
  }
  return def;
}

/** Whether a type's options schema refuses a key it does not know (or `key`, as one it should not know). */
export function refusesUnknownKeys(def: Pick<SlotType<unknown, unknown>, 'options'>, key: string = PROBE_KEY): boolean {
  const result = def.options.safeParse({ [key]: true });
  return !result.success && result.error.issues.some((issue) => issue.code === 'unrecognized_keys' && issue.keys.includes(key));
}
