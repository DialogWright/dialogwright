import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { formsSchema } from './forms';
import { checkOutcomeSchema, parseOnMaxAttempts, slotAttemptsSchema, slotOnMaxAttemptsSchema } from './outcome';
import { buildSlot } from '../../slots/defineSlot';
import { slotsJsonSchema } from './json';

/**
 * A slot's `attempts` and `onMaxAttempts` (design 2026-10-09-per-slot-retries, decisions 1 and 4), and
 * the outcome a check's refusal and a slot that runs out share: one shape and one validator.
 */

const messages = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }): string[] =>
  r.success ? [] : r.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`);

describe('onMaxAttempts', () => {
  it('takes each form the plan writes', () => {
    for (const value of [
      'handoff',
      'skip',
      { say: 'referral_skipped', then: 'skip' },
      { then: 'skip' },
      { say: 'plan_help', then: 'form', form: 'plan_help' },
      { then: 'form', form: 'plan_help' },
      { then: 'handoff', reason: 'member-lookup' },
      { say: 'sorry', then: 'handoff' },
      { say: 'goodbye_unclear', then: 'end' },
      { say: 'cannot_take', then: 'anything-else' },
    ]) {
      expect(messages(parseOnMaxAttempts(value)), JSON.stringify(value)).toEqual([]);
      expect(slotOnMaxAttemptsSchema.safeParse(value).success, JSON.stringify(value)).toBe(true);
    }
  });

  it('refuses then: end or anything-else with no say, a reason without handoff, a form without then: form, and then: form with no form', () => {
    expect(messages(parseOnMaxAttempts({ then: 'end' }))).toEqual([': then: end says a line first, and this outcome names none']);
    expect(messages(parseOnMaxAttempts({ then: 'anything-else' }))).toEqual([': then: anything-else says a line first, and this outcome names none']);
    expect(messages(parseOnMaxAttempts({ then: 'skip', reason: 'x' }))).toEqual(['reason: a reason names the handoff line, and this outcome does not hand off']);
    expect(messages(parseOnMaxAttempts({ then: 'form' }))).toEqual([': then: form enters another form, and this outcome names none']);
    expect(messages(parseOnMaxAttempts({ then: 'skip', form: 'x' }))).toEqual(['form: a form is entered only by then: form, and this outcome does something else']);
  });

  it('refuses a short form that needs what only the long form says, and a word that is no outcome', () => {
    expect(messages(parseOnMaxAttempts('end'))).toEqual([': "end" is written out, with what it needs (the line said)']);
    expect(messages(parseOnMaxAttempts('form'))).toEqual([': "form" is written out, with what it needs (the form entered)']);
    expect(messages(parseOnMaxAttempts('agent'))).toEqual([': "agent" is not "handoff" or "skip"']);
    expect(parseOnMaxAttempts({ then: 'skip', sya: 'x' }).success).toBe(false);
  });
});

describe('attempts', () => {
  it('takes 1 to 10', () => {
    for (const n of [1, 2, 3, 4, 10]) expect(slotAttemptsSchema.safeParse(n).success, String(n)).toBe(true);
  });
  it('refuses 0, 11 and a part of one', () => {
    for (const n of [0, 11, 2.5, -1]) expect(slotAttemptsSchema.safeParse(n).success, String(n)).toBe(false);
  });
});

describe('a library slot takes both beside its type\'s options', () => {
  const config = { type: 'choice', text: { instructions: 'Read asr.text. Which plan does the caller name?' }, options: { basic: 'Basic', plus: 'Plus' } };

  it('on its spec', () => {
    const built = buildSlot('planType', { ...config, attempts: 4, onMaxAttempts: { say: 'plan_help', then: 'form', form: 'plan_help' } });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.spec.attempts).toBe(4);
    expect(built.spec.onMaxAttempts).toEqual({ say: 'plan_help', then: 'form', form: 'plan_help' });
    const short = buildSlot('referral', { ...config, onMaxAttempts: 'skip' });
    expect(short.ok && short.spec.onMaxAttempts).toBe('skip');
  });

  it('absent, the spec has neither', () => {
    const built = buildSlot('planType', config);
    expect(built.ok && 'attempts' in built.spec).toBe(false);
    expect(built.ok && 'onMaxAttempts' in built.spec).toBe(false);
  });

  it('a wrong value is a problem at its key', () => {
    const built = buildSlot('planType', { ...config, attempts: 0, onMaxAttempts: { then: 'end' } });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problems.map((p) => p.path)).toEqual(['planType.attempts', 'planType.onMaxAttempts']);
    expect(built.problems[0]!.message).toContain('at least 1');
    expect(built.problems[1]!.message).toContain('then: end says a line first');
  });

  it('the JSON Schema names both on every type', () => {
    const branches = (slotsJsonSchema().additionalProperties as { oneOf: { properties: Record<string, unknown> }[] }).oneOf;
    for (const branch of branches.filter((b) => (b.properties.type as { const?: string }).const !== 'code')) {
      expect(Object.keys(branch.properties)).toEqual(expect.arrayContaining(['attempts', 'onMaxAttempts']));
    }
  });
});
