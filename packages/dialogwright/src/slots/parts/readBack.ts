import type { SlotPrompt, SlotSpec } from '../../core/slots/types';

/**
 * How a library slot is read back, as slots.yaml writes it (`confirm`, and a choice slot's
 * `confirmValues`), turned into what the SlotSpec carries: its spokenConfirm, the values read back at
 * once (SlotSpec.confirmValues, only when there are any), and, for a slot that can read back at all,
 * readBackNo `ask`: a no empties the slot and asks it again, where a slot written in code goes to the
 * keypad. A slot that never reads back carries neither, so it is built exactly as before.
 */
export function readBackOf(confirm: SlotSpec['spokenConfirm'], confirmValues?: readonly string[]): Pick<SlotSpec, 'spokenConfirm' | 'confirmValues' | 'readBackNo'> {
  const values = confirmValues !== undefined && confirmValues.length > 0 ? [...confirmValues] : null;
  const reads = confirm === 'always' || values !== null;
  return { spokenConfirm: confirm, ...(values !== null ? { confirmValues: values } : {}), ...(reads ? { readBackNo: 'ask' as const } : {}) };
}

/**
 * What `confirm: always` does, for an option's description: `what` is the value as the type names it
 * ("a spoken number").
 */
export function alwaysConfirmText(what: string): string {
  return `"always": ${what} is read back for a yes as soon as it is heard (confirm_<slot>, given its display as {<slot>}), before the form goes on; a no empties the slot and asks it again (ack_declined, then ask_<slot>, or ask_<slot>_dtmf where the slot takes keys), and a second no goes to a person.`;
}

/**
 * The read-back line a slot that reads back declares (SlotSpec.prompts): `confirm_<slot>`, given the
 * display as `{<slot>}`, so check holds the line to that one variable. None for a slot that never
 * reads back.
 */
export function readBackPrompts(id: string, confirm: SlotSpec['spokenConfirm'], confirmValues?: readonly string[]): SlotPrompt[] {
  if (confirm === 'always') return [{ id: `confirm_${id}`, why: 'it reads a value back for a yes as soon as it is heard (confirm: always)', vars: [id] }];
  if (confirmValues !== undefined && confirmValues.length > 0) {
    return [{ id: `confirm_${id}`, why: `it reads ${confirmValues.map((v) => `"${v}"`).join(' or ')} back for a yes as soon as it is chosen (confirmValues)`, vars: [id] }];
  }
  return [];
}
