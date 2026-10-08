import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { SlotContext, SlotSpec } from '../../core/slots/types';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { formatProblem } from '../../define/problems';
import type { AnswerMap, ChoiceQuestion, QuestionMap } from '../../jev/types';
import { choice } from '../../testing/answers';
import { createShadowReport, shadowSlot } from '../../testing/shadowSlot';
import { parcelSelectSlot as testkitParcel } from '../../testing/testkit/oracles/parcelSelect';
import { parcelSelectRecordSlot } from '../../testing/testkit/domain/slots/parcelSelectRecord';
import { numbersSaid } from '../../core/extract/numbersSaid';
import { spokenParcelNumbers } from '../../testing/testkit/oracles/parcelSelect';
import { testSlotContext } from '../../testing/slots';
import { runSlotConformance } from '../conformance/run';
import { buildSlot, defineSlot, slotTypeJsonSchema } from '../defineSlot';
import { recordType, renderLabel } from './index';

/** The `record` type: the conformance kit over its examples, then what the kit does not cover. */
runSlotConformance(recordType, { describe, it, locales: ['en-US', 'es'] });

const T = DEFAULT_THRESHOLDS;
const BOOKINGS = [{ id: 'B12', room: 'the north room', from: '2026-09-21' }, { id: 'C3', room: 'the garden room', from: '2026-10-02' }];
const PARCELS = [{ number: '7101', item: 'a box of books', day: '2026-09-14' }, { number: '7102', item: 'a pair of boots', day: '2026-09-16' }];
const ctx = (text = '', over: Partial<SlotContext> = {}) => testSlotContext(text, over);
const criteriaOf = (q: QuestionMap, id: string) => (q[id] as ChoiceQuestion).criteria;

const booking = defineSlot('booking', { type: 'record' });
const parcel = defineSlot('parcel', {
  type: 'record',
  key: 'number',
  keyPattern: '\\d{4}',
  labelPrefix: 'parcel_',
  label: 'Parcel {number}, {item}, due {day|day}',
  spoken: { digits: 4 },
  keypad: 4,
  missReason: 'no_parcel',
  ids: { choice: 'parcelChoice' },
});

describe('a record slot built from the defaults', () => {
  it('asks one question, the slot\'s id followed by Choice, offering each record by its id, then none', () => {
    expect(booking.questionIds).toEqual(['bookingChoice']);
    expect(booking.questions(ctx('the north room', { records: BOOKINGS }))).toEqual({
      bookingChoice: {
        type: 'choice',
        instructions:
          'Read asr.text and node.promptJustPlayed. Which of these does the caller mean? They may name it by its number or by what the list says about it. Choose none only when they name none of these.',
        criteria: { record_B12: 'Number B12', record_C3: 'Number C3', none: 'Names none of these' },
      },
    });
  });

  it('asks nothing when there is nothing to offer', () => {
    expect(booking.questions(ctx('B12'))).toEqual({});
  });

  it('may lead to one line beyond its ask and retry, asking which of two records; no keypad by default', () => {
    expect(booking.prompts).toEqual([{ id: 'disambiguate_booking', why: 'the caller could mean either of two records and is asked which', vars: ['a', 'b'] }]);
    expect(booking.dtmf).toBeUndefined();
  });

  it('is read back in the summary only, kept as it is, displayed as its key', () => {
    expect(booking).toMatchObject({ spokenConfirm: 'summary' });
    expect(booking.redact).toBeUndefined();
    expect(booking.handoff).toBeUndefined();
    expect(booking.detect).toBeUndefined();
    expect(booking.display('B12')).toBe('B12');
    expect(booking.display('B12', 'es')).toBe('B12');
  });

  it('carries its type and its parsed options, defaults applied', () => {
    expect(booking.type).toBe('record');
    expect(booking.config).toEqual({
      key: 'id', keyPattern: '[A-Za-z0-9_-]+', labelPrefix: 'record_', label: 'Number {key}', missReason: 'no_match', disambiguate: true, fillAt: 'SLOT_CHOICE_FILL',
    });
  });
});

describe('the threshold a record slot names (SlotSpec.thresholds)', () => {
  it('is its fillAt', () => {
    expect(booking.thresholds).toEqual(['SLOT_CHOICE_FILL']);
    expect(defineSlot('booking', { type: 'record', fillAt: 'SLOT_CHOICE_CONFIRM' }).thresholds).toEqual(['SLOT_CHOICE_CONFIRM']);
  });
});

describe('the records offered', () => {
  it('labels each record from its fields, through a filter where one is named, in the order listed', () => {
    expect(criteriaOf(parcel.questions(ctx('', { records: PARCELS })), 'parcelChoice')).toEqual({
      parcel_7101: 'Parcel 7101, a box of books, due Monday, September 14',
      parcel_7102: 'Parcel 7102, a pair of boots, due Wednesday, September 16',
      none: 'Names none of these',
    });
  });

  it('offers a key once, and only a key that matches keyPattern, from a field that is text or a number', () => {
    const records = [
      { number: '7101', item: 'x', day: '2026-09-14' }, { number: '7101', item: 'again', day: '2026-09-14' }, { number: '710', item: 'short' },
      { number: 7103, item: 'numeric', day: '2026-09-15' }, { item: 'no number' }, null, 'text', { number: { n: 1 } },
    ];
    expect(Object.keys(criteriaOf(parcel.questions(ctx('', { records })), 'parcelChoice'))).toEqual(['parcel_7101', 'parcel_7103', 'none']);
  });

  it('leaves a field the record lacks empty, and a value the day filter cannot read as it is', () => {
    expect(renderLabel('Parcel {number}, {item}, due {day|day}', '7101', { number: '7101' })).toBe('Parcel 7101, , due ');
    expect(renderLabel('{day|day}', 'k', { day: 'soon' })).toBe('soon');
    expect(renderLabel('{day|day} {n} {flag} {list}', 'k', { day: '2026-09-18', n: 3, flag: true, list: [1] })).toBe('Friday, September 18 3 true ');
    expect(renderLabel('{key} {key|day} {nope} {not a placeholder}', '2026-09-18', {})).toBe('2026-09-18 Friday, September 18  {not a placeholder}');
  });

  it('{key} is the record\'s key whatever its field is called', () => {
    const slot = defineSlot('order', { type: 'record', key: 'ref', label: 'Order {key} ({ref})' });
    expect(criteriaOf(slot.questions(ctx('', { records: [{ ref: 'A12' }] })), 'orderChoice')).toMatchObject({ record_A12: 'Order A12 (A12)' });
  });

  it('then each number the caller says that no record has, in the order said, labelled as said', () => {
    const q = parcel.questions(ctx('not 7101, it is four four one two, or maybe 5550', { records: PARCELS }));
    expect(criteriaOf(q, 'parcelChoice')).toEqual({
      parcel_7101: 'Parcel 7101, a box of books, due Monday, September 14',
      parcel_7102: 'Parcel 7102, a pair of boots, due Wednesday, September 16',
      parcel_4412: 'Number 4412, as the caller said it',
      parcel_5550: 'Number 5550, as the caller said it',
      none: 'Names none of these',
    });
    expect(parcel.questions(ctx('parcel 4412'))).toMatchObject({ parcelChoice: { criteria: { parcel_4412: 'Number 4412, as the caller said it', none: 'Names none of these' } } });
  });

  it('offers no spoken number without `spoken`, and a spoken year after a month only without skipYearAfterMonth', () => {
    expect(booking.questions(ctx('4412'))).toEqual({});
    const said = 'it was march twenty twenty five, number four four one two';
    expect(Object.keys(criteriaOf(parcel.questions(ctx(said)), 'parcelChoice'))).toEqual(['parcel_2025', 'parcel_4412', 'none']);
    const skip = defineSlot('parcel', { ...(parcel.config as object), type: 'record', spoken: { digits: 4, skipYearAfterMonth: true } });
    expect(Object.keys(criteriaOf(skip.questions(ctx(said)), 'parcelChoice'))).toEqual(['parcel_4412', 'none']);
  });

  it('never offers a label that would be the question\'s own none', () => {
    const slot = defineSlot('odd', { type: 'record', labelPrefix: 'non' });
    expect(slot.questions(ctx('', { records: [{ id: 'e' }] }))).toEqual({});
    expect(Object.keys(criteriaOf(slot.questions(ctx('', { records: [{ id: 'e' }, { id: 'x' }] })), 'oddChoice'))).toEqual(['nonx', 'none']);
    expect(slot.fill({ oddChoice: choice({ none: 0.9, nonx: 0.1 }) }, ctx('', { prompted: true }))).toEqual({ kind: 'invalid', reason: 'no_match', raw: '' });
  });
});

describe('from: lists by name', () => {
  const ORDERS = [{ ref: 'A12', what: 'a desk lamp' }, { ref: 'B07', what: 'a lampshade' }];
  const sources = { parcels: PARCELS, orders: ORDERS };
  const parcels = defineSlot('parcel', { type: 'record', from: 'parcels', key: 'number', label: '{item}', labelPrefix: 'parcel_' });
  const orders = defineSlot('order', { type: 'record', from: 'orders', key: 'ref', label: '{what}', labelPrefix: 'order_' });

  it('two record slots in one app each read their own list, and neither reads the one list', () => {
    const c = ctx('', { records: BOOKINGS, sources });
    expect(criteriaOf(parcels.questions(c), 'parcelChoice')).toEqual({ parcel_7101: 'a box of books', parcel_7102: 'a pair of boots', none: 'Names none of these' });
    expect(criteriaOf(orders.questions(c), 'orderChoice')).toEqual({ order_A12: 'a desk lamp', order_B07: 'a lampshade', none: 'Names none of these' });
    expect(criteriaOf(booking.questions(c), 'bookingChoice')).toEqual({ record_B12: 'Number B12', record_C3: 'Number C3', none: 'Names none of these' });
    expect(orders.fill({ orderChoice: choice({ order_B07: 0.9, none: 0.1 }) }, c)).toMatchObject({ kind: 'filled', value: 'B07' });
  });

  it('a list the app does not give is empty: nothing to offer', () => {
    expect(orders.questions(ctx('', { records: ORDERS }))).toEqual({});
    expect(orders.questions(ctx('', { sources: { parcels: PARCELS } }))).toEqual({});
    expect(orders.questions(ctx('', { sources: { orders: 'not a list' } as never }))).toEqual({});
  });
});

describe('fill', () => {
  const c = ctx('', { records: PARCELS });
  const asked = ctx('', { records: PARCELS, prompted: true });
  const two = (a: number, b: number) => ({ parcelChoice: choice({ parcel_7101: a, parcel_7102: b, none: Math.max(0, 1 - a - b) }) });
  const one = (p: number) => ({ parcelChoice: choice({ parcel_7101: p, none: 1 - p }) });

  it('fills the key the model is sure of, displayed as it is, never acknowledged', () => {
    expect(parcel.fill(one(0.9), c)).toEqual({ kind: 'filled', value: '7101', display: '7101', confidence: 0.9, confirm: 'none' });
  });

  it('reads the probabilities, not the model\'s one pick', () => {
    const answer = { type: 'choice' as const, choice: 'none', probabilities: { parcel_7101: 0.8, none: 0.2 }, confidence: 0.2 };
    expect(parcel.fill({ parcelChoice: answer }, c)).toMatchObject({ kind: 'filled', value: '7101', confidence: 0.8 });
  });

  it('asks which of two the model cannot tell apart, at SLOT_CHOICE_CONFIRM or above, within SLOT_CHOICE_MARGIN', () => {
    expect(parcel.fill(two(0.5, 0.4), c)).toEqual({ kind: 'disambiguate', a: { value: '7101', display: '7101' }, b: { value: '7102', display: '7102' } });
    expect(parcel.fill(two(T.SLOT_CHOICE_CONFIRM, 0.4), c).kind).toBe('disambiguate');
    expect(parcel.fill(two(0.6, 0.6 - T.SLOT_CHOICE_MARGIN), c).kind).toBe('filled');
    expect(parcel.fill(two(0.44, 0.43), c).kind).toBe('absent');
    expect(parcel.fill(two(0.44, 0.43), asked)).toEqual({ kind: 'invalid', reason: 'no_parcel', raw: '' });
  });

  it('with disambiguate off, takes the top one when it reaches fillAt, and declares no line for it', () => {
    const off = defineSlot('parcel', { ...(parcel.config as object), type: 'record', disambiguate: false });
    expect(off.prompts!.map((p) => p.id)).toEqual(['ask_parcel_dtmf']);
    expect(off.fill(two(0.56, 0.44), c)).toMatchObject({ kind: 'filled', value: '7101' });
    expect(off.fill(two(0.5, 0.4), asked)).toEqual({ kind: 'invalid', reason: 'no_parcel', raw: '' });
  });

  it('fillAt names the threshold the top one must reach; below it, nothing was chosen', () => {
    expect(parcel.fill(one(T.SLOT_CHOICE_FILL), c).kind).toBe('filled');
    expect(parcel.fill(one(0.5), c).kind).toBe('absent');
    expect(parcel.fill(one(0.5), asked)).toEqual({ kind: 'invalid', reason: 'no_parcel', raw: '' });
    const lower = defineSlot('parcel', { ...(parcel.config as object), type: 'record', fillAt: 'SLOT_CHOICE_CONFIRM' });
    expect(lower.fill(one(0.5), c).kind).toBe('filled');
    expect(lower.fill(one(0.44), c).kind).toBe('absent');
  });

  it('none, a label it never offers, a key keyPattern refuses, or an answer that is not a choice: nothing chosen', () => {
    for (const answers of [
      { parcelChoice: choice({ none: 0.9, parcel_7101: 0.1 }) },
      { parcelChoice: choice({ order_7101: 0.9, none: 0.1 }) },
      { parcelChoice: choice({ parcel_710: 0.9, none: 0.1 }) },
      { parcelChoice: { type: 'noul', noul: 0.9 } },
      { parcelChoice: { type: 'choice' } },
    ] as never[]) {
      expect(parcel.fill(answers, c)).toEqual({ kind: 'absent' });
      expect(parcel.fill(answers, asked)).toEqual({ kind: 'invalid', reason: 'no_parcel', raw: '' });
    }
  });

  it('no answer at all (the question was not asked, there being nothing to offer) is nothing chosen: invalid when asked, else absent', () => {
    expect(parcel.fill({}, c)).toEqual({ kind: 'absent' });
    expect(parcel.fill({}, asked)).toEqual({ kind: 'invalid', reason: 'no_parcel', raw: '' });
    expect(parcel.fill({}, ctx('', { prompted: true }))).toEqual({ kind: 'invalid', reason: 'no_parcel', raw: '' });
  });

  it('reads every threshold from the context', () => {
    const strict = ctx('', { records: PARCELS, thresholds: { ...T, SLOT_CHOICE_FILL: 0.95 } });
    expect(parcel.fill(one(0.9), strict).kind).toBe('absent');
    const wide = ctx('', { records: PARCELS, thresholds: { ...T, SLOT_CHOICE_MARGIN: 0.5 } });
    expect(parcel.fill(two(0.7, 0.25), wide).kind).toBe('disambiguate');
  });
});

describe('the keypad', () => {
  it('takes exactly `keypad` digits that match keyPattern, and declares its line', () => {
    expect(parcel.dtmf!.length).toBe(4);
    expect(parcel.dtmf!.parse('4412', ctx())).toEqual({ value: '4412', display: '4412' });
    for (const keys of ['441', '44120', '44*2', '', 'abcd']) expect(parcel.dtmf!.parse(keys, ctx()), keys).toBeNull();
    expect(parcel.prompts!.map((p) => p.id)).toEqual(['disambiguate_parcel', 'ask_parcel_dtmf']);
    const letters = defineSlot('booking', { type: 'record', keyPattern: '[A-Z]\\d{2}', keypad: 3 });
    expect(letters.dtmf!.parse('123', ctx())).toBeNull();
  });
});

describe('the words and the ids', () => {
  it('text replaces the question and the none criterion word for word, and ids renames the question', () => {
    const slot = defineSlot('booking', { type: 'record', text: { instructions: 'Which booking?', none: 'No booking' }, ids: { choice: 'whichBooking' } });
    expect(slot.questionIds).toEqual(['whichBooking']);
    expect(slot.questions(ctx('', { records: BOOKINGS }))).toEqual({
      whichBooking: { type: 'choice', instructions: 'Which booking?', criteria: { record_B12: 'Number B12', record_C3: 'Number C3', none: 'No booking' } },
    });
  });

  it('a second record slot asks under its own id', () => {
    expect(defineSlot('other', { type: 'record' }).questionIds).toEqual(['otherChoice']);
  });
});

describe('defineSlot problems', () => {
  const problems = (config: Record<string, unknown>) => {
    const r = buildSlot('parcel', { type: 'record', ...config });
    return r.ok ? [] : r.problems.map(formatProblem);
  };

  it('a keyPattern that is not a regular expression', () => {
    expect(problems({ keyPattern: '[0-9' })).toEqual(['(code)  parcel.keyPattern  "[0-9" is not a regular expression  ->  write the source of a regular expression without slashes, such as "\\d{4}"']);
  });

  it('a filter a label does not have, and a spoken label that names a field', () => {
    expect(problems({ label: 'Parcel {number|upper}' })).toEqual([
      '(code)  parcel.label  {number|upper} uses the filter "upper", which is not one of "day"  ->  use {field} or {field|filter}; the filters are day',
    ]);
    expect(problems({ spoken: { digits: 4, label: 'Parcel {number}' } })).toEqual([
      '(code)  parcel.spoken.label  {number} is not one of its variables; it may use {key}  ->  use {key}, the number said, with or without a filter',
    ]);
  });

  it('a key, a source or a reason that is not an id, a prefix that is not a word, a keypad or digits out of range', () => {
    const r = buildSlot('parcel', { type: 'record', key: 'item number', from: 'my-list', missReason: 'no parcel', labelPrefix: '_x', keypad: 0, spoken: { digits: 21 } });
    expect(!r.ok && r.problems.map((p) => p.path).sort()).toEqual(['parcel.from', 'parcel.key', 'parcel.keypad', 'parcel.labelPrefix', 'parcel.missReason', 'parcel.spoken.digits']);
  });

  it('an unknown option, and an unknown part under text, ids or spoken', () => {
    expect(buildSlot('parcel', { type: 'record', labelprefix: 'x_' }).ok).toBe(false);
    expect(buildSlot('parcel', { type: 'record', text: { label: 'x' } }).ok).toBe(false);
    expect(buildSlot('parcel', { type: 'record', ids: { span: 'x' } }).ok).toBe(false);
    expect(buildSlot('parcel', { type: 'record', spoken: { digits: 4, skip: true } }).ok).toBe(false);
  });
});

/**
 * Every mix a record slot reads, for a shadowed pair (shadowSlot throws on the first difference):
 * the questions over no records, two, and a list with a repeat and a number said, for words that say
 * nothing, name a record, say a number on and off the list, say a year after a month, say a longer
 * number, or say several; and fills, asked and not, with the top label each record, a number said, a
 * key too short, a label of another prefix and none, at, around and between the thresholds, against
 * every second label (or none), at every gap around SLOT_CHOICE_MARGIN; then every four keys and keys
 * of other lengths; and no answer at all (nothing to offer), asked and not.
 */
function recordGrid(shadow: SlotSpec, o: { id: string; prefix: string; records: readonly unknown[]; said: string }): void {
  const lists: readonly (readonly unknown[])[] = [[], o.records, [...o.records, o.records[0], { number: o.said, item: 'something said', day: '2026-09-01', service: 'something said', serviceDate: '2026-09-01' }]];
  const texts = [
    '', 'the first one', `number ${o.said}`, 'four four one two', 'it was march twenty twenty five, number four four one two', 'march 2025',
    'three one eight seven four zero two six', '7101, 4412 and 5550', 'the twelfth, nineteen ninety', 'one two three',
  ];
  for (const records of lists) for (const text of texts) for (const prompted of [false, true]) shadow.questions(testSlotContext(text, { records, prompted }));
  const labels = [...(o.records as { number: string }[]).map((r) => `${o.prefix}${r.number}`), `${o.prefix}4412`, `${o.prefix}710`, `other_${(o.records[0] as { number: string }).number}`, 'none'];
  const tops = [0.2, 0.44, T.SLOT_CHOICE_CONFIRM, 0.5, T.SLOT_CHOICE_FILL, 0.56, 0.7, 0.9];
  const gaps = [0, 0.05, T.SLOT_CHOICE_MARGIN - 0.01, T.SLOT_CHOICE_MARGIN, T.SLOT_CHOICE_MARGIN + 0.01, 0.3];
  for (const records of lists) {
    for (const prompted of [false, true]) {
      const c = testSlotContext('', { records, prompted });
      for (const top of labels) {
        for (const p of tops) {
          shadow.fill({ [o.id]: choice({ [top]: p, ...(top === 'none' ? {} : { none: 1 - p }) }) }, c);
          for (const second of labels) {
            if (second === top) continue;
            for (const gap of gaps) {
              const answers: AnswerMap = { [o.id]: { type: 'choice', choice: top, probabilities: { [top]: p, [second]: Math.max(0, p - gap) }, confidence: p } };
              shadow.fill(answers, c);
            }
          }
        }
      }
      shadow.fill({ [o.id]: { type: 'noul', noul: 0.9 } } as never, c);
      shadow.fill({}, c);
    }
  }
  for (let n = 0; n < 10_000; n++) shadow.dtmf!.parse(String(n).padStart(4, '0'), testSlotContext(''));
  for (const keys of ['', '1', '441', '44120', '44*2', '#123', 'abcd']) shadow.dtmf!.parse(keys, testSlotContext(''));
  for (const value of ['7101', '4412', '0000']) shadow.display(value);
}

describe('a keyPattern that could take minutes', () => {
  it('is refused when it repeats a repeat', () => {
    const r = buildSlot('r', { type: 'record', keyPattern: '(\\d+)+5' });
    expect(!r.ok && r.problems.map(formatProblem)).toEqual([
      '(code)  r.keyPattern  "(\\d+)+5" repeats a group that itself repeats (as (\\d+)+ does), which can take minutes to refuse a key that almost matches  ->  write it without the repeat inside the repeat, such as "\\d+5" for "(\\d+)+5"',
    ]);
  });

  it('is never tried on a key longer than 64 characters', () => {
    const slot = defineSlot('r', { type: 'record', keypad: 4 });
    const long = `record_${'a'.repeat(65)}`;
    expect(slot.fill({ rChoice: choice({ [long]: 1 }) } as AnswerMap, testSlotContext(''))).toEqual({ kind: 'absent' });
    const offered = slot.questions(testSlotContext('', { records: [{ id: 'a'.repeat(65) }, { id: 'a'.repeat(64) }] })).rChoice as ChoiceQuestion;
    expect(Object.keys(offered.criteria)).toEqual([`record_${'a'.repeat(64)}`, 'none']);
  });
});

describe('the testkit\'s parcel, written as configuration', () => {
  // The testkit's hand-written parcel slot and the library slot that replaces it (its own words, id,
  // labels, criteria and reason, a four-digit number said offered, no year rule, the keypad), through
  // the same shadow harness the migration uses.
  const testkit = { id: 'parcelChoice', prefix: 'parcel_', records: PARCELS, said: '4412' };

  it('declares what the hand-written slot did', () => {
    expect(parcelSelectRecordSlot.config).toEqual({
      key: 'number', keyPattern: '\\d{4}', labelPrefix: 'parcel_', label: 'Parcel {number}, {item}, due {day|day}',
      spoken: { digits: 4, label: 'Parcel number {key}, as the caller said it', skipYearAfterMonth: false },
      missReason: 'no_parcel', keypad: 4, disambiguate: true, fillAt: 'SLOT_CHOICE_FILL',
      text: {
        instructions: 'Read asr.text and node.promptJustPlayed. Which parcel does the caller mean? They may name it by number, by what is in it, or by its day. Choose none only when they name no parcel.',
        none: 'Names no parcel',
      },
      ids: { choice: 'parcelChoice' },
    });
    expect(parcelSelectRecordSlot.questionIds).toEqual(['parcelChoice']);
    expect(parcelSelectRecordSlot.prompts!.map((p) => p.id)).toEqual(['disambiguate_parcelSelect', 'ask_parcelSelect_dtmf']);
  });

  it('asks the same questions, fills the same way and keys the same numbers on every branch', () => {
    const report = createShadowReport();
    recordGrid(shadowSlot(testkitParcel, parcelSelectRecordSlot, { report }), testkit);
    expect(report.mismatches).toEqual([]);
    expect(report.calls['parcelSelect.questions']).toBe(60);
    expect(report.calls['parcelSelect.fill']).toBe(8_940);
    expect(report.calls['parcelSelect.dtmf.parse']).toBe(10_007);
  });

  it('would find a slot that differs by one option', () => {
    const off = defineSlot('parcelSelect', { ...parcelSelectRecordSlot.config, type: 'record', disambiguate: false });
    expect(() => recordGrid(shadowSlot(testkitParcel, off), testkit)).toThrow(/fill/);
    const year = defineSlot('parcelSelect', { ...parcelSelectRecordSlot.config, type: 'record', spoken: { digits: 4, label: 'Parcel number {key}, as the caller said it', skipYearAfterMonth: true } });
    expect(() => recordGrid(shadowSlot(testkitParcel, year), testkit)).toThrow(/questions/);
  });

  it('the stub reads the numbers said with the slot\'s own reader, which says what the hand-written one did', () => {
    for (const text of ['four four one two', 'not 7101 but 4412', 'three one eight seven four zero two six', 'march twenty twenty five', '47 11, 5550', 'one two three four five six seven eight and nine nine nine nine']) {
      expect(numbersSaid(text, { digits: 4 }), text).toEqual(spokenParcelNumbers(text));
    }
  });

  it('agrees with the hand-written slot with no answer at all: nothing chosen, invalid when the parcel was asked for', () => {
    // With nothing to offer (no parcels listed, no number said) neither slot asks a question, and both
    // read the missing answer as a miss when the parcel was asked for (the retry ladder moves on). No
    // stub turn reaches it; the grid above includes it, asked and not, and finds no mismatch.
    const report = createShadowReport();
    const shadow = shadowSlot(testkitParcel, parcelSelectRecordSlot, { report });
    for (const records of [[], PARCELS]) {
      expect(shadow.fill({}, testSlotContext('', { records, prompted: true }))).toEqual({ kind: 'invalid', reason: 'no_parcel', raw: '' });
      expect(shadow.fill({}, testSlotContext('', { records }))).toEqual({ kind: 'absent' });
    }
    expect(report.mismatches).toEqual([]);
  });
});

describe('the docs', () => {
  it('the docs page names every option and every text part', () => {
    const readme = readFileSync(new URL('../../../../../docs/slots/record.md', import.meta.url), 'utf8');
    const options = Object.keys((slotTypeJsonSchema(recordType).properties ?? {}) as object).filter((k) => k !== 'type');
    expect(options.sort()).toEqual(['disambiguate', 'fillAt', 'from', 'ids', 'key', 'keyPattern', 'keypad', 'label', 'labelPrefix', 'listen', 'missReason', 'offer', 'spoken', 'text']);
    for (const option of [...options, 'spoken.digits', 'spoken.skipYearAfterMonth', 'text.instructions', 'text.none', 'ids.choice']) expect(readme, option).toContain(`\`${option}\``);
  });
});

describe('a record slot in Spanish (es, es-*)', () => {
  const parcel = defineSlot('parcel', { type: 'record', key: 'number', keyPattern: '\\d{4}', labelPrefix: 'parcel_', spoken: { digits: 4, skipYearAfterMonth: true } });

  it('offers a number said in Spanish words, the "y" inside it, and not a year said after a month', () => {
    const offered = (text: string, locale?: string): string[] => Object.keys((parcel.questions(testSlotContext(text, { locale })).parcelChoice as ChoiceQuestion | undefined)?.criteria ?? {});
    expect(offered('el paquete cuarenta y cuatro doce', 'es')).toEqual(['parcel_4412', 'none']);
    expect(offered('el paquete cuatro cuatro uno dos', 'es-US')).toEqual(['parcel_4412', 'none']);
    expect(offered('llegó en marzo de dos mil veinticinco', 'es')).toEqual([]);
    expect(offered('el paquete cuarenta y cuatro doce')).toEqual([]);
    expect(offered('parcel four four one two', 'es')).toEqual([]);
  });
});
