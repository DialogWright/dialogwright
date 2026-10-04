import { afterEach, describe, expect, it, vi } from 'vitest';
import { idempotencyKey, serviceIdempotencyKey } from './idempotency';
import { newSession, type Session } from './session';
import { callTool, newTurnOut } from './lifecycle';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { demoTools } from './tools';
import type { TurnContext } from './turn';
import { VOICE_RELAY } from '../channel/caps';
import { useTestkit } from '../testing/apps';
import { testkitApp } from '../testing/testkit';
import { customerPrincipal } from '../testing/testkit/domain/principals';
import { CUSTOMERS } from '../testing/testkit/domain/data';
import type { ParcelSystems } from '../testing/testkit/domain/systems';
import type { ToolCall } from '../gate/types';
import { confirmationHash } from '../gate/lines';

useTestkit();

afterEach(() => {
  vi.restoreAllMocks();
});

const REPORT: ToolCall = { tool: 'createReport', params: { accountId: '55501234', missingNote: 'a small brown box left at the side gate', expectedDate: '2026-09-15' } };

/** A verified caller on the report form, who has just said yes to the summary of REPORT. */
function confirmed(id = 'CA1'): Session {
  const s = newSession(id, 0, VOICE_RELAY, customerPrincipal(CUSTOMERS[0]!, 2));
  s.form = 'report_missing';
  s.entered = 'report_missing';
  s.confirmedHash = confirmationHash(REPORT.params, testkitApp.policy.confirmedFields);
  return s;
}

function ctx(): TurnContext {
  return { nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: demoTools() };
}

describe('the idempotency key of a write', () => {
  it('is 32 hex characters, the same for the same call, form, confirmed values and tool', () => {
    const key = idempotencyKey(confirmed(), REPORT);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(idempotencyKey(confirmed(), REPORT)).toBe(key);
    // The confirmed values decide it, not the turn or anything else in the session.
    expect(idempotencyKey(Object.assign(confirmed(), { turnIndex: 9, lastPromptText: 'again' }), REPORT)).toBe(key);
  });

  it('differs when the call, the form, any confirmed value or the tool differs', () => {
    const key = idempotencyKey(confirmed(), REPORT);
    expect(idempotencyKey(confirmed('CA2'), REPORT)).not.toBe(key);
    expect(idempotencyKey({ ...confirmed(), form: 'delivery_window' }, REPORT)).not.toBe(key);
    expect(idempotencyKey({ ...confirmed(), confirmedHash: confirmationHash({ ...REPORT.params, expectedDate: '2026-09-16' }, testkitApp.policy.confirmedFields) }, REPORT)).not.toBe(key);
    expect(idempotencyKey(confirmed(), { ...REPORT, tool: 'notifyDepot' })).not.toBe(key);
  });

  it("is made from the call's own values when nothing was confirmed, in any order", () => {
    const s = { ...confirmed(), confirmedHash: null };
    const key = idempotencyKey(s, REPORT);
    expect(idempotencyKey(s, { ...REPORT, params: { expectedDate: '2026-09-15', missingNote: REPORT.params.missingNote!, accountId: '55501234' } })).toBe(key);
    expect(idempotencyKey(s, { ...REPORT, params: { ...REPORT.params, expectedDate: '2026-09-16' } })).not.toBe(key);
  });
});

describe('a tool that declares idempotent', () => {
  it('is given the key in its run, and the testkit files one report for two runs of the same confirmed write', () => {
    expect(testkitApp.tools.createReport!.idempotent).toBe(true);
    const run = vi.spyOn(testkitApp.tools.createReport!, 'run');
    const tc = ctx();
    const first = callTool(confirmed(), REPORT, tc, newTurnOut());
    const again = callTool(confirmed(), REPORT, tc, newTurnOut());
    expect(run.mock.calls.map((c) => c[2].idempotencyKey)).toEqual([idempotencyKey(confirmed(), REPORT), idempotencyKey(confirmed(), REPORT)]);
    expect(first.value).toEqual(again.value);
    expect((tc.tools.sys as ParcelSystems).reportsOf('55501234')).toHaveLength(1);
  });

  it('a tool that does not is given no key, as before', () => {
    const run = vi.spyOn(testkitApp.tools.getAccount!, 'run');
    callTool(confirmed(), { tool: 'getAccount', params: { accountId: '55501234' } }, ctx(), newTurnOut());
    expect(run).toHaveBeenCalledOnce();
    expect('idempotencyKey' in run.mock.calls[0]![2]).toBe(false);
  });
});

describe('the idempotency key of a service request', () => {
  const effect = { kind: 'service' as const, service: 'depot', params: { report: '9001', missingNote: 'a box', expectedDate: '2026-09-15' } };

  it('is 32 hex characters, the same for the same call, turn, service and values', () => {
    const s = { ...confirmed(), turnIndex: 7 };
    const key = serviceIdempotencyKey(s, effect);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(serviceIdempotencyKey({ ...s }, { ...effect, params: { expectedDate: '2026-09-15', report: '9001', missingNote: 'a box' } })).toBe(key);
  });

  it('differs for another call, turn, service or value', () => {
    const s = { ...confirmed(), turnIndex: 7 };
    const key = serviceIdempotencyKey(s, effect);
    expect(serviceIdempotencyKey({ ...s, sessionId: 'CA2' }, effect)).not.toBe(key);
    expect(serviceIdempotencyKey({ ...s, turnIndex: 8 }, effect)).not.toBe(key);
    expect(serviceIdempotencyKey(s, { ...effect, service: 'other' })).not.toBe(key);
    expect(serviceIdempotencyKey(s, { ...effect, params: { ...effect.params, report: '9002' } })).not.toBe(key);
  });
});
