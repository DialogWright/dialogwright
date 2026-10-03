import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { useTestkit } from '../testing/apps';
import { CUSTOMERS, STAFF } from '../testing/testkit/domain/data';
import { CONFIRMED_FIELDS, TESTKIT_POLICY, TOOL_LEVEL } from '../testing/testkit/domain/policy';
import { agentPrincipal, customerPrincipal } from '../testing/testkit/domain/principals';
import { lookupsFor, ParcelSystems } from '../testing/testkit/domain/systems';
import { namedDecision } from '../testing/gateGrid';
import { ANONYMOUS } from './principal';
import { compiledPolicyOf } from './compiled';
import { confirmationHash, evaluateCall as legacyEvaluate } from './policy';
import type { GateDecision, GateFacts, GateLookups, Principal, ToolCall } from './types';
import type { PolicyTables } from '../core/app/types';

useTestkit();

/**
 * The gate as the testkit calls it (its subject kind is the customer, testkitApp.identity.subjectKind),
 * both ways: the legacy evaluator over the tables, and the compiled gate the lifecycle runs (for the
 * testkit's own tables, the named rules of its policy.yaml; for tables a test changes, the tables
 * read as rules). Every test here holds the two to the same whole decision (the legacy evaluator
 * records R1..R7 and R0, the compiled gate the rules' names, so the legacy decision is mapped by
 * the shadow gate's id map first), and checks the compiled one.
 */
function evaluateCall(call: ToolCall, p: Principal, f: GateFacts, lk: GateLookups, policy: PolicyTables): GateDecision {
  const legacy = legacyEvaluate(call, p, f, lk, policy, 'customer');
  const compiled = compiledPolicyOf(policy, 'customer').evaluate(call, p, f, lk);
  // The two differ only in the ids of the built-in rules' lines (R1..R7, R0 and the rules' names).
  expect(compiled).toStrictEqual(namedDecision(legacy));
  return compiled;
}

const sys = new ParcelSystems();
const lookups = lookupsFor(sys);
const POLICY = TESTKIT_POLICY;
const alex1 = customerPrincipal(CUSTOMERS[0]!, 1);
const alex2 = customerPrincipal(CUSTOMERS[0]!, 2);
const taylor = agentPrincipal(STAFF[0]!); // viewer, North Depot
const morgan = agentPrincipal(STAFF[1]!); // clerk, North Depot
/** North Depot's customers, as the scope rule shows them. */
const TAYLOR_SCOPE = '...1234, ...5678';
const facts: GateFacts = { attempts: 0, confirmedHash: null, todayIso: '2026-09-18' };
const reportParams = { accountId: '55501234', missingNote: 'A small brown box at the gate.', expectedDate: '2026-09-15' };

describe('evaluateCall', () => {
  it('identity: steps an anonymous caller up to level 1 for an account', () => {
    const d = evaluateCall({ tool: 'getAccount', params: { accountId: '' } }, ANONYMOUS, facts, lookups, POLICY);
    expect(d).toMatchObject({ verdict: 'STEP_UP', needLevel: 1 });
    expect(d.rules.map((r) => r.id)).toEqual(['identity']);
  });

  it('identity: steps a level-1 customer up to level 2 for parcels', () => {
    expect(evaluateCall({ tool: 'listParcels', params: { accountId: '55501234' } }, alex1, facts, lookups, POLICY)).toMatchObject({ verdict: 'STEP_UP', needLevel: 2 });
  });

  it('identity: a purpose raises the bar above the tool level', () => {
    expect(TOOL_LEVEL.getAccount).toBe(1);
    expect(evaluateCall({ tool: 'getAccount', params: { accountId: '55501234' }, purpose: 'report_missing' }, alex1, facts, lookups, POLICY)).toMatchObject({ verdict: 'STEP_UP', needLevel: 2 });
  });

  it('scope: allows a customer their own parcel', () => {
    expect(evaluateCall({ tool: 'getParcel', params: { parcel: '7101' } }, alex2, facts, lookups, POLICY).verdict).toBe('ALLOW');
  });

  it('scope: blocks a customer asking for another customer\'s parcel, showing the comparison', () => {
    const d = evaluateCall({ tool: 'getParcel', params: { parcel: '7201' } }, alex2, facts, lookups, POLICY);
    expect(d).toMatchObject({ verdict: 'BLOCK', reason: 'scope' });
    expect(d.rules.at(-1)).toMatchObject({ id: 'scope', pass: false, compared: 'record owner ...5678 · caller may see ...1234 only' });
  });

  it('scope: allows staff a parcel in their depot\'s book and blocks one outside it', () => {
    expect(evaluateCall({ tool: 'getParcel', params: { parcel: '7201' } }, taylor, facts, lookups, POLICY).verdict).toBe('ALLOW');
    const d = evaluateCall({ tool: 'getParcel', params: { parcel: '7301' } }, taylor, facts, lookups, POLICY);
    expect(d).toMatchObject({ verdict: 'BLOCK', reason: 'scope' });
    // Staff's scope is the depot's customers, listed by last four.
    expect(d.rules.at(-1)).toMatchObject({ id: 'scope', pass: false, compared: `record owner ...9012 · caller may see ${TAYLOR_SCOPE}` });
  });

  it('scope: compares a subject-keyed check against who is asking', () => {
    const own = evaluateCall({ tool: 'getAccount', params: { accountId: '55501234' } }, alex2, facts, lookups, POLICY);
    expect(own.rules.at(-1)).toMatchObject({ id: 'scope', pass: true, compared: 'subject ...1234 · caller may see ...1234 only' });
    const staff = evaluateCall({ tool: 'listParcels', params: { accountId: '55509012' } }, taylor, facts, lookups, POLICY);
    expect(staff.rules.at(-1)).toMatchObject({ id: 'scope', pass: false, compared: `subject ...9012 · caller may see ${TAYLOR_SCOPE}` });
  });

  it('scope: an unknown parcel fails closed, so parcel numbers cannot be probed', () => {
    const d = evaluateCall({ tool: 'getParcel', params: { parcel: '0000' } }, alex2, facts, lookups, POLICY);
    expect(d).toMatchObject({ verdict: 'BLOCK', reason: 'scope' });
    expect(d.rules.at(-1)).toMatchObject({ id: 'scope', pass: false, compared: 'record owner unknown · caller may see ...1234 only' });
  });

  it('scope: an empty parcel param fails closed', () => {
    const d = evaluateCall({ tool: 'getParcel', params: { parcel: '' } }, alex2, facts, lookups, POLICY);
    expect(d).toMatchObject({ verdict: 'BLOCK', reason: 'scope' });
    expect(d.rules.at(-1)).toMatchObject({ id: 'scope', pass: false, compared: 'record owner unknown · caller may see ...1234 only' });
  });

  it('scope: a missing accountId on an account-keyed tool fails closed', () => {
    const d = evaluateCall({ tool: 'listParcels', params: {} }, alex2, facts, lookups, POLICY);
    expect(d).toMatchObject({ verdict: 'BLOCK', reason: 'scope' });
    expect(d.rules.at(-1)).toMatchObject({ id: 'scope', pass: false, compared: 'subject missing · caller may see ...1234 only' });
  });

  it('confirmed: blocks a write whose values differ from what was confirmed', () => {
    const confirmed = { ...facts, confirmedHash: confirmationHash(reportParams, CONFIRMED_FIELDS) };
    expect(evaluateCall({ tool: 'createReport', params: reportParams }, alex2, confirmed, lookups, POLICY).verdict).toBe('ALLOW');
    const changed = { ...reportParams, expectedDate: '2026-09-13' };
    expect(evaluateCall({ tool: 'createReport', params: changed }, alex2, confirmed, lookups, POLICY)).toMatchObject({ verdict: 'BLOCK', reason: 'confirmation' });
    expect(evaluateCall({ tool: 'createReport', params: reportParams }, alex2, facts, lookups, POLICY)).toMatchObject({ verdict: 'BLOCK', reason: 'confirmation' });
  });

  it('confirmed: blocks a write that carries an extra field beyond the confirmed three', () => {
    const confirmed = { ...facts, confirmedHash: confirmationHash(reportParams, CONFIRMED_FIELDS) };
    const withExtra = { ...reportParams, status: 'approved' };
    const d = evaluateCall({ tool: 'createReport', params: withExtra }, alex2, confirmed, lookups, POLICY);
    expect(d).toMatchObject({ verdict: 'BLOCK', reason: 'confirmation' });
    expect(d.rules.at(-1)).toMatchObject({ id: 'confirmed', pass: false, compared: 'extra fields: status' });
  });

  it('confirmed: blocks a write that is missing one of the confirmed three fields', () => {
    const confirmed = { ...facts, confirmedHash: confirmationHash(reportParams, CONFIRMED_FIELDS) };
    const { missingNote: _omit, ...missingOne } = reportParams;
    const d = evaluateCall({ tool: 'createReport', params: missingOne }, alex2, confirmed, lookups, POLICY);
    expect(d).toMatchObject({ verdict: 'BLOCK', reason: 'confirmation' });
    expect(d.rules.at(-1)).toMatchObject({ id: 'confirmed', pass: false, compared: 'missing fields: missingNote' });
  });

  it('R8, the app\'s own rule: sends a report to a person when a parcel was delivered the day the missing one was due', () => {
    const delivered = { ...reportParams, expectedDate: '2026-09-16' };
    const confirmed = { ...facts, confirmedHash: confirmationHash(delivered, CONFIRMED_FIELDS) };
    const d = evaluateCall({ tool: 'createReport', params: delivered }, alex2, confirmed, lookups, POLICY);
    expect(d).toMatchObject({ verdict: 'NEEDS_HUMAN', reason: 'delivered' });
    expect(d.rules.at(-1)).toMatchObject({ id: 'R8', pass: false, compared: 'due 2026-09-16: a parcel delivered that day' });
  });

  it('R8: passes a report for a day nothing was delivered, after the rules before it', () => {
    const confirmed = { ...facts, confirmedHash: confirmationHash(reportParams, CONFIRMED_FIELDS) };
    const d = evaluateCall({ tool: 'createReport', params: reportParams }, alex2, confirmed, lookups, POLICY);
    expect(d.verdict).toBe('ALLOW');
    expect(d.rules.map((r) => [r.id, r.pass])).toEqual([['identity', true], ['role', true], ['scope', true], ['confirmed', true], ['R8', true]]);
    expect(d.rules.at(-1)).toMatchObject({ compared: 'due 2026-09-15: nothing delivered that day' });
  });

  it('R8: blocks a malformed date, or lookups that cannot say, so the rule fails closed', () => {
    const bad = { ...reportParams, expectedDate: '2026-9-15' };
    const confirmed = { ...facts, confirmedHash: confirmationHash(bad, CONFIRMED_FIELDS) };
    const d = evaluateCall({ tool: 'createReport', params: bad }, alex2, confirmed, lookups, POLICY);
    expect(d).toMatchObject({ verdict: 'BLOCK', reason: 'unchecked' });
    expect(d.rules.at(-1)).toMatchObject({ id: 'R8', pass: false, compared: 'due 2026-9-15 not checkable' });
    // Lookups with no delivered-on check cannot answer.
    const plain = { ownerOf: lookups.ownerOf, scopeOf: lookups.scopeOf };
    const ok = { ...facts, confirmedHash: confirmationHash(reportParams, CONFIRMED_FIELDS) };
    expect(evaluateCall({ tool: 'createReport', params: reportParams }, alex2, ok, plain, POLICY)).toMatchObject({ verdict: 'BLOCK', reason: 'unchecked' });
  });

  it('role: blocks a viewer from filing and sends a clerk to a person', () => {
    expect(evaluateCall({ tool: 'createReport', params: reportParams }, taylor, facts, lookups, POLICY)).toMatchObject({ verdict: 'BLOCK', reason: 'role' });
    expect(evaluateCall({ tool: 'createReport', params: reportParams }, morgan, facts, lookups, POLICY)).toMatchObject({ verdict: 'NEEDS_HUMAN', reason: 'role-person' });
  });

  it('role: reads what each role may do from the app\'s roles table; a role or a table with no row is refused', () => {
    const call = { tool: 'createReport', params: reportParams };
    const roleLine = (policy: PolicyTables, who: typeof taylor) => evaluateCall(call, who, facts, lookups, policy).rules.find((r) => r.id === 'role');
    // Without the table, the role rule refuses every role: the clerk is refused as a viewer is.
    const none = { ...POLICY, roles: undefined };
    expect(evaluateCall(call, morgan, facts, lookups, none)).toMatchObject({ verdict: 'BLOCK', reason: 'role' });
    expect(roleLine(none, morgan)).toMatchObject({ pass: false, compared: 'role clerk may createReport: no' });
    // A role the table allows passes the role rule, and the call goes on to the rules after it.
    const allowed = { ...POLICY, roles: { createReport: { viewer: 'allow' as const } } };
    expect(roleLine(allowed, taylor)).toMatchObject({ pass: true, compared: 'role viewer may createReport: yes' });
    expect(evaluateCall(call, taylor, facts, lookups, allowed)).toMatchObject({ verdict: 'BLOCK', reason: 'confirmation' });
    expect(roleLine(allowed, morgan)).toMatchObject({ pass: false, compared: 'role clerk may createReport: no' });
  });

  it('reads the app\'s tables, not its own: levels, attempts and rules come from the argument', () => {
    const getAccount = { tool: 'getAccount', params: { accountId: '55501234' } };
    expect(evaluateCall(getAccount, alex1, facts, lookups, POLICY).verdict).toBe('ALLOW');
    expect(evaluateCall(getAccount, alex1, facts, lookups, { ...POLICY, toolLevel: { ...TOOL_LEVEL, getAccount: 2 } })).toMatchObject({ verdict: 'STEP_UP', needLevel: 2 });
    // A tool in rulesFor with no level needs the highest: it fails closed.
    const { getAccount: _dropped, ...noLevel } = TOOL_LEVEL;
    expect(evaluateCall(getAccount, alex1, facts, lookups, { ...POLICY, toolLevel: noLevel })).toMatchObject({ verdict: 'STEP_UP', needLevel: 2 });
    const once = { ...POLICY, maxAttempts: 1 };
    expect(evaluateCall({ tool: 'verifyCustomer', params: {} }, ANONYMOUS, { ...facts, attempts: 1 }, lookups, once)).toMatchObject({ verdict: 'NEEDS_HUMAN', reason: 'attempts' });
    const unlisted = { ...POLICY, rulesFor: { verifyCustomer: ['R6'] } };
    expect(evaluateCall(getAccount, alex2, facts, lookups, unlisted)).toMatchObject({ verdict: 'BLOCK', reason: 'unknown-tool' });
  });

  it('BLOCKs a rule id it does not know', () => {
    const d = evaluateCall({ tool: 'getAccount', params: { accountId: '55501234' } }, alex2, facts, lookups, { ...POLICY, rulesFor: { getAccount: ['R1', 'R9'] } });
    expect(d).toMatchObject({ verdict: 'BLOCK', reason: 'unknown-rule' });
    expect(d.rules.map((r) => [r.id, r.pass])).toEqual([['identity', true], ['R9', false]]);
  });

  it('attempts: stops identity attempts after three', () => {
    expect(evaluateCall({ tool: 'verifyCustomer', params: {} }, ANONYMOUS, { ...facts, attempts: 3 }, lookups, POLICY)).toMatchObject({ verdict: 'NEEDS_HUMAN', reason: 'attempts' });
    expect(evaluateCall({ tool: 'verifyCode', params: {} }, alex1, { ...facts, attempts: 3 }, lookups, POLICY)).toMatchObject({ verdict: 'NEEDS_HUMAN', reason: 'attempts' });
  });

  it('fields: lets the depot agent receive only its listed fields', () => {
    const filed = new ParcelSystems();
    const report = filed.createReport({ owner: '55501234', missingNote: 'x', expectedDate: '2026-09-15' }).number;
    const own = lookupsFor(filed);
    const ok = { report, missingNote: 'x', expectedDate: '2026-09-15' };
    expect(evaluateCall({ tool: 'notifyDepot', params: ok }, alex2, facts, own, POLICY).verdict).toBe('ALLOW');
    const d = evaluateCall({ tool: 'notifyDepot', params: { ...ok, dob: '1985-04-12' } }, alex2, facts, own, POLICY);
    expect(d).toMatchObject({ verdict: 'BLOCK', reason: 'minimization' });
    expect(d.rules.at(-1)!.compared).toContain('dob');
  });

  it('notifyDepot is scoped: a customer cannot send someone else\'s report to the depot', () => {
    const filed = new ParcelSystems();
    const report = filed.createReport({ owner: '55505678', missingNote: 'x', expectedDate: '2026-09-10' }).number;
    const d = evaluateCall({ tool: 'notifyDepot', params: { report, missingNote: 'x', expectedDate: '2026-09-10' } }, alex2, facts, lookupsFor(filed), POLICY);
    expect(d).toMatchObject({ verdict: 'BLOCK', reason: 'scope' });
  });

  it('BLOCKs a tool not on the approved list', () => {
    const call = { tool: 'deleteAccount' } as unknown as ToolCall;
    const d = evaluateCall(call, alex2, facts, lookups, POLICY);
    expect(d).toMatchObject({ verdict: 'BLOCK', reason: 'unknown-tool' });
    expect(d.rules).toEqual([{ id: 'unlisted', description: 'The action is on the approved list', compared: 'tool deleteAccount not in policy', pass: false }]);
  });

  it('is deterministic: identical inputs give deep-equal results', () => {
    const call: ToolCall = { tool: 'getParcel', params: { parcel: '7101' } };
    const a = evaluateCall(call, alex2, facts, lookups, POLICY);
    const b = evaluateCall(call, alex2, facts, lookups, POLICY);
    expect(a).toEqual(b);
  });

  it('imports only from ./lines, ./principal and ./types; anything else is type-only', () => {
    const src = readFileSync(new URL('./policy.ts', import.meta.url), 'utf8');
    const importRe = /^import\s+(type\s+)?.*?from\s+'([^']+)';?\s*$/gm;
    const allowedValueImports = new Set(['./lines', './principal', './types']);
    let match: RegExpExecArray | null;
    let found = 0;
    while ((match = importRe.exec(src)) !== null) {
      found++;
      const isTypeOnly = Boolean(match[1]);
      const from = match[2]!;
      if (!allowedValueImports.has(from)) {
        expect(isTypeOnly).toBe(true);
      }
    }
    expect(found).toBeGreaterThan(0);
  });
});
