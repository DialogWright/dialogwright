import { describe, expect, it } from 'vitest';
import { ANONYMOUS } from '../gate/principal';
import { compiledPolicyOf } from '../gate/compiled';
import { confirmationHash, evaluateCall } from '../gate/policy';
import type { GateLookups } from '../gate/types';
import { compareGateGrid, gateGridCases } from '../testing/gateGrid';
import { compilePolicy } from './policyFile';
import { SCHEMAS } from './schema/index';

/**
 * Each action's own confirmed fields (PolicyTables.confirmedBy): the legacy evaluator's confirmed rule
 * and the gate grid read them where a policy's actions confirm different lists (each form's read-back
 * confirms its own action), and a policy whose actions share one list keeps its tables as they were.
 */

const lookups: GateLookups = { ownerOf: () => null, scopeOf: () => [] };
const facts = { attempts: 0, todayIso: '2026-11-09' };
const two = SCHEMAS.policy.parse({
  actions: {
    placeHold: { say: 'place the hold', level: 0, rules: ['identity', { confirmed: ['title', 'day'] }] },
    noteCallback: { say: 'leave a callback note', level: 0, rules: ['identity', { confirmed: ['callbackNumber'] }] },
  },
  audit: { title: 'keep', day: 'keep', callbackNumber: 'last4' },
});

describe('per-action confirmed fields', () => {
  it('the tables carry each action\'s own list only where the lists differ', () => {
    expect(compilePolicy(two).confirmedBy).toEqual({ placeHold: ['title', 'day'], noteCallback: ['callbackNumber'] });
    const one = SCHEMAS.policy.parse({ actions: { a: { level: 0, rules: [{ confirmed: ['x'] }] }, b: { level: 0, rules: [{ confirmed: ['x'] }] } }, audit: { x: 'keep' } });
    expect(compilePolicy(one).confirmedBy).toBeUndefined();
    expect(compilePolicy(one).confirmedFields).toEqual(['x']);
  });

  it('the legacy evaluator\'s confirmed rule (R3) reads the action\'s own list, as the gate does', () => {
    const tables = compilePolicy(two);
    const call = { tool: 'noteCallback', params: { callbackNumber: '5555550144' } };
    const confirmedHash = confirmationHash(call.params, ['callbackNumber']);
    expect(evaluateCall(call, ANONYMOUS, { ...facts, confirmedHash }, lookups, tables, '').verdict).toBe('ALLOW');
    expect(compiledPolicyOf(tables, '').evaluate(call, ANONYMOUS, { ...facts, confirmedHash }, lookups).verdict).toBe('ALLOW');
  });

  it('the gate grid builds and confirms each action\'s calls with its own list, and the two evaluators agree', () => {
    const tables = compilePolicy(two);
    const input = {
      policy: tables, subjectKind: '', lookups, tools: ['placeHold', 'noteCallback'],
      matrix: {
        principals: { subject1: { kind: 'member', level: 1, id: 'a', first: 'Avery' }, subject2: { kind: 'member', level: 2, id: 'a', first: 'Avery' }, delegates: {}, unlistedRole: { kind: 'staff', level: 2, id: 'S-1', first: 'Quinn', role: 'assistant' }, roleless: { kind: 'staff', level: 2, id: 'S-2', first: 'Rowan' }, otherParty: { kind: 'visitor', level: 2, id: 'V-1', first: 'Robin' } },
        records: { own: { subject: 'a' }, inScope: { subject: 'b' }, outOfScope: { subject: 'c' }, unknown: { subject: 'd' } },
      },
    } as never;
    const allowed = gateGridCases(input).filter((c) => c.tool === 'noteCallback' && c.fields === 'exact' && c.confirmation === 'match');
    expect(allowed.length).toBeGreaterThan(0);
    for (const c of allowed) expect(Object.keys(c.call.params)).toEqual(['callbackNumber']);
    expect(compareGateGrid(input, (c, p, f, lk) => compiledPolicyOf(tables, '').evaluate(c, p, f, lk))).toEqual([]);
  });
});
