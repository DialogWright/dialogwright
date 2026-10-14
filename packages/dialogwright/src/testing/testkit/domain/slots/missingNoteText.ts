import { defineSlot } from '../../../../slots/defineSlot';
import { MAX_NOTE } from './shared';

/**
 * The caller's own words about the missing parcel, as a library `text` slot: what it is and where it
 * should have been left. The value is the utterance verbatim; the summary does not read it back, so
 * its display is a stand-in. The words of the question are the testkit's own (text.given) and its
 * question keeps its id (ids.given). oracles/missingNote.ts is the hand-written slot this
 * replaced, kept as a test oracle for the grid test.
 *
 * `others: listen`: the testkit's own setting over the default for a slot that takes the whole answer
 * (`quiet`; live findings item 27), and the engine's regression test of it. A caller describing a
 * missing parcel often says when it was due in the same breath, and the testkit's corpus holds that
 * over-answer (nt-05: "it was a box of plates, due last tuesday", the expected date filled with the
 * description); under `quiet` that turn would be the description alone and the date asked next. The
 * default is the message fixture's (src/testing/message), whose scripted calls cover it.
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
  others: 'listen',
});
