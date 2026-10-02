import { defineSlot } from '../../../../slots/defineSlot';

/**
 * The day a missing parcel was due, as a library `date` slot: today or a day gone, keyable as MMDD.
 * A turn that names no day, or one that does not resolve or resolves below SLOT_CHOICE_FILL, is
 * invalid when the day was asked for and absent otherwise (the defaults). Its questions keep the
 * testkit's own context sentence and its date-of-birth sentence (the mode, month and day questions end
 * with it); their ids are the defaults (expectedDateMode, expectedDateRelative, expectedDateWeekday,
 * expectedDateMonth, expectedDateDay). The hand-written slot never let a confident month and day win
 * over a weekday reading, so preferMonthDay is off. expectedDate.ts is the hand-written slot this
 * replaces, kept until the library is whole (the shadow pair in ../../shadowPairs.ts compares the two).
 */
export const expectedDateDateSlot = defineSlot('expectedDate', {
  type: 'date',
  range: 'past',
  keypad: true,
  preferMonthDay: false,
  context: 'The caller is saying which day a parcel was due to arrive.',
  exclude: "The caller's date of birth is not the day the parcel was due.",
});
