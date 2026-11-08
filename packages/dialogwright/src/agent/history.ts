import type { App, SlotId } from '../core/app/types';
import type { SlotState } from '../core/session';
import { slotsScrubber } from '../trace/redact';
import type { AgentUtterance } from './types';

/**
 * The conversation so far as the agent model is sent it (the maintainer's decision 1, the design's calls
 * 12 and 24): the caller's words and the line's, each earlier one scrubbed of the values the records hide
 * that the line has understood since (a callback number by its last four, said by the caller or read
 * back by the line), as the trace scrubs a line said aloud (trace/redact.ts slotsScrubber: the raw value,
 * its display, and its digits however spaced). Only the fields' slots are looked at, and only their
 * values now: a value not yet understood is not known to be one, and the caller's latest words, which the
 * model reads the value from, are added after this, whole.
 */
export function maskedConversation(app: App, slots: Readonly<Record<SlotId, SlotState>>, fields: readonly SlotId[], conversation: readonly AgentUtterance[]): AgentUtterance[] {
  const held = Object.fromEntries(fields.flatMap((id) => (slots[id] !== undefined && slots[id]!.value !== null ? [[id, slots[id]!]] : [])));
  const scrub = slotsScrubber(held, null, 'length', app);
  return conversation.map((u) => ({ who: u.who, text: scrub === null ? u.text : scrub(u.text) }));
}
