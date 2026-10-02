import { defineSlot } from '../../../../slots/defineSlot';

/**
 * The day a delivery is wanted on, as a library `date` slot: today or a day to come, keyable as MMDD.
 * A turn that names no day, or one that does not resolve (a month without a day is a span, which this
 * slot does not hold) or resolves below SLOT_CHOICE_FILL, is invalid when the day was asked for and
 * absent otherwise (the defaults). Its questions keep the testkit's own context sentence; their ids
 * are the defaults (deliveryDayMode, deliveryDayRelative, deliveryDayWeekday, deliveryDayMonth,
 * deliveryDayDay). The hand-written slot never let a confident month and day win over a weekday
 * reading, so preferMonthDay is off. oracles/deliveryDay.ts is the hand-written slot this
 * replaced, kept as a test oracle for the grid test.
 */
export const deliveryDayDateSlot = defineSlot('deliveryDay', {
  type: 'date',
  range: 'future',
  keypad: true,
  preferMonthDay: false,
  context: 'The caller is saying which day they want a delivery on.',
});
