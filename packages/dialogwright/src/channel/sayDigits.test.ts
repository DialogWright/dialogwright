import { describe, expect, it } from 'vitest';
import { digitsSaidOf, sayDigits, spellDigits } from './sayDigits';

const app = { slots: { phone: { sayAs: 'digits' as const }, count: {}, caller: {} } };
const session = (slots: Record<string, { value: string | null; display?: string | null }>, pendingConfirmation: unknown = null) => ({ slots, pendingConfirmation });

describe('spellDigits', () => {
  it('says each digit, with a comma between groups', () => {
    expect(spellDigits('0142')).toBe('0 1 4 2');
    expect(spellDigits('555 555 0142')).toBe('5 5 5, 5 5 5, 0 1 4 2');
    expect(spellDigits(' 5550  7788 ')).toBe('5 5 5 0, 7 7 8 8');
  });
});

describe('sayDigits', () => {
  it('spells each value found whole, longest first, and leaves the rest of the line as written', () => {
    expect(sayDigits('I have Jordan Avery, at 555 555 0142, about an order.', ['555 555 0142', '5555550142'])).toBe('I have Jordan Avery, at 5 5 5, 5 5 5, 0 1 4 2, about an order.');
    expect(sayDigits('Is the number ending in 0142 the best one?', ['0142'])).toBe('Is the number ending in 0 1 4 2 the best one?');
    expect(sayDigits('Your card is 55520417.', ['55520417', '5552 0417'])).toBe('Your card is 5 5 5 2 0 4 1 7.');
  });

  it('never inside a longer number, nor across a separator of dates, times and amounts', () => {
    expect(sayDigits('Call 155550142 or 01425.', ['0142'])).toBe('Call 155550142 or 01425.');
    expect(sayDigits('It costs 10,142 or 0142.50 or 3.0142, ending in 0142.', ['0142'])).toBe('It costs 10,142 or 0142.50 or 3.0142, ending in 0 1 4 2.');
    expect(sayDigits('On 10/13/2026, or 2026-10-13, at 10:42.', ['2026', '42', '10'])).toBe('On 10/13/2026, or 2026-10-13, at 10:42.');
    expect(sayDigits('Ending in 0142-7 or 7-0142.', ['0142'])).toBe('Ending in 0142-7 or 7-0142.');
    // A sentence's own punctuation is no separator: nothing numeric across it.
    expect(sayDigits('Your number is 55520417. Is that right?', ['55520417'])).toBe('Your number is 5 5 5 2 0 4 1 7. Is that right?');
  });

  it('leaves a line with none of them, or with no values, as it is', () => {
    expect(sayDigits('Ending in 0 1 4 2.', ['0142'])).toBe('Ending in 0 1 4 2.');
    expect(sayDigits('Ending in 0142.', [])).toBe('Ending in 0142.');
  });
});

describe('digitsSaidOf', () => {
  it('a short value the session holds is not looked for unless the decision names it: "born April 12, 1980" stays a date', () => {
    const s = session({ phone: { value: '1980', display: '1980' } });
    expect(digitsSaidOf(app, s, null)).toEqual([]);
    expect(sayDigits('Born April 12, 1980.', digitsSaidOf(app, s, null))).toBe('Born April 12, 1980.');
    expect(digitsSaidOf(app, s, { vars: { phone: '1980' } })).toEqual(['1980']);
    // Five digits or more: looked for wherever a line says it, a repeat included.
    expect(digitsSaidOf(app, session({ phone: { value: '55520', display: '55520' } }), { kind: 'replay', text: 'x' })).toEqual(['55520']);
  });

  it("is a slot's value and display, for a slot said digit by digit only", () => {
    const s = session({ phone: { value: '5555550142', display: '555 555 0142' }, count: { value: '12', display: '12' }, caller: { value: 'jordan avery', display: 'Jordan Avery' } });
    expect(digitsSaidOf(app, s, null).sort()).toEqual(['555 555 0142', '5555550142']);
  });

  it('is nothing for an app with no slot said digit by digit', () => {
    expect(digitsSaidOf({ slots: { phone: {} } }, session({ phone: { value: '5555550142', display: '555 555 0142' } }), { vars: { phone: '555 555 0142' } })).toEqual([]);
  });

  it("is the caller's number offered and its last four, a value read back, and none proposed from the facts by its last four", () => {
    const offered = session({ phone: { value: null } }, { target: 'slot', slot: 'phone', value: '5555550142', display: '555 555 0142', offered: true });
    expect(digitsSaidOf(app, offered, { vars: { last4: '0142' } }).sort()).toEqual(['0142', '555 555 0142', '5555550142']);
    // Asked again word for word (a repeat has no variables): the offer is still the question.
    expect(digitsSaidOf(app, offered, { kind: 'replay', text: 'x' })).toContain('0142');
    expect(digitsSaidOf(app, offered, null)).not.toContain('0142');
    const consent = session({ phone: { value: null } }, { target: 'slot', slot: 'phone', value: '5555550142', display: '555 555 0142', offered: true, consent: true, at: 'greeting' });
    expect(digitsSaidOf(app, consent, { kind: 'replay', text: 'x' })).toContain('0142');
    const readBack = session({ phone: { value: null } }, { target: 'slot', slot: 'phone', value: '5555550177', display: '555 555 0177' });
    expect(digitsSaidOf(app, readBack, null).sort()).toEqual(['555 555 0177', '5555550177']);
    const facts = session({ phone: { value: null } }, { target: 'slot', slot: 'phone', value: '5555550177', display: '555 555 0177', offered: true, from: 'facts' });
    expect(digitsSaidOf(app, facts, null)).not.toContain('0177');
  });

  it("takes the decision's variables named for the slot, and a last four only when it is one of the slot's", () => {
    const s = session({ phone: { value: '5555550142', display: '555 555 0142' } });
    expect(digitsSaidOf(app, s, { vars: { last4: '0142' }, acks: [{ vars: { phone: '555 555 0199' } }] }).sort()).toEqual(['0142', '555 555 0142', '555 555 0199', '5555550142']);
    expect(digitsSaidOf(app, s, { vars: { last4: '7788', count: '1234' } }).sort()).toEqual(['555 555 0142', '5555550142']);
  });

  it('keeps only digits in groups, of two digits or more', () => {
    const s = session({ phone: { value: '7', display: '7' } }, null);
    expect(digitsSaidOf(app, s, { vars: { phone: '•••• 0142' } })).toEqual([]);
    expect(digitsSaidOf(app, session({ phone: { value: '55', display: '5-5' } }), { vars: { phone: '55' } })).toEqual(['55']);
  });
});
