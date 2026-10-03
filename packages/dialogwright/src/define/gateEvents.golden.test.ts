import { describe, expect, it } from 'vitest';
import { ANONYMOUS } from '../gate/principal';
import { confirmationHash } from '../gate/policy';
import { VOICE_RELAY } from '../channel/caps';
import { speechEvent, startEvent } from '../channel/events';
import { registerApp } from '../core/app/registry';
import { callTool, newTurnOut, type GateEvent } from '../core/lifecycle';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { resolve, type TurnContext, type TurnResult } from '../core/turn';
import { mockCodeVerifier } from '../core/tools';
import { choice, noul, score } from '../testing/answers';
import { gateEventLines } from '../testing/gateEvents';
import { gateGridInput, gridUnexercised, runGateGrid, compareGateGrid, legacyGateEvaluator, formatGateGridMismatches } from '../testing/gateGrid';
import { createGateShadowReport, formatGateShadowReport, gateEvaluator, gateShadowUnexercised, legacyGateOf, shadowGate, withShadowGate } from '../testing/shadowGate';
import { useTestkit } from '../testing/apps';
import { resetAppsForTest } from '../core/app/registry';
import type { PolicyTables } from '../core/app/types';
import { FROZEN_LIBRARY_POLICY } from './__fixtures__/frozen/library';
import type { AnswerMap } from '../jev/types';
import type { ToolCall } from '../gate/types';
import { libraryApp, libraryCode } from './fixture/app';

/**
 * The library fixture has no regression fixtures of its own, so its gate-event golden is taken from
 * a few scripted calls: a renewal read back and confirmed, a hold at a branch, the loans on a card,
 * each through whole turns with the model's answers written out; then calls put to the gate directly
 * (a branch the library does not have, a renewal nobody confirmed or with a field too many, a tool
 * the policy does not list). Every gate event is written as the other apps' goldens write theirs.
 */
registerApp(libraryApp);

const tc = (): TurnContext => ({ nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...libraryApp.systems(), codes: mockCodeVerifier } });

const BASE: AnswerMap = {
  addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
  rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05),
  frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }),
  intent: choice({ none: 0.9, other: 0.1 }),
  intentChange: choice({ answering: 0.95, adding: 0.03, replacing: 0.02 }),
  cardGiven: noul(0.05), cardSpan: choice({ none: 1 }), cardComplete: noul(0.4),
};
const YES: AnswerMap = { confirmsYes: noul(0.95), confirmsNo: noul(0.05), changeSlot: choice({ none: 0.95, book: 0.05 }) };

/** A scripted call: the caller's words and the model's answers to them, turn by turn after the greeting. */
type Script = ReadonlyArray<readonly [string, AnswerMap]>;

const CALLS: Record<string, Script> = {
  'renew-confirmed': [
    ['I want to renew A Quiet Orchard', { intent: choice({ renew_loan: 0.95, none: 0.05 }), book: choice({ quiet_orchard: 0.9, none: 0.1 }) }],
    ['yes please', YES],
  ],
  'hold-at-branch': [
    ['is my hold for The River Atlas in', { intent: choice({ check_hold: 0.95, none: 0.05 }), book: choice({ river_atlas: 0.9, none: 0.1 }) }],
    ['North', { branch: choice({ north: 0.92, none: 0.08 }) }],
  ],
  'loans-on-card': [
    ['what do I have checked out', { intent: choice({ check_loans: 0.95, none: 0.05 }) }],
    ['five five five two zero four one seven', { cardGiven: noul(0.95), cardSpan: choice({ 'five five five two zero four one seven': 0.9, none: 0.1 }), cardComplete: noul(0.9) }],
  ],
};

function scripted(id: string, script: Script): { lines: string[]; events: number } {
  const t = tc();
  let r: TurnResult = resolve(newSession(`library-${id}`, 0, VOICE_RELAY, ANONYMOUS, libraryApp.id), startEvent(), null, t);
  const turns: TurnResult[] = [r];
  for (const [text, over] of script) {
    r = resolve(r.session, speechEvent(text), { ...BASE, ...over }, t);
    turns.push(r);
  }
  const lines = [`# call ${id}`];
  let events = 0;
  turns.forEach((turn, i) => {
    for (const e of turn.gateEvents) {
      events += 1;
      lines.push(...gateEventLines(i, e));
    }
  });
  return { lines, events };
}

/** Calls put to the gate directly, each on a fresh session: what the scripted turns cannot reach. */
function direct(): { lines: string[]; events: number } {
  const calls: Array<readonly [string, ToolCall, string | null]> = [
    ['hold at a branch the library does not have', { tool: 'findHold', params: { book: 'river_atlas', branch: 'east' } }, null],
    ['renewal nobody confirmed', { tool: 'renewLoan', params: { book: 'quiet_orchard' } }, null],
    ['renewal confirmed for another book', { tool: 'renewLoan', params: { book: 'quiet_orchard' } }, confirmationHash({ book: 'river_atlas' }, ['book'])],
    ['renewal with a field too many', { tool: 'renewLoan', params: { book: 'quiet_orchard', due: '2026-12-01' } }, confirmationHash({ book: 'quiet_orchard' }, ['book'])],
    ['renewal with its field missing', { tool: 'renewLoan', params: {} }, confirmationHash({ book: 'quiet_orchard' }, ['book'])],
    ['renewal confirmed', { tool: 'renewLoan', params: { book: 'quiet_orchard' } }, confirmationHash({ book: 'quiet_orchard' }, ['book'])],
    ['a card that is not on file', { tool: 'listLoans', params: { card: '55500000' } }, null],
    ['a tool the policy does not list', { tool: 'cancelCard', params: { card: '55520417' } }, null],
    ['an entry-check probe', { tool: 'renewLoan', params: {}, purpose: 'entry-check' }, null],
  ];
  const lines = ['# direct'];
  const events: GateEvent[] = [];
  for (const [what, call, hash] of calls) {
    const s = newSession(`library-direct`, 0, VOICE_RELAY, ANONYMOUS, libraryApp.id);
    s.confirmedHash = hash;
    const out = newTurnOut();
    callTool(s, call, tc(), out);
    lines.push(`## ${what}`);
    for (const e of out.gateEvents) lines.push(...gateEventLines(0, e));
    events.push(...out.gateEvents);
  }
  return { lines, events: events.length };
}

describe('the library fixture', () => {
  it('gate-event golden: scripted calls and calls put to the gate directly', async () => {
    const parts = [...Object.entries(CALLS).map(([id, script]) => scripted(id, script)), direct()];
    for (const p of parts) expect(p.events, p.lines[0]).toBeGreaterThan(0);
    await expect(`${parts.flatMap((p) => p.lines).join('\n')}\n`).toMatchFileSnapshot('./__snapshots__/gate-events.library.txt');
  });

  it('gate grid: stable, and every rule seen to pass and fail but R1, which no call can fail at level 0', () => {
    const input = gateGridInput(libraryApp);
    const grid = runGateGrid(input);
    expect(grid.points.length).toBe(3 * 6 * 18 * (1 + 2 + 1 + 1));
    expect(compareGateGrid(input, legacyGateEvaluator(input))).toEqual([]);
    expect(gridUnexercised(input, grid)).toEqual(['renewLoan R1 never fails', 'findHold R1 never fails', 'listLoans R1 never fails']);
  });
});

/**
 * The shadow gate on the library fixture: its gate (the named rules of its policy.yaml) beside the
 * legacy evaluator over the tables its old policy.yaml gave (frozen test data), on every case of the
 * grid and on every call of the golden's scripted and direct calls. Not one decision may differ, and
 * the golden's lines are the same with the shadow in front.
 */
describe('the shadow gate on the library fixture', () => {
  const FROZEN: PolicyTables = { ...FROZEN_LIBRARY_POLICY, customRules: libraryCode.customRules! };
  const input = { ...gateGridInput(libraryApp), policy: FROZEN };

  it('grid: every case decided as the legacy evaluator over the frozen tables decides it', () => {
    const mismatches = compareGateGrid(input, gateEvaluator(libraryApp));
    expect(mismatches.length === 0 ? [] : [formatGateGridMismatches(mismatches)]).toEqual([]);
    const report = createGateShadowReport();
    runGateGrid(input, shadowGate(gateEvaluator(libraryApp), legacyGateEvaluator(input), { mode: 'report', report }));
    expect(report.mismatches, formatGateShadowReport(report)).toEqual([]);
    expect(report.compared).toBe(3 * 6 * 18 * (1 + 2 + 1 + 1));
    expect(gateShadowUnexercised(report, FROZEN.rulesFor, true)).toEqual(['renewLoan R1 never fails', 'findHold R1 never fails', 'listLoans R1 never fails']);
  });

  it('the scripted and direct calls: every decision the same, and the golden\'s lines unchanged', () => {
    const plain = [...Object.entries(CALLS).map(([id, script]) => scripted(id, script)), direct()].flatMap((p) => p.lines);
    const report = createGateShadowReport();
    resetAppsForTest();
    try {
      useTestkit();
      registerApp(withShadowGate(libraryApp, legacyGateOf(libraryApp, FROZEN), { mode: 'report', report }));
      const shadowed = [...Object.entries(CALLS).map(([id, script]) => scripted(id, script)), direct()].flatMap((p) => p.lines);
      expect(shadowed).toEqual(plain);
    } finally {
      useTestkit();
      registerApp(libraryApp);
    }
    expect(report.mismatches, formatGateShadowReport(report)).toEqual([]);
    expect(report.compared).toBeGreaterThan(10);
    expect(gateShadowUnexercised(report)).toEqual(['R1 never fails']);
  });
});
