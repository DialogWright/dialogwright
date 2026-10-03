import { describe, expect, it } from 'vitest';
import { gateOf } from '../core/app/lookup';
import { libraryApp } from '../define/fixture/app';
import { compileGate, RULE_ID, type PolicySource, type Rule } from '../gate/compiled';
import { confirmationHash } from '../gate/lines';
import { isAnonymous, type GateDecision, type Level, type RuleContext, type RuleOutcome } from '../gate/types';
import { useTestkit } from './apps';
import type { GateEvaluate } from './gateGrid';
import {
  checkPolicyInvariants, formatPolicyInvariantViolations, INVARIANTS, policyInvariants, PolicyInvariantError, type InvariantName,
} from './policyInvariants';
import { testkitApp } from './testkit';

/**
 * The policy's invariants on the testkit and the library fixture: their gates hold to every one on
 * the whole grid, and on the testkit, whose policy has every kind of rule, each invariant applies to
 * cases (it is not vacuous). Then the anti-tautology test: a gate with one bug per invariant, each a
 * bug the gate's own lines would agree with, is caught by the invariant written for it, and the
 * failure names the invariant, the case and the rule.
 */

useTestkit();

describe('the policy invariants', () => {
  it('hold on the testkit, and every invariant applies to some case', () => {
    const report = policyInvariants(testkitApp);
    expect(report.violations).toEqual([]);
    expect(report.cases).toBe(27648);
    for (const name of INVARIANTS) expect([name, report.applied[name] > 0]).toEqual([name, true]);
  });

  it('hold on the library fixture', () => {
    expect(policyInvariants(libraryApp).violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// A gate with one bug per invariant
// ---------------------------------------------------------------------------------------------

const gate = gateOf(testkitApp);
const SOURCE = gate.source;

/** A gate compiled from the testkit's policy after `change`: the gate as it runs, with one rule replaced. */
function buggy(change: (source: PolicySource) => PolicySource): GateEvaluate {
  const g = compileGate(change(SOURCE), gate.tables, gate.subjectKind);
  return (call, p, facts, lk) => g.evaluate(call, p, facts, lk);
}

/**
 * The policy with every rule called `name` run by `run` instead, recorded under the rule's own id (as
 * a rule of the app's own by that id, which finds the rule as the call's action writes it).
 */
function replace(name: Exclude<Rule['rule'], 'custom'>, run: (c: RuleContext, rule: Rule) => RuleOutcome): (source: PolicySource) => PolicySource {
  return (source) => {
    const id = RULE_ID[name];
    const actions = Object.fromEntries(Object.entries(source.actions).map(([tool, action]) => [tool, {
      ...action,
      rules: action.rules.map((r): Rule => (r.rule === name ? { rule: 'custom', id } : r)),
    }]));
    const rule = (c: RuleContext): RuleOutcome => run(c, source.actions[c.call.tool]!.rules.find((r) => r.rule === name)!);
    return { ...source, actions, customRules: { ...source.customRules, [id]: rule } };
  };
}

/** A broken rule's line (the gate stamps it with the rule's id). */
const line = (pass: boolean, fail?: RuleOutcome['fail']): RuleOutcome => ({ result: { id: '', description: 'a broken rule', compared: 'bug', pass }, ...(fail ? { fail } : {}) });

/** The level a call needs, as the file says: the action's, raised by the call's purpose. */
const levelOf = (c: RuleContext): Level => {
  const action = SOURCE.actions[c.call.tool]!;
  const purpose = c.call.purpose && Object.hasOwn(SOURCE.purposes, c.call.purpose) ? SOURCE.purposes[c.call.purpose]! : 0;
  return Math.max(action.level, purpose) as Level;
};

/** The scope rule as written, but taking its subject from `subjectOf`. */
const scopeWith = (subjectOf: (c: RuleContext, param: string, via: 'record' | undefined) => string | null) => (c: RuleContext, r: Rule): RuleOutcome => {
  if (r.rule !== 'scope' || r.subject === null) return line(false, { verdict: 'BLOCK', reason: 'scope' });
  const who = subjectOf(c, r.subject.param, r.subject.via);
  return who !== null && c.lk.scopeOf(c.p).includes(who) ? line(true) : line(false, { verdict: 'BLOCK', reason: 'scope' });
};

const ownerOrNull = (c: RuleContext, param: string, via: 'record' | undefined): string | null => {
  const named = c.call.params[param] ?? '';
  return (via === 'record' ? (named ? c.lk.ownerOf(named) : null) : named) || null;
};

/** Each invariant, and a gate with the one bug it exists to catch. */
const BUGS: Record<InvariantName, { bug: string; evaluate: GateEvaluate }> = {
  unlisted: {
    bug: 'an action the policy does not list is allowed',
    evaluate: (call, p, facts, lk) => (Object.hasOwn(SOURCE.actions, call.tool) ? gate.evaluate(call, p, facts, lk) : ({ call, verdict: 'ALLOW', rules: [] } satisfies GateDecision)),
  },
  level: {
    bug: 'the identity rule is one level short',
    evaluate: buggy(replace('identity', (c) => (c.p.level + 1 >= levelOf(c) ? line(true) : line(false, { verdict: 'STEP_UP', needLevel: levelOf(c) as 1 | 2 })))),
  },
  scope: {
    bug: 'a record no one owns passes the scope rule',
    evaluate: buggy(replace('scope', scopeWith((c, param, via) => {
      const named = c.call.params[param] ?? '';
      if (via === 'record' && named && c.lk.ownerOf(named) === null) return c.lk.scopeOf(c.p)[0] ?? null;
      return ownerOrNull(c, param, via);
    }))),
  },
  confirmed: {
    bug: 'a call with no confirmation at all passes the confirmed rule',
    evaluate: buggy(replace('confirmed', (c, r) => {
      const fields = r.rule === 'confirmed' ? r.fields : [];
      const sent = Object.keys(c.call.params);
      const exact = sent.length === fields.length && fields.every((f) => sent.includes(f));
      const held = c.facts.confirmedHash;
      return exact && (held === null || held === confirmationHash(c.call.params, fields)) ? line(true) : line(false, { verdict: 'BLOCK', reason: 'confirmation' });
    })),
  },
  role: {
    bug: 'a role the rule sends to a person is let through',
    evaluate: buggy(replace('role', (c, r) => {
      if (isAnonymous(c.p) || c.p.role === undefined) return isAnonymous(c.p) || c.p.kind === gate.subjectKind ? line(true) : line(false, { verdict: 'BLOCK', reason: 'role' });
      const access = r.rule === 'role' && Object.hasOwn(r.access, c.p.role) ? r.access[c.p.role]! : 'refuse';
      return access === 'refuse' ? line(false, { verdict: 'BLOCK', reason: 'role' }) : line(true);
    })),
  },
  fields: {
    bug: 'the fields rule lets any field through',
    evaluate: buggy(replace('fields', () => line(true))),
  },
  attempts: {
    bug: 'the attempts rule allows one try too many',
    evaluate: buggy(replace('attempts', (c) => (c.facts.attempts <= SOURCE.maxAttempts ? line(true) : line(false, { verdict: 'NEEDS_HUMAN', reason: 'attempts' })))),
  },
  'all-rules-passed': {
    bug: 'the gate skips the app\'s own rules',
    evaluate: buggy((source) => ({ ...source, actions: Object.fromEntries(Object.entries(source.actions).map(([tool, a]) => [tool, { ...a, rules: a.rules.filter((r) => r.rule !== 'custom') }])) })),
  },
  monotonic: {
    bug: 'the identity rule wants exactly the action\'s level, so a caller above it is stepped up',
    evaluate: buggy(replace('identity', (c) => (c.p.level === levelOf(c) ? line(true) : line(false, { verdict: 'STEP_UP', needLevel: Math.max(1, levelOf(c)) as 1 | 2 })))),
  },
  'scope-stable': {
    bug: 'the scope rule takes the subject from the session\'s slots when they name one',
    evaluate: buggy(replace('scope', scopeWith((c, param, via) => {
      const slots = (c.facts as unknown as { slots?: Record<string, string> }).slots;
      if (slots && Object.hasOwn(slots, param)) return via === 'record' ? c.lk.ownerOf(slots[param]!) : slots[param]!;
      return ownerOrNull(c, param, via);
    }))),
  },
};

describe('the policy invariants catch a broken gate (anti-tautology)', () => {
  for (const name of INVARIANTS) {
    const { bug, evaluate } = BUGS[name];
    it(`${name}: ${bug}`, () => {
      const { violations } = checkPolicyInvariants(testkitApp, { evaluate });
      const caught = violations.filter((v) => v.invariant === name);
      expect(caught.length).toBeGreaterThan(0);
      // The failure names the invariant, the case and the rule.
      const first = caught[0]!;
      expect(first.key).toMatch(/^\S+ \S+ \S+ /);
      expect(first.rule).not.toBe('');
      expect(formatPolicyInvariantViolations(caught, 1)).toContain(`[${name}] ${first.key}: ${first.rule}: `);
      expect(() => policyInvariants(testkitApp, { evaluate })).toThrow(PolicyInvariantError);
    });
  }

  it('each bug is caught by the invariant written for it, and by no other', () => {
    const caughtBy = Object.fromEntries(INVARIANTS.map((name) => [name, [...new Set(checkPolicyInvariants(testkitApp, { evaluate: BUGS[name].evaluate }).violations.map((v) => v.invariant))].sort()]));
    expect(caughtBy).toEqual(Object.fromEntries(INVARIANTS.map((name) => [name, [name]])));
  });
});
