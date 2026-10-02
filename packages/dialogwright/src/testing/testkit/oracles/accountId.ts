// ORACLE: a frozen copy of the hand-written slot the library `digits` type replaced.
// Used only by the grid tests (src/slots/digits/digits.test.ts) to catch drift in the library.
// Never edit except to delete. Nothing in app runtime may import this file (oracles.test.ts).
import type { SlotOutcome, SlotSpec } from '../../../core/slots/types';
import { isChoice, noulValue } from '../../../jev/types';
import { spokenToDigits } from '../../../core/extract/spokenNumber';
import { matchesMask } from '../../../core/extract/mask';
import { atLeast } from '../../../core/thresholds';
import { ACCOUNT_ID_DIGITS, ACCOUNT_ID_MASK } from '../domain/slots/shared';

/** "5550 1234": two groups of four, as the line reads it back. */
export function formatAccountId(value: string): string {
  return `${value.slice(0, 4)} ${value.slice(4)}`;
}

/** The first identity factor: detected by a yes-or-no question, then picked as a span of the words. */
export const accountIdSlot: SlotSpec = {
  id: 'accountId',
  spokenConfirm: 'summary',
  redact: 'last4',
  handoff: 'last4',
  detect: true,

  questions(ctx) {
    const criteria: Record<string, string | null> = {};
    for (const span of ctx.candidateSpans) criteria[span] = null;
    criteria.none = 'No span of asr.text is an account ID';
    return {
      containsAccountId: {
        type: 'noul',
        instructions: 'Read asr.text. Does the caller state an account ID number, either as digits or as spoken number words?',
      },
      accountIdSpan: {
        type: 'choice',
        instructions: 'Read asr.text. Which of these spans is the account ID the caller states? Choose the span that covers the whole number as spoken, and no other words. Choose none if no span is an account ID.',
        criteria,
      },
      accountIdComplete: {
        type: 'noul',
        instructions: 'Read asr.text. If the caller states an account ID, do they finish saying the whole number rather than trailing off?',
      },
    };
  },

  fill(answers, ctx): SlotOutcome {
    const t = ctx.thresholds;
    if (!atLeast(noulValue(answers, 'containsAccountId'), t.SLOT_DETECT)) return { kind: 'absent' };
    if (!atLeast(noulValue(answers, 'accountIdComplete'), t.SLOT_DETECT)) return { kind: 'invalid', reason: 'incomplete', raw: '' };
    const span = answers.accountIdSpan;
    if (!isChoice(span) || span.choice === 'none') return { kind: 'invalid', reason: 'no_span', raw: '' };
    const digits = spokenToDigits(span.choice);
    if (!matchesMask(digits, ACCOUNT_ID_MASK)) return { kind: 'invalid', reason: 'mask', raw: digits };
    return { kind: 'filled', value: digits, display: formatAccountId(digits), confidence: span.probabilities[span.choice] ?? span.confidence, confirm: 'implicit' };
  },

  dtmf: {
    length: ACCOUNT_ID_DIGITS,
    parse: (digits) => (matchesMask(digits, ACCOUNT_ID_MASK) ? { value: digits, display: formatAccountId(digits) } : null),
  },

  display: formatAccountId,
};
