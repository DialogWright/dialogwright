import { defineSlot } from '../../../../slots/defineSlot';
import { MAX_NOTE } from './missingNote';

/**
 * The caller's own words about the missing parcel, as a library `text` slot: what it is and where it
 * should have been left. The value is the utterance verbatim; the summary does not read it back, so
 * its display is a stand-in. The words of the question are the testkit's own (text.given) and its
 * question keeps its id (ids.given). missingNote.ts is the hand-written slot this replaces, kept
 * until the library is whole (the shadow pair in ../../shadowPairs.ts compares the two).
 */
export const missingNoteTextSlot = defineSlot('missingNote', {
  type: 'text',
  text: {
    given:
      'Read asr.text. Does the caller describe the missing parcel: what was in it, what it looked like, or where it should have been left? A request alone is not a description.',
  },
  ids: { given: 'describesParcel' },
  maxLength: MAX_NOTE,
  say: 'your description',
  keep: 'first-unless-prompted',
  redact: 'length',
});
