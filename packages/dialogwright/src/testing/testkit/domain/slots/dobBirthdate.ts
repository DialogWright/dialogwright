import { defineSlot } from '../../../../slots/defineSlot';

/** The sentence the month and day questions end with: which number of a date said as numbers is which. */
const NUMBERS = 'A date said as numbers is month first, then day, then year.';

/**
 * The second identity factor, as a library `birthdate` slot: a date of birth heard whole or in part,
 * keyable on the keypad as MMDDYYYY, masked to its year, handed over only as whether the caller was
 * verified. A month and day with no year ask for the year alone (ask_dob_year, the default); a month
 * or a day missing asks for the whole date again (ask_dob_whole). Its questions keep the testkit's own
 * words where they differ from the library's defaults (text), and its ids are the defaults (dobGiven,
 * dobMonth, dobDay, dobYear). dob.ts is the hand-written slot this replaces, kept until the library is
 * whole (the shadow pair in ../../shadowPairs.ts compares the two).
 */
export const dobBirthdateSlot = defineSlot('dob', {
  type: 'birthdate',
  keypad: true,
  wholePrompt: 'ask_dob_whole',
  handoff: 'verified',
  text: {
    given: 'Read asr.text. Does the caller state their date of birth, in whole or in part (a month and day, or a year alone when asked for it)?',
    givenFalse: "No birth date. A delivery date, or someone else's birth date, is not the caller's date of birth",
    monthHint: NUMBERS,
    dayHint: NUMBERS,
    year: "Read asr.text. Which of these spans is the year of the caller's birth, if they say one? Choose none when no year is said.",
    yearAsked: 'Read asr.text. The caller was asked for the year of their birth. Which of these spans is that year? Choose none when no year is said.',
    yearNone: "No span of asr.text is the year of the caller's birth",
  },
});
