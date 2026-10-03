import { describe, expect, it, vi } from 'vitest';
import type { PolicyTables } from '../core/app/types';
import { definePolicy } from '../define/definePolicy';
import {
  addDays, dateInRangeRule, isIsoDate, literalOrder, MAX_DAYS_FROM_TODAY, isSafeName, limitRule, lookupNameProblem, parseDateBound, parseLookupRef, parseNumberBound, readDecimal,
  type DateInRangeParams, type LimitParams,
} from './bounded';
import { compiledPolicyOf } from './compiled';
import type { GateFacts, GateLookups, Party, RuleContext, RuleOutcome, ToolCall } from './types';

/**
 * The range rules (dateInRange, limit) and the reference grammar their bounds are written in: each
 * branch of each rule, its boundaries (every bound inclusive), and each way a lookup can fail or a
 * reference can reach for something it may not. The rules are run directly (their outcome) and, where
 * the gate's own handling matters (a lookup that throws), through a compiled policy.
 */

const today = '2026-10-02';
const facts: GateFacts = { attempts: 0, confirmedHash: null, todayIso: today };
const caller: Party = { kind: 'customer', level: 2, id: 'C-1', first: 'Avery' };

/** The gate's lookups and a store's own: an order's total and its return window, by order id. */
const ORDERS: Record<string, { total: unknown; window: unknown; deliveredOn: unknown }> = {
  'ORD-1234': { total: 120, window: { start: '2026-09-20', end: '2026-10-20' }, deliveredOn: '2026-09-20' },
  'ORD-5678': { total: '80.50', window: { start: '2026-09-01', end: null }, deliveredOn: '2026-09-01' },
  'ORD-NONE': { total: null, window: null, deliveredOn: null },
};
function lookups(over: Record<string, unknown> = {}): GateLookups {
  return {
    ownerOf: () => null,
    scopeOf: () => [],
    orderTotal: (id: string) => (Object.hasOwn(ORDERS, id) ? ORDERS[id]!.total : null),
    returnWindow: (id: string) => (Object.hasOwn(ORDERS, id) ? ORDERS[id]!.window : null),
    order: (id: string) => (Object.hasOwn(ORDERS, id) ? { total: ORDERS[id]!.total, deliveredOn: ORDERS[id]!.deliveredOn } : null),
    ...over,
  } as GateLookups;
}

function ctx(params: Record<string, string>, lk: GateLookups = lookups(), f: GateFacts = facts): RuleContext {
  const call: ToolCall = { tool: 'refundOrder', params };
  return { call, p: caller, facts: f, lk, policy: {} as PolicyTables, subjectKind: 'customer' };
}

const dateRule = (p: Omit<DateInRangeParams, 'field'>, params: Record<string, string>, lk?: GateLookups, f?: GateFacts): RuleOutcome =>
  dateInRangeRule({ field: 'returnDate', ...p })(ctx(params, lk, f));
const limit = (p: Omit<LimitParams, 'field'>, params: Record<string, string>, lk?: GateLookups): RuleOutcome =>
  limitRule({ field: 'amount', ...p })(ctx(params, lk));

/** An outcome on one line: pass or the verdict and reason, then the compared line. */
const line = (o: RuleOutcome): string => `${o.fail ? `${o.fail.verdict} ${o.fail.reason}` : 'pass'} | ${o.result.compared}`;

const TODAY = { kind: 'today' } as const;
const fromToday = (days: number) => ({ kind: 'today', days }) as const;
const date = (d: string) => ({ kind: 'date', date: d }) as const;
const ref = (lookup: string, param: string, field?: string) => ({ kind: 'lookup', ref: field === undefined ? { lookup, param } : { lookup, param, field } }) as const;
const num = (value: string) => ({ kind: 'number', value }) as const;

describe('the reference grammar', () => {
  it('reads <lookup>(<param>) and <lookup>(<param>).<field>', () => {
    expect(parseLookupRef('orderTotal(orderId)')).toEqual({ ref: { lookup: 'orderTotal', param: 'orderId' } });
    expect(parseLookupRef('order(orderId).total')).toEqual({ ref: { lookup: 'order', param: 'orderId', field: 'total' } });
  });

  it('refuses anything else: spaces, two fields, two params, no param, a call of a call, an index, code', () => {
    for (const text of [
      'orderTotal( orderId )', 'orderTotal(orderId) ', 'order(orderId).total.cents', 'order(orderId, other)', 'order()', 'order(orderId)(x)',
      'order(orderId)[0]', 'order[orderId]', 'orderId', '1order(orderId)', 'order(1d)', 'order(orderId).1x', 'process.exit(1)', 'order(orderId);x()',
      `${'a'.repeat(200)}(orderId)`,
    ]) {
      expect(parseLookupRef(text), text).toHaveProperty('problem');
    }
  });

  it('refuses names every object has, `prototype`, and the gate\'s own lookups', () => {
    for (const text of [
      'constructor(orderId)', 'toString(orderId)', 'hasOwnProperty(orderId)', 'valueOf(orderId)', 'isPrototypeOf(orderId)', 'prototype(orderId)', '__proto__(orderId)',
      'order(orderId).constructor', 'order(orderId).__proto__', 'order(orderId).prototype', 'order(orderId).toString', 'order(orderId).hasOwnProperty',
      'ownerOf(orderId)', 'scopeOf(orderId)',
    ]) {
      expect(parseLookupRef(text), text).toHaveProperty('problem');
    }
    expect(isSafeName('total')).toBe(true);
    expect(isSafeName('constructor')).toBe(false);
    expect(lookupNameProblem('orderTotal')).toBeNull();
    expect(lookupNameProblem('scopeOf')).toMatch(/gate's own/);
    expect(lookupNameProblem('toString')).toMatch(/Object.prototype/);
  });

  it('reads date bounds: today, a date the calendar has, a reference', () => {
    expect(parseDateBound('today')).toEqual({ bound: TODAY });
    expect(parseDateBound('2024-02-29')).toEqual({ bound: date('2024-02-29') });
    expect(parseDateBound('order(orderId).deliveredOn')).toEqual({ bound: ref('order', 'orderId', 'deliveredOn') });
    for (const bad of ['2026-02-29', '2026-13-01', 'Today', 'yesterday', '10/02/2026', 20261002]) expect(parseDateBound(bad), String(bad)).toHaveProperty('problem');
  });

  it('reads a number of days from today: today+N and today-N, N from 1 to 3660', () => {
    expect(MAX_DAYS_FROM_TODAY).toBe(3660);
    expect(parseDateBound('today+1')).toEqual({ bound: fromToday(1) });
    expect(parseDateBound('today+30')).toEqual({ bound: fromToday(30) });
    expect(parseDateBound('today-7')).toEqual({ bound: fromToday(-7) });
    expect(parseDateBound('today+3660')).toEqual({ bound: fromToday(3660) });
    expect(parseDateBound('today-3660')).toEqual({ bound: fromToday(-3660) });
    // A lookup whose name starts with "today" is still a reference.
    expect(parseDateBound('todayPlus(orderId)')).toEqual({ bound: ref('todayPlus', 'orderId') });
  });

  it('refuses a number of days from today written any other way, and says how to write it', () => {
    for (const bad of [
      'today+0', 'today-0', 'today+', 'today-', 'today+ 30', 'today +30', 'today + 30', 'today+30 ', 'today+030', 'today+3661', 'today-3661', 'today+99999999999999999999',
      'today+1.5', 'today+30d', 'today+30days', 'today++1', 'today+-1', 'today+1e3', 'today+0x1e',
    ]) {
      const read = parseDateBound(bad);
      expect(read, bad).toEqual({ problem: `"${bad}" is not a number of days from today: write today+N or today-N, N a whole number from 1 to 3660, with no spaces and no leading zero` });
    }
    for (const bad of ['Today+30', 'today*2', 'tomorrow', 'today30']) expect(parseDateBound(bad), bad).toHaveProperty('problem');
  });

  it('orders two bounds that both count from today, and no other pair with today in it', () => {
    expect(literalOrder(fromToday(-7), fromToday(30))).toBe(true);
    expect(literalOrder(TODAY, fromToday(30))).toBe(true);
    expect(literalOrder(fromToday(30), fromToday(30))).toBe(true);
    expect(literalOrder(fromToday(30), fromToday(7))).toBe(false);
    expect(literalOrder(fromToday(1), TODAY)).toBe(false);
    expect(literalOrder(date('2026-01-01'), fromToday(30))).toBeNull();
    expect(literalOrder(fromToday(30), ref('order', 'orderId', 'deliveredOn'))).toBeNull();
  });

  it('reads number bounds: a number, a decimal text, a reference', () => {
    expect(parseNumberBound(100)).toEqual({ bound: num('100') });
    expect(parseNumberBound(0.01)).toEqual({ bound: num('0.01') });
    expect(parseNumberBound('12.50')).toEqual({ bound: num('12.50') });
    expect(parseNumberBound('orderTotal(orderId)')).toEqual({ bound: ref('orderTotal', 'orderId') });
    for (const bad of [Number.NaN, Infinity, 1e21, 1e-7, '1,000', '1e3', true, null]) expect(parseNumberBound(bad), String(bad)).toHaveProperty('problem');
  });
});

describe('dates and numbers, strictly', () => {
  it('a date is yyyy-mm-dd and a day the calendar has', () => {
    for (const ok of ['2024-02-29', '2026-12-31', '2000-02-29', '0001-01-01']) expect(isIsoDate(ok), ok).toBe(true);
    for (const bad of ['2026-02-29', '1900-02-29', '2026-04-31', '2026-00-10', '2026-01-00', '0000-01-01', '2026-1-01', ' 2026-01-01', '2026-01-01T00:00', '20261001', 2026, null]) {
      expect(isIsoDate(bad), String(bad)).toBe(false);
    }
  });

  it('a number is an optional minus, digits with no leading zero, an optional point and digits; nothing else', () => {
    for (const ok of ['0', '12', '12.50', '-3.5', '0.01', 7, 0.1, -2]) expect(readDecimal(ok), String(ok)).not.toBeNull();
    for (const bad of ['012', '1,000', '1 000', '1e3', '+1', ' 1', '1 ', '$5', '5 USD', '5€', '.5', '5.', '', '-', '١٢', 'NaN', Number.NaN, Infinity, 1e21, '9'.repeat(41), {}, null, true, undefined]) {
      expect(readDecimal(bad), String(bad)).toBeNull();
    }
  });
});

describe('days from today, in UTC calendar days', () => {
  it('crosses a month\'s end, a year\'s end and a leap day where the calendar has them', () => {
    const cases: [string, number, string][] = [
      ['2026-10-02', 30, '2026-11-01'],
      ['2026-10-02', -7, '2026-09-25'],
      ['2026-01-31', 1, '2026-02-01'],
      ['2026-03-01', -1, '2026-02-28'],
      ['2026-04-30', 1, '2026-05-01'],
      ['2026-12-31', 1, '2027-01-01'],
      ['2027-01-01', -1, '2026-12-31'],
      ['2024-02-28', 1, '2024-02-29'],
      ['2024-02-29', 1, '2024-03-01'],
      ['2024-03-01', -1, '2024-02-29'],
      ['2023-02-28', 1, '2023-03-01'],
      ['2000-02-28', 1, '2000-02-29'],
      ['1900-02-28', 1, '1900-03-01'],
      ['2024-01-01', 366, '2025-01-01'],
      ['2025-01-01', 365, '2026-01-01'],
      ['2026-10-02', 3660, '2036-10-09'],
      ['2026-10-02', -3660, '2016-09-24'],
      ['0050-06-15', 1, '0050-06-16'],
      ['0001-01-01', 0, '0001-01-01'],
      ['9999-12-30', 1, '9999-12-31'],
    ];
    for (const [from, days, to] of cases) expect(addDays(from, days), `${from} ${days}`).toBe(to);
  });

  it('gives no date past the calendar\'s ends, or from a today that is not a date', () => {
    expect(addDays('9999-12-31', 1)).toBeNull();
    expect(addDays('0001-01-01', -1)).toBeNull();
    for (const bad of ['', 'unknown', '2026-02-30', '2026-10-02T00:00']) expect(addDays(bad, 1), bad).toBeNull();
    expect(addDays('2026-10-02', 1.5)).toBeNull();
  });

  it('counts calendar days whatever the process\'s time zone', () => {
    const zone = process.env.TZ;
    try {
      for (const tz of ['America/Los_Angeles', 'Pacific/Kiritimati', 'Europe/London', 'UTC']) {
        process.env.TZ = tz;
        expect(addDays('2026-03-08', 1), tz).toBe('2026-03-09');
        expect(addDays('2026-10-25', 1), tz).toBe('2026-10-26');
        expect(addDays('2026-03-29', -1), tz).toBe('2026-03-28');
      }
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});

describe('dateInRange', () => {
  it('passes a date within its bounds, every bound inclusive, and says which bounds it held to', () => {
    const p = { notBefore: ref('order', 'orderId', 'deliveredOn'), notAfter: TODAY, within: { lookup: 'returnWindow', param: 'orderId' } };
    expect(line(dateRule(p, { returnDate: '2026-09-25', orderId: 'ORD-1234' }))).toBe(
      'pass | returnDate on or after order(orderId ...1234).deliveredOn 2026-09-20, on or before today 2026-10-02, within returnWindow(orderId ...1234) 2026-09-20..2026-10-20',
    );
    // On each bound: the day itself passes.
    expect(dateRule(p, { returnDate: '2026-09-20', orderId: 'ORD-1234' }).fail).toBeUndefined();
    expect(dateRule(p, { returnDate: today, orderId: 'ORD-1234' }).fail).toBeUndefined();
    expect(dateRule({ within: p.within }, { returnDate: '2026-10-20', orderId: 'ORD-1234' }).fail).toBeUndefined();
  });

  it('holds a date to a number of days from today, each bound inclusive, and shows the date it computed', () => {
    const p = { notBefore: fromToday(-7), notAfter: fromToday(30) };
    expect(line(dateRule(p, { returnDate: '2026-10-15' }))).toBe('pass | returnDate on or after today-7 2026-09-25, on or before today+30 2026-11-01');
    // On each bound: the day itself passes; the day past it fails.
    expect(dateRule(p, { returnDate: '2026-09-25' }).fail).toBeUndefined();
    expect(dateRule(p, { returnDate: '2026-11-01' }).fail).toBeUndefined();
    expect(line(dateRule(p, { returnDate: '2026-09-24' }))).toBe('BLOCK date-range | returnDate before today-7 2026-09-25');
    expect(line(dateRule(p, { returnDate: '2026-11-02' }))).toBe('BLOCK date-range | returnDate after today+30 2026-11-01');
    // Today's date comes from the session's facts, across a month's and a year's end and a leap day.
    const on = (todayIso: string): GateFacts => ({ ...facts, todayIso });
    expect(line(dateRule({ notAfter: fromToday(1) }, { returnDate: '2025-01-01' }, undefined, on('2024-12-31')))).toBe('pass | returnDate on or before today+1 2025-01-01');
    expect(line(dateRule({ notAfter: fromToday(1) }, { returnDate: '2024-03-01' }, undefined, on('2024-02-28')))).toBe('BLOCK date-range | returnDate after today+1 2024-02-29');
    expect(line(dateRule({ notBefore: fromToday(-1) }, { returnDate: '2024-02-28' }, undefined, on('2024-03-01')))).toBe('BLOCK date-range | returnDate before today-1 2024-02-29');
    expect(line(dateRule({ notAfter: fromToday(30) }, { returnDate: '2026-03-02' }, undefined, on('2026-01-31')))).toBe('pass | returnDate on or before today+30 2026-03-02');
    // A bound the calendar does not have, or a today that is not a date: the bound is unknown, and the rule BLOCKs.
    const human = { verdicts: { outOfRange: 'NEEDS_HUMAN' } } as const;
    expect(line(dateRule({ ...human, notAfter: fromToday(1) }, { returnDate: '9999-12-31' }, undefined, on('9999-12-31')))).toBe('BLOCK bound-unknown | returnDate: notAfter today+1 gave no date');
    expect(line(dateRule({ ...human, notBefore: fromToday(-30) }, { returnDate: '2026-09-25' }, undefined, on('')))).toBe('BLOCK bound-unknown | returnDate: notBefore today-30 gave no date');
  });

  it('a value that is not a date BLOCKs, whatever the verdicts say', () => {
    const p = { notAfter: TODAY, verdicts: { outOfRange: 'NEEDS_HUMAN', outsideWindow: 'NEEDS_HUMAN' } } as const;
    expect(line(dateRule(p, {}))).toBe('BLOCK not-a-date | returnDate missing');
    expect(line(dateRule(p, { returnDate: '' }))).toBe('BLOCK not-a-date | returnDate missing');
    for (const junk of ['2026-02-30', 'tomorrow', '10/01/2026', '2026-10-01 ', 'last tuesday']) expect(line(dateRule(p, { returnDate: junk })), junk).toBe('BLOCK not-a-date | returnDate is not a date');
    expect(dateRule({ notAfter: TODAY, reasons: { invalid: 'return-date' } }, { returnDate: 'soon' }).fail).toEqual({ verdict: 'BLOCK', reason: 'return-date' });
  });

  it('fails a date outside notBefore or notAfter, a day past each, as the rule says', () => {
    expect(line(dateRule({ notAfter: TODAY }, { returnDate: '2026-10-03' }))).toBe('BLOCK date-range | returnDate after today 2026-10-02');
    expect(line(dateRule({ notBefore: date('2026-01-01') }, { returnDate: '2025-12-31' }))).toBe('BLOCK date-range | returnDate before 2026-01-01');
    const own = { notAfter: TODAY, reasons: { outOfRange: 'future-date' }, verdicts: { outOfRange: 'NEEDS_HUMAN' } } as const;
    expect(dateRule(own, { returnDate: '2027-01-01' }).fail).toEqual({ verdict: 'NEEDS_HUMAN', reason: 'future-date' });
  });

  it('fails a date outside the window, and a lookup with no window (null) is outside it', () => {
    const within = { lookup: 'returnWindow', param: 'orderId' };
    expect(line(dateRule({ within }, { returnDate: '2026-09-19', orderId: 'ORD-1234' }))).toBe('BLOCK date-window | returnDate outside returnWindow(orderId ...1234) 2026-09-20..2026-10-20');
    expect(line(dateRule({ within }, { returnDate: '2026-10-21', orderId: 'ORD-1234' }))).toBe('BLOCK date-window | returnDate outside returnWindow(orderId ...1234) 2026-09-20..2026-10-20');
    // An open-ended window (end null) holds any date on or after its start.
    expect(line(dateRule({ within }, { returnDate: '2030-01-01', orderId: 'ORD-5678' }))).toBe('pass | returnDate within returnWindow(orderId ...5678) 2026-09-01..open');
    const human = { within, verdicts: { outsideWindow: 'NEEDS_HUMAN' }, reasons: { outsideWindow: 'late-return' } } as const;
    expect(line(dateRule(human, { returnDate: '2026-09-25', orderId: 'ORD-NONE' }))).toBe('NEEDS_HUMAN late-return | returnDate: returnWindow(orderId ...NONE) has no window');
    expect(dateRule(human, { returnDate: '2026-11-25', orderId: 'ORD-1234' }).fail).toEqual({ verdict: 'NEEDS_HUMAN', reason: 'late-return' });
  });

  it('a bound it cannot find BLOCKs (bound-unknown), whatever the verdicts say', () => {
    const within = { lookup: 'returnWindow', param: 'orderId' };
    const human = { verdicts: { outOfRange: 'NEEDS_HUMAN', outsideWindow: 'NEEDS_HUMAN' } } as const;
    const unknown = (p: Omit<DateInRangeParams, 'field'>, params: Record<string, string>, lk?: GateLookups, f?: GateFacts) => dateRule({ ...human, ...p }, params, lk, f).fail;
    const blocked = { verdict: 'BLOCK', reason: 'bound-unknown' };
    // The param the lookup reads is missing or empty: the lookup is not asked.
    const spy = vi.fn(() => ({ start: '2026-01-01', end: null }));
    expect(unknown({ within }, { returnDate: '2026-09-25' }, lookups({ returnWindow: spy }))).toEqual(blocked);
    expect(unknown({ within }, { returnDate: '2026-09-25', orderId: '' }, lookups({ returnWindow: spy }))).toEqual(blocked);
    expect(spy).not.toHaveBeenCalled();
    expect(line(dateRule({ within }, { returnDate: '2026-09-25' }))).toBe('BLOCK bound-unknown | returnDate: within returnWindow(orderId missing) gave no window');
    // The lookup is missing, or is not a function.
    expect(unknown({ within: { lookup: 'refundWindow', param: 'orderId' } }, { returnDate: '2026-09-25', orderId: 'ORD-1234' })).toEqual(blocked);
    expect(unknown({ within }, { returnDate: '2026-09-25', orderId: 'ORD-1234' }, lookups({ returnWindow: { start: '2026-01-01', end: null } }))).toEqual(blocked);
    // The lookup returns junk: not a window, dates that are not dates, an array, a window from a prototype or a getter.
    const getter = Object.defineProperty({ end: null }, 'start', { get: () => '2026-01-01', enumerable: true });
    for (const junk of [undefined, 'open', 42, [], ['2026-01-01', null], { start: '2026-01-01' }, { start: 'soon', end: null }, { start: '2026-01-01', end: 'never' }, Object.create({ start: '2026-01-01', end: null }), getter]) {
      expect(unknown({ within }, { returnDate: '2026-09-25', orderId: 'ORD-1234' }, lookups({ returnWindow: () => junk })), JSON.stringify(junk) ?? 'undefined').toEqual(blocked);
    }
    // A date bound from a lookup that gives no date, or a field that is not there.
    expect(unknown({ notBefore: ref('order', 'orderId', 'deliveredOn') }, { returnDate: '2026-09-25', orderId: 'ORD-NONE' })).toEqual(blocked);
    expect(unknown({ notBefore: ref('order', 'orderId', 'shippedOn') }, { returnDate: '2026-09-25', orderId: 'ORD-1234' })).toEqual(blocked);
    expect(unknown({ notBefore: ref('orderTotal', 'orderId') }, { returnDate: '2026-09-25', orderId: 'ORD-1234' })).toEqual(blocked);
    // Today is not a date in the session's facts.
    expect(unknown({ notAfter: TODAY }, { returnDate: '2026-09-25' }, undefined, { ...facts, todayIso: 'unknown' })).toEqual(blocked);
    expect(line(dateRule({ notAfter: TODAY }, { returnDate: '2026-09-25' }, undefined, { ...facts, todayIso: '' }))).toBe('BLOCK bound-unknown | returnDate: notAfter today gave no date');
  });

  it('reaches no prototype property and calls no gate lookup, even when handed a reference the grammar refuses', () => {
    const blocked = { verdict: 'BLOCK', reason: 'bound-unknown' };
    for (const lookup of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__', 'prototype', 'ownerOf', 'scopeOf']) {
      expect(dateRule({ within: { lookup, param: 'orderId' } }, { returnDate: '2026-09-25', orderId: 'ORD-1234' }).fail, lookup).toEqual(blocked);
    }
    for (const field of ['constructor', '__proto__', 'toString', 'prototype']) {
      expect(dateRule({ notBefore: ref('order', 'orderId', field) }, { returnDate: '2026-09-25', orderId: 'ORD-1234' }).fail, field).toEqual(blocked);
    }
  });

  it('never puts the call\'s own date in its line: only the field\'s name, the bounds and a masked id', () => {
    const p = { notBefore: date('2026-01-01'), notAfter: TODAY, within: { lookup: 'returnWindow', param: 'orderId' } };
    for (const returnDate of ['2026-09-27', '2025-06-13', '2026-10-29', '1999-12-31', 'next week sometime']) {
      const o = dateRule(p, { returnDate, orderId: 'ORD-1234' });
      expect(o.result.compared, returnDate).not.toContain(returnDate);
      expect(o.result.compared).not.toContain('ORD-1234');
      expect(o.result.description).toBe('The date in returnDate is within its bounds');
      expect(o.result.id).toBe('dateInRange');
    }
  });
});

describe('limit', () => {
  it('passes a number within its limits, each inclusive, and says which it held to', () => {
    const p = { min: num('0.01'), max: ref('orderTotal', 'orderId') };
    expect(line(limit(p, { amount: '45.10', orderId: 'ORD-1234' }))).toBe('pass | amount at least 0.01, at most orderTotal(orderId ...1234) 120');
    expect(limit(p, { amount: '120', orderId: 'ORD-1234' }).fail).toBeUndefined();
    expect(limit(p, { amount: '120.00', orderId: 'ORD-1234' }).fail).toBeUndefined();
    expect(limit(p, { amount: '0.01', orderId: 'ORD-1234' }).fail).toBeUndefined();
    // A decimal text from the lookup, compared exactly.
    expect(line(limit({ max: ref('orderTotal', 'orderId') }, { amount: '80.5', orderId: 'ORD-5678' }))).toBe('pass | amount at most orderTotal(orderId ...5678) 80.50');
    expect(line(limit({ max: ref('order', 'orderId', 'total') }, { amount: '1', orderId: 'ORD-1234' }))).toBe('pass | amount at most order(orderId ...1234).total 120');
  });

  it('fails a number past either limit, by the smallest step, as the rule says', () => {
    const p = { min: num('0.01'), max: ref('orderTotal', 'orderId') };
    expect(line(limit(p, { amount: '120.01', orderId: 'ORD-1234' }))).toBe('BLOCK limit | amount above orderTotal(orderId ...1234) 120');
    expect(line(limit(p, { amount: '0.009', orderId: 'ORD-1234' }))).toBe('BLOCK limit | amount below 0.01');
    expect(line(limit(p, { amount: '-5', orderId: 'ORD-1234' }))).toBe('BLOCK limit | amount below 0.01');
    // Exact: past the precision of a JavaScript number.
    expect(limit({ max: num('100') }, { amount: '100.000000000000000001' }).fail).toEqual({ verdict: 'BLOCK', reason: 'limit' });
    expect(limit({ max: num('0.3') }, { amount: '0.30000000000000001' }).fail).toEqual({ verdict: 'BLOCK', reason: 'limit' });
    const own = { max: num('500'), reasons: { outOfRange: 'refund-cap' }, verdicts: { outOfRange: 'NEEDS_HUMAN' } } as const;
    expect(limit(own, { amount: '500.5' }).fail).toEqual({ verdict: 'NEEDS_HUMAN', reason: 'refund-cap' });
  });

  it('a value that is not a number BLOCKs, whatever the verdicts say: no units, separators, exponents or spaces', () => {
    const p = { max: num('500'), verdicts: { outOfRange: 'NEEDS_HUMAN' } } as const;
    expect(line(limit(p, {}))).toBe('BLOCK not-a-number | amount missing');
    for (const junk of ['1,000', '12 USD', '$12', '1e3', '+5', ' 5', '5 ', '.5', '5.', 'five', '0x10', '012', 'Infinity', 'NaN']) {
      expect(line(limit(p, { amount: junk })), junk).toBe('BLOCK not-a-number | amount is not a number');
    }
    expect(limit({ max: num('5'), reasons: { invalid: 'amount-unclear' } }, { amount: 'a lot' }).fail).toEqual({ verdict: 'BLOCK', reason: 'amount-unclear' });
  });

  it('a limit it cannot find BLOCKs (bound-unknown): a missing param, a missing lookup, junk from it', () => {
    const blocked = { verdict: 'BLOCK', reason: 'bound-unknown' };
    const max = ref('orderTotal', 'orderId');
    const human = { max, verdicts: { outOfRange: 'NEEDS_HUMAN' } } as const;
    expect(line(limit({ max }, { amount: '5' }))).toBe('BLOCK bound-unknown | amount: max orderTotal(orderId missing) gave no number');
    expect(limit(human, { amount: '5', orderId: 'ORD-NONE' }).fail).toEqual(blocked);
    expect(limit({ max: ref('refundCap', 'orderId') }, { amount: '5', orderId: 'ORD-1234' }).fail).toEqual(blocked);
    for (const junk of [undefined, null, '120 USD', '1,000', Number.NaN, Infinity, 1e21, {}, [120], { total: 120 }, true]) {
      expect(limit(human, { amount: '5', orderId: 'ORD-1234' }, lookups({ orderTotal: () => junk })).fail, String(junk)).toEqual(blocked);
    }
    const getter = Object.defineProperty({}, 'total', { get: () => 999, enumerable: true });
    expect(limit({ max: ref('order', 'orderId', 'total') }, { amount: '5', orderId: 'ORD-1234' }, lookups({ order: () => getter })).fail).toEqual(blocked);
    expect(limit({ max: ref('order', 'orderId', 'total') }, { amount: '5', orderId: 'ORD-1234' }, lookups({ order: () => Object.create({ total: 999 }) })).fail).toEqual(blocked);
    for (const lookup of ['constructor', 'toString', 'valueOf', 'ownerOf', 'scopeOf']) expect(limit({ max: ref(lookup, 'orderId') }, { amount: '5', orderId: 'ORD-1234' }).fail, lookup).toEqual(blocked);
  });

  it('calls the lookup with the param\'s value, on the gate\'s lookups', () => {
    const lk = lookups();
    const spy = vi.fn(function (this: unknown, id: string) {
      expect(this).toBe(lk);
      return id === 'ORD-1234' ? 50 : null;
    });
    (lk as unknown as Record<string, unknown>).orderTotal = spy;
    expect(limit({ max: ref('orderTotal', 'orderId') }, { amount: '5', orderId: 'ORD-1234' }, lk).fail).toBeUndefined();
    expect(spy).toHaveBeenCalledWith('ORD-1234');
  });

  it('never puts the call\'s own number in its line', () => {
    for (const amount of ['45.17', '987654.32', '1,234']) {
      const o = limit({ min: num('0.01'), max: ref('orderTotal', 'orderId') }, { amount, orderId: 'ORD-1234' });
      expect(o.result.compared, amount).not.toContain(amount);
      expect(o.result.description).toBe('The number in amount is within its limits');
      expect(o.result.id).toBe('limit');
    }
  });
});

describe('through the gate', () => {
  const policy = (): PolicyTables =>
    definePolicy(
      {
        actions: {
          refundOrder: {
            level: 0,
            rules: [
              { limit: { field: 'amount', min: 0.01, max: 'orderTotal(orderId)' } },
              { dateInRange: { field: 'returnDate', notAfter: 'today', within: 'returnWindow(orderId)', verdicts: { outsideWindow: 'NEEDS_HUMAN' } } },
            ],
          },
        },
      },
      { tools: { refundOrder: {} }, lookups: ['orderTotal', 'returnWindow'] },
    );

  it('runs the rules in order, under their names, and stops at the first that fails', () => {
    const gate = compiledPolicyOf(policy(), '');
    const decide = (params: Record<string, string>, lk = lookups()) => gate.evaluate({ tool: 'refundOrder', params }, caller, facts, lk);
    const allowed = decide({ amount: '20', returnDate: '2026-09-30', orderId: 'ORD-1234' });
    expect(allowed.verdict).toBe('ALLOW');
    expect(allowed.rules.map((r) => `${r.id}${r.pass ? '+' : '-'}`)).toEqual(['limit+', 'dateInRange+']);
    const over = decide({ amount: '200', returnDate: '2026-09-30', orderId: 'ORD-1234' });
    expect({ verdict: over.verdict, reason: over.reason, rules: over.rules.map((r) => r.id) }).toEqual({ verdict: 'BLOCK', reason: 'limit', rules: ['limit'] });
    const late = decide({ amount: '20', returnDate: '2026-09-01', orderId: 'ORD-1234' });
    expect({ verdict: late.verdict, reason: late.reason }).toEqual({ verdict: 'NEEDS_HUMAN', reason: 'date-window' });
  });

  it('a lookup that throws BLOCKs the call (rule-error), and the error never leaves the gate', () => {
    const gate = compiledPolicyOf(policy(), '');
    const lk = lookups({ orderTotal: () => { throw new Error('the order system is down'); } });
    const d = gate.evaluate({ tool: 'refundOrder', params: { amount: '20', returnDate: '2026-09-30', orderId: 'ORD-1234' } }, caller, facts, lk);
    expect({ verdict: d.verdict, reason: d.reason, rules: d.rules }).toEqual({
      verdict: 'BLOCK',
      reason: 'rule-error',
      rules: [{ id: 'limit', description: 'A rule the gate could run', compared: 'rule limit threw', pass: false }],
    });
  });
});
