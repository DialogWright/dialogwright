import { describe, expect, it } from 'vitest';
import { checkArgs, idempotencyKey, type Seen } from './actions';
import type { ActionSpec } from './business/schema';

/** The typed check of a call's arguments, before the gate: each failure a reason the model can act on. */

const TODAY = '2026-11-11';

const book: ActionSpec = {
  about: 'Book a visit into a free window.',
  kind: 'change',
  params: {
    day: { type: 'date', about: 'The day of the visit.' },
    window: { type: 'slot', from: 'check_availability', about: 'A window the lookup returned.' },
    item: { type: 'choice', options: ['kettle', 'toaster', 'lamp'], about: 'What is to be repaired.' },
    count: { type: 'number', optional: true, about: 'How many items.' },
    details: { type: 'text', optional: true, about: 'What is wrong with it.' },
    phone: { type: 'phone', about: 'The number to confirm on.' },
  },
};

const seen: Seen = {
  check_availability: { results: [{ id: 'w-1', label: '9 to 12' }, { id: 'w-2', label: '1 to 5' }], atMs: 1 },
};

const good = { day: '2026-11-13', window: 'w-1', item: 'kettle', phone: '+15555550142' };

const reasonOf = (args: Record<string, unknown>, s: Seen = seen): string => {
  const r = checkArgs(book, args, s, TODAY);
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r.params)}`);
  return r.reason;
};

describe('checkArgs', () => {
  it('passes good arguments, each as a string, with an optional param left out as empty', () => {
    expect(checkArgs(book, good, seen, TODAY)).toEqual({ ok: true, params: { ...good, count: '', details: '' } });
  });

  it('refuses a date that is not a real day, naming the param', () => {
    expect(reasonOf({ ...good, day: '2026-02-30' })).toMatch(/\bday\b/);
    expect(reasonOf({ ...good, day: '2026-02-30' })).toMatch(/YYYY-MM-DD/);
    expect(reasonOf({ ...good, day: 'next Friday' })).toMatch(/\bday\b/);
    expect(reasonOf({ ...good, day: '2026-13-01' })).toMatch(/\bday\b/);
  });

  it('refuses a choice outside its options, listing them; a choice is matched without regard to case', () => {
    const reason = reasonOf({ ...good, item: 'blender' });
    expect(reason).toMatch(/\bitem\b/);
    expect(reason).toContain('kettle, toaster, lamp');
    const r = checkArgs(book, { ...good, item: ' Kettle ' }, seen, TODAY);
    expect(r.ok && r.params.item).toBe('kettle');
  });

  it('refuses a slot the lookup did not return on this call, naming the lookup', () => {
    expect(reasonOf({ ...good, window: 'x-1' })).toContain("pick a time from check_availability's results");
    expect(reasonOf({ ...good, window: 'w-1' }, {})).toContain("pick a time from check_availability's results");
    expect(reasonOf({ ...good, window: 'w-1' }, { other: seen.check_availability! })).toContain('check_availability');
  });

  it('reads no lookup from the prototype of what was seen', () => {
    const fromProto: ActionSpec = { ...book, params: { window: { type: 'slot', from: 'constructor', about: 'A window.' } } };
    const r = checkArgs(fromProto, { window: 'w-1' }, {}, TODAY);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('constructor has not been called on this call');
  });

  it('takes a slot by the id of a result, whether a result is an object or a bare id', () => {
    expect(checkArgs(book, { ...good, window: 'w-2' }, seen, TODAY).ok).toBe(true);
    expect(checkArgs(book, { ...good, window: 'w-9' }, { check_availability: { results: ['w-9'], atMs: 1 } }, TODAY).ok).toBe(true);
  });

  it('normalises a phone number to E.164, or refuses it', () => {
    const as = (phone: unknown): string | null => {
      const r = checkArgs(book, { ...good, phone }, seen, TODAY);
      return r.ok ? r.params.phone! : null;
    };
    expect(as('(555) 555-0142')).toBe('+15555550142');
    expect(as('555.555.0142')).toBe('+15555550142');
    expect(as('1 555 555 0142')).toBe('+15555550142');
    expect(as('+1 555-555-0142')).toBe('+15555550142');
    expect(as(5555550142)).toBe('+15555550142');
    expect(as('12345')).toBeNull();
    expect(as('call me')).toBeNull();
    expect(reasonOf({ ...good, phone: '12345' })).toMatch(/\bphone\b/);
  });

  it('checks a number', () => {
    const r = checkArgs(book, { ...good, count: 2 }, seen, TODAY);
    expect(r.ok && r.params.count).toBe('2');
    expect(reasonOf({ ...good, count: 'two' })).toMatch(/\bcount\b/);
  });

  it('refuses a missing required param, naming it', () => {
    const { item: _item, ...rest } = good;
    expect(reasonOf(rest)).toMatch(/\bitem\b/);
    expect(reasonOf({ ...good, item: '' })).toMatch(/\bitem\b/);
    expect(reasonOf({ ...good, item: null })).toMatch(/\bitem\b/);
  });

  it('refuses params the action does not take, naming them and the ones it does', () => {
    const reason = reasonOf({ ...good, colour: 'red' });
    expect(reason).toContain('colour');
    expect(reason).toContain('day, window, item, count, details, phone');
  });

  it('refuses a value that is not text or a number', () => {
    expect(reasonOf({ ...good, details: { what: 'broken' } })).toMatch(/\bdetails\b/);
    expect(reasonOf({ ...good, item: true })).toMatch(/\bitem\b/);
  });
});

describe('idempotencyKey', () => {
  it('is a sha256 in hex, the same whatever the order of the params', () => {
    const a = idempotencyKey('call-1', 'book', { day: '2026-11-13', item: 'kettle' });
    const b = idempotencyKey('call-1', 'book', { item: 'kettle', day: '2026-11-13' });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it('differs with the call, the action or a value', () => {
    const a = idempotencyKey('call-1', 'book', { day: '2026-11-13' });
    expect(idempotencyKey('call-2', 'book', { day: '2026-11-13' })).not.toBe(a);
    expect(idempotencyKey('call-1', 'notify', { day: '2026-11-13' })).not.toBe(a);
    expect(idempotencyKey('call-1', 'book', { day: '2026-11-14' })).not.toBe(a);
  });
});
