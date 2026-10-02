import { defineSlot } from '../../../../slots/defineSlot';

/**
 * Which parcel the caller means, as a library `record` slot: one of the customer's parcels (the
 * app's one list, facts.forSlots records), by number, by what is in it or by its day, or a
 * four-digit number they said that is not theirs (spoken, no year rule), keyable as four digits. The
 * question keeps the testkit's own words and id (parcelChoice), its labels (parcel_<number>), its
 * criteria ("Parcel 7101, a box of books, due Monday, September 14"; "Parcel number 4412, as the
 * caller said it") and its reason for a miss when asked (no_parcel). parcelSelect.ts is the
 * hand-written slot this replaces, kept until the library is whole (the shadow pair in
 * ../../shadowPairs.ts compares the two).
 */
export const parcelSelectRecordSlot = defineSlot('parcelSelect', {
  type: 'record',
  key: 'number',
  keyPattern: '\\d{4}',
  labelPrefix: 'parcel_',
  label: 'Parcel {number}, {item}, due {day|day}',
  spoken: { digits: 4, label: 'Parcel number {key}, as the caller said it' },
  missReason: 'no_parcel',
  keypad: 4,
  text: {
    instructions: 'Read asr.text and node.promptJustPlayed. Which parcel does the caller mean? They may name it by number, by what is in it, or by its day. Choose none only when they name no parcel.',
    none: 'Names no parcel',
  },
  ids: { choice: 'parcelChoice' },
});
