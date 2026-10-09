import { describe, expect, it } from 'vitest';
import { definePolicy } from '../define/definePolicy';
import { compiledPolicyOf } from './compiled';
import { CALLER_NUMBER_ID, callerNumberRule, NO_CALLER_NUMBER, NOT_CALLER_NUMBER } from './callerNumber';
import { confirmationHash } from './lines';
import { VALUE_MISSING } from './listed';
import { ANONYMOUS } from './principal';
import type { GateFacts, GateLookups, RuleContext } from './types';

/**
 * The callerNumber rule: a param held to the number the caller is calling from (GateFacts.callerNumber),
 * compared as the slot of the same name holds it (GateFacts.callerNumberAs) or digit for digit, or, with
 * `else: confirmed`, to a number the caller confirmed at the summary. Each outcome, failing closed, and
 * lines that never show a number. Run directly and through a policy compiled from the file.
 */

const NUMBER = '+15555550142';
const base: GateFacts = { attempts: 0, confirmedHash: null, todayIso: '2026-10-07' };
const kept: GateFacts = { ...base, callerNumber: NUMBER, callerNumberAs: { textTo: '5555550142' } };
const lk: GateLookups = { ownerOf: () => null, scopeOf: () => [] };
const ctx = (params: Record<string, string>, facts: GateFacts = kept): RuleContext => ({ call: { tool: 'sendUpdates', params }, p: ANONYMOUS, facts, lk, policy: {} as never, subjectKind: '' });

const OWN = { id: CALLER_NUMBER_ID, description: 'The number in textTo is the caller\'s own', compared: 'textTo is the caller\'s number', pass: true };

describe('callerNumber, else refuse (the default)', () => {
  const rule = callerNumberRule({ field: 'textTo' }, null);

  it('passes the caller\'s own number, as the slot of the field\'s name holds it', () => {
    expect(rule(ctx({ textTo: '5555550142' }))).toEqual({ result: OWN });
    expect(CALLER_NUMBER_ID).toBe('callerNumber');
  });

  it('refuses another number, not-caller-number, BLOCK', () => {
    expect(rule(ctx({ textTo: '5555550199' }))).toEqual({
      result: { ...OWN, compared: 'textTo is not the caller\'s number', pass: false },
      fail: { verdict: 'BLOCK', reason: NOT_CALLER_NUMBER },
    });
    expect(NOT_CALLER_NUMBER).toBe('not-caller-number');
    // As the slot holds it: the number as kept (+1 and all) is not the slot's value.
    expect(rule(ctx({ textTo: '+15555550142' })).fail).toEqual({ verdict: 'BLOCK', reason: NOT_CALLER_NUMBER });
  });

  it('refuses any number on a call with no caller\'s number kept, no-caller-number', () => {
    expect(rule(ctx({ textTo: '5555550142' }, base))).toEqual({
      result: { ...OWN, compared: 'textTo with no caller\'s number', pass: false },
      fail: { verdict: 'BLOCK', reason: NO_CALLER_NUMBER },
    });
    expect(rule(ctx({ textTo: '5555550142' }, { ...base, callerNumber: '' })).fail).toEqual({ verdict: 'BLOCK', reason: NO_CALLER_NUMBER });
    expect(NO_CALLER_NUMBER).toBe('no-caller-number');
  });

  it('fails closed on a missing or empty value, BLOCK value-missing', () => {
    for (const params of [{}, { textTo: '' }, { other: '5555550142' }] as Record<string, string>[]) {
      expect(rule(ctx(params))).toMatchObject({ result: { compared: 'textTo missing', pass: false }, fail: { verdict: 'BLOCK', reason: VALUE_MISSING } });
    }
    expect(callerNumberRule({ field: 'toString' }, null)(ctx({})).fail).toEqual({ verdict: 'BLOCK', reason: VALUE_MISSING });
  });

  it('compares a field that is no slot of the number digit for digit with the number as kept, the international form included', () => {
    const to = callerNumberRule({ field: 'to' }, null);
    expect(to(ctx({ to: '+1 (555) 555-0142' })).result.pass).toBe(true);
    expect(to(ctx({ to: '15555550142' })).result.pass).toBe(true);
    // The number without its country code is another string of digits: refused, as no slot says how it is held.
    expect(to(ctx({ to: '5555550142' })).fail).toEqual({ verdict: 'BLOCK', reason: NOT_CALLER_NUMBER });
    expect(to(ctx({ to: 'none' })).fail).toEqual({ verdict: 'BLOCK', reason: NOT_CALLER_NUMBER });
  });

  it('never shows a number in its line, the caller\'s or the call\'s', () => {
    for (const params of [{ textTo: '5555550142' }, { textTo: '5555550199' }]) {
      for (const facts of [kept, base]) {
        const line = JSON.stringify(rule(ctx(params, facts)).result);
        expect(line).not.toMatch(/\d{4}/);
      }
    }
  });
});

describe('callerNumber, else confirmed', () => {
  const FIELDS = ['topic', 'textTo'];
  const rule = callerNumberRule({ field: 'textTo', else: 'confirmed' }, FIELDS);
  const confirmedFor = (params: Record<string, string>, facts: GateFacts = kept): GateFacts => ({ ...facts, confirmedHash: confirmationHash(params, FIELDS) });

  it('passes the caller\'s own number, confirmed or not', () => {
    expect(rule(ctx({ topic: 'order', textTo: '5555550142' })).result).toMatchObject({ compared: 'textTo is the caller\'s number', pass: true, description: 'The number in textTo is the caller\'s own, or one the caller confirmed' });
  });

  it('passes another number the caller confirmed at the summary, and refuses one they did not', () => {
    const other = { topic: 'order', textTo: '5555550199' };
    expect(rule(ctx(other, confirmedFor(other))).result).toMatchObject({ compared: 'textTo is not the caller\'s number, but a number the caller confirmed', pass: true });
    expect(rule(ctx(other))).toMatchObject({ result: { compared: 'textTo is not the caller\'s number, and not confirmed', pass: false }, fail: { verdict: 'BLOCK', reason: NOT_CALLER_NUMBER } });
    // A confirmation of other values is no confirmation of these.
    expect(rule(ctx(other, confirmedFor({ topic: 'order', textTo: '5555550123' }))).fail).toEqual({ verdict: 'BLOCK', reason: NOT_CALLER_NUMBER });
  });

  it('passes a confirmed number on a call with no caller\'s number (a chat), and refuses an unconfirmed one there', () => {
    const said = { topic: 'bill', textTo: '5555550199' };
    expect(rule(ctx(said, confirmedFor(said, base))).result).toMatchObject({ compared: 'textTo is a number the caller confirmed', pass: true });
    expect(rule(ctx(said, base)).fail).toEqual({ verdict: 'BLOCK', reason: NO_CALLER_NUMBER });
  });

  it('confirms nothing when the action has no confirmed rule, or one that does not name the field', () => {
    const other = { topic: 'order', textTo: '5555550199' };
    expect(callerNumberRule({ field: 'textTo', else: 'confirmed' }, null)(ctx(other, confirmedFor(other))).fail).toEqual({ verdict: 'BLOCK', reason: NOT_CALLER_NUMBER });
    const topicOnly = callerNumberRule({ field: 'textTo', else: 'confirmed' }, ['topic']);
    expect(topicOnly(ctx(other, { ...kept, confirmedHash: confirmationHash(other, ['topic']) })).fail).toEqual({ verdict: 'BLOCK', reason: NOT_CALLER_NUMBER });
  });

  it('still fails closed on a missing value', () => {
    expect(rule(ctx({ topic: 'order' }, confirmedFor({ topic: 'order' }))).fail).toEqual({ verdict: 'BLOCK', reason: VALUE_MISSING });
  });
});

describe('callerNumber in a policy compiled from the file', () => {
  const tables = definePolicy(
    {
      actions: {
        sendUpdates: { level: 0, rules: ['identity', { callerNumber: { field: 'textTo', else: 'confirmed' } }, { confirmed: ['topic', 'textTo'] }] },
        textOwn: { level: 0, rules: ['identity', { callerNumber: { field: 'textTo' } }] },
      },
      audit: { topic: 'keep', textTo: 'last4' },
    },
    { tools: { sendUpdates: { params: ['topic', 'textTo'] }, textOwn: { params: ['textTo'] } } },
  );
  const gate = compiledPolicyOf(tables, '');

  it('runs under its name, with the action\'s confirmed fields for else: confirmed', () => {
    expect(tables.rulesFor.sendUpdates).toEqual(['R1', 'callerNumber', 'R3']);
    const own = gate.evaluate({ tool: 'textOwn', params: { textTo: '5555550142' } }, ANONYMOUS, kept, lk);
    expect(own.verdict).toBe('ALLOW');
    expect(own.rules.map((r) => [r.id, r.pass])).toEqual([['identity', true], ['callerNumber', true]]);
    expect(gate.evaluate({ tool: 'textOwn', params: { textTo: '5555550199' } }, ANONYMOUS, kept, lk)).toMatchObject({ verdict: 'BLOCK', reason: NOT_CALLER_NUMBER });
    expect(gate.evaluate({ tool: 'textOwn', params: { textTo: '5555550142' } }, ANONYMOUS, base, lk)).toMatchObject({ verdict: 'BLOCK', reason: NO_CALLER_NUMBER });
    const other = { topic: 'order', textTo: '5555550199' };
    const confirmed = { ...kept, confirmedHash: confirmationHash(other, ['topic', 'textTo']) };
    expect(gate.evaluate({ tool: 'sendUpdates', params: other }, ANONYMOUS, confirmed, lk).verdict).toBe('ALLOW');
    expect(gate.evaluate({ tool: 'sendUpdates', params: other }, ANONYMOUS, kept, lk)).toMatchObject({ verdict: 'BLOCK', reason: NOT_CALLER_NUMBER });
  });
});
