import { describe, expect, it } from 'vitest';
import { choice, noul, testSlotContext as ctx } from 'dialogwright';
import { memberIdSlot } from './memberId';

describe('memberIdSlot', () => {
  it('asks three questions with the spans as choice criteria', () => {
    const q = memberIdSlot.questions(ctx('it is five five five'));
    expect(Object.keys(q)).toEqual(['containsMemberId', 'memberIdSpan', 'memberIdComplete']);
    const span = q.memberIdSpan!;
    expect(span.type).toBe('choice');
    if (span.type === 'choice') expect(Object.keys(span.criteria)).toEqual(expect.arrayContaining(['five five five', 'none']));
  });

  it('fills when detected, complete, and the span is eight digits', () => {
    const out = memberIdSlot.fill(
      { containsMemberId: noul(0.95), memberIdSpan: choice({ 'five five five zero seven seven eight eight': 0.9, none: 0.1 }), memberIdComplete: noul(0.9) },
      ctx('my id is five five five zero seven seven eight eight'),
    );
    expect(out).toEqual({ kind: 'filled', value: '55507788', display: '5550 7788', confidence: 0.9, confirm: 'implicit' });
  });

  it('is absent when not detected', () => {
    const out = memberIdSlot.fill({ containsMemberId: noul(0.1), memberIdSpan: choice({ none: 1 }), memberIdComplete: noul(0.5) }, ctx('I want to cancel'));
    expect(out).toEqual({ kind: 'absent' });
  });

  it('is invalid when the digits do not match the mask', () => {
    const out = memberIdSlot.fill({ containsMemberId: noul(0.9), memberIdSpan: choice({ 'five five five': 0.9, none: 0.1 }), memberIdComplete: noul(0.9) }, ctx('it is five five five'));
    expect(out).toMatchObject({ kind: 'invalid', reason: 'mask', raw: '555' });
  });

  it('is invalid when detected but incomplete', () => {
    const out = memberIdSlot.fill({ containsMemberId: noul(0.9), memberIdSpan: choice({ 'five five': 0.9, none: 0.1 }), memberIdComplete: noul(0.2) }, ctx('it is five five'));
    expect(out).toMatchObject({ kind: 'invalid', reason: 'incomplete' });
  });

  it('parses eight keypad digits', () => {
    expect(memberIdSlot.dtmf!.parse('55507788', ctx(''))).toEqual({ value: '55507788', display: '5550 7788' });
    expect(memberIdSlot.dtmf!.parse('5550778#', ctx(''))).toBeNull();
  });

  it('is recorded and handed off by its last four, and detected', () => {
    expect(memberIdSlot).toMatchObject({ redact: 'last4', handoff: 'last4', detect: true });
  });
});
