import { describe, expect, it } from 'vitest';
import { formatAnswers, formatGates, formatDecision, formatSlots } from './print';
import { endAction, sayAction, transferAction } from '../channel/actions';
import type { Decision } from '../core/decision';
import { choice, noul, score } from '../testing/answers';
import type { QuestionMap } from '../jev/types';
import { ALL_SLOTS, type TestkitSlot } from '../testing/testkit/domain/slots';
import { useTestkit } from '../testing/apps';
import type { SlotState } from '../core/session';

useTestkit();

describe('print', () => {
  it('formats top choices, all score levels and noul values', () => {
    const q: QuestionMap = {
      intent: { type: 'choice', instructions: '', criteria: { a: null, b: null, c: null, d: null } },
      frustration: { type: 'score', instructions: '', levels: [{ label: 'none', description: '' }, { label: 'high', description: '' }] },
      ok: { type: 'noul', instructions: '' },
    };
    const text = formatAnswers(q, {
      intent: choice({ a: 0.5, b: 0.3, c: 0.15, d: 0.05 }),
      frustration: score({ none: 0.9, high: 0.1 }),
      ok: noul(0.42),
    });
    expect(text).toContain('intent');
    expect(text).toContain('a 0.50');
    expect(text).not.toContain('d 0.05');
    expect(text).toContain('none 0.90');
    expect(text).toContain('ok');
    expect(text).toContain('0.42');
  });

  it('formats gate rows with a marker on the deciding gate', () => {
    const text = formatGates([
      { gate: 'addressedToSystem', value: 0.9, threshold: 0.7, passed: true, outcome: 'pass', decided: false },
      { gate: 'intent', value: 0.3, threshold: 0.4, passed: false, outcome: 'failed:none', decided: true },
    ]);
    expect(text).toContain('addressedToSystem');
    expect(text).toMatch(/intent.*0\.30.*0\.40.*FAIL.*failed:none.*<==/);
  });

  it('formats a decision with its spoken text', () => {
    const text = formatDecision(
      { kind: 'prompt', promptId: 'ask_accountId', vars: {}, acks: [], target: 'accountId', options: [] },
      [sayAction([{ text: "What's your account ID?" }], true)],
    );
    expect(text).toContain('prompt ask_accountId');
    expect(text).toContain("What's your account ID?");
  });

  it('prints a clip as [play] and the end of the call with the handoff data the relay is handed', () => {
    const handoff = { kind: 'handoff', reason: 'needs-human', promptId: 'handoff_needs_human', acks: [], completed: ['track_parcel'], queued: [], slots: { accountId: '...1234' } } satisfies Decision;
    expect(formatDecision(handoff, [sayAction([{ audio: 'https://h/a.mp3' }, { text: 'Connecting you now.' }], false), transferAction('needs-human', ['track_parcel'], [], { accountId: '...1234' })])).toBe([
      'decision: handoff handoff_needs_human (needs-human)',
      '  [play]',
      '  > Connecting you now.',
      '  [end] {"reasonCode":"needs-human","completed":["track_parcel"],"slots":{"accountId":"...1234"}}',
    ].join('\n'));
    expect(formatDecision({ kind: 'complete', form: null, promptId: 'goodbye', vars: {}, acks: [], completed: ['track_parcel'] }, [endAction(['track_parcel'])]))
      .toBe('decision: complete goodbye\n  [end] {"reasonCode":"completed","completed":["track_parcel"]}');
  });
});

describe('formatSlots', () => {
  const empty: SlotState = { value: null, display: null, confirmed: false, attempts: 0, window: null, helped: [] };
  const slots = (over: Partial<Record<TestkitSlot, SlotState>>): Record<TestkitSlot, SlotState> =>
    ({ ...Object.fromEntries(ALL_SLOTS.map((id) => [id, empty])), ...over }) as Record<TestkitSlot, SlotState>;
  it('lists only filled slots with value, display and confirmation', () => {
    const text = formatSlots(slots({
      accountId: { ...empty, value: '55501234', display: '5550 1234' },
      deliveryPart: { ...empty, value: 'morning', display: 'in the morning', confirmed: true },
    }));
    expect(text).toMatch(/accountId\s+55501234\s+5550 1234/);
    expect(text).toMatch(/deliveryPart\s+morning\s+in the morning\s+confirmed/);
    expect(text).not.toContain('deliveryDay');
  });

  it('returns an empty string when no slot is filled', () => {
    expect(formatSlots(slots({}))).toBe('');
  });
});
