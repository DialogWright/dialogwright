import type { SlotOutcome, SlotSpec } from '../../../../core/slots/types';
import { isChoice } from '../../../../jev/types';
import { atLeast } from '../../../../core/thresholds';
import { DAY_PARTS, type DayPart } from '../systems';

/** How the line says each part of the day: "in the morning". */
export const DAY_PART_DISPLAY: Readonly<Record<DayPart, string>> = {
  morning: 'in the morning',
  afternoon: 'in the afternoon',
  evening: 'in the evening',
};

const isPart = (label: string): label is DayPart => (DAY_PARTS as readonly string[]).includes(label);

export const dayPartDisplay = (value: string): string => (isPart(value) ? DAY_PART_DISPLAY[value] : value);

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
