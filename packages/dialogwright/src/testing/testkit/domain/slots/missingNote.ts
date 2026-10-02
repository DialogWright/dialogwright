import type { SlotOutcome, SlotSpec } from '../../../../core/slots/types';
import { noulValue } from '../../../../jev/types';
import { atLeast } from '../../../../core/thresholds';

/** The most of the caller's words a note keeps. */
export const MAX_NOTE = 500;

/**
 * The caller's own words about the missing parcel: what it is and where it should have been left.
 * The value is the utterance verbatim; the summary does not read it back, so its display is a stand-in.
 */
export const missingNoteSlot: SlotSpec = {
  id: 'missingNote',
  spokenConfirm: 'summary',
  redact: 'length',
  detect: true,

  questions() {
    return {
      describesParcel: {
        type: 'noul',
        instructions: 'Read asr.text. Does the caller describe the missing parcel: what was in it, what it looked like, or where it should have been left? A request alone is not a description.',
      },
    };
  },

  fill(answers, ctx): SlotOutcome {
    const p = noulValue(answers, 'describesParcel');
    if (!atLeast(p, ctx.thresholds.SLOT_DETECT)) return { kind: 'absent' };
    // Already on file and not being asked for: a later aside must not overwrite it.
    if (ctx.current !== null && !ctx.prompted) return { kind: 'absent' };
    const value = ctx.text.trim().slice(0, MAX_NOTE);
    if (!value) return { kind: 'absent' };
    return { kind: 'filled', value, display: 'your description', confidence: p, confirm: 'none' };
  },

  display: () => 'your description',
};
