import { describe, expect, it } from 'vitest';
import { serviceResultEvent } from '../channel/events';
import { VOICE_RELAY } from '../channel/caps';
import { useTestkit } from '../testing/apps';
import { testkitApp } from '../testing/testkit';
import { CUSTOMERS } from '../testing/testkit/domain/data';
import { customerPrincipal } from '../testing/testkit/domain/principals';
import type { ParcelSystems } from '../testing/testkit/domain/systems';
import { resolveService } from '../server/services';
import { redactRecordSlots } from '../trace/redact';
import type { TraceRecord } from '../trace/types';
import { auditDrafts } from './audit';
import { registerApp } from './app/registry';
import type { App, ServiceDef } from './app/types';
import { callTool, newTurnOut, type Effect } from './lifecycle';
import { carryScrub, recordedEffect, registerScrub, scrubberOf } from './recording';
import { newSession } from './session';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { demoTools } from './tools';

/**
 * The side effects a tool queues as it runs are recorded masked as its call is: their params in the
 * trace and the console, whatever their names, and a downstream service's audit row for the answer.
 * What is sent to the service is the effect itself.
 */

useTestkit();

const NOTE = 'left behind the blue recycling bin';
const REPORT = { missingNote: NOTE, expectedDate: '2026-09-21' };
const tc = () => ({ nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: demoTools() });

/** A depot service whose audit row repeats what it was asked: the careless row the engine masks. */
const ECHO: ServiceDef = {
  resolve: async (params) => serviceResultEvent('depot', { heard: params.note ?? '' }),
  fromLog: (result) => result,
  audit: (result) => ({ type: 'a2a', detail: { agent: 'depot', heard: String((result as { heard?: string } | null)?.heard ?? '') } }),
};

/** The testkit with a notifyDepot that sends the description under a name no slot has, and the echoing depot. */
const RENAMING: App = {
  ...testkitApp,
  id: 'effect-renaming',
  services: { depot: ECHO },
  tools: {
    ...testkitApp.tools,
    notifyDepot: {
      ...testkitApp.tools.notifyDepot!,
      run: (call, _sys, { out }) => {
        out.effects.push({ kind: 'service', service: 'depot', params: { ref: call.params.report ?? '', note: call.params.missingNote ?? '' } });
        return { value: null, summary: 'sent to the depot agent' };
      },
    },
  },
};
registerApp(RENAMING);

function notify() {
  const s = newSession('e', 0, VOICE_RELAY, customerPrincipal(CUSTOMERS[0]!, 2), RENAMING.id);
  const out = newTurnOut();
  const t = tc();
  // The customer's own report, so the scope rule lets the notice go.
  const report = (t.tools.sys as ParcelSystems).createReport({ owner: CUSTOMERS[0]!.id, missingNote: NOTE, expectedDate: REPORT.expectedDate });
  const outcome = callTool(s, { tool: 'notifyDepot', params: { ...REPORT, report: report.number } }, t, out);
  expect(outcome.decision.verdict).toBe('ALLOW');
  return { s, out, outcome, report: report.number };
}

describe('a side effect is recorded masked as its call, and sent as it is', () => {
  it('a param under a name of its own, carrying a value recorded by its length: masked where recorded, whole where sent', () => {
    const { out, report } = notify();
    const effect = out.effects[0]!;
    // Sent: the depot needs the words.
    expect(effect.params.note).toBe(NOTE);
    // Recorded: masked as the call's missingNote is, though its name is no slot's.
    expect(recordedEffect(effect).params).toEqual({ ref: report, note: `<${NOTE.length} chars>` });
    // And so in a trace record, which masks by name too (the effect param "note" is no slot).
    const record = { effects: out.effects.map(recordedEffect), slots: {}, turnState: null, decision: { kind: 'ignore' } } as unknown as TraceRecord;
    expect(JSON.stringify(redactRecordSlots(record, 'length', RENAMING))).not.toContain(NOTE);
  });

  it('an effect queued by no call the engine masked is recorded as it is', () => {
    const effect: Effect = { kind: 'service', service: 'depot', params: { note: NOTE } };
    expect(recordedEffect(effect)).toBe(effect);
  });

  it('the service\'s answer carries the effect\'s scrub, and its audit row is masked with it', async () => {
    const { out } = notify();
    const effect = out.effects[0]!;
    const answer = await resolveService(RENAMING, effect, undefined);
    expect(answer.result).toEqual({ heard: NOTE });
    expect(scrubberOf(answer)).not.toBeNull();
    const s = { ...newSession('e', 0, VOICE_RELAY, undefined, RENAMING.id), pendingService: 'depot' };
    const drafts = auditDrafts({ before: s, after: s, event: answer, decision: { kind: 'ignore' }, gateEvents: [], kb: null, screen: null, quarantined: false });
    expect(drafts).toEqual([{ type: 'a2a', detail: { agent: 'depot', heard: `<${NOTE.length} chars>` } }]);
  });

  it('carries nothing where the effect has no scrub', () => {
    const from = { kind: 'service', service: 'depot', params: {} };
    const to = serviceResultEvent('depot', null);
    carryScrub(from, to);
    expect(scrubberOf(to)).toBeNull();
    registerScrub(from, (t) => t.toUpperCase());
    carryScrub(from, to);
    expect(scrubberOf(to)!('x')).toBe('X');
  });
});
