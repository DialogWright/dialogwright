import { describe, expect, it } from 'vitest';
import { useTestkit } from '../testing/apps';
import { testkitApp } from '../testing/testkit';
import { TESTKIT_POLICY } from '../testing/testkit/domain/policy';
import { CUSTOMERS, STAFF } from '../testing/testkit/domain/data';
import { agentPrincipal, customerPrincipal } from '../testing/testkit/domain/principals';
import { gateOf } from '../core/app/lookup';
import { callTool, handleCodeDigit, newTurnOut, sendCodeAndAsk } from '../core/lifecycle';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { demoTools } from '../core/tools';
import { VOICE_RELAY } from '../channel/caps';
import { compareGateGrid, gateGridInput, gridPrincipals, legacyGateEvaluator } from '../testing/gateGrid';
import { gateEvaluator, legacyGateOf } from '../testing/shadowGate';
import { compiledPolicyOf, identityToolsOf, isBuiltInRuleId, SUBJECT_ONLY_REASON, SUBJECT_RULE_ID } from './compiled';
import { ANONYMOUS } from './principal';
import type { GateFacts, Party, ToolCall } from './types';

/**
 * The identity tools (the verify tool, and the one-time code's two tools) are for the app's subject
 * only: the gate refuses them to any other party before their rules run, and the lifecycle never
 * sends or takes a code for one.
 */

useTestkit();

const facts: GateFacts = { attempts: 0, confirmedHash: null, todayIso: '2026-09-18' };
const tc = () => ({ nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: demoTools() });
const viewer = agentPrincipal(STAFF[0]!);
const visitor: Party = { kind: 'visitor', level: 2, id: 'V-1', first: 'Robin' };
const alex1 = customerPrincipal(CUSTOMERS[0]!, 1);

describe('the identity tools are for the subject', () => {
  const gate = gateOf(testkitApp);
  const lk = testkitApp.systems().lookups;

  it('the app\'s gate knows its identity tools', () => {
    expect(gate.identityTools).toEqual(['verifyCustomer', 'sendCode', 'verifyCode']);
    expect(identityToolsOf(testkitApp.identity!)).toEqual(gate.identityTools);
  });

  it('refuses a party who acts for subjects, and any other party, each identity tool, before its rules', () => {
    for (const p of [viewer, visitor, { ...viewer, level: 1 as const }]) {
      for (const call of <ToolCall[]>[{ tool: 'sendCode', params: { accountId: CUSTOMERS[1]!.id } }, { tool: 'verifyCode', params: {} }, { tool: 'verifyCustomer', params: { accountId: CUSTOMERS[0]!.id, dob: CUSTOMERS[0]!.dob } }]) {
        const d = gate.evaluate(call, p, { ...facts, attempts: 3 }, lk);
        expect(d).toEqual({
          call,
          rules: [{ id: SUBJECT_RULE_ID, description: 'Only the subject proves who they are', compared: `${p.kind} is not a customer: ${call.tool} is for the subject only`, pass: false }],
          verdict: 'BLOCK',
          reason: SUBJECT_ONLY_REASON,
        });
      }
    }
  });

  it('a caller not yet verified and a subject are held to the action\'s rules alone, with no subject line', () => {
    expect(gate.evaluate({ tool: 'verifyCustomer', params: {} }, ANONYMOUS, facts, lk)).toMatchObject({ verdict: 'ALLOW', rules: [{ id: 'attempts', pass: true }] });
    expect(gate.evaluate({ tool: 'sendCode', params: { accountId: CUSTOMERS[0]!.id } }, alex1, facts, lk)).toMatchObject({ verdict: 'ALLOW', rules: [{ id: 'identity' }, { id: 'scope' }] });
    expect(gate.evaluate({ tool: 'verifyCode', params: {} }, alex1, facts, lk).rules.map((r) => r.id)).toEqual(['identity', 'attempts']);
  });

  it('the other actions are not the check\'s: a delegate reads an account as before', () => {
    expect(gate.evaluate({ tool: 'getAccount', params: { accountId: CUSTOMERS[0]!.id } }, viewer, facts, lk)).toMatchObject({ verdict: 'ALLOW' });
  });

  it('a gate given no identity tools keeps none for the subject', () => {
    const bare = compiledPolicyOf(TESTKIT_POLICY, 'customer');
    expect(bare.identityTools).toEqual([]);
    expect(bare.evaluate({ tool: 'sendCode', params: { accountId: CUSTOMERS[0]!.id } }, viewer, facts, lk)).toMatchObject({ verdict: 'ALLOW' });
  });

  it('no app\'s own rule may take the check\'s id', () => {
    expect(isBuiltInRuleId(SUBJECT_RULE_ID)).toBe(true);
  });
});

describe('the lifecycle never sends or takes a code for a party who is not a subject', () => {
  it('a delegate\'s call to the code tool through callTool is refused and recorded', () => {
    const s = newSession('d', 0, VOICE_RELAY, viewer);
    const out = newTurnOut();
    const { decision, value } = callTool(s, { tool: 'sendCode', params: { accountId: CUSTOMERS[0]!.id } }, tc(), out);
    expect(decision).toMatchObject({ verdict: 'BLOCK', reason: SUBJECT_ONLY_REASON });
    expect(value).toBeNull();
    expect(out.gateEvents).toHaveLength(1);
  });

  it('sendCodeAndAsk hands a delegate to a person and texts nothing', () => {
    const s = newSession('d', 0, VOICE_RELAY, viewer);
    const out = newTurnOut();
    expect(sendCodeAndAsk(s, tc(), out, [])).toMatchObject({ kind: 'handoff', reason: 'needs-human' });
    expect(out.gateEvents).toEqual([]);
    expect(s.codeSent).toBe(false);
  });

  it('handleCodeDigit hands a delegate to a person and keeps no digit', () => {
    const s = newSession('d', 0, VOICE_RELAY, viewer);
    const out = newTurnOut();
    expect(handleCodeDigit(s, '4', tc(), out, [])).toMatchObject({ kind: 'handoff', reason: 'needs-human' });
    expect(s.dtmfBuffer).toBe('');
    expect(out.gateEvents).toEqual([]);
  });

  it('a subject is texted the code as before', () => {
    const s = newSession('d', 0, VOICE_RELAY, alex1);
    const out = newTurnOut();
    expect(sendCodeAndAsk(s, tc(), out, [])).toMatchObject({ kind: 'prompt', promptId: 'ask_otp' });
    expect(out.gateEvents[0]!.decision.verdict).toBe('ALLOW');
  });
});

describe('the reference the gate is compared with makes the same check, its one deliberate difference', () => {
  it('the grid has a delegate below level 2, and the gate and the reference agree on every case', () => {
    const input = gateGridInput(testkitApp);
    expect(gridPrincipals(input.matrix).map(([label]) => label)).toContain('delegate:viewer@1');
    expect(compareGateGrid(input, gateEvaluator(testkitApp), legacyGateOf(testkitApp))).toEqual([]);
  });

  it('without the identity, the reference is the legacy evaluator alone, and refuses no delegate the code tool', () => {
    const input = gateGridInput(testkitApp);
    const bare = legacyGateEvaluator({ policy: input.policy, subjectKind: input.subjectKind });
    expect(bare({ tool: 'sendCode', params: { accountId: CUSTOMERS[0]!.id } }, viewer, facts, input.lookups).verdict).toBe('ALLOW');
    expect(legacyGateEvaluator(input)({ tool: 'sendCode', params: { accountId: CUSTOMERS[0]!.id } }, viewer, facts, input.lookups).reason).toBe(SUBJECT_ONLY_REASON);
  });
});
