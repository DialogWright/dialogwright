import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { useTestkit } from '../testing/apps';
import { testkitApp } from '../testing/testkit';
import { TESTKIT_POLICY } from '../testing/testkit/domain/policy';
import { gateOf } from '../core/app/lookup';
import { callTool, newTurnOut } from '../core/lifecycle';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { demoTools } from '../core/tools';
import { VOICE_RELAY } from '../channel/caps';
import type { App, PolicyTables } from '../core/app/types';
import { definePolicy } from '../define/definePolicy';
import { defineRule } from './defineRule';
import { compileGate, compiledPolicyOf, programFromTables, sourceOf, type CompiledPolicy, type PolicySource } from './compiled';
import { confirmationHash, evaluateCall } from './policy';
import type { GateFacts, GateLookups, Party, RuleContext, RuleOutcome } from './types';

/**
 * The gate that reads the policy's named rules: each built-in rule with its own parameters (a role
 * rule's own reason, an action's own confirmed fields), the tables only what an app's own rule reads;
 * the seam the lifecycle asks (gateOf: App.gate, or the policy the tables were compiled from, or the
 * tables read as rules for an app written by hand). The legacy evaluator's cases are run through both
 * gates in policy.test.ts and generic.test.ts; the grids and whole runs in testing/shadowGate.test.ts.
 */

useTestkit();

const facts: GateFacts = { attempts: 0, confirmedHash: null, todayIso: '2026-10-02' };
const lookups: GateLookups = {
  ownerOf: (r) => ({ 'B-1': 'P-1', 'B-2': 'P-2' } as Record<string, string>)[r] ?? null,
  scopeOf: (p) => (p.level === 0 ? [] : p.kind === 'patient' ? [p.id] : ['P-1', 'P-2']),
};
const patient: Party = { kind: 'patient', level: 2, id: 'P-1', first: 'Avery' };
const staff = (role: string): Party => ({ kind: 'staff', level: 2, id: 'S-1', first: 'Quinn', role });

/** A small policy whose two role rules hand a call to a person for reasons of their own. */
const IDENTITY = {
  principals: { subject: 'patient', delegates: { staff: { roles: ['viewer', 'clerk', 'scribe'] } } },
  levels: {
    1: { name: 'verified', factors: ['patientId'], verify: 'checkFactors' },
    2: { name: 'confirmed by code', factors: [{ otp: { length: 6 } }], send: 'sendCode', verify: 'checkCode' },
  },
  attempts: 4,
};
const ACTIONS = {
  fileRequest: { level: 2, rules: ['identity', { role: { viewer: 'refuse', clerk: 'person', reason: 'staff-filing' } }, { scope: { param: 'patientId' } }, { confirmed: ['patientId', 'note'] }] },
  cancelVisit: { level: 2, rules: ['identity', { role: { clerk: 'allow', scribe: 'person', reason: 'staff-cancel' } }, { scope: { record: 'visit' } }, { confirmed: ['patientId', 'note'] }] },
  checkFactors: { level: 0, rules: ['attempts'] },
  sendCode: { level: 1, rules: ['identity'] },
  checkCode: { level: 1, rules: ['identity', 'attempts'] },
};
const TOOLS = { fileRequest: { params: ['patientId', 'note'] }, cancelVisit: { params: ['visit', 'patientId', 'note'] }, checkFactors: { params: ['patientId'] }, sendCode: { params: [] }, checkCode: { params: [] } };
const tables = (): PolicyTables => definePolicy({ actions: ACTIONS, audit: { visit: 'keep' } }, { identity: IDENTITY, tools: TOOLS, slots: { patientId: { redact: 'last4' }, note: { redact: 'length' } } });

describe('the compiled gate reads each rule\'s own parameters', () => {
  it('a role rule hands the call to a person for its own reason (Decision 4); the tables keep the first', () => {
    const policy = tables();
    const gate = compiledPolicyOf(policy, 'patient');
    expect(policy.rolePersonReason).toBe('staff-filing');
    const file = gate.evaluate({ tool: 'fileRequest', params: { patientId: 'P-2', note: 'x' } }, staff('clerk'), facts, lookups);
    const cancel = gate.evaluate({ tool: 'cancelVisit', params: { visit: 'B-2', note: 'x' } }, staff('scribe'), facts, lookups);
    expect(file).toMatchObject({ verdict: 'NEEDS_HUMAN', reason: 'staff-filing' });
    expect(cancel).toMatchObject({ verdict: 'NEEDS_HUMAN', reason: 'staff-cancel' });
    expect(cancel.rules.at(-1)).toEqual({ id: 'R5', description: 'The caller\'s role allows this action', compared: 'role scribe may cancelVisit: with a person', pass: false });
    // The legacy evaluator over the tables has the one reason: this is where the two part, deliberately.
    expect(evaluateCall({ tool: 'cancelVisit', params: { visit: 'B-2', note: 'x' } }, staff('scribe'), facts, lookups, policy, 'patient')).toMatchObject({ reason: 'staff-filing' });
  });

  it('a confirmed rule compares its own fields; an attempts rule the identity file\'s maximum', () => {
    const own: PolicySource = {
      actions: {
        write: { level: 0, rules: [{ rule: 'confirmed', fields: ['a', 'b'] }] },
        other: { level: 0, rules: [{ rule: 'confirmed', fields: ['c'] }] },
        check: { level: 0, rules: [{ rule: 'attempts' }] },
      },
      purposes: {},
      maxAttempts: 4,
    };
    const gate = compileGate(own, TESTKIT_POLICY, 'patient');
    const write = { tool: 'write', params: { a: '1', b: '2' } };
    expect(gate.evaluate(write, patient, { ...facts, confirmedHash: confirmationHash(write.params, ['a', 'b']) }, lookups).verdict).toBe('ALLOW');
    const other = { tool: 'other', params: { c: '3' } };
    expect(gate.evaluate(other, patient, { ...facts, confirmedHash: confirmationHash(other.params, ['c']) }, lookups).verdict).toBe('ALLOW');
    expect(gate.evaluate(other, patient, { ...facts, confirmedHash: confirmationHash(write.params, ['a', 'b']) }, lookups).rules.at(-1)).toMatchObject({ id: 'R3', compared: 'confirmed hash != call hash' });
    expect(gate.evaluate({ tool: 'check', params: {} }, patient, { ...facts, attempts: 3 }, lookups).rules).toEqual([{ id: 'R6', description: 'Identity attempts under the limit', compared: 'attempts 3 < 4', pass: true }]);
    expect(gate.evaluate({ tool: 'check', params: {} }, patient, { ...facts, attempts: 4 }, lookups)).toMatchObject({ verdict: 'NEEDS_HUMAN', reason: 'attempts' });
    expect(compiledPolicyOf(tables(), 'patient').source.maxAttempts).toBe(4);
  });

  it('an action\'s level and the purposes; an unlisted action is R0, also one named after an object property', () => {
    const gate = compileGate({ actions: { read: { level: 1, rules: [{ rule: 'identity' }] } }, purposes: { deep: 2 }, maxAttempts: 3 }, TESTKIT_POLICY, 'patient');
    const one = { ...patient, level: 1 as const };
    expect(gate.evaluate({ tool: 'read', params: {} }, one, facts, lookups).verdict).toBe('ALLOW');
    expect(gate.evaluate({ tool: 'read', params: {}, purpose: 'deep' }, one, facts, lookups)).toMatchObject({ verdict: 'STEP_UP', needLevel: 2 });
    expect(gate.evaluate({ tool: 'read', params: {}, purpose: 'constructor' }, one, facts, lookups).verdict).toBe('ALLOW');
    for (const tool of ['write', 'constructor', '__proto__']) {
      expect(gate.evaluate({ tool, params: {} }, one, facts, lookups)).toEqual({
        call: { tool, params: {} }, verdict: 'BLOCK', reason: 'unknown-tool', rules: [{ id: 'R0', description: 'The action is on the approved list', compared: `tool ${tool} not in policy`, pass: false }],
      });
    }
  });

  it('fails closed: a custom rule the app does not define, one that throws, one whose answer does not hold together', () => {
    const thrower = (): RuleOutcome => { throw new Error('down'); };
    const invalid = (() => ({ result: { id: 'mine', description: 'd', compared: 'c', pass: false } })) as unknown as (c: RuleContext) => RuleOutcome;
    const source = (rule: string): PolicySource => ({ actions: { act: { level: 0, rules: [{ rule: 'identity' }, { rule: 'custom', id: rule }] } }, purposes: {}, maxAttempts: 3, customRules: { thrower, invalid } });
    const decide = (rule: string) => compileGate(source(rule), TESTKIT_POLICY, 'patient').evaluate({ tool: 'act', params: {} }, patient, facts, lookups);
    expect(decide('ghost')).toMatchObject({ verdict: 'BLOCK', reason: 'unknown-rule' });
    expect(decide('ghost').rules.at(-1)).toEqual({ id: 'ghost', description: 'A rule the gate knows', compared: 'rule ghost unknown', pass: false });
    expect(decide('thrower')).toMatchObject({ verdict: 'BLOCK', reason: 'rule-error' });
    expect(decide('thrower').rules.at(-1)).toEqual({ id: 'thrower', description: 'A rule the gate could run', compared: 'rule thrower threw', pass: false });
    expect(decide('invalid')).toMatchObject({ verdict: 'BLOCK', reason: 'rule-invalid' });
    expect(decide('invalid').rules.at(-1)).toEqual({ id: 'invalid', description: 'A rule that answers as the gate needs', compared: 'rule invalid answered invalidly', pass: false });
  });

  it('an app\'s own rule reads the tables the policy compiled to, as RuleContext.policy', () => {
    let seen: PolicyTables | null = null;
    const peek = defineRule({
      id: 'peek',
      description: 'd',
      run: (c) => {
        seen = c.policy;
        return c.call.params.refuse === undefined ? { pass: true, compared: 'c' } : { pass: false, compared: 'c', verdict: 'BLOCK', reason: 'refused' };
      },
      examples: [
        { name: 'a call', call: { params: {} }, principal: patient, expect: { verdict: 'ALLOW' } },
        { name: 'a call it refuses', call: { params: { refuse: 'yes' } }, principal: patient, expect: { verdict: 'BLOCK', reason: 'refused' } },
      ],
    });
    const policy = definePolicy({ actions: { act: { level: 0, rules: [{ custom: 'peek' }] } } }, { tools: { act: { params: [] } }, customRules: { peek } });
    expect(compiledPolicyOf(policy, '').evaluate({ tool: 'act', params: {} }, patient, facts, lookups).verdict).toBe('ALLOW');
    expect(seen).toBe(policy);
  });
});

describe('the seam', () => {
  it('compiled tables carry the rules they were compiled from, and are frozen so the two cannot drift', () => {
    const source = sourceOf(TESTKIT_POLICY)!;
    expect(source).not.toBeNull();
    expect(source.actions.createReport!.rules.map((r) => r.rule)).toEqual(['identity', 'role', 'scope', 'confirmed', 'custom']);
    expect(gateOf(testkitApp).source).toBe(source);
    expect(gateOf(testkitApp)).toBe(compiledPolicyOf(TESTKIT_POLICY, 'customer'));
    expect(Object.isFrozen(TESTKIT_POLICY) && Object.isFrozen(TESTKIT_POLICY.toolLevel) && Object.isFrozen(TESTKIT_POLICY.rulesFor)).toBe(true);
    expect(() => { (TESTKIT_POLICY.toolLevel as Record<string, number>).getAccount = 2; }).toThrow(TypeError);
  });

  it('tables written by hand, or compiled tables copied and changed, are read as the rules they say', () => {
    const changed: PolicyTables = { ...TESTKIT_POLICY, toolLevel: { ...TESTKIT_POLICY.toolLevel, getAccount: 2 } };
    expect(sourceOf(changed)).toBeNull();
    expect(compiledPolicyOf(changed, 'customer').source).toEqual(programFromTables(changed));
    const one = { kind: 'customer', level: 1 as const, id: '55501234', first: 'Alex' };
    const call = { tool: 'getAccount', params: { accountId: '55501234' } };
    expect(compiledPolicyOf(TESTKIT_POLICY, 'customer').evaluate(call, one, facts, lookups).rules[0]).toMatchObject({ id: 'R1', pass: true });
    expect(compiledPolicyOf(changed, 'customer').evaluate(call, one, facts, lookups)).toMatchObject({ verdict: 'STEP_UP', needLevel: 2 });
  });

  it('the lifecycle asks the app\'s gate: App.gate when the app has one', () => {
    const calls: string[] = [];
    const own = gateOf(testkitApp);
    const gate: CompiledPolicy = { ...own, evaluate: (call, p, f, lk) => { calls.push(call.tool); return own.evaluate(call, p, f, lk); } };
    const app: App = { ...testkitApp, gate };
    resetAppsForTest();
    try {
      registerApp(app);
      const s = newSession('seam', 0, VOICE_RELAY);
      const out = newTurnOut();
      callTool(s, { tool: 'getAccount', params: { accountId: '55501234' } }, { nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: demoTools() }, out);
      expect(calls).toEqual(['getAccount']);
      expect(out.gateEvents[0]!.decision).toMatchObject({ verdict: 'STEP_UP', needLevel: 1, call: { tool: 'getAccount', params: { accountId: '...1234' } } });
    } finally {
      useTestkit();
    }
  });

  it('imports only from ./lines, ./bounded, ./principal and ./types; anything else is type-only (and ./bounded only from ./principal and ./types)', () => {
    const runtime: Record<string, readonly string[]> = { './compiled.ts': ['./lines', './bounded', './principal', './types'], './bounded.ts': ['./principal', './types'] };
    for (const [file, allowed] of Object.entries(runtime)) {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8');
      const imports = [...src.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+'([^']+)';?\s*$/gm)];
      expect(imports.length).toBeGreaterThan(0);
      for (const m of imports) if (!allowed.includes(m[2]!)) expect(Boolean(m[1]), `${file} ${m[2]}`).toBe(true);
    }
  });
});
