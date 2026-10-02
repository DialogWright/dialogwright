import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { matchesMask } from '../../core/extract/mask';
import { spokenToDigits } from '../../core/extract/spokenNumber';
import type { SlotOutcome, SlotSpec } from '../../core/slots/types';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { isChoice, noulValue } from '../../jev/types';
import { formatProblem } from '../../define/problems';
import { choice, noul } from '../../testing/answers';
import { shadowSlot } from '../../testing/shadowSlot';
import { testSlotContext } from '../../testing/slots';
import { accountIdSlot } from '../../testing/testkit/oracles/accountId';
import { runSlotConformance } from '../conformance/run';
import { buildSlot, defineSlot, slotTypeJsonSchema } from '../defineSlot';
import { digitsType } from './index';

/** The `digits` type: the conformance kit over its examples, then what the kit does not cover. */
runSlotConformance(digitsType, { describe, it, locales: ['en-US', 'es'] });

const T = DEFAULT_THRESHOLDS;
const account = defineSlot('account', { type: 'digits', noun: 'account', length: 8, keypad: true, group: [4, 4] });
const SAID = 'my account is five five five zero seven seven eight eight';
const SPAN = 'five five five zero seven seven eight eight';
const heard = (span: string, p = 0.9, given = 0.95, complete = 0.9) => ({
  accountGiven: noul(given),
  accountSpan: choice({ [span]: p, none: 1 - p }),
  accountComplete: noul(complete),
});

describe('a digits slot built from the defaults', () => {
  it('asks three questions, named after the slot, in the default words, with the spans as the span question\'s choices', () => {
    expect(account.questionIds).toEqual(['accountGiven', 'accountSpan', 'accountComplete']);
    const q = account.questions(testSlotContext('it is five five five'));
    expect(Object.keys(q)).toEqual(['accountGiven', 'accountSpan', 'accountComplete']);
    expect(q.accountGiven).toEqual({
      type: 'noul',
      instructions: 'Read asr.text. Does the caller state an account number, either as digits or as spoken number words?',
    });
    expect(q.accountComplete).toEqual({
      type: 'noul',
      instructions: 'Read asr.text. If the caller states an account, do they finish saying the whole number rather than trailing off?',
    });
    expect(q.accountSpan).toEqual({
      type: 'choice',
      instructions:
        'Read asr.text. Which of these spans is the account the caller states? Choose the span that covers the whole number as spoken, including number words like forty-four or three hundred fifty-five and modifiers like double or triple. Do not include words that are not part of the number. Choose none if no span is an account.',
      criteria: { ...Object.fromEntries(testSlotContext('it is five five five').candidateSpans.map((s) => [s, null])), none: 'No span of asr.text is an account' },
    });
  });

  it('puts "a" before a consonant and "an" before a vowel, unless the article is given', () => {
    const card = defineSlot('card', { type: 'digits', noun: 'library card', length: 8 });
    expect(card.questions(testSlotContext('')).cardGiven).toMatchObject({ instructions: expect.stringContaining('state a library card number,') });
    const the = defineSlot('card', { type: 'digits', noun: 'library card', article: 'the', length: 8 });
    expect(the.questions(testSlotContext('')).cardGiven).toMatchObject({ instructions: expect.stringContaining('state the library card number,') });
  });

  it('declares its keypad line, and no others', () => {
    expect(account.prompts).toEqual([{ id: 'ask_account_dtmf', why: 'it asks for an account on the keypad after spoken answers missed' }]);
    expect(defineSlot('n', { type: 'digits', noun: 'account', length: 8 }).prompts).toEqual([]);
  });

  it('is detected, read back in the summary, masked and handed over by its last four, with a keypad of length digits', () => {
    expect(account).toMatchObject({ spokenConfirm: 'summary', redact: 'last4', handoff: 'last4', detect: true });
    expect(account.dtmf?.length).toBe(8);
  });

  it('carries its type and its parsed options, defaults applied', () => {
    expect(account.type).toBe('digits');
    expect(account.config).toEqual({
      noun: 'account', length: 8, keypad: true, group: [4, 4], confirm: 'summary', readBack: 'implicit', minConfidence: 'none', redact: 'last4', handoff: 'last4',
    });
    expect(Object.isFrozen(account.config)).toBe(true);
  });
});

describe('fill', () => {
  it('fills the span\'s digits, grouped for the line, and asks to be read back', () => {
    expect(account.fill(heard(SPAN), testSlotContext(SAID))).toEqual({ kind: 'filled', value: '55507788', display: '5550 7788', confidence: 0.9, confirm: 'implicit' });
    expect(account.fill(heard('5550 7788'), testSlotContext('it is 5550 7788'))).toMatchObject({ kind: 'filled', value: '55507788' });
  });

  it('is absent when no number is stated, and when there are no answers at all', () => {
    expect(account.fill({ accountGiven: noul(0.1), accountSpan: choice({ none: 1 }), accountComplete: noul(0.5) }, testSlotContext('I want to cancel'))).toEqual({ kind: 'absent' });
    expect(account.fill({}, testSlotContext(''))).toEqual({ kind: 'absent' });
  });

  it('is invalid when the caller trails off, when no span is the number, and when the digits are the wrong length', () => {
    expect(account.fill(heard('five five', 0.9, 0.9, 0.2), testSlotContext('it is five five'))).toEqual({ kind: 'invalid', reason: 'incomplete', raw: '' });
    expect(account.fill({ ...heard('x'), accountSpan: choice({ none: 0.9, 'five five': 0.1 }) }, testSlotContext('five five'))).toEqual({ kind: 'invalid', reason: 'no_span', raw: '' });
    expect(account.fill(heard('five five five'), testSlotContext('it is five five five'))).toEqual({ kind: 'invalid', reason: 'length', raw: '555' });
  });

  it('reads SLOT_DETECT from the context, at the threshold and not below it', () => {
    expect(account.fill(heard(SPAN, 0.9, T.SLOT_DETECT), testSlotContext(SAID)).kind).toBe('filled');
    expect(account.fill(heard(SPAN, 0.9, T.SLOT_DETECT - 0.01), testSlotContext(SAID)).kind).toBe('absent');
    expect(account.fill(heard(SPAN, 0.9, 0.9), testSlotContext(SAID, { thresholds: { ...T, SLOT_DETECT: 0.95 } })).kind).toBe('absent');
    expect(account.fill(heard(SPAN, 0.9, 0.9, T.SLOT_DETECT - 0.01), testSlotContext(SAID))).toMatchObject({ reason: 'incomplete' });
  });
});

describe('mask and length', () => {
  it('mask checks the pattern, and the reason says so; length alone says "length"', () => {
    const fives = defineSlot('code', { type: 'digits', noun: 'code', mask: '^5\\d{3}$' });
    const ids = { codeGiven: noul(0.9), codeComplete: noul(0.9) };
    expect(fives.fill({ ...ids, codeSpan: choice({ 'five one two three': 0.9, none: 0.1 }) }, testSlotContext(''))).toMatchObject({ kind: 'filled', value: '5123' });
    expect(fives.fill({ ...ids, codeSpan: choice({ 'six one two three': 0.9, none: 0.1 }) }, testSlotContext(''))).toEqual({ kind: 'invalid', reason: 'mask', raw: '6123' });
    expect(fives.dtmf).toBeUndefined();
  });

  it('a keypad needs a length, and the keypad takes only digits that match', () => {
    const r = buildSlot('code', { type: 'digits', noun: 'code', mask: '^5\\d{3}$', keypad: true });
    expect(!r.ok && r.problems.map(formatProblem)).toEqual(['(code)  code.keypad  keypad is true, but the keypad needs to know how many digits to wait for  ->  add "length:" with the number of digits']);
    const both = defineSlot('code', { type: 'digits', noun: 'code', length: 4, mask: '^5\\d{3}$', keypad: true });
    expect(both.dtmf?.parse('5123', testSlotContext(''))).toEqual({ value: '5123', display: '5123' });
    expect(both.dtmf?.parse('6123', testSlotContext(''))).toBeNull();
  });

  it('needs a length or a mask, a mask that is a pattern, and groups that add up to the length', () => {
    const none = buildSlot('code', { type: 'digits', noun: 'code' });
    expect(!none.ok && none.problems.map(formatProblem)).toEqual(['(code)  code  a digits slot needs "length" (how many digits) or "mask" (a pattern the digits must match)  ->  add "length:" with a number such as 8']);
    const bad = buildSlot('code', { type: 'digits', noun: 'code', mask: '^(\\d' });
    expect(!bad.ok && bad.problems.map((p) => p.path)).toEqual(['code.mask']);
    const sum = buildSlot('code', { type: 'digits', noun: 'code', length: 8, group: [4, 3] });
    expect(!sum.ok && sum.problems.map(formatProblem)).toEqual(['(code)  code.group  group adds up to 7 digits, but length is 8  ->  change the groups so they add up to 8']);
  });
});

describe('group', () => {
  it('says the value in groups, the last taking what is left, and all together without group', () => {
    const phone = defineSlot('line', { type: 'digits', noun: 'line', length: 10, group: [3, 3, 4] });
    expect(phone.display('5550123456')).toBe('555 012 3456');
    expect(account.display('55507788')).toBe('5550 7788');
    expect(account.display('555077889')).toBe('5550 77889');
    expect(account.display('555')).toBe('555');
    expect(defineSlot('plain', { type: 'digits', noun: 'thing', length: 8 }).display('55507788')).toBe('55507788');
  });

  it('the fill and the keypad say it the same way', () => {
    expect(account.dtmf!.parse('55507788', testSlotContext(''))).toEqual({ value: '55507788', display: '5550 7788' });
    expect(account.dtmf!.parse('5550778#', testSlotContext(''))).toBeNull();
  });
});

describe('the threshold a digits slot names (SlotSpec.thresholds)', () => {
  it('is its minConfidence floor, and none when there is no floor', () => {
    expect(account.thresholds).toBeUndefined();
    expect(defineSlot('account', { type: 'digits', noun: 'account', length: 8, minConfidence: 'SLOT_CHOICE_CONFIRM' }).thresholds).toEqual(['SLOT_CHOICE_CONFIRM']);
    expect(defineSlot('account', { type: 'digits', noun: 'account', length: 8, minConfidence: 'SLOT_DETECT' }).thresholds).toEqual(['SLOT_DETECT']);
    expect(defineSlot('account', { type: 'digits', noun: 'account', length: 8, minConfidence: 'none' }).thresholds).toBeUndefined();
  });
});

describe('confirm, readBack and minConfidence', () => {
  const card = defineSlot('card', { type: 'digits', noun: 'library card', length: 8, confirm: 'by-confidence', readBack: 'below-fill', minConfidence: 'SLOT_CHOICE_CONFIRM', lengthRetryPromptId: 'ask_card_length' });
  // the model chose the span, however sure it was of it
  const heardCard = (p: number) => ({ cardGiven: noul(0.95), cardSpan: { type: 'choice' as const, choice: SPAN, probabilities: { [SPAN]: p, none: 1 - p }, confidence: p }, cardComplete: noul(0.9) });

  it('is acknowledged when the model is less sure of the span, taken silently when it is sure, refused when it is unsure', () => {
    expect(card.spokenConfirm).toBe('by-confidence');
    expect(card.fill(heardCard(T.SLOT_CHOICE_FILL), testSlotContext(SAID))).toMatchObject({ kind: 'filled', confirm: 'none' });
    expect(card.fill(heardCard((T.SLOT_CHOICE_FILL + T.SLOT_CHOICE_CONFIRM) / 2), testSlotContext(SAID))).toMatchObject({ kind: 'filled', confirm: 'implicit' });
    expect(card.fill(heardCard(T.SLOT_CHOICE_CONFIRM), testSlotContext(SAID)).kind).toBe('filled');
    expect(card.fill(heardCard(T.SLOT_CHOICE_CONFIRM - 0.01), testSlotContext(SAID))).toEqual({ kind: 'invalid', reason: 'low_confidence', raw: '' });
  });

  it('reads the thresholds from the context, so an override moves them', () => {
    const ctx = testSlotContext(SAID, { thresholds: { ...T, SLOT_CHOICE_FILL: 0.95 } });
    expect(card.fill(heardCard(0.9), ctx)).toMatchObject({ confirm: 'implicit' });
  });

  it('declares the acknowledgement and the length re-ask, and the re-ask is what a wrong length says', () => {
    expect(card.prompts!.map((p) => p.id)).toEqual(['ask_card_length', 'ack_card']);
    expect(card.prompts![1]).toMatchObject({ vars: ['card'] });
    expect(card.fill({ cardGiven: noul(0.95), cardSpan: choice({ 'five five five': 0.9, none: 0.1 }), cardComplete: noul(0.9) }, testSlotContext(''))).toEqual({
      kind: 'invalid', reason: 'length', raw: '555', retryPromptId: 'ask_card_length',
    });
  });

  it('readBack none never asks, and implicit always does; summary refuses a readBack it would ignore', () => {
    const quiet = defineSlot('card', { type: 'digits', noun: 'card', length: 8, confirm: 'by-confidence', readBack: 'none' });
    expect(quiet.fill(heardCard(0.4), testSlotContext(SAID))).toMatchObject({ kind: 'filled', confirm: 'none' });
    const always = defineSlot('card', { type: 'digits', noun: 'card', length: 8, confirm: 'by-confidence' });
    expect(always.fill(heardCard(0.9), testSlotContext(SAID))).toMatchObject({ kind: 'filled', confirm: 'implicit' });
    const r = buildSlot('card', { type: 'digits', noun: 'card', length: 8, readBack: 'below-fill' });
    expect(!r.ok && r.problems.map(formatProblem)).toEqual([
      '(code)  card.readBack  readBack "below-fill" has no effect with confirm "summary", which neither acknowledges nor reads back a spoken number  ->  set confirm: by-confidence, or delete readBack',
    ]);
  });

  it('minConfidence names a threshold the engine has', () => {
    const r = buildSlot('card', { type: 'digits', noun: 'card', length: 8, minConfidence: 'SLOT_CHOICE_CONFRIM' });
    expect(!r.ok && r.problems.map((p) => p.path)).toEqual(['card.minConfidence']);
  });
});

describe('redact and handoff', () => {
  it('can be left off: redact none keeps the value as it is, handoff display hands over the display', () => {
    const open = defineSlot('parcel', { type: 'digits', noun: 'parcel', length: 10, redact: 'none', handoff: 'display' });
    expect(open.redact).toBeUndefined();
    expect(open.handoff).toBeUndefined();
    expect(defineSlot('parcel', { type: 'digits', noun: 'parcel', length: 10, handoff: 'verified' }).handoff).toBe('verified');
  });
});

describe('the words and the ids', () => {
  it('text replaces a question word for word, and ids renames a question', () => {
    const slot = defineSlot('reference', {
      type: 'digits',
      length: 6,
      text: { given: 'Is there a reference?', span: 'Which span?', none: 'None of them', complete: 'Is that all of it?' },
      ids: { given: 'givesReference', span: 'referenceSpan', complete: 'referenceWhole' },
    });
    expect(slot.questionIds).toEqual(['givesReference', 'referenceSpan', 'referenceWhole']);
    expect(slot.questions(testSlotContext('five')).referenceWhole).toEqual({ type: 'noul', instructions: 'Is that all of it?' });
    expect(slot.questions(testSlotContext('five')).referenceSpan).toMatchObject({ instructions: 'Which span?', criteria: { five: null, none: 'None of them' } });
  });

  it('needs a noun unless every question is literal, and refuses a noun then', () => {
    const none = buildSlot('code', { type: 'digits', length: 4, text: { given: 'x' } });
    expect(!none.ok && none.problems.map(formatProblem)).toEqual([
      '(code)  code  a digits slot needs "noun" (what the number identifies, which the default questions name) or text for each of given, span, none and complete  ->  add "noun:" with a word or two, such as "account" or "library card"',
    ]);
    const both = buildSlot('code', { type: 'digits', length: 4, noun: 'code', text: { given: 'a', span: 'b', none: 'c', complete: 'd' } });
    expect(!both.ok && both.problems.map((p) => `${p.path}: ${p.message}`)).toEqual(['code.noun: "noun" is not used, since text gives every question in its own words']);
  });

  it('refuses an id the engine asks', () => {
    const r = buildSlot('code', { type: 'digits', noun: 'code', length: 4, ids: { span: 'intent' } });
    expect(!r.ok && r.problems.map((p) => p.path)).toEqual(['code.ids.span']);
  });
});

describe('the testkit\'s account ID, written as configuration', () => {
  // Proof that the type's options reach a hand-written slot exactly, through the same shadow
  // harness the migration uses: its own question words, its ids, its grouping.
  const library = defineSlot('accountId', {
    type: 'digits',
    noun: 'account ID',
    length: 8,
    mask: '^\\d{8}$',
    keypad: true,
    group: [4, 4],
    text: { span: 'Read asr.text. Which of these spans is the account ID the caller states? Choose the span that covers the whole number as spoken, and no other words. Choose none if no span is an account ID.' },
    ids: { given: 'containsAccountId', span: 'accountIdSpan', complete: 'accountIdComplete' },
  });
  const shadow = shadowSlot(accountIdSlot, library);
  const texts = ['', 'my account id is five five five zero seven seven eight eight', 'it is 5550 1234', 'five five five'];
  const spans = ['five five five zero seven seven eight eight', '5550 1234', 'five five five', 'none'];

  it('asks the same questions and fills the same way on every branch', () => {
    for (const text of texts) {
      const ctx = testSlotContext(text);
      shadow.questions(ctx);
      for (const given of [0, 0.59, 0.6, 0.95]) {
        for (const complete of [0, 0.59, 0.6, 0.95]) {
          for (const span of spans) {
            for (const p of [0.3, 0.9]) {
              shadow.fill({ containsAccountId: noul(given), accountIdComplete: noul(complete), accountIdSpan: choice({ [span]: p, ...(span === 'none' ? {} : { none: 1 - p }) }) }, ctx);
            }
          }
        }
      }
      shadow.fill({}, ctx);
    }
    for (const keys of ['55501234', '5550123#', '555012345', '', '12345678']) shadow.dtmf!.parse(keys, testSlotContext(''));
    expect(shadow.display('55501234')).toBe('5550 1234');
  });
});

describe('the library fixture\'s card, written as configuration', () => {
  // The card was hand-written before it was a digits slot: acknowledged below SLOT_CHOICE_FILL, refused
  // below SLOT_CHOICE_CONFIRM, with its own re-ask for a wrong length. This is that slot, as it was,
  // shadowed by the same configuration with the old words as literals: everything but the words is the
  // type's (the default words are asserted above).
  const MASK = /^\d{8}$/;
  const legacy: SlotSpec = {
    id: 'card',
    spokenConfirm: 'by-confidence',
    redact: 'last4',
    handoff: 'last4',
    detect: true,
    questions(ctx) {
      const criteria: Record<string, string | null> = {};
      for (const span of ctx.candidateSpans) criteria[span] = null;
      criteria.none = 'No span of asr.text is a library card number';
      return {
        cardGiven: { type: 'noul', instructions: 'Read asr.text. Does the caller state a library card number, as digits or as spoken number words?' },
        cardSpan: {
          type: 'choice',
          instructions: 'Read asr.text. Which of these spans is the library card number the caller states? Choose the span that covers the whole number as spoken, and no words that are not part of it. Choose none if no span is a card number.',
          criteria,
        },
        cardComplete: { type: 'noul', instructions: 'Read asr.text. If the caller states a library card number, do they finish saying the whole number rather than trailing off?' },
      };
    },
    fill(answers, ctx): SlotOutcome {
      const t = ctx.thresholds;
      if (noulValue(answers, 'cardGiven') < t.SLOT_DETECT) return { kind: 'absent' };
      if (noulValue(answers, 'cardComplete') < t.SLOT_DETECT) return { kind: 'invalid', reason: 'incomplete', raw: '' };
      const span = answers.cardSpan;
      if (!isChoice(span) || span.choice === 'none') return { kind: 'invalid', reason: 'no_span', raw: '' };
      const p = span.probabilities[span.choice] ?? span.confidence;
      if (p < t.SLOT_CHOICE_CONFIRM) return { kind: 'invalid', reason: 'low_confidence', raw: '' };
      const digits = spokenToDigits(span.choice);
      if (!matchesMask(digits, MASK)) return { kind: 'invalid', reason: 'length', raw: digits, retryPromptId: 'ask_card_length' };
      return { kind: 'filled', value: digits, display: digits, confidence: p, confirm: p >= t.SLOT_CHOICE_FILL ? 'none' : 'implicit' };
    },
    dtmf: { length: 8, parse: (digits) => (matchesMask(digits, MASK) ? { value: digits, display: digits } : null) },
    display: (value) => value,
  };
  const library = defineSlot('card', {
    type: 'digits',
    length: 8,
    keypad: true,
    confirm: 'by-confidence',
    readBack: 'below-fill',
    minConfidence: 'SLOT_CHOICE_CONFIRM',
    lengthRetryPromptId: 'ask_card_length',
    text: {
      given: 'Read asr.text. Does the caller state a library card number, as digits or as spoken number words?',
      span: 'Read asr.text. Which of these spans is the library card number the caller states? Choose the span that covers the whole number as spoken, and no words that are not part of it. Choose none if no span is a card number.',
      none: 'No span of asr.text is a library card number',
      complete: 'Read asr.text. If the caller states a library card number, do they finish saying the whole number rather than trailing off?',
    },
  });
  const shadow = shadowSlot(legacy, library);

  it('asks the same questions and fills the same way on every branch, probabilities away from the thresholds', () => {
    // (the legacy slot compares with < and the type with atLeast: they differ only on a probability
    // within 1e-9 of a threshold, so the grid stays off the thresholds)
    const spans = ['five five five two zero four one seven', '5552 0417', 'five five five two', 'none'];
    for (const text of ['', 'my card is five five five two zero four one seven', 'five five five']) {
      const ctx = testSlotContext(text);
      shadow.questions(ctx);
      for (const given of [0.2, 0.9]) {
        for (const complete of [0.2, 0.9]) {
          for (const span of spans) {
            for (const p of [0.2, 0.44, 0.5, 0.56, 0.95]) {
              const answer = span === 'none' ? choice({ none: 1 }) : { type: 'choice' as const, choice: span, probabilities: { [span]: p, none: 1 - p }, confidence: p };
              shadow.fill({ cardGiven: noul(given), cardComplete: noul(complete), cardSpan: answer }, ctx);
            }
          }
        }
      }
      shadow.fill({}, ctx);
    }
    for (const keys of ['55520417', '5552041#', '555204171', '']) shadow.dtmf!.parse(keys, testSlotContext(''));
  });
});

describe('the docs', () => {
  it('the README names every option', () => {
    const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
    const options = Object.keys((slotTypeJsonSchema(digitsType).properties ?? {}) as object).filter((k) => k !== 'type');
    expect(options.sort()).toEqual(['article', 'confirm', 'group', 'handoff', 'ids', 'keypad', 'length', 'lengthRetryPromptId', 'mask', 'minConfidence', 'noun', 'readBack', 'redact', 'text']);
    for (const option of options) expect(readme, option).toContain(`\`${option}\``);
  });
});

describe('a digits slot in Spanish (es, es-*)', () => {
  const card = defineSlot('card', { type: 'digits', noun: 'library card', length: 8, keypad: true, group: [4, 4] });
  const answered = (span: string) => ({ cardGiven: noul(0.95), cardSpan: choice({ [span]: 0.9, none: 0.1 }), cardComplete: noul(0.9) });

  it('offers the Spanish spans and reads them as Spanish numbers; the questions stay in English', () => {
    const said = 'mi tarjeta es cincuenta y cinco cincuenta y dos, cero cuatro diecisiete';
    const es = testSlotContext(said, { locale: 'es' });
    const q = card.questions(es);
    const span = q.cardSpan!;
    expect(span.type === 'choice' && Object.keys(span.criteria)).toContain('cincuenta y cinco cincuenta y dos cero cuatro diecisiete');
    expect(q.cardGiven!.instructions).toBe(card.questions(testSlotContext(said)).cardGiven!.instructions);
    expect(card.fill(answered('cincuenta y cinco cincuenta y dos cero cuatro diecisiete'), es)).toMatchObject({ kind: 'filled', value: '55520417', display: '5552 0417' });
    expect(card.fill(answered('cinco cinco cinco dos cero cuatro uno siete'), testSlotContext('cinco cinco cinco dos cero cuatro uno siete', { locale: 'es-MX' }))).toMatchObject({ kind: 'filled', value: '55520417' });
  });

  it('reads no Spanish words in English, and no English words in Spanish', () => {
    expect(card.fill(answered('cinco cinco cinco dos cero cuatro uno siete'), testSlotContext('cinco cinco cinco dos cero cuatro uno siete', { locale: 'en-US' }))).toEqual({ kind: 'invalid', reason: 'length', raw: '' });
    expect(card.fill(answered('five five five two zero four one seven'), testSlotContext('five five five two zero four one seven', { locale: 'es' }))).toEqual({ kind: 'invalid', reason: 'length', raw: '' });
    // digits as written are digits in either
    expect(card.fill(answered('5552 0417'), testSlotContext('5552 0417', { locale: 'es' }))).toMatchObject({ kind: 'filled', value: '55520417' });
  });

  it('keys and says the number the same in every locale', () => {
    expect(card.dtmf!.parse('55520417', testSlotContext('', { locale: 'es' }))).toEqual({ value: '55520417', display: '5552 0417' });
    expect(card.display('55520417', 'es')).toBe(card.display('55520417'));
  });
});
