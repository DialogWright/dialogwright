import { birthdateType } from './birthdate/index';
import { choiceType } from './choice/index';
import { dateType } from './date/index';
import { digitsType } from './digits/index';
import { textType } from './text/index';
import type { SlotType, SlotTypes } from './types';

/**
 * The slot types the library ships, by name. Frozen: an app adds its own (or a contributed one)
 * with registerSlotType, which returns a new map to pass to defineSlot, so no import changes what
 * another app sees.
 */
export const BUILT_IN_SLOT_TYPES: SlotTypes = Object.freeze({
  [birthdateType.type]: birthdateType,
  [choiceType.type]: choiceType,
  [dateType.type]: dateType,
  [digitsType.type]: digitsType,
  [textType.type]: textType,
});

/**
 * `types` (the built-in ones by default) with `type` added, as a new map. A name already taken is
 * refused: a type replacing a built-in one would change every slot that names it.
 */
export function registerSlotType(type: SlotType<any>, types: SlotTypes = BUILT_IN_SLOT_TYPES): SlotTypes {
  if (Object.hasOwn(types, type.type)) throw new Error(`a slot type named "${type.type}" is already registered; give the new type another name`);
  return Object.freeze({ ...types, [type.type]: type });
}
