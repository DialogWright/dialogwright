import { defineSlot } from '../../../../slots/defineSlot';
import { DAY_PART_DISPLAY } from './deliveryPart';

/**
 * Which part of the day the delivery should come in, as a library `choice` slot: the three parts in
 * keypad order (1, 2, 3), each with the line's words for it (say) and the testkit's own criterion
 * (means), and the testkit's own question and none criterion. The question keeps the slot's id, as it
 * always had. deliveryPart.ts is the hand-written slot this replaces, kept until the library is whole
 * (the shadow pair in ../../shadowPairs.ts compares the two).
 */
export const deliveryPartChoiceSlot = defineSlot('deliveryPart', {
  type: 'choice',
  text: {
    instructions: 'Read asr.text alone. Which part of the day do these words name for a delivery?',
    none: 'Names no part of the day',
  },
  keypad: true,
  options: {
    morning: { say: DAY_PART_DISPLAY.morning, means: 'The morning, before noon' },
    afternoon: { say: DAY_PART_DISPLAY.afternoon, means: 'The afternoon, from noon until about five' },
    evening: { say: DAY_PART_DISPLAY.evening, means: 'The evening, after about five' },
  },
});
