import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { registerApp, resetAppsForTest } from './app/registry';
import type { App, ToolDef } from './app/types';
import { testkitApp } from '../testing/testkit';
import { TESTKIT_TOOLS } from '../testing/testkit/domain/tools';
import { SLOTS } from '../testing/testkit/domain/slots/index';
import { TESTKIT_CUSTOM_RULES } from '../testing/testkit/domain/policy';
import { customerPrincipal } from '../testing/testkit/domain/principals';
import { CUSTOMERS } from '../testing/testkit/domain/data';
import { accountIdOf } from '../testing/testkit/domain/forms';
import { defineIdentity, definePolicy } from '../define/definePolicy';
import { runScenario, type Scenario } from '../harness-text/runner';
import { buildClient, buildThresholds } from '../run/client';
import { defaultCorpusFile } from '../run/fixtures';
import { REGRESS_TODAY } from '../harness-text/baseline';
import { sayText } from '../channel/actions';
import type { TurnRun } from '../run/turn';

/**
 * identity.yaml's level 1 `ways` (docs/designs/2026-10-18-identity-ways.md), on the testkit: its account
 * number and date of birth, or, as a second way, a day the caller names (a test's own way, checked by a
 * test tool that knows one day).
 */

const DIR = fileURLToPath(new URL('../testing/testkit/', import.meta.url));
const policyYaml = parse(readFileSync(`${DIR}policy.yaml`, 'utf8')) as { actions: Record<string, unknown> };
const identityYaml = parse(readFileSync(`${DIR}identity.yaml`, 'utf8')) as { levels: Record<string, Record<string, unknown>> };

/** The second way's check: the day the parcel was due (2026-09-15, "last tuesday" from 2026-09-18) proves Alex. */
const verifyByDay: ToolDef = {
  params: ['expectedDate'],
  run: (call) => (call.params.expectedDate === '2026-09-15'
    ? { value: { ok: true, principal: customerPrincipal(CUSTOMERS[0]!, 1) }, summary: 'verified' }
    : { value: { ok: false }, summary: 'no match' }),
};

function withWays(): App {
  const tools = { ...TESTKIT_TOOLS, verifyByDay };
  const policy = { ...policyYaml, actions: { ...policyYaml.actions, verifyByDay: { say: 'check the day a parcel was due', level: 0, rules: ['attempts'] } } };
  const { factors: _f, verify: _v, ...one } = identityYaml.levels['1']!;
  const identity = {
    ...identityYaml,
    levels: { ...identityYaml.levels, 1: { ...one, ways: [{ factors: ['accountId', 'dob'], verify: 'verifyCustomer' }, { factors: ['expectedDate'], verify: 'verifyByDay', say: 'way_by_day' }] } },
  };
  const manifest = { ...testkitApp.prompts.manifest, way_by_day: { text: 'No problem, I can find it by the day it was due.', interruptible: false } };
  return {
    ...testkitApp,
    tools,
    policy: definePolicy(policy, { identity, tools, slots: SLOTS, customRules: TESTKIT_CUSTOM_RULES }),
    identity: defineIdentity(identity, { policy, tools, slots: SLOTS, prompts: manifest, sendCodeParams: (s) => ({ accountId: accountIdOf(s) }) }),
    prompts: { ...testkitApp.prompts, manifest },
  };
}

async function call(app: App, steps: Scenario['steps']): Promise<TurnRun[]> {
  resetAppsForTest();
  registerApp(app);
  const thresholds = buildThresholds([]);
  const opts = { client: buildClient('stub', defaultCorpusFile(), thresholds, REGRESS_TODAY), thresholds, todayIso: REGRESS_TODAY, now: () => 0 };
  return (await runScenario({ id: 'ways', steps, expect: {} } as Scenario, opts)).runs;
}

const promptOf = (run: TurnRun): string | undefined => (run.result.decision.kind === 'prompt' ? run.result.decision.promptId : undefined);
const ASK = { say: 'i want to book a delivery window' };

describe('more than one way to prove level 1', () => {
  it('compiles each way, its factors among the identity factors, and lists every way\'s check as an identity tool', () => {
    const app = withWays();
    expect(app.identity!.ways!.map((w) => [w.factorSlots, w.verifyTool, w.sayPromptId])).toEqual([[['accountId', 'dob'], 'verifyCustomer', undefined], [['expectedDate'], 'verifyByDay', 'way_by_day']]);
    expect(app.identity!.factorSlots).toEqual(['accountId', 'dob', 'expectedDate']);
    expect(app.identity!.verifyTool).toBe('verifyCustomer');
  });

  it('asks the first way, and verifies by it as before', async () => {
    const runs = await call(withWays(), [ASK, { say: 'five five five zero one two three four' }, { say: 'april twelfth nineteen eighty five' }]);
    expect(promptOf(runs[1]!)).toBe('ask_accountId');
    expect(runs.at(-1)!.result.session.principal.level).toBe(1);
    expect(runs.at(-1)!.result.gateEvents.some((e) => e.decision.call.tool === 'verifyCustomer' && e.decision.verdict === 'ALLOW')).toBe(true);
  });

  it('moves a caller who misses the first way\'s question to the next, with its line and no attempt counted, and verifies by it', async () => {
    const runs = await call(withWays(), [ASK, { say: "i don't have it with me" }, { say: 'last tuesday' }]);
    const moved = runs[2]!;
    expect(promptOf(moved)).toBe('ask_expectedDate');
    expect(sayText(moved.result.actions)).toMatch(/^No problem, I can find it by the day it was due\. /);
    expect(moved.result.session.slots.accountId!.attempts).toBe(0);
    const last = runs.at(-1)!;
    expect(last.result.session.principal.level).toBe(1);
    expect(last.result.gateEvents.some((e) => e.decision.call.tool === 'verifyByDay' && e.decision.verdict === 'ALLOW')).toBe(true);
    expect(last.result.session.identityWay).toBeUndefined();
  });

  it('asks the way again after a failed check, from its first factor', async () => {
    const runs = await call(withWays(), [ASK, { say: "i don't have it with me" }, { say: 'yesterday' }]);
    const last = runs.at(-1)!;
    expect(promptOf(last)).toBe('ask_expectedDate');
    expect(sayText(last.result.actions)).toContain("I couldn't match");
    expect(last.result.session.principal.level).toBe(0);
  });

  it('refuses ways with factors too, and ways with callerId', () => {
    const bad = { ...identityYaml, levels: { ...identityYaml.levels, 1: { ...identityYaml.levels['1'], ways: [{ factors: ['accountId'], verify: 'verifyCustomer' }, { factors: ['dob'], verify: 'verifyCustomer' }] } } };
    expect(() => defineIdentity(bad, { policy: policyYaml, tools: TESTKIT_TOOLS, slots: SLOTS })).toThrow(/both ways and factors/);
  });
});
