// ORACLE: a frozen copy of the hand-written slot the library `record` type replaced.
// Used only by the grid tests (src/slots/record/record.test.ts) to catch drift in the library.
// Never edit except to delete. Nothing in app runtime may import this file (oracles.test.ts).
import type { SlotContext, SlotOutcome, SlotSpec } from '../../../core/slots/types';
import { isChoice, rankProbabilities, type QuestionMap } from '../../../jev/types';
import { NUMBER_WORDS, spokenToDigits, tokenize } from '../../../core/extract/spokenNumber';
import { describeDay } from '../../../core/extract/date';
import { atLeast } from '../../../core/thresholds';

const PARCEL_NUMBER = /^\d{4}$/;
const PREFIX = 'parcel_';

/** One of the customer's parcels, as the choice question describes it (SlotContext.records). */
export interface ParcelRef {
  number: string;
  item: string;
  day: string;
}

const numberish = (tok: string): boolean => NUMBER_WORDS.has(tok) || /^\d+$/.test(tok);

/** Four-digit numbers the caller says, as digits or as number words, each run of number words read on its own. */
export function spokenParcelNumbers(text: string): string[] {
  const words = tokenize(text);
  const out = new Set<string>();
  for (let i = 0; i < words.length; ) {
    if (!numberish(words[i]!)) {
      i++;
      continue;
    }
    let j = i;
    while (j < words.length && numberish(words[j]!)) j++;
    const digits = spokenToDigits(words.slice(i, j).join(' '));
    if (PARCEL_NUMBER.test(digits)) out.add(digits);
    i = j;
  }
  for (const m of text.matchAll(/\b\d{4}\b/g)) out.add(m[0]);
  return [...out];
}

/** The customer's own parcels, then any other number the caller said. */
function candidates(ctx: SlotContext): { number: string; criterion: string }[] {
  const seen = new Set<string>();
  const out: { number: string; criterion: string }[] = [];
  for (const p of ctx.records as readonly ParcelRef[]) {
    if (seen.has(p.number)) continue;
    seen.add(p.number);
    out.push({ number: p.number, criterion: `Parcel ${p.number}, ${p.item}, due ${describeDay(p.day)}` });
  }
  for (const n of spokenParcelNumbers(ctx.text)) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push({ number: n, criterion: `Parcel number ${n}, as the caller said it` });
  }
  return out;
}

function numberOf(label: string): string | null {
  const n = label.startsWith(PREFIX) ? label.slice(PREFIX.length) : '';
  return PARCEL_NUMBER.test(n) ? n : null;
}

/**
 * Which parcel the caller means: one of their own, by number or by what is in it, or a number they
 * said that is not theirs. The gate, not this slot, decides whether they may hear about it (R2).
 */
export const parcelSelectSlot: SlotSpec = {
  id: 'parcelSelect',
  spokenConfirm: 'summary',

  questions(ctx): QuestionMap {
    const list = candidates(ctx);
    if (list.length === 0) return {};
    const criteria: Record<string, string | null> = {};
    for (const c of list) criteria[`${PREFIX}${c.number}`] = c.criterion;
    criteria.none = 'Names no parcel';
    return {
      parcelChoice: {
        type: 'choice',
        instructions: 'Read asr.text and node.promptJustPlayed. Which parcel does the caller mean? They may name it by number, by what is in it, or by its day. Choose none only when they name no parcel.',
        criteria,
      },
    };
  },

  fill(answers, ctx): SlotOutcome {
    const t = ctx.thresholds;
    const a = answers.parcelChoice;
    const miss: SlotOutcome = ctx.prompted ? { kind: 'invalid', reason: 'no_parcel', raw: '' } : { kind: 'absent' };
    if (!isChoice(a)) return miss;
    const [top, second] = rankProbabilities(a.probabilities);
    const n = top ? numberOf(top.label) : null;
    if (!top || n === null || !atLeast(top.p, t.SLOT_CHOICE_CONFIRM)) return miss;
    const rival = second ? numberOf(second.label) : null;
    if (rival !== null && !atLeast(top.p - second!.p, t.SLOT_CHOICE_MARGIN)) {
      return { kind: 'disambiguate', a: { value: n, display: n }, b: { value: rival, display: rival } };
    }
    if (!atLeast(top.p, t.SLOT_CHOICE_FILL)) return miss;
    return { kind: 'filled', value: n, display: n, confidence: top.p, confirm: 'none' };
  },

  dtmf: {
    length: 4,
    parse: (digits) => (PARCEL_NUMBER.test(digits) ? { value: digits, display: digits } : null),
  },

  display: (value) => value,
};
