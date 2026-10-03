import { isDeepStrictEqual } from 'node:util';
import type { App, PolicyTables } from '../core/app/types';
import { gateOf, identityOf } from '../core/app/lookup';
import type { CompiledPolicy } from '../gate/compiled';
import { isAnonymous, type GateDecision, type GateFacts, type Principal, type ToolCall } from '../gate/types';
import { gridDecisionLine, legacyGateEvaluator, type GateEvaluate } from './gateGrid';
import type { ShadowMode } from './shadowSlot';

/**
 * Test support: the shadow gate. The gate that reads the policy's named rules (gate/compiled.ts)
 * replaced the legacy evaluator over the tables (gate/policy.ts evaluateCall); the two must decide
 * every call alike, whole decision for whole decision. `withShadowGate(app, reference)` returns the
 * app with a gate that, on every call, asks the app's own gate (the candidate) and the reference,
 * compares the two decisions deep and strict (the call, the verdict, the reason, the level, every
 * rule's id, description, compared line and pass), and answers with the reference's. On a
 * difference it throws a GateShadowMismatchError; in `report` mode it records the difference and
 * carries on. The report also counts what was compared: every decision, its verdict, and each rule
 * id seen passing and failing, overall and per tool, so a shadow that never reached a rule says so
 * (gateShadowUnexercised).
 *
 * `shadowGate(candidate, reference)` is the same comparison as a GateEvaluate, for the gate grid
 * (runGateGrid), so the grid and whole runs fill one report. Kept out of the root entry: import it
 * from `dialogwright/testing`, as the slot shadow (shadowSlot.ts) is.
 */

export interface GateShadowMismatch {
  /** The call as the gate was given it (raw: a test's own data). */
  readonly call: ToolCall;
  /** Who asked, as "<kind>@<level>[:<role>]". */
  readonly principal: string;
  readonly facts: GateFacts;
  readonly expected: GateDecision;
  /** The candidate's decision, or the message it threw. */
  readonly actual: GateDecision | string;
}

export interface GateShadowCounts {
  pass: number;
  fail: number;
}

export interface GateShadowReport {
  readonly mismatches: GateShadowMismatch[];
  /** Decisions compared. */
  compared: number;
  /** Decisions by the reference's verdict. */
  readonly verdicts: Record<string, number>;
  /** Each rule id the reference ran, seen passing and failing. */
  readonly rules: Record<string, GateShadowCounts>;
  /** The same, by "<tool> <rule id>". */
  readonly toolRules: Record<string, GateShadowCounts>;
}

export interface GateShadowOptions {
  /** throw (default): a GateShadowMismatchError on the first difference; report: collect into `report`. */
  mode?: ShadowMode;
  /** Where mismatches are collected (required in report mode) and comparisons are counted. */
  report?: GateShadowReport;
}

export class GateShadowMismatchError extends Error {
  constructor(readonly mismatch: GateShadowMismatch) {
    super(formatGateShadowMismatch(mismatch));
    this.name = 'GateShadowMismatchError';
  }
}

export function createGateShadowReport(): GateShadowReport {
  return { mismatches: [], compared: 0, verdicts: {}, rules: {}, toolRules: {} };
}

/** A principal on one line. */
function principalLine(p: Principal): string {
  if (isAnonymous(p)) return 'anonymous@0';
  return `${p.kind}@${p.level}${p.role === undefined ? '' : `:${p.role}`}`;
}

function count(report: GateShadowReport, tool: string, d: GateDecision): void {
  report.compared += 1;
  report.verdicts[d.verdict] = (report.verdicts[d.verdict] ?? 0) + 1;
  for (const r of d.rules) {
    for (const [table, key] of [[report.rules, r.id], [report.toolRules, `${tool} ${r.id}`]] as const) {
      const n = (table[key] ??= { pass: 0, fail: 0 });
      if (r.pass) n.pass += 1;
      else n.fail += 1;
    }
  }
}

/**
 * The comparison as a gate: each call goes to the reference and the candidate, the two decisions
 * are compared whole, and the reference's is the answer. A candidate that throws is a mismatch.
 */
export function shadowGate(candidate: GateEvaluate, reference: GateEvaluate, options: GateShadowOptions = {}): GateEvaluate {
  const mode = options.mode ?? 'throw';
  const report = options.report;
  if (mode === 'report' && !report) throw new Error('shadowGate: report mode needs a report (createGateShadowReport())');
  return (call, p, facts, lk) => {
    const expected = reference(call, p, facts, lk);
    let actual: GateDecision | string;
    try {
      actual = candidate(call, p, facts, lk);
    } catch (e) {
      actual = `threw: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (report) count(report, call.tool, expected);
    if (!isDeepStrictEqual(expected, actual)) {
      const found: GateShadowMismatch = { call, principal: principalLine(p), facts, expected, actual };
      report?.mismatches.push(found);
      if (mode === 'throw') throw new GateShadowMismatchError(found);
    }
    return expected;
  };
}

/** The app's own gate (gateOf: its policy's named rules), as a GateEvaluate. */
export function gateEvaluator(app: App): GateEvaluate {
  const gate = gateOf(app);
  return (call, p, facts, lk) => gate.evaluate(call, p, facts, lk);
}

/**
 * The legacy evaluator (gate/policy.ts evaluateCall) over `tables` for the app's subject kind: the
 * shadow's reference. Default: the app's own tables; give the tables the app ran before its policy
 * was a file (frozen test data) to hold the gate to those.
 */
export function legacyGateOf(app: App, tables: PolicyTables = app.policy): GateEvaluate {
  return legacyGateEvaluator({ policy: tables, subjectKind: identityOf(app).subjectKind });
}

/**
 * The app with the shadow gate in front of its calls: its own gate (gateOf) compared, on every call,
 * with `reference` (default: the legacy evaluator over the app's tables), the reference's decision
 * answering. Register the result in place of the app to run a whole regression or replay through it.
 */
export function withShadowGate(app: App, reference: GateEvaluate = legacyGateOf(app), options: GateShadowOptions = {}): App {
  const own: CompiledPolicy = gateOf(app);
  const evaluate = shadowGate((call, p, facts, lk) => own.evaluate(call, p, facts, lk), reference, options);
  const gate: CompiledPolicy = { source: own.source, tables: own.tables, subjectKind: own.subjectKind, evaluate };
  return { ...app, gate };
}

/**
 * What the shadow never saw: each rule id of `rulesFor` (default: every id the report saw) that the
 * reference never ran passing, or never ran failing, as "<id> never passes|fails" (R0, an action not
 * listed, only ever fails). With `byTool`, per "<tool> <id>" of the tables' rulesFor.
 */
export function gateShadowUnexercised(report: GateShadowReport, rulesFor?: PolicyTables['rulesFor'], byTool = false): string[] {
  const out: string[] = [];
  const keys = rulesFor
    ? [...new Set(Object.entries(rulesFor).flatMap(([tool, ids]) => ids.map((id) => (byTool ? `${tool} ${id}` : id))))]
    : Object.keys(byTool ? report.toolRules : report.rules);
  const table = byTool ? report.toolRules : report.rules;
  for (const key of keys) {
    const n = table[key] ?? { pass: 0, fail: 0 };
    // R0 is the line for an action not listed, which never passes.
    if (n.pass === 0 && key !== 'R0' && !key.endsWith(' R0')) out.push(`${key} never passes`);
    if (n.fail === 0) out.push(`${key} never fails`);
  }
  return out;
}

/** A report as lines for a person: decisions compared, verdicts, each rule's passes and failures, and every mismatch. */
export function formatGateShadowReport(report: GateShadowReport, limit = 20): string {
  const lines = [`shadow gate  ${report.compared} decisions  ${report.mismatches.length} mismatch${report.mismatches.length === 1 ? '' : 'es'}`];
  lines.push(`  verdicts ${Object.keys(report.verdicts).sort().map((v) => `${v} ${report.verdicts[v]}`).join(', ')}`);
  for (const id of Object.keys(report.rules).sort()) lines.push(`  ${id} pass ${report.rules[id]!.pass} fail ${report.rules[id]!.fail}`);
  for (const m of report.mismatches.slice(0, limit)) lines.push(formatGateShadowMismatch(m));
  if (report.mismatches.length > limit) lines.push(`... and ${report.mismatches.length - limit} more`);
  return lines.join('\n');
}

export function formatGateShadowMismatch(m: GateShadowMismatch): string {
  const lines = [`shadow gate: ${m.call.tool}${m.call.purpose === undefined ? '' : ` (${m.call.purpose})`} by ${m.principal} decided otherwise`];
  lines.push(`  facts    attempts ${m.facts.attempts}, ${m.facts.confirmedHash === null ? 'no confirmation' : 'a confirmation'}, today ${m.facts.todayIso}`);
  lines.push(`  expected ${gridDecisionLine(m.expected)}`);
  if (typeof m.actual === 'string') {
    lines.push(`  actual   ${m.actual}`);
    return lines.join('\n');
  }
  const actual = m.actual;
  lines.push(`  actual   ${gridDecisionLine(actual)}`);
  const n = Math.max(m.expected.rules.length, actual.rules.length);
  const at = Array.from({ length: n }, (_, i) => i).find((i) => !isDeepStrictEqual(m.expected.rules[i], actual.rules[i]));
  const shown = (r: unknown): string => (r === undefined ? '(none)' : JSON.stringify(r));
  if (at !== undefined) {
    lines.push(`  rule ${at}: expected ${shown(m.expected.rules[at])}`);
    lines.push(`  rule ${at}: actual   ${shown(actual.rules[at])}`);
  } else if (!isDeepStrictEqual(m.expected.call, actual.call)) {
    lines.push(`  call: expected ${JSON.stringify(m.expected.call)}, actual ${JSON.stringify(actual.call)}`);
  }
  return lines.join('\n');
}
