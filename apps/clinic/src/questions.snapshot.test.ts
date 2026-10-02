import { describe, expect, it } from 'vitest';
import { buildQuestions, newSession, slotContext, VOICE_RELAY, type Session, type SlotPartial } from 'dialogwright';
import { turnContext } from './testing/turns';

/**
 * Every question the model sees on the clinic, pinned: what the cassette keys a turn by (with the
 * turn state), so a change here re-keys the recorded calls. The slot context is the engine's own for
 * the words (core/turn.ts slotContext: the candidate spans come from the text), each slot's pending
 * partial and `prompted` substituted in by buildQuestions as on a real turn. The engine's own
 * snapshot (core/questions.snapshot.test.ts) pins the same views on the testkit.
 */

const tc = turnContext();
const QUIET = 'hi';

/** A fresh call to the clinic, outside any form. */
const call = (): Session => newSession('clinic-q', 0, VOICE_RELAY);

/** In `form` from the start of the call, the line having just asked for `slot`. */
function asking(form: string, slot: string): Session {
  const s = call();
  s.form = form;
  s.promptedFor = slot;
  return s;
}

function filled(s: Session, slot: string, value: string, display: string): void {
  s.slots[slot] = { ...s.slots[slot]!, value, display };
}

function pending(s: Session, slot: string, window: SlotPartial): void {
  s.slots[slot] = { ...s.slots[slot]!, window };
}

const questionsFor = (s: Session, text: string) => buildQuestions(s, slotContext(s, text, tc));

describe('the questions the model sees, on the clinic', () => {
  it('pins every question outside a form, with no candidate spans', () => {
    expect(slotContext(call(), QUIET, tc).candidateSpans).toEqual([]);
    expect(questionsFor(call(), QUIET)).toMatchSnapshot();
  });

  it('pins every question outside a form, with candidate spans (digits and number words)', () => {
    const text = 'I need to move my appointment, I was born June 14 nineteen seventy five and my member ID is 5550 7788';
    expect(slotContext(call(), text, tc).candidateSpans.length).toBeGreaterThan(0);
    expect(questionsFor(call(), text)).toMatchSnapshot();
  });

  for (const [form, first] of [
    ['schedule_new', 'name'], ['reschedule', 'name'], ['cancel', 'name'], ['confirm_appointment', 'name'], ['billing', 'memberId'],
  ] as const) {
    it(`pins every question in ${form} at its first slot (${first}), with no candidate spans`, () => {
      expect(questionsFor(asking(form, first), QUIET)).toMatchSnapshot();
    });
  }

  it('pins every question in billing at the member ID, with candidate spans', () => {
    const text = 'sure it is five five five zero seven seven eight eight';
    expect(slotContext(call(), text, tc).candidateSpans.length).toBeGreaterThan(0);
    expect(questionsFor(asking('billing', 'memberId'), text)).toMatchSnapshot();
  });

  it('pins every question with a birth date pending its year (month and day heard), the year said', () => {
    const s = asking('schedule_new', 'dob');
    filled(s, 'name', 'morgan ellis', 'Morgan Ellis');
    pending(s, 'dob', { kind: 'dob', month: 6, day: 14 });
    const q = questionsFor(s, 'nineteen seventy five');
    // The year question says the year alone was asked for, and offers the year as a span.
    expect((q.dobYear as { instructions: string }).instructions).toContain('The caller was asked for the year of their birth');
    expect(Object.keys((q.dobYear as { criteria: Record<string, unknown> }).criteria)).toContain('nineteen seventy five');
    expect(q).toMatchSnapshot();
  });

  it('pins every question with a span of days pending (next week), a weekday said', () => {
    const s = asking('schedule_new', 'date');
    filled(s, 'name', 'morgan ellis', 'Morgan Ellis');
    filled(s, 'dob', '1975-06-14', 'June 14th, 1975');
    filled(s, 'provider', 'patel', 'Dr. Patel');
    pending(s, 'date', { kind: 'window', start: '2026-09-21', end: '2026-09-27', label: 'next_week' });
    expect(questionsFor(s, 'wednesday works')).toMatchSnapshot();
  });

  it('pins every question at the summary of a scheduling form', () => {
    const s = asking('schedule_new', 'name');
    s.promptedFor = 'confirm';
    s.pendingConfirmation = { target: 'form', form: 'schedule_new', attempts: 0 };
    expect(questionsFor(s, QUIET)).toMatchSnapshot();
  });
});
