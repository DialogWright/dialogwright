import { defineSlot } from '../../../../slots/defineSlot';
import { ACCOUNT_ID_DIGITS, ACCOUNT_ID_MASK } from './shared';

/**
 * The first identity factor, as a library `digits` slot: an eight digit account ID, said back in two
 * groups of four, keyable on the keypad, recorded and handed over by its last four. Its questions are
 * the library's defaults with "account ID" as the noun, except the span question, which keeps the
 * testkit's own wording (text.span). Its ids are the ones it always had (ids), and a number that is
 * not eight digits is "mask" (the mask is given). oracles/accountId.ts is the
 * hand-written slot this replaced, kept as a test oracle for the grid test.
 */
export const accountIdDigitsSlot = defineSlot('accountId', {
  type: 'digits',
  noun: 'account ID',
  length: ACCOUNT_ID_DIGITS,
  mask: ACCOUNT_ID_MASK.source,
  keypad: true,
  group: [4, 4],
  text: {
    span: 'Read asr.text. Which of these spans is the account ID the caller states? Choose the span that covers the whole number as spoken, and no other words. Choose none if no span is an account ID.',
  },
  ids: { given: 'containsAccountId', span: 'accountIdSpan', complete: 'accountIdComplete' },
  redact: 'last4',
  handoff: 'last4',
});
