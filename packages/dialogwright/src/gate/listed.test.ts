import { describe, expect, it } from 'vitest';
import { definePolicy } from '../define/definePolicy';
import { compiledPolicyOf } from './compiled';
import { MAX_VALUES_SHOWN, NONE_OF_REASON, noneOfRule, ONE_OF_REASON, oneOfRule, VALUE_MISSING, valuesShown, type ListParams } from './listed';
import { ANONYMOUS } from './principal';
import type { GateFacts, GateLookups, RuleContext } from './types';

/**
 * The list rules (oneOf, noneOf): each outcome, the exact match, the default and the author's reason
 * and verdict, a missing value failing closed, and lines that name the list but never the value. Run
 * directly and through a policy compiled from the file.
 */

const facts: GateFacts = { attempts: 0, confirmedHash: null, todayIso: '2026-10-07' };
const lk: GateLookups = { ownerOf: () => null, scopeOf: () => [] };
const ctx = (params: Record<string, string>): RuleContext => ({ call: { tool: 'checkArea', params }, p: ANONYMOUS, facts, lk, policy: {} as never, subjectKind: '' });

const TOWNS: ListParams = { field: 'town', values: ['millbrook', 'cedar_falls', 'ashford', 'riverton'] };

describe('oneOf', () => {
  it('passes a listed value, and fails any other with its reason, BLOCK by default', () => {
    expect(oneOfRule(TOWNS)(ctx({ town: 'ashford' }))).toEqual({
      result: { id: 'oneOf', description: 'The value in town is one of those listed', compared: 'town one of [millbrook, cedar_falls, ashford, riverton]', pass: true },
    });
    expect(oneOfRule(TOWNS)(ctx({ town: 'elsewhere' }))).toEqual({
      result: { id: 'oneOf', description: 'The value in town is one of those listed', compared: 'town not one of [millbrook, cedar_falls, ashford, riverton]', pass: false },
      fail: { verdict: 'BLOCK', reason: ONE_OF_REASON },
    });
    expect(ONE_OF_REASON).toBe('not-one-of');
  });

  it('gives the author\'s reason and verdict', () => {
    const rule = oneOfRule({ ...TOWNS, reason: 'out-of-area', verdict: 'NEEDS_HUMAN' });
    expect(rule(ctx({ town: 'elsewhere' })).fail).toEqual({ verdict: 'NEEDS_HUMAN', reason: 'out-of-area' });
    expect(rule(ctx({ town: 'riverton' })).fail).toBeUndefined();
  });

  it('matches exactly: a value in another case or with spaces is not listed', () => {
    for (const town of ['Ashford', 'ASHFORD', ' ashford', 'ashford ', 'cedar falls', 'Cedar Falls']) {
      expect(oneOfRule(TOWNS)(ctx({ town })).result.pass, town).toBe(false);
    }
  });

  it('fails closed on a missing or empty value, BLOCK value-missing, whatever its own verdict', () => {
    const rule = oneOfRule({ ...TOWNS, reason: 'out-of-area', verdict: 'NEEDS_HUMAN' });
    for (const params of [{}, { town: '' }, { other: 'ashford' }] as Record<string, string>[]) {
      expect(rule(ctx(params))).toMatchObject({ result: { compared: 'town missing', pass: false }, fail: { verdict: 'BLOCK', reason: VALUE_MISSING } });
    }
    // Only the call's own param: one inherited from Object.prototype is not there.
    expect(oneOfRule({ field: 'toString', values: ['x'] })(ctx({})).fail).toEqual({ verdict: 'BLOCK', reason: VALUE_MISSING });
  });
});

describe('noneOf', () => {
  const URGENT: ListParams = { field: 'howUrgent', values: ['urgent'], reason: 'urgent', verdict: 'NEEDS_HUMAN' };

  it('passes a value it does not list, and fails a listed one with its reason and verdict', () => {
    expect(noneOfRule(URGENT)(ctx({ howUrgent: 'routine' }))).toEqual({
      result: { id: 'noneOf', description: 'The value in howUrgent is none of those listed', compared: 'howUrgent none of [urgent]', pass: true },
    });
    expect(noneOfRule(URGENT)(ctx({ howUrgent: 'urgent' }))).toEqual({
      result: { id: 'noneOf', description: 'The value in howUrgent is none of those listed', compared: 'howUrgent one of [urgent]', pass: false },
      fail: { verdict: 'NEEDS_HUMAN', reason: 'urgent' },
    });
    expect(noneOfRule({ field: 'howUrgent', values: ['urgent'] })(ctx({ howUrgent: 'urgent' })).fail).toEqual({ verdict: 'BLOCK', reason: NONE_OF_REASON });
    expect(NONE_OF_REASON).toBe('one-of');
  });

  it('never passes a call without the value: saying nothing is not "none of these"', () => {
    expect(noneOfRule(URGENT)(ctx({})).fail).toEqual({ verdict: 'BLOCK', reason: VALUE_MISSING });
    expect(noneOfRule(URGENT)(ctx({ howUrgent: '' })).fail).toEqual({ verdict: 'BLOCK', reason: VALUE_MISSING });
  });
});

describe('the lines', () => {
  it('name the field and the list, never the value', () => {
    const secret = 'a value the app records hidden';
    for (const run of [oneOfRule(TOWNS), noneOfRule(TOWNS)]) expect(JSON.stringify(run(ctx({ town: secret })))).not.toContain(secret);
  });

  it('show a long list by its first values and how many more', () => {
    const many = Array.from({ length: MAX_VALUES_SHOWN + 3 }, (_, i) => `v${i}`);
    expect(valuesShown(many)).toBe(`[${many.slice(0, MAX_VALUES_SHOWN).join(', ')}, and 3 more]`);
    expect(valuesShown(['a'])).toBe('[a]');
  });
});

describe('through a compiled policy', () => {
  it('records each under its name, in the order written, and the first that fails decides', () => {
    const tables = definePolicy({
      actions: {
        bookVisit: {
          level: 0,
          rules: [
            'identity',
            { noneOf: { field: 'howUrgent', values: ['urgent'], reason: 'urgent', verdict: 'NEEDS_HUMAN' } },
            { oneOf: { field: 'ownership', values: ['own'], reason: 'not-owner' } },
            { oneOf: { field: 'town', values: ['millbrook', 'ashford'], reason: 'out-of-area' } },
          ],
        },
      },
    }, { tools: { bookVisit: { params: ['howUrgent', 'ownership', 'town'] } } });
    expect(tables.rulesFor.bookVisit).toEqual(['R1', 'noneOf', 'oneOf', 'oneOf']);
    const gate = compiledPolicyOf(tables, '');
    const decide = (params: Record<string, string>) => gate.evaluate({ tool: 'bookVisit', params }, ANONYMOUS, facts, lk);
    const ok = decide({ howUrgent: 'routine', ownership: 'own', town: 'ashford' });
    expect(ok.verdict).toBe('ALLOW');
    expect(ok.rules.map((r) => r.id)).toEqual(['identity', 'noneOf', 'oneOf', 'oneOf']);
    expect(decide({ howUrgent: 'urgent', ownership: 'rent', town: 'elsewhere' })).toMatchObject({ verdict: 'NEEDS_HUMAN', reason: 'urgent' });
    expect(decide({ howUrgent: 'routine', ownership: 'rent', town: 'elsewhere' })).toMatchObject({ verdict: 'BLOCK', reason: 'not-owner' });
    expect(decide({ howUrgent: 'routine', ownership: 'own', town: 'elsewhere' })).toMatchObject({ verdict: 'BLOCK', reason: 'out-of-area' });
    expect(decide({ howUrgent: 'routine', ownership: 'own' })).toMatchObject({ verdict: 'BLOCK', reason: 'value-missing' });
  });
});
