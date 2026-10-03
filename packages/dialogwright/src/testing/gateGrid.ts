import { isDeepStrictEqual } from 'node:util';
import type { App, PolicyMatrix, PolicyMatrixSubject, PolicyTables, ToolName } from '../core/app/types';
import { identityOf } from '../core/app/lookup';
import { confirmationHash, evaluateCall } from '../gate/policy';
import { ANONYMOUS } from '../gate/principal';
import type { GateDecision, GateFacts, GateLookups, Party, Principal, ToolCall } from '../gate/types';
import { REGRESS_TODAY } from '../harness-text/baseline';

/**
 * The gate grid: every tool and probe an app's policy knows (and one it does not), crossed with
 * every kind of principal, every kind of subject a call can name, and the facts the gate reads
 * (attempts, the confirmation, the fields sent), each evaluated by the gate. The principals and
 * records are the app's (TestingHooks.policyMatrix); the crossing is the grid's. The legacy
 * evaluator (gate/policy.ts evaluateCall) is the reference, so a new evaluator is compared against it
 * decision by decision, whole (compareGateGrid).
 */

/** A tool name no app has: the grid's unlisted action (R0). */
export const UNLISTED_TOOL = '(unlisted)';

/** The probe purposes the lifecycle asks the gate with (core/lifecycle.ts PROBES). */
export const GRID_PROBES = ['entry-check', 'retry-check'] as const;

/** The param the `extra` field variant adds. */
export const EXTRA_FIELD = 'gridExtra';

/** What the grid evaluates: the app's tables, its subject kind, its lookups and its matrix. */
export interface GateGridInput {
  readonly policy: PolicyTables;
  /** The app's subject kind (App.identity.subjectKind; '' for an app that verifies no one). */
  readonly subjectKind: string;
  readonly lookups: GateLookups;
  readonly matrix: PolicyMatrix;
  /** Tool names to try beside the tables' (the app's tools and identity tools). */
  readonly tools?: readonly ToolName[];
}

/** An app's grid input: its tables, its subject kind, its matrix, and the matrix's lookups or a fresh copy of the app's. */
export function gateGridInput(app: App): GateGridInput {
  const matrix = app.testing?.policyMatrix?.();
  if (!matrix) throw new Error(`app "${app.id}" has no policy matrix (App.testing.policyMatrix)`);
  const id = identityOf(app);
  const tools = [...Object.keys(app.tools), id.verifyTool, id.codeTool, id.sendCodeTool].filter((t) => t !== '');
  return { policy: app.policy, subjectKind: id.subjectKind, lookups: matrix.lookups?.() ?? app.systems().lookups, matrix, tools };
}

/** A gate to put through the grid: the legacy evaluator, or a candidate to compare with it. */
export type GateEvaluate = (call: ToolCall, p: Principal, facts: GateFacts, lk: GateLookups) => GateDecision;

/** The legacy evaluator over the input's tables and subject kind: the grid's reference. */
export function legacyGateEvaluator(input: Pick<GateGridInput, 'policy' | 'subjectKind'>): GateEvaluate {
  return (call, p, facts, lk) => evaluateCall(call, p, facts, lk, input.policy, input.subjectKind);
}

/** One point of the grid, by its labels. */
export interface GateGridCase {
  /** The labels joined: "<tool> <purpose|-> <principal> <subject> <params> <fields> a<attempts> <confirmation>". */
  readonly key: string;
  readonly tool: ToolName;
  readonly purpose: string | null;
  readonly principal: string;
  readonly subject: string;
  readonly params: string;
  readonly fields: 'exact' | 'extra' | 'missing';
  readonly attempts: number;
  readonly confirmation: 'none' | 'match' | 'mismatch';
  readonly call: ToolCall;
  readonly p: Principal;
  readonly facts: GateFacts;
}

export interface GateGridPoint {
  readonly case: GateGridCase;
  readonly decision: GateDecision;
}

export interface GateGrid {
  readonly points: readonly GateGridPoint[];
}

/** Every role the tables name (PolicyTables.roles), in order of first appearance. */
function rolesNamed(policy: PolicyTables): string[] {
  return [...new Set(Object.values(policy.roles ?? {}).flatMap((row) => Object.keys(row)))];
}

/** The principals of the grid, by label: anonymous, the subject at 1 and 2, each delegate, and the three edge parties. */
export function gridPrincipals(matrix: PolicyMatrix): Array<readonly [string, Principal]> {
  const m = matrix.principals;
  return [
    ['anonymous', ANONYMOUS],
    ['subject@1', m.subject1],
    ['subject@2', m.subject2],
    ...Object.entries(m.delegates).map(([role, p]) => [`delegate:${role}`, p] as const),
    ['unlisted-role', m.unlistedRole],
    ['roleless', m.roleless],
    ['other-party', m.otherParty],
  ];
}

/**
 * The matrix's problems against the input: a matrix that does not hold the principals and records
 * it says it does would test less than it seems to. Empty when it holds together.
 */
export function matrixProblems(input: GateGridInput): string[] {
  const { matrix, policy, subjectKind, lookups } = input;
  const m = matrix.principals;
  const out: string[] = [];
  const isSubject = (p: Party): boolean => subjectKind !== '' && p.kind === subjectKind;
  if (m.subject1.level !== 1) out.push(`subject1 is at level ${m.subject1.level}, not 1`);
  if (m.subject2.level !== 2) out.push(`subject2 is at level ${m.subject2.level}, not 2`);
  if (m.subject1.id !== m.subject2.id || m.subject1.kind !== m.subject2.kind) out.push('subject1 and subject2 are not the same subject');
  if (subjectKind !== '' && m.subject1.kind !== subjectKind) out.push(`subject1 is a ${m.subject1.kind}, not the app's subject kind ${subjectKind}`);
  const named = rolesNamed(policy);
  for (const role of named) if (!Object.hasOwn(m.delegates, role)) out.push(`no delegate with role ${role}, which the tables name`);
  for (const [role, p] of Object.entries(m.delegates)) {
    if (p.role !== role) out.push(`delegates.${role} has role ${p.role ?? '(none)'}`);
    if (isSubject(p)) out.push(`delegates.${role} is one of the app's subjects`);
  }
  if (m.unlistedRole.role === undefined || named.includes(m.unlistedRole.role)) out.push(`unlistedRole's role ${m.unlistedRole.role ?? '(none)'} is not one the tables leave out`);
  if (isSubject(m.unlistedRole)) out.push('unlistedRole is one of the app\'s subjects');
  if (m.roleless.role !== undefined) out.push(`roleless has role ${m.roleless.role}`);
  if (isSubject(m.roleless)) out.push('roleless is one of the app\'s subjects');
  const delegateKinds = new Set([...Object.values(m.delegates), m.unlistedRole, m.roleless].map((p) => p.kind));
  if (isSubject(m.otherParty) || delegateKinds.has(m.otherParty.kind)) out.push(`otherParty is a ${m.otherParty.kind}, a kind the matrix already has`);
  const r = matrix.records;
  if (subjectKind !== '' && r.own.subject !== m.subject1.id) out.push(`records.own names ${r.own.subject}, not the subject ${m.subject1.id}`);
  // Who owns each record and who may see each subject, where the tables ask the lookups at all.
  const rows = Object.values(policy.subjects ?? {});
  if (rows.some((row) => row.via === 'record')) {
    for (const k of ['own', 'inScope', 'outOfScope'] as const) {
      if (lookups.ownerOf(r[k].record) !== r[k].subject) out.push(`records.${k}.record is owned by ${lookups.ownerOf(r[k].record) ?? 'no one'}, not ${r[k].subject}`);
    }
    if (lookups.ownerOf(r.unknown.record) !== null) out.push('records.unknown.record has an owner');
  }
  if (rows.length > 0) {
    const own = lookups.scopeOf(m.subject2);
    if (!own.includes(r.own.subject)) out.push('the subject may not see their own records');
    for (const k of ['inScope', 'outOfScope', 'unknown'] as const) if (own.includes(r[k].subject)) out.push(`the subject may see records.${k}`);
    for (const [role, p] of Object.entries(m.delegates)) {
      const scope = lookups.scopeOf(p);
      if (!scope.includes(r.inScope.subject)) out.push(`delegates.${role} may not see records.inScope`);
      if (scope.includes(r.outOfScope.subject) || scope.includes(r.unknown.subject)) out.push(`delegates.${role} may see records.outOfScope or records.unknown`);
    }
  }
  return out;
}

/** The tools of the grid: the tables', the input's, and the unlisted one, each once. */
export function gridTools(input: GateGridInput): ToolName[] {
  const { policy } = input;
  return [...new Set([...Object.keys(policy.rulesFor), ...Object.keys(policy.toolLevel), ...(input.tools ?? []), UNLISTED_TOOL])];
}

/** A tool's named param sets: the matrix's, or one built from what the tool's rules read. */
function paramSets(input: GateGridInput, tool: ToolName): Array<readonly [string, Record<string, string>]> {
  const given = input.matrix.calls && Object.hasOwn(input.matrix.calls, tool) ? input.matrix.calls[tool]! : null;
  if (given) return Object.entries(given).map(([label, params]) => [label, { ...params }] as const);
  const { policy } = input;
  const rules = Object.hasOwn(policy.rulesFor, tool) ? policy.rulesFor[tool]! : [];
  const row = Object.hasOwn(policy.subjects, tool) ? policy.subjects[tool] : undefined;
  const keys = [
    ...(row ? [row.param] : []),
    ...(rules.includes('R3') ? policy.confirmedFields : []),
    ...(rules.includes('R7') ? policy.serviceFields[tool] ?? [] : []),
  ];
  const values = input.matrix.values ?? {};
  return [['base', Object.fromEntries([...new Set(keys)].map((k) => [k, Object.hasOwn(values, k) ? values[k]! : 'x']))]];
}

/** The params with one field dropped: the last that is not the subject's param, or the subject's if it is the only one. */
function withoutOne(params: Record<string, string>, subjectParam: string | undefined): Record<string, string> {
  const keys = Object.keys(params);
  const drop = [...keys].reverse().find((k) => k !== subjectParam) ?? keys.at(-1);
  if (drop === undefined) return { ...params };
  const out = { ...params };
  delete out[drop];
  return out;
}

/** Every case of the grid, in a fixed order. Throws when the matrix does not hold together (matrixProblems). */
export function gateGridCases(input: GateGridInput): GateGridCase[] {
  const problems = matrixProblems(input);
  if (problems.length > 0) throw new Error(`the policy matrix does not hold together:\n  ${problems.join('\n  ')}`);
  const { policy, matrix } = input;
  const todayIso = matrix.todayIso ?? REGRESS_TODAY;
  const purposes: Array<string | null> = [null, ...GRID_PROBES, ...Object.keys(policy.purposeLevel)];
  const principals = gridPrincipals(matrix);
  const subjects: Array<readonly [string, PolicyMatrixSubject]> = [
    ...(['own', 'inScope', 'outOfScope', 'unknown'] as const).map((k) => [k, matrix.records[k]] as const),
    ['empty', { subject: '', record: '' }],
  ];
  const mismatchHash = confirmationHash({ [EXTRA_FIELD]: 'mismatch' }, [EXTRA_FIELD]);
  const out: GateGridCase[] = [];
  for (const tool of gridTools(input)) {
    const row = Object.hasOwn(policy.subjects, tool) ? policy.subjects[tool] : undefined;
    const named: Array<readonly [string, PolicyMatrixSubject | null]> = row ? subjects : [['-', null]];
    for (const purpose of purposes) {
      for (const [principal, p] of principals) {
        for (const [subject, value] of named) {
          for (const [paramsLabel, base] of paramSets(input, tool)) {
            const params = row && value ? { ...base, [row.param]: row.via === 'record' ? value.record : value.subject } : base;
            const variants = { exact: params, extra: { ...params, [EXTRA_FIELD]: 'x' }, missing: withoutOne(params, row?.param) } as const;
            for (const fields of ['exact', 'extra', 'missing'] as const) {
              const sent = variants[fields];
              const call: ToolCall = purpose === null ? { tool, params: sent } : { tool, params: sent, purpose };
              for (const attempts of [0, policy.maxAttempts]) {
                for (const confirmation of ['none', 'match', 'mismatch'] as const) {
                  const confirmedHash = confirmation === 'none' ? null : confirmation === 'match' ? confirmationHash(sent, policy.confirmedFields) : mismatchHash;
                  const key = `${tool} ${purpose ?? '-'} ${principal} ${subject} ${paramsLabel} ${fields} a${attempts} ${confirmation}`;
                  out.push({ key, tool, purpose, principal, subject, params: paramsLabel, fields, attempts, confirmation, call, p, facts: { attempts, confirmedHash, todayIso } });
                }
              }
            }
          }
        }
      }
    }
  }
  return out;
}

/** The grid's decisions by `evaluate` (default: the legacy evaluator, the reference). */
export function runGateGrid(input: GateGridInput, evaluate: GateEvaluate = legacyGateEvaluator(input)): GateGrid {
  return { points: gateGridCases(input).map((c) => ({ case: c, decision: evaluate(c.call, c.p, c.facts, input.lookups) })) };
}

/** A case where a candidate gate decided otherwise than the reference; `actual` is the error's message when the candidate threw. */
export interface GateGridMismatch {
  readonly key: string;
  readonly expected: GateDecision;
  readonly actual: GateDecision | string;
}

/**
 * Every case where `candidate` decides otherwise than the reference (default: the legacy evaluator),
 * comparing whole decisions: the call, the verdict, the reason, the level and every rule line.
 */
export function compareGateGrid(input: GateGridInput, candidate: GateEvaluate, reference: GateEvaluate = legacyGateEvaluator(input)): GateGridMismatch[] {
  const out: GateGridMismatch[] = [];
  for (const c of gateGridCases(input)) {
    const expected = reference(c.call, c.p, c.facts, input.lookups);
    let actual: GateDecision | string;
    try {
      actual = candidate(c.call, c.p, c.facts, input.lookups);
    } catch (e) {
      actual = `threw: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (!isDeepStrictEqual(expected, actual)) out.push({ key: c.key, expected, actual });
  }
  return out;
}

/** A decision on one line: verdict, reason, level, and each rule's id with + for a pass and - for a failure. */
export function gridDecisionLine(d: GateDecision): string {
  const reason = d.reason === undefined ? '' : ` reason=${d.reason}`;
  const need = d.needLevel === undefined ? '' : ` need=${d.needLevel}`;
  return `${d.verdict}${reason}${need} ${d.rules.map((r) => `${r.id}${r.pass ? '+' : '-'}`).join(' ')}`;
}

/** Mismatches as a reader wants them: the case, both decisions, and where they agree on that, the first rule line that differs. */
export function formatGateGridMismatches(mismatches: readonly GateGridMismatch[], limit = 20): string {
  const lines = [`${mismatches.length} case(s) decided otherwise`];
  for (const m of mismatches.slice(0, limit)) {
    lines.push(m.key);
    lines.push(`  expected ${gridDecisionLine(m.expected)}`);
    if (typeof m.actual === 'string') {
      lines.push(`  actual   ${m.actual}`);
      continue;
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
  }
  if (mismatches.length > limit) lines.push(`... and ${mismatches.length - limit} more`);
  return lines.join('\n');
}

/** How often each tool's rules passed and failed on the grid, by "<tool> <rule id>". */
export function gridRuleCounts(grid: GateGrid): Record<string, { pass: number; fail: number }> {
  const out: Record<string, { pass: number; fail: number }> = {};
  for (const { case: c, decision } of grid.points) {
    for (const r of decision.rules) {
      const k = `${c.tool} ${r.id}`;
      const n = (out[k] ??= { pass: 0, fail: 0 });
      if (r.pass) n.pass += 1;
      else n.fail += 1;
    }
  }
  return out;
}

/** The rules a tool's row lists that the grid never saw pass, or never saw fail, as "<tool> <rule> never passes|fails". */
export function gridUnexercised(input: GateGridInput, grid: GateGrid): string[] {
  const seen = gridRuleCounts(grid);
  const out: string[] = [];
  for (const [tool, ids] of Object.entries(input.policy.rulesFor)) {
    for (const id of ids) {
      const n = seen[`${tool} ${id}`] ?? { pass: 0, fail: 0 };
      if (n.pass === 0) out.push(`${tool} ${id} never passes`);
      if (n.fail === 0) out.push(`${tool} ${id} never fails`);
    }
  }
  return out;
}

/** Cases per verdict. */
export function gridVerdicts(grid: GateGrid): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { decision } of grid.points) out[decision.verdict] = (out[decision.verdict] ?? 0) + 1;
  return out;
}
