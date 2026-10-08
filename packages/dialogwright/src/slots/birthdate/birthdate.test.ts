import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MONTHS } from '../../core/extract/date';
import type { SlotPartial, SlotSpec } from '../../core/slots/types';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import type { ChoiceAnswer } from '../../jev/types';
import { formatProblem } from '../../define/problems';
import { choice, noul } from '../../testing/answers';
import { createShadowReport, shadowSlot } from '../../testing/shadowSlot';
import { testSlotContext } from '../../testing/slots';
import { dobSlot as testkitDob } from '../../testing/testkit/oracles/dob';
import { dobBirthdateSlot } from '../../testing/testkit/domain/slots/dobBirthdate';
import { runSlotConformance } from '../conformance/run';
import { buildSlot, defineSlot, slotTypeJsonSchema } from '../defineSlot';
import { BIRTHDATE_DAYS, birthdateType } from './index';

/** The `birthdate` type: the conformance kit over its examples, then what the kit does not cover. */
runSlotConformance(birthdateType, { describe, it, locales: ['en-US', 'es'] });

const T = DEFAULT_THRESHOLDS;
const dob = defineSlot('dob', { type: 'birthdate', keypad: true });
const PENDING: SlotPartial = { kind: 'dob', month: 6, day: 14 };

/** The model chose `label` with probability `p` (however low), or none. */
const chose = (label: string, p: number): ChoiceAnswer =>
  label === 'none' ? choice({ none: 1 }) : { type: 'choice', choice: label, probabilities: { [label]: p, none: 1 - p }, confidence: p };
const heard = (month: string, day: string, year: string, p = 0.9, given = 0.95) => ({
  dobGiven: noul(given),
  dobMonth: chose(month, p),
  dobDay: chose(day, p),
  dobYear: chose(year, p),
});

describe('a birthdate slot built from the defaults', () => {
  it('asks four questions, named after the slot, in the default words', () => {
    expect(dob.questionIds).toEqual(['dobGiven', 'dobMonth', 'dobDay', 'dobYear']);
    const ctx = testSlotContext('june fourteenth seventy five');
    const q = dob.questions(ctx);
    expect(Object.keys(q)).toEqual(['dobGiven', 'dobMonth', 'dobDay', 'dobYear']);
    expect(q.dobGiven).toEqual({
      type: 'noul',
      instructions: 'Read asr.text. Does the caller state their date of birth or birthday, in whole or in part (a month and day, or a year alone when asked for it)?',
      criteria: {
        true: 'The caller gives their own birth date or part of it: a full date, a month and day, or a year on its own in answer to a question about their birth year',
        false: "No birth date. Someone else's birth date is not the caller's date of birth",
      },
    });
    expect(q.dobMonth).toEqual({
      type: 'choice',
      instructions: "Read asr.text. Which month is the caller's date of birth in, if they say one?",
      criteria: Object.fromEntries([...MONTHS, 'none'].map((m) => [m, null])),
    });
    expect(q.dobDay).toEqual({
      type: 'choice',
      instructions: "Read asr.text. Which day of the month is the caller's date of birth, if they say one?",
      criteria: Object.fromEntries([...BIRTHDATE_DAYS, 'none'].map((d) => [d, null])),
    });
    expect(Object.keys((q.dobDay as { criteria: object }).criteria)).toEqual([...Array.from({ length: 31 }, (_, i) => String(i + 1)), 'none']);
    expect(q.dobYear).toEqual({
      type: 'choice',
      instructions:
        'Read asr.text. Which of these spans is the year of the caller\'s birth, if they say one, as in "nineteen seventy four", "seventy four", or "two thousand one"? Choose none when no year is said.',
      criteria: { ...Object.fromEntries(ctx.candidateSpans.map((s) => [s, null])), none: "No span of asr.text is a year of the caller's birth" },
    });
  });

  it('says the caller was asked for the year while a month and day are on hand, and asks the other three as before', () => {
    const before = dob.questions(testSlotContext('seventy five'));
    const after = dob.questions(testSlotContext('seventy five', { window: PENDING, prompted: true }));
    expect(after.dobYear).toMatchObject({
      instructions:
        'Read asr.text. The caller was asked for the year of their birth. Which of these spans is that year, as in "nineteen seventy four", "seventy four", or "two thousand one"? Choose none when no year is said.',
    });
    expect(after.dobYear).toMatchObject({ criteria: (before.dobYear as { criteria: object }).criteria });
    for (const id of ['dobGiven', 'dobMonth', 'dobDay']) expect(after[id], id).toEqual(before[id]);
    // a partial of another kind is not the slot's
    expect(dob.questions(testSlotContext('seventy five', { window: { kind: 'week', from: 'x' } })).dobYear).toEqual(before.dobYear);
  });

  it('is detected, a date, masked, summarized, with an eight-key keypad and the year line as its partial prompt', () => {
    expect(dob).toMatchObject({ spokenConfirm: 'summary', redact: 'mask', valueKind: 'date', detect: true, partialPromptId: 'ask_dob_year' });
    expect(dob.handoff).toBeUndefined();
    expect(dob.partialVars).toBeUndefined();
    expect(dob.dtmf?.length).toBe(8);
  });

  it('declares the year line and the keypad line, and the whole-date line when it has one', () => {
    expect(dob.prompts).toEqual([
      { id: 'ask_dob_year', why: 'the caller gave the month and day of their birth without the year (the partialPromptId)' },
      { id: 'ask_dob_dtmf', why: 'it asks for the date of birth on the keypad, as eight digits, after spoken answers missed' },
    ]);
    const spoken = defineSlot('born', { type: 'birthdate', wholePrompt: 'ask_born_again', yearPrompt: 'ask_born_when' });
    expect(spoken.prompts!.map((p) => p.id)).toEqual(['ask_born_when', 'ask_born_again']);
    expect(spoken.partialPromptId).toBe('ask_born_when');
    expect(spoken.dtmf).toBeUndefined();
  });

  it('carries its type and its parsed options, defaults applied', () => {
    expect(dob.type).toBe('birthdate');
    expect(dob.config).toEqual({ keypad: true, minYear: 1900, redact: 'mask', handoff: 'display', confirm: 'summary' });
    expect(Object.isFrozen(dob.config)).toBe(true);
  });
});

describe('fill', () => {
  it('fills a whole date with the ISO day, said back as a birthday, never read back on its own', () => {
    expect(dob.fill(heard('june', '14', 'nineteen seventy five'), testSlotContext(''))).toEqual({
      kind: 'filled', value: '1975-06-14', display: 'June 14th, 1975', confidence: 0.9, confirm: 'none',
    });
  });

  it('takes the least sure of the parts it heard as its confidence', () => {
    const answers = { ...heard('june', '14', 'seventy five'), dobDay: chose('14', 0.6) };
    expect(dob.fill(answers, testSlotContext(''))).toMatchObject({ kind: 'filled', confidence: 0.6 });
  });

  it('holds a month and day without a year as the partial, then fills from the year alone', () => {
    expect(dob.fill(heard('june', '14', 'none'), testSlotContext(''))).toEqual({ kind: 'window', window: { kind: 'dob', month: 6, day: 14 }, confidence: 0.9 });
    expect(dob.fill(heard('none', 'none', 'seventy five'), testSlotContext('seventy five', { window: PENDING, prompted: true }))).toMatchObject({ kind: 'filled', value: '1975-06-14' });
    // a restated month or day replaces the partial's
    expect(dob.fill(heard('july', 'none', 'seventy five'), testSlotContext('', { window: PENDING }))).toMatchObject({ kind: 'filled', value: '1975-07-14' });
  });

  it('is absent when no birth date is stated, when nothing at all is heard, and when none of the parts is heard this turn', () => {
    expect(dob.fill(heard('june', '14', 'seventy five', 0.9, 0.2), testSlotContext(''))).toEqual({ kind: 'absent' });
    expect(dob.fill({}, testSlotContext(''))).toEqual({ kind: 'absent' });
    expect(dob.fill(heard('none', 'none', 'none'), testSlotContext('', { window: PENDING }))).toEqual({ kind: 'absent' });
    expect(dob.fill(heard('june', '14', 'seventy five', 0.3), testSlotContext('', { window: PENDING }))).toEqual({ kind: 'absent' });
  });

  it('is invalid, "no_year", when a month or a day is missing and no wholePrompt is set', () => {
    expect(dob.fill(heard('none', 'none', 'seventy five'), testSlotContext(''))).toEqual({ kind: 'invalid', reason: 'no_year', raw: '' });
    expect(dob.fill(heard('june', 'none', 'none'), testSlotContext(''))).toEqual({ kind: 'invalid', reason: 'no_year', raw: '' });
  });

  it('with a wholePrompt, says which part is missing and asks for the whole date again', () => {
    const whole = defineSlot('dob', { type: 'birthdate', wholePrompt: 'ask_dob_whole' });
    expect(whole.fill(heard('none', 'none', 'seventy five'), testSlotContext(''))).toEqual({ kind: 'invalid', reason: 'no_month_day', raw: '', retryPromptId: 'ask_dob_whole' });
    expect(whole.fill(heard('none', '14', 'seventy five'), testSlotContext(''))).toEqual({ kind: 'invalid', reason: 'no_month', raw: '', retryPromptId: 'ask_dob_whole' });
    expect(whole.fill(heard('june', 'none', 'none'), testSlotContext(''))).toEqual({ kind: 'invalid', reason: 'no_day', raw: '', retryPromptId: 'ask_dob_whole' });
  });

  it('is invalid, "impossible", for a year before minYear and a day that does not exist', () => {
    expect(dob.fill(heard('june', '14', 'eighteen ninety nine'), testSlotContext(''))).toEqual({ kind: 'invalid', reason: 'impossible', raw: '1899' });
    expect(dob.fill(heard('june', '14', 'nineteen hundred'), testSlotContext(''))).toMatchObject({ kind: 'filled', value: '1900-06-14' });
    expect(dob.fill(heard('february', '30', 'nineteen ninety'), testSlotContext(''))).toEqual({ kind: 'invalid', reason: 'impossible', raw: '1990-2-30' });
    expect(dob.fill(heard('february', '29', 'nineteen seventy six'), testSlotContext(''))).toMatchObject({ kind: 'filled', value: '1976-02-29' });
    const later = defineSlot('dob', { type: 'birthdate', minYear: 1920 });
    expect(later.fill(heard('june', '14', 'nineteen nineteen'), testSlotContext(''))).toEqual({ kind: 'invalid', reason: 'impossible', raw: '1919' });
  });

  it('is invalid, "future", from today on, with the ISO day as raw (so the engine can tell the day was heard)', () => {
    expect(dob.fill(heard('september', '18', 'twenty twenty six'), testSlotContext(''))).toEqual({ kind: 'invalid', reason: 'future', raw: '2026-09-18' });
    expect(dob.fill(heard('september', '17', 'twenty twenty six'), testSlotContext(''))).toMatchObject({ kind: 'filled', value: '2026-09-17' });
  });

  it('reads SLOT_DETECT and SLOT_CHOICE_CONFIRM from the context, at the threshold and not below it', () => {
    expect(dob.fill(heard('june', '14', 'seventy five', 0.9, T.SLOT_DETECT), testSlotContext('')).kind).toBe('filled');
    expect(dob.fill(heard('june', '14', 'seventy five', 0.9, T.SLOT_DETECT - 0.01), testSlotContext('')).kind).toBe('absent');
    expect(dob.fill(heard('june', '14', 'seventy five', T.SLOT_CHOICE_CONFIRM), testSlotContext('')).kind).toBe('filled');
    expect(dob.fill(heard('june', '14', 'seventy five', T.SLOT_CHOICE_CONFIRM - 0.01), testSlotContext('')).kind).toBe('absent');
    expect(dob.fill(heard('june', '14', 'seventy five'), testSlotContext('', { thresholds: { ...T, SLOT_CHOICE_CONFIRM: 0.95 } })).kind).toBe('absent');
  });
});

describe('the keypad', () => {
  const ctx = testSlotContext('');

  it('takes eight digits, month, day and year, that make a real day in the past', () => {
    expect(dob.dtmf!.parse('06141975', ctx)).toEqual({ value: '1975-06-14', display: 'June 14th, 1975' });
    expect(dob.dtmf!.parse('02291976', ctx)).toEqual({ value: '1976-02-29', display: 'February 29th, 1976' });
    expect(dob.dtmf!.parse('09172026', ctx)).toMatchObject({ value: '2026-09-17' });
  });

  it('refuses no such day, today and later, a year before minYear, and keys that are not eight digits', () => {
    for (const keys of ['02301990', '13011990', '00141975', '06001975', '02291975', '09182026', '01012030', '12311899', '0614197', '061419755', '0614197#', '']) {
      expect(dob.dtmf!.parse(keys, ctx), keys).toBeNull();
    }
    expect(defineSlot('dob', { type: 'birthdate', keypad: true, minYear: 1950 }).dtmf!.parse('06141949', ctx)).toBeNull();
  });
});

describe('the words and the ids', () => {
  it('notThisDate ends the month and day questions with which date this is not, and names it in the "false" criterion', () => {
    const slot = defineSlot('born', { type: 'birthdate', notThisDate: 'the date a book is due' });
    const q = slot.questions(testSlotContext(''));
    expect(q.bornMonth).toMatchObject({ instructions: "Read asr.text. Which month is the caller's date of birth in, if they say one? This is the birth date, not the date a book is due." });
    expect(q.bornDay).toMatchObject({ instructions: "Read asr.text. Which day of the month is the caller's date of birth, if they say one? This is the birth date, not the date a book is due." });
    expect(q.bornGiven).toMatchObject({ criteria: { false: "No birth date. The date a book is due, or someone else's birth date, is not the caller's date of birth" } });
  });

  it('the hints end the month and day questions, after notThisDate', () => {
    const slot = defineSlot('born', { type: 'birthdate', notThisDate: 'a due date', text: { monthHint: 'Month first.', dayHint: 'Day second.' } });
    const q = slot.questions(testSlotContext(''));
    expect(q.bornMonth).toMatchObject({ instructions: "Read asr.text. Which month is the caller's date of birth in, if they say one? This is the birth date, not a due date. Month first." });
    expect(q.bornDay).toMatchObject({ instructions: "Read asr.text. Which day of the month is the caller's date of birth, if they say one? This is the birth date, not a due date. Day second." });
  });

  it('text replaces any part word for word, and ids renames a question', () => {
    const slot = defineSlot('born', {
      type: 'birthdate',
      text: { given: 'Is a birthday said?', givenTrue: 'Yes', givenFalse: 'No', month: 'Which month?', day: 'Which day?', year: 'Which year?', yearAsked: 'Which year, then?', yearNone: 'No year' },
      ids: { given: 'saysBirthday', month: 'birthMonth', day: 'birthDay', year: 'birthYear' },
    });
    expect(slot.questionIds).toEqual(['saysBirthday', 'birthMonth', 'birthDay', 'birthYear']);
    const q = slot.questions(testSlotContext('seventy five'));
    expect(q.saysBirthday).toEqual({ type: 'noul', instructions: 'Is a birthday said?', criteria: { true: 'Yes', false: 'No' } });
    expect(q.birthMonth).toMatchObject({ instructions: 'Which month?' });
    expect(q.birthDay).toMatchObject({ instructions: 'Which day?' });
    expect(q.birthYear).toMatchObject({ instructions: 'Which year?', criteria: { none: 'No year' } });
    expect(slot.questions(testSlotContext('', { window: PENDING })).birthYear).toMatchObject({ instructions: 'Which year, then?' });
    expect(slot.fill({ saysBirthday: noul(0.9), birthMonth: chose('june', 0.9), birthDay: chose('14', 0.9), birthYear: chose('seventy five', 0.9) }, testSlotContext(''))).toMatchObject({ value: '1975-06-14' });
  });

  it('refuses a hint or a notThisDate that the literal text leaves unused', () => {
    const hint = buildSlot('born', { type: 'birthdate', text: { month: 'Which month?', monthHint: 'Month first.' } });
    expect(!hint.ok && hint.problems.map(formatProblem)).toEqual([
      '(code)  born.text.monthHint  "text.monthHint" is not used, since text.month gives the whole month question  ->  delete "monthHint", or write it into text.month',
    ]);
    const day = buildSlot('born', { type: 'birthdate', text: { day: 'Which day?', dayHint: 'Day second.' } });
    expect(!day.ok && day.problems.map((p) => p.path)).toEqual(['born.text.dayHint']);
    const date = buildSlot('born', { type: 'birthdate', notThisDate: 'a due date', text: { month: 'a', day: 'b', givenFalse: 'c' } });
    expect(!date.ok && date.problems.map((p) => `${p.path}: ${p.message}`)).toEqual([
      'born.notThisDate: "notThisDate" is not used, since text gives the month and day questions and the "false" criterion in their own words',
    ]);
  });

  it('refuses an unknown part, an id the engine asks, and a prompt that is not an id', () => {
    expect((buildSlot('born', { type: 'birthdate', text: { hint: 'x' } }) as { problems: { path: string }[] }).problems.map((p) => p.path)).toEqual(['born.text.hint']);
    expect((buildSlot('born', { type: 'birthdate', ids: { month: 'intent' } }) as { problems: { path: string }[] }).problems.map((p) => p.path)).toEqual(['born.ids.month']);
    expect((buildSlot('born', { type: 'birthdate', yearPrompt: 'ask year' }) as { problems: { path: string }[] }).problems.map((p) => p.path)).toEqual(['born.yearPrompt']);
  });
});

describe('redact and handoff', () => {
  it('can be left off, or hand over only whether the caller was verified', () => {
    const open = defineSlot('born', { type: 'birthdate', redact: 'none' });
    expect(open.redact).toBeUndefined();
    expect(defineSlot('born', { type: 'birthdate', handoff: 'verified' }).handoff).toBe('verified');
  });
});

/**
 * Every mix of answers a birthdate slot reads, in every state it can be in, for a shadowed pair of
 * slots (shadowSlot throws on the first difference): the questions with and without a pending
 * partial; fills with each part chosen above, at and below SLOT_CHOICE_CONFIRM, on two todays, with
 * no partial, a partial, a partial of no real day, and another kind's; and every eight keys a keypad
 * can send that make a month, a day and a year near the edges.
 */
function birthdateGrid(shadow: SlotSpec, ids: { given: string; month: string; day: string; year: string }): void {
  const windows: (SlotPartial | null)[] = [null, PENDING, { kind: 'dob', month: 2, day: 29 }, { kind: 'week', from: '2026-09-21' }];
  for (const window of windows) {
    for (const text of ['', 'june fourteenth nineteen seventy five', 'seventy five', 'oh six one four seventy five']) {
      for (const prompted of [false, true]) shadow.questions(testSlotContext(text, { window, prompted }));
    }
  }
  const months = ['june', 'february', 'september', 'none'];
  const days = ['14', '17', '18', '29', '30', '31', 'none'];
  const years = ['nineteen seventy five', 'seventy five', 'eighteen ninety nine', 'nineteen hundred', 'nineteen seventy six', 'twenty twenty six', 'twenty thirty', 'oh', 'none'];
  const ps = [0.3, T.SLOT_CHOICE_CONFIRM, 0.9];
  for (const todayIso of ['2026-09-18', '2001-03-01']) {
    for (const window of windows) {
      const ctx = testSlotContext('', { window, todayIso });
      shadow.fill({}, ctx);
      for (const given of [0.2, T.SLOT_DETECT, 0.9]) {
        for (const month of months) {
          for (const day of days) {
            for (const year of years) {
              for (const p of ps) {
                shadow.fill({ [ids.given]: noul(given), [ids.month]: chose(month, p), [ids.day]: chose(day, p), [ids.year]: chose(year, p) }, ctx);
                shadow.fill({ [ids.given]: noul(given), [ids.month]: chose(month, 0.9), [ids.day]: chose(day, p), [ids.year]: chose(year, 0.3) }, ctx);
              }
            }
          }
        }
      }
    }
  }
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  for (const today of ['2026-09-18', '2001-03-01']) {
    const ctx = testSlotContext('', { todayIso: today });
    for (const m of [0, 1, 2, 6, 9, 12, 13]) {
      for (const d of [0, 1, 14, 17, 18, 28, 29, 30, 31, 32]) {
        for (const y of [1899, 1900, 1975, 1976, 2001, 2026, 2030]) shadow.dtmf!.parse(`${pad(m, 2)}${pad(d, 2)}${pad(y, 4)}`, ctx);
      }
    }
    for (const keys of ['0614197*', '#6141975', '06*41975', 'A6141975', '00000000', '99999999']) shadow.dtmf!.parse(keys, ctx);
  }
  for (const iso of ['1975-06-14', '1976-02-29', '1900-01-01', '2001-11-22']) shadow.display(iso);
}

describe('the testkit\'s date of birth, written as configuration', () => {
  // The testkit's hand-written dob and the library slot that replaces it (its own words as literals,
  // a whole-date re-ask, handed over as verified), through the same shadow harness the migration uses.
  it('declares what the hand-written slot did', () => {
    expect(dobBirthdateSlot.config).toEqual({
      keypad: true,
      wholePrompt: 'ask_dob_whole',
      handoff: 'verified',
      minYear: 1900,
      redact: 'mask',
      confirm: 'summary',
      text: {
        given: 'Read asr.text. Does the caller state their date of birth, in whole or in part (a month and day, or a year alone when asked for it)?',
        givenFalse: "No birth date. A delivery date, or someone else's birth date, is not the caller's date of birth",
        monthHint: 'A date said as numbers is month first, then day, then year.',
        dayHint: 'A date said as numbers is month first, then day, then year.',
        year: "Read asr.text. Which of these spans is the year of the caller's birth, if they say one? Choose none when no year is said.",
        yearAsked: 'Read asr.text. The caller was asked for the year of their birth. Which of these spans is that year? Choose none when no year is said.',
        yearNone: "No span of asr.text is the year of the caller's birth",
      },
    });
    expect(dobBirthdateSlot.prompts!.map((p) => p.id)).toEqual(['ask_dob_year', 'ask_dob_whole', 'ask_dob_dtmf']);
  });

  const ids = { given: 'dobGiven', month: 'dobMonth', day: 'dobDay', year: 'dobYear' };

  it('asks the same questions, fills the same way and keys the same days on every branch', () => {
    const report = createShadowReport();
    birthdateGrid(shadowSlot(testkitDob, dobBirthdateSlot, { report }), ids);
    expect(report.mismatches).toEqual([]);
    expect(report.calls['dob.fill']).toBeGreaterThan(30_000);
    expect(report.calls['dob.dtmf.parse']).toBeGreaterThan(900);
    expect(report.calls['dob.partialVars']).toBeGreaterThan(0);
  });

  it('would find a slot that differs on one edge (a minYear of 1901)', () => {
    const off = defineSlot('dob', { ...dobBirthdateSlot.config, type: 'birthdate', minYear: 1901 });
    expect(() => birthdateGrid(shadowSlot(testkitDob, off), ids)).toThrow(/fill|dtmf/);
  });
});

describe('the docs', () => {
  it('the docs page names every option and every text part', () => {
    const readme = readFileSync(new URL('../../../../../docs/slots/birthdate.md', import.meta.url), 'utf8');
    const options = Object.keys((slotTypeJsonSchema(birthdateType).properties ?? {}) as object).filter((k) => k !== 'type');
    expect(options.sort()).toEqual(['confirm', 'handoff', 'ids', 'keypad', 'listen', 'minYear', 'notThisDate', 'offer', 'redact', 'text', 'wholePrompt', 'yearPrompt']);
    for (const option of options) expect(readme, option).toContain(`\`${option}\``);
    for (const part of ['given', 'givenTrue', 'givenFalse', 'month', 'monthHint', 'day', 'dayHint', 'year', 'yearAsked', 'yearNone']) expect(readme, part).toContain(`\`text.${part}\``);
  });
});

describe('a birthdate slot in Spanish (es, es-*)', () => {
  const dob = defineSlot('dob', { type: 'birthdate', keypad: true });
  const heard = (year: string) => ({
    dobGiven: noul(0.95), dobMonth: choice({ november: 0.93, none: 0.07 }), dobDay: choice({ '22': 0.92, none: 0.08 }), dobYear: choice({ [year]: 0.9, none: 0.1 }),
  });

  it('reads a year said in Spanish and says the date as "22 de noviembre de 1991"', () => {
    const said = 'el veintidós de noviembre de mil novecientos noventa y uno';
    const es = testSlotContext(said, { locale: 'es' });
    const year = dob.questions(es).dobYear!;
    expect(year.type === 'choice' && Object.keys(year.criteria)).toContain('mil novecientos noventa y uno');
    expect(dob.fill(heard('mil novecientos noventa y uno'), es)).toEqual({ kind: 'filled', value: '1991-11-22', display: '22 de noviembre de 1991', confidence: 0.9, confirm: 'none' });
    expect(dob.fill(heard('noventa y uno'), testSlotContext('noventa y uno', { locale: 'es-US' }))).toMatchObject({ value: '1991-11-22', display: '22 de noviembre de 1991' });
    expect(dob.display('1991-11-22', 'en-US')).toBe('November 22nd, 1991');
  });

  it('takes the keypad day first in Spanish (DDMMYYYY), month first otherwise', () => {
    expect(dob.dtmf!.parse('22111991', testSlotContext('', { locale: 'es' }))).toEqual({ value: '1991-11-22', display: '22 de noviembre de 1991' });
    expect(dob.dtmf!.parse('11221991', testSlotContext('', { locale: 'es' }))).toBeNull();
    expect(dob.dtmf!.parse('11221991', testSlotContext(''))).toEqual({ value: '1991-11-22', display: 'November 22nd, 1991' });
    expect(dob.dtmf!.length).toBe(8);
  });

  it('ends the default month and day questions with the day-first sentence in Spanish only; a literal is as written', () => {
    const es = dob.questions(testSlotContext('22/11/1991', { locale: 'es' }));
    const en = dob.questions(testSlotContext('22/11/1991', { locale: 'en-US' }));
    expect(es.dobMonth!.instructions).toBe(`${en.dobMonth!.instructions} A date said as numbers gives the day before the month, as Spanish does: "22/11" and "el 22 del 11" are November 22.`);
    expect(es.dobDay!.instructions).toMatch(/ A date said as numbers gives the day before the month/);
    expect(es.dobGiven).toEqual(en.dobGiven);
    expect(en).toEqual(dob.questions(testSlotContext('22/11/1991')));
    const literal = defineSlot('dob', { type: 'birthdate', text: { month: 'Read asr.text. Which month?' } });
    expect(literal.questions(testSlotContext('x', { locale: 'es' })).dobMonth!.instructions).toBe('Read asr.text. Which month?');
  });
});
