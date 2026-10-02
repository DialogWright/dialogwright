import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { SlotContext } from '../../core/slots/types';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { formatProblem } from '../../define/problems';
import type { ChoiceQuestion, QuestionMap } from '../../jev/types';
import { choice } from '../../testing/answers';
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

  it('no answer at all is absent, asked or not: the question was not asked (there was nothing to offer), so nothing was heard', () => {
    expect(parcel.fill({}, c)).toEqual({ kind: 'absent' });
    expect(parcel.fill({}, asked)).toEqual({ kind: 'absent' });
    expect(parcel.fill({}, ctx('', { prompted: true }))).toEqual({ kind: 'absent' });
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

describe('the docs', () => {
  it('the README names every option and every text part', () => {
    const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
    const options = Object.keys((slotTypeJsonSchema(recordType).properties ?? {}) as object).filter((k) => k !== 'type');
    expect(options.sort()).toEqual(['disambiguate', 'fillAt', 'from', 'ids', 'key', 'keyPattern', 'keypad', 'label', 'labelPrefix', 'missReason', 'spoken', 'text']);
    for (const option of [...options, 'digits', 'skipYearAfterMonth', 'instructions', 'none', 'choice']) expect(readme, option).toContain(`\`${option}\``);
  });
});
