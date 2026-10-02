import { beforeAll, describe, expect, it } from 'vitest';
import { serviceResultEvent } from '../../channel/events';
import { useTestkit } from '../../testing/apps';
import { testkitApp } from '../../testing/testkit';
import { CUSTOMERS, STAFF } from '../../testing/testkit/domain/data';
import { agentPrincipal, customerPrincipal } from '../../testing/testkit/domain/principals';
import { callTool, ensureEntry, newTurnOut, sendCodeAndAsk, takeSummaryHash, verifyFactors } from '../lifecycle';
import { cloneSession, closeForm, newSession, setForm } from '../session';
import { DEFAULT_THRESHOLDS } from '../thresholds';
import { demoTools } from '../tools';
import { resolve, slotContext, type TurnContext } from '../turn';
import type { Ack } from '../fia';
import { registerApp } from './registry';
import type { App } from './types';
import { WEB_CHAT, VOICE_RELAY } from '../../channel/caps';

/**
 * The engine's defaults where an app leaves a hook out, run against a small app that is not the testkit:
 * one form with a summary and none of the optional hooks, no onServiceResult, and its identity
 * factors in the other order. Its policy, systems, prompts and slot specs are the testkit's, and its tools
 * the testkit's but for getAccount, so a test can see a call run the app's own tool. The gate reads its
 * policy (the testkit's tables) from the app.
 */
useTestkit();

const fake: App = {
  id: 'fake',
  intents: {
    agent: { criteria: '', label: 'agent', kind: 'control' },
    repeat_prompt: { criteria: '', label: 'repeat', kind: 'control' },
    done: { criteria: '', label: 'done', kind: 'control' },
    look: { criteria: '', label: 'look something up', kind: 'form' },
  },
  menu: [],
  forms: {
    look: {
      slots: ['missingNote'],
      summaryPromptId: 'confirm_report',
      entry: () => ({ tool: 'getAccount', params: { accountId: '' }, purpose: 'look' }),
      complete: ({ acks }) => ({ kind: 'said', acks }),
    },
  },
  slots: { dob: testkitApp.slots.dob!, accountId: testkitApp.slots.accountId!, missingNote: testkitApp.slots.missingNote! },
  identity: { subjectKind: 'customer', factorSlots: ['dob', 'accountId'], verifyTool: 'verifyCustomer', codeTool: 'verifyCode', sendCodeTool: 'sendCode' },
  tools: { ...testkitApp.tools, getAccount: { run: () => ({ value: null, summary: 'the fake app\'s account' }) } },
  policy: testkitApp.policy,
  systems: testkitApp.systems,
  prompts: testkitApp.prompts,
};

/** The fake app with the identity and refusal hooks set, each to something the testkit would not say. */
const fakeHooked: App = {
  ...fake,
  id: 'fake-hooked',
  identity: { ...fake.identity!, sendCodeParams: () => ({ accountId: CUSTOMERS[0]!.id }), failedPromptId: 'otp_failed' },
  blockPromptId: (reason) => (reason === 'scope' ? 'report_blocked_role' : null),
};

/** The fake app with a verify tool that answers `value` on any factors. */
const verifiesAs = (id: string, value: unknown): App => ({ ...fake, id, tools: { ...fake.tools, verifyCustomer: { run: () => ({ value, summary: 'verified' }) } } });


/** The fake app with its one-time code checked by a tool of another name. */
const fakePin: App = {
  ...fake,
  id: 'fake-pin',
  identity: { ...fake.identity!, codeTool: 'checkPin' },
  tools: { ...fake.tools, checkPin: testkitApp.tools.verifyCode! },
  policy: { ...fake.policy, toolLevel: { ...fake.policy.toolLevel, checkPin: 1 }, rulesFor: { ...fake.policy.rulesFor, checkPin: ['R1', 'R6'] } },
};

beforeAll(() => {
  for (const app of [
    fake,
    fakeHooked,
    verifiesAs('fake-level2', { ok: true, principal: customerPrincipal(CUSTOMERS[0]!, 2) }),
    verifiesAs('fake-agent', { ok: true, principal: agentPrincipal(STAFF[0]!) }),
    verifiesAs('fake-novalue', undefined),
    verifiesAs('fake-noid', { ok: true, principal: { kind: 'customer', level: 1, id: '', first: 'Alex' } }),
    verifiesAs('fake-notparty', { ok: true, principal: { kind: 'customer', level: 1, first: 'Alex' } }),
    fakePin,
  ]) registerApp(app);
});

const tc = (): TurnContext => ({ nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: demoTools() });

describe('tool dispatch', () => {
  it('runs the session\'s app\'s own tool once the gate allows the call', () => {
    const s = newSession('f', 0, VOICE_RELAY, customerPrincipal(CUSTOMERS[0]!, 1), 'fake');
    const out = newTurnOut();
    const { decision, value } = callTool(s, { tool: 'getAccount', params: { accountId: CUSTOMERS[0]!.id } }, tc(), out);
    expect([decision.verdict, value]).toEqual(['ALLOW', null]);
    expect(out.gateEvents[0]!.summary).toBe('the fake app\'s account');
  });
});

describe('app hooks left out', () => {
  it('a form with no principalEntry makes its entry call for a non-subject principal, and the gate decides', () => {
    const s = newSession('f', 0, WEB_CHAT, agentPrincipal(STAFF[0]!), 'fake');
    setForm(s, 'look');
    const out = newTurnOut();
    ensureEntry(s, tc(), out, []);
    expect(out.gateEvents.map((e) => [e.decision.call.tool, e.decision.call.purpose])).toEqual([['getAccount', 'look']]);
  });

  it('a form with a summary but no confirmedParams holds no confirmation', () => {
    const s = newSession('f', 0, VOICE_RELAY, undefined, 'fake');
    setForm(s, 'look');
    s.pendingHash = 'left over';
    takeSummaryHash(s, 'look');
    expect(s.pendingHash).toBeNull();
  });

  it('an agent answer is ignored, and still awaited, when the app has no onServiceResult', () => {
    const s = newSession('f', 0, VOICE_RELAY, undefined, 'fake');
    s.pendingService = 'depot';
    const r = resolve(s, serviceResultEvent('depot', { searchDays: 2 }), null, tc());
    expect(r.decision).toEqual({ kind: 'ignore' });
    expect(r.session.pendingService).toBe('depot');
  });

  it('a session\'s facts start empty, are copied whole with it, stay when a form closes, and give the slot specs no parcels', () => {
    const s = newSession('f', 0, VOICE_RELAY, undefined, 'fake');
    expect(s.facts).toEqual({});
    s.facts.seen = { list: ['a'] };
    s.facts.parcels = [{ number: '7101', item: 'a box of books', day: '2026-09-01' }];
    const c = cloneSession(s);
    (c.facts.seen as { list: string[] }).list.push('b');
    expect(s.facts.seen).toEqual({ list: ['a'] });
    setForm(s, 'look');
    closeForm(s);
    expect(Object.keys(s.facts)).toEqual(['seen', 'parcels']);
    // A fact that happens to be named parcels is the app's own: without facts.forSlots, the slot specs get none.
    expect(slotContext(s, '', tc()).records).toEqual([]);
  });

  it('a refused entry call goes to a person when the app has no blockPromptId', () => {
    // The fake entry call names no account, so a verified caller's call fails R2 (scope).
    const s = setForm(newSession('f', 0, VOICE_RELAY, customerPrincipal(CUSTOMERS[0]!, 2), 'fake'), 'look');
    const out = newTurnOut();
    const d = ensureEntry(s, tc(), out, []);
    expect(out.gateEvents[0]!.decision).toMatchObject({ verdict: 'BLOCK', reason: 'scope' });
    expect(d).toMatchObject({ kind: 'handoff', reason: 'needs-human' });
  });

  it('texts the code with no params when the app has no sendCodeParams, and the gate decides', () => {
    const s = newSession('f', 0, VOICE_RELAY, customerPrincipal(CUSTOMERS[0]!, 1), 'fake');
    const out = newTurnOut();
    const d = sendCodeAndAsk(s, tc(), out, []);
    expect(out.gateEvents[0]!.decision).toMatchObject({ call: { tool: 'sendCode', params: {} }, verdict: 'BLOCK' });
    expect(d).toMatchObject({ kind: 'handoff', reason: 'needs-human' });
  });

  it('verifies the identity factors, and asks them again, in the app\'s order', () => {
    const s = newSession('f', 0, VOICE_RELAY, undefined, 'fake');
    s.slots.dob!.value = '1985-04-13';
    s.slots.accountId!.value = '55501234';
    const out = newTurnOut();
    const d = verifyFactors(s, tc(), out, []);
    expect(Object.keys(out.gateEvents[0]!.decision.call.params)).toEqual(['dob', 'accountId']);
    expect(out.gateEvents[0]!.summary).toBe('no match');
    expect(d).toMatchObject({ kind: 'prompt', promptId: 'ask_dob' });
  });
});

describe('app hooks set', () => {
  it('says the app\'s line for a refused entry call', () => {
    const s = setForm(newSession('f', 0, VOICE_RELAY, customerPrincipal(CUSTOMERS[0]!, 2), 'fake-hooked'), 'look');
    const d = ensureEntry(s, tc(), newTurnOut(), []);
    expect(d).toEqual({ kind: 'refused', acks: [{ promptId: 'report_blocked_role', vars: {} }] });
  });

  it('texts the code with the app\'s params', () => {
    const s = newSession('f', 0, VOICE_RELAY, customerPrincipal(CUSTOMERS[0]!, 1), 'fake-hooked');
    const out = newTurnOut();
    const d = sendCodeAndAsk(s, tc(), out, []);
    expect(out.gateEvents[0]!.decision).toMatchObject({ call: { tool: 'sendCode', params: { accountId: '...1234' } }, verdict: 'ALLOW' });
    expect(d).toMatchObject({ kind: 'prompt', promptId: 'ask_otp' });
    expect(s.codeSent).toBe(true);
  });

  it('says the app\'s line before asking the factors again', () => {
    const s = newSession('f', 0, VOICE_RELAY, undefined, 'fake-hooked');
    s.slots.dob!.value = '1985-04-13';
    s.slots.accountId!.value = '55501234';
    const d = verifyFactors(s, tc(), newTurnOut(), []);
    expect(d).toMatchObject({ kind: 'prompt', promptId: 'ask_dob', acks: [{ promptId: 'otp_failed' }] });
    expect(s.identityAttempts).toEqual({ factors: 1, code: 0 });
  });
});

describe('identity checks fail closed', () => {
  const factorsIn = (appId: string) => {
    const s = newSession('f', 0, VOICE_RELAY, undefined, appId);
    s.slots.dob!.value = '1985-04-12';
    s.slots.accountId!.value = '55501234';
    return s;
  };

  for (const [appId, what] of [['fake-level2', 'a principal above level 1'], ['fake-agent', 'a principal of another kind'], ['fake-novalue', 'no value'], ['fake-noid', 'a principal with an empty id'], ['fake-notparty', 'a principal with no id']] as const) {
    it(`hands off, unverified, when the verify tool answers ${what}`, () => {
      const s = factorsIn(appId);
      const acks: Ack[] = [];
      const d = verifyFactors(s, tc(), newTurnOut(), acks);
      expect(d).toMatchObject({ kind: 'handoff', reason: 'needs-human' });
      expect(s.principal).toEqual({ kind: 'anonymous', level: 0 });
      expect(acks).toEqual([]);
    });
  }

  it('caps the attempts at a code tool of any name by the code\'s own count', () => {
    const s = newSession('f', 0, VOICE_RELAY, customerPrincipal(CUSTOMERS[0]!, 1), 'fake-pin');
    s.identityAttempts = { factors: 3, code: 2 };
    expect(callTool(s, { tool: 'checkPin', params: {} }, tc(), newTurnOut(), '123456').decision.verdict).toBe('ALLOW');
    s.identityAttempts = { factors: 0, code: 3 };
    const { decision } = callTool(s, { tool: 'checkPin', params: {} }, tc(), newTurnOut(), '123456');
    expect(decision).toMatchObject({ verdict: 'NEEDS_HUMAN', reason: 'attempts' });
    expect(decision.rules.at(-1)).toMatchObject({ id: 'R6', compared: 'attempts 3 < 3', pass: false });
    // The verify tool is capped by the factors' count, not the code's.
    expect(callTool(s, { tool: 'verifyCustomer', params: {} }, tc(), newTurnOut()).decision.verdict).toBe('ALLOW');
  });
});
