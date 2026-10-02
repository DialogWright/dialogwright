// ORACLE: a frozen copy of the hand-written slot the library `choice` type replaced.
// Used only by the grid tests (src/slots/choice/choice.test.ts) to catch drift in the library.
// Never edit except to delete. Nothing in app runtime may import this file (oracles.test.ts).
import type { SlotOutcome, SlotSpec } from '../../../core/slots/types';
import { isChoice } from '../../../jev/types';
import { atLeast } from '../../../core/thresholds';
import { DAY_PARTS, type DayPart } from '../domain/systems';
import { DAY_PART_DISPLAY, dayPartDisplay } from '../domain/slots/shared';

const isPart = (label: string): label is DayPart => (DAY_PARTS as readonly string[]).includes(label);

/** A plain choice: which part of the day the delivery should come in. */
export const deliveryPartSlot: SlotSpec = {
  id: 'deliveryPart',
  spokenConfirm: 'summary',

  questions() {
    return {
      deliveryPart: {
        type: 'choice',
        instructions: 'Read asr.text alone. Which part of the day do these words name for a delivery?',
        criteria: {
          morning: 'The morning, before noon',
          afternoon: 'The afternoon, from noon until about five',
          evening: 'The evening, after about five',
          none: 'Names no part of the day',
        },
      },
    };
  },

  fill(answers, ctx): SlotOutcome {
    const a = answers.deliveryPart;
    if (!isChoice(a) || !isPart(a.choice)) return { kind: 'absent' };
    const p = a.probabilities[a.choice] ?? a.confidence;
    if (!atLeast(p, ctx.thresholds.SLOT_CHOICE_FILL)) return { kind: 'absent' };
    return { kind: 'filled', value: a.choice, display: DAY_PART_DISPLAY[a.choice], confidence: p, confirm: 'none' };
  },

  dtmf: {
    length: 1,
    parse(digits) {
      const part = DAY_PARTS[Number(digits) - 1];
      return part ? { value: part, display: DAY_PART_DISPLAY[part] } : null;
    },
  },

  display: dayPartDisplay,
};
