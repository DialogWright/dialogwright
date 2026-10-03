import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import type { App, ToolName } from '../core/app/types';
import { gateOf } from '../core/app/lookup';
import type { PolicyAction, PolicySource, Rule } from '../gate/compiled';
import { isDefinedRule } from '../gate/defineRule';
import { confirmationHash } from '../gate/lines';
import { isAnonymous, type GateDecision, type GateFacts, type GateLookups, type Principal, type ToolCall } from '../gate/types';
import { REGRESS_TODAY } from '../harness-text/baseline';
import { gateGridCases, gateGridInput, gridPrincipals, UNLISTED_TOOL, type GateGridCase, type GateGridInput } from './gateGrid';

/**
 * Test support: the policy matrix, a reviewed golden of what an app's gate decides. `policy.matrix`
 * (beside the app's policy.yaml) is the gate grid's decisions written for a person: under each
 * action, one row per kind of caller with the verdict and its reason, summarized over what the call
 * carries where the verdict does not depend on it and split where it does; then each custom rule's
 * examples, run through the compiled gate in every action that names the rule. A policy change is a
 * diff of this file, which compliance reads.
 *
 * `policyMatrixText(app)` writes it from the compiled gate (gateOf) and the app's policy matrix
 * (TestingHooks.policyMatrix); `expectPolicyMatrix(app, file)` fails a test on any difference, with
 * a readable diff; `dialogwright policy:matrix [dir...]` (pnpm policy:matrix) writes it, deliberately,
 * never in CI. `runRuleExamples(app)` runs the custom rules' examples alone, for a test.
 */

/** What a call carries, the axes a row is split by, in the order a split is preferred when two are as short. */
const AXES = ['purpose', 'subject', 'fields', 'confirmed', 'attempts', 'params'] as const;
type Axis = (typeof AXES)[number];

function axisValue(c: GateGridCase, axis: Axis): string {
  switch (axis) {
    case 'purpose': return c.purpose ?? 'none';
    case 'subject': return c.subject;
    case 'fields': return c.fields;
    case 'confirmed': return c.confirmation;
    case 'attempts': return String(c.attempts);
    case 'params': return c.params;
  }
}

/** A decision as a row says it: ALLOW, BLOCK <reason>, STEP_UP to <level>, NEEDS_HUMAN <reason>. */
export function verdictText(d: Pick<GateDecision, 'verdict' | 'reason' | 'needLevel'>): string {
  if (d.verdict === 'STEP_UP') return `STEP_UP to ${d.needLevel ?? '?'}`;
  return d.reason === undefined ? d.verdict : `${d.verdict} ${d.reason}`;
}

/** One line of a row: the values of the axes it is split by (none: every call), and the verdict. */
interface Leaf {
  readonly conds: ReadonlyMap<Axis, readonly string[]>;
  readonly verdict: string;
}

/**
 * The shortest split of one caller's verdicts over the axes: an axis the verdicts do not depend on
 * is left out; values with the same verdicts under them are written together (a|b); at each step the
 * axis that gives the fewest lines is taken, the earlier in AXES when two give as few.
 */
function summarize(points: readonly { readonly values: Readonly<Record<Axis, string>>; readonly verdict: string }[]): Leaf[] {
  const domain = Object.fromEntries(AXES.map((a) => [a, [...new Set(points.map((p) => p.values[a]))]])) as Record<Axis, string[]>;
  const keyOf = (v: Readonly<Record<Axis, string>>): string => AXES.map((a) => v[a]).join('\u0000');
  const table = new Map(points.map((p) => [keyOf(p.values), p.verdict]));
  const combos = (assign: Partial<Record<Axis, string>>, free: readonly Axis[]): Record<Axis, string>[] => {
    let out: Partial<Record<Axis, string>>[] = [{ ...assign }];
    for (const a of free) out = out.flatMap((o) => domain[a].map((v) => ({ ...o, [a]: v })));
    return out as Record<Axis, string>[];
  };
  const vector = (assign: Partial<Record<Axis, string>>, free: readonly Axis[]): string[] => combos(assign, free).map((v) => table.get(keyOf(v)) ?? '?');
  const groups = (assign: Partial<Record<Axis, string>>, free: readonly Axis[], axis: Axis): string[][] => {
    const rest = free.filter((a) => a !== axis);
    const by = new Map<string, string[]>();
    for (const value of domain[axis]) {
      const sig = vector({ ...assign, [axis]: value }, rest).join('\u0001');
      const g = by.get(sig);
      if (g) g.push(value);
      else by.set(sig, [value]);
    }
    return [...by.values()];
  };
  const memo = new Map<string, Leaf[]>();
  const solve = (assign: Partial<Record<Axis, string>>, free: readonly Axis[]): Leaf[] => {
    const key = JSON.stringify([assign, free]);
    const known = memo.get(key);
    if (known) return known;
    const all = vector(assign, free);
    let leaves: Leaf[];
    if (all.every((v) => v === all[0])) leaves = [{ conds: new Map(), verdict: all[0]! }];
    else {
      const fixed = { ...assign };
      let left = [...free];
      for (const a of free) {
        if (groups(fixed, left, a).length === 1) {
          fixed[a] = domain[a][0]!;
          left = left.filter((x) => x !== a);
        }
      }
      let best: Leaf[] | null = null;
      for (const a of left) {
        const rest = left.filter((x) => x !== a);
        const split = groups(fixed, left, a).flatMap((g) => solve({ ...fixed, [a]: g[0]! }, rest).map((l) => ({ conds: new Map([[a, g], ...l.conds]), verdict: l.verdict })));
        if (best === null || split.length < best.length) best = split;
      }
      leaves = best!;
    }
    memo.set(key, leaves);
    return leaves;
  };
  // An axis with one value (no subject for this action, one set of params) is fixed, and never written.
  const single = Object.fromEntries(AXES.filter((a) => domain[a].length === 1).map((a) => [a, domain[a][0]!]));
  return solve(single, AXES.filter((a) => domain[a].length > 1));
}

function condText(conds: ReadonlyMap<Axis, readonly string[]>): string {
  return AXES.filter((a) => conds.has(a)).map((a) => `${a} ${conds.get(a)!.join('|')}`).join(', ') || 'any call';
}

/** A rule as a row's header writes it, with its parameters. */
function ruleText(rule: Rule, source: PolicySource): string {
  switch (rule.rule) {
    case 'identity': return 'identity';
    case 'attempts': return `attempts(${source.maxAttempts})`;
    case 'scope': return rule.subject === null ? 'scope(no subject)' : `scope(${rule.subject.via === 'record' ? 'record ' : ''}${rule.subject.param})`;
    case 'role': {
      const access = Object.entries(rule.access).map(([role, a]) => `${role} ${a}`).join(', ');
      return `role(${access || 'none'}${rule.reason === undefined ? '' : `; reason ${rule.reason}`})`;
    }
    case 'confirmed': return `confirmed(${rule.fields.join(', ')})`;
    case 'fields': return `fields(${rule.fields.join(', ')})`;
    case 'dateInRange': return `dateInRange(${rule.field})`;
    case 'limit': return `limit(${rule.field})`;
    case 'custom': return `custom ${rule.id}`;
  }
}

function actionHeader(tool: ToolName, action: PolicyAction | undefined, source: PolicySource): string {
  if (!action) return `${tool} · not in the policy`;
  return `${tool} · level ${action.level} · ${action.rules.map((r) => ruleText(r, source)).join(', ') || 'no rules'}`;
}

function principalText(p: Principal, label: string, subjectKind: string): string {
  if (isAnonymous(p)) return 'no one proven (level 0)';
  const role = p.role === undefined ? (label === 'roleless' ? ' with no role' : '') : `, role ${p.role}`;
  const note = label === 'unlisted-role' ? ' (a role the policy does not name)' : label === 'other-party' ? ' (neither a subject nor of a delegate kind)' : p.kind === subjectKind && subjectKind !== '' ? ' (one of the app\'s subjects)' : /^delegate:.*@1$/.test(label) ? ' (a delegate below level 2)' : '';
  return `${p.kind}${role}, level ${p.level}${note}`;
}

const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - s.length));

// ---------------------------------------------------------------------------------------------
// Custom rules' examples
// ---------------------------------------------------------------------------------------------

/** One example of a custom rule, run through the compiled gate in one action that names the rule. */
export interface RuleExampleResult {
  readonly rule: string;
  readonly example: string;
  readonly tool: ToolName;
  /** What the example expects, as a row says it (BLOCK <reason>, or BLOCK alone when it names none). */
  readonly expected: string;
  readonly decision: GateDecision;
  /** Why the decision is not what the example says; null when it is. */
  readonly problem: string | null;
}

export interface RuleExampleRun {
  readonly results: readonly RuleExampleResult[];
  /** Custom rules that cannot be run: a plain function (no examples), or a rule no action names. */
  readonly unrunnable: readonly string[];
}

export class RuleExampleError extends Error {
  constructor(readonly run: RuleExampleRun, appId: string) {
    const failed = run.results.filter((r) => r.problem !== null);
    super([`app "${appId}": ${failed.length + run.unrunnable.length} custom rule example problem(s)`, ...run.unrunnable.map((u) => `  ${u}`), ...failed.map((r) => `  ${r.problem}`)].join('\n'));
    this.name = 'RuleExampleError';
  }
}

/** The lookups an example runs against: the app's (the policy matrix's, else its systems'), with the example's own set over them. */
function exampleLookups(app: App, own: Readonly<Record<string, unknown>> | undefined): GateLookups {
  const matrix = app.testing?.policyMatrix?.();
  const base = matrix?.lookups?.() ?? app.systems().lookups;
  if (own === undefined) return base;
  // Over a plain object, a copy; over a class's instance, an object whose prototype it is (so its methods keep their state).
  return Object.getPrototypeOf(base) === Object.prototype ? ({ ...base, ...own } as GateLookups) : (Object.assign(Object.create(base) as object, own) as unknown as GateLookups);
}

/**
 * Every example of every custom rule (defineRule), run through the app's compiled gate in every
 * action that names the rule. An example holds when the gate's verdict (and reason, if it names one)
 * is the one it expects, the rule ran, and a refusal is the rule's own. Its facts default to no
 * failed attempts, the call's values confirmed for the action's confirmed fields, and the policy
 * matrix's day (else the regression's).
 */
export function ruleExampleResults(app: App): RuleExampleRun {
  const gate = gateOf(app);
  const source = gate.source;
  const todayIso = app.testing?.policyMatrix?.().todayIso ?? REGRESS_TODAY;
  const results: RuleExampleResult[] = [];
  const unrunnable: string[] = [];
  for (const [id, rule] of Object.entries(source.customRules ?? {})) {
    const actions = Object.entries(source.actions).filter(([, a]) => a.rules.some((r) => r.rule === 'custom' && r.id === id));
    if (!isDefinedRule(rule)) {
      unrunnable.push(`custom rule "${id}" is a plain function, with no examples: define it with defineRule`);
      continue;
    }
    if (actions.length === 0) unrunnable.push(`custom rule "${id}" is named by no action, so its examples have nowhere to run`);
    for (const ex of rule.examples) {
      for (const [tool, action] of actions) {
        const confirmed = action.rules.find((r): r is Extract<Rule, { rule: 'confirmed' }> => r.rule === 'confirmed');
        const facts: GateFacts = { attempts: 0, confirmedHash: confirmed ? confirmationHash(ex.call.params, confirmed.fields) : null, todayIso, ...ex.facts };
        const call: ToolCall = ex.call.purpose === undefined ? { tool, params: { ...ex.call.params } } : { tool, params: { ...ex.call.params }, purpose: ex.call.purpose };
        const decision = gate.evaluate(call, ex.principal, facts, exampleLookups(app, ex.lookups));
        const expected = verdictText(ex.expect);
        const got = verdictText(decision);
        const last = decision.rules.at(-1);
        const ran = decision.rules.some((r) => r.id === id);
        let why: string | null = null;
        if (decision.verdict !== ex.expect.verdict || (ex.expect.reason !== undefined && decision.reason !== ex.expect.reason)) why = `expected ${expected}, got ${got}`;
        if (!ran) why = `${why ?? `got ${got}`}, and the gate stopped at ${last?.id ?? 'nothing'} before the rule ran`;
        else if (decision.verdict !== 'ALLOW' && last?.id !== id) why = `${why ?? `got ${got}`}, a refusal by ${last?.id ?? 'nothing'}, not by the rule`;
        const problem = why === null ? null : `custom rule "${id}" example "${ex.name}" in ${tool}: ${why}`;
        results.push({ rule: id, example: ex.name, tool, expected, decision, problem });
      }
    }
  }
  return { results, unrunnable };
}

/** Every custom rule's examples, asserted: the results when each holds, a RuleExampleError naming each that does not (and each rule that cannot be run). */
export function runRuleExamples(app: App): readonly RuleExampleResult[] {
  const run = ruleExampleResults(app);
  if (run.unrunnable.length > 0 || run.results.some((r) => r.problem !== null)) throw new RuleExampleError(run, app.id);
  return run.results;
}

// ---------------------------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------------------------

/**
 * policy.matrix's text for `app`: the header, the callers and what a call carries, the purposes,
 * every action (the policy's, then any tool or identity tool it does not list, then an action no app
 * has) with a row per kind of caller, and the custom rules' examples. Throws a RuleExampleError when
 * an example does not hold: a matrix is only written for rules that do what their examples say.
 */
export function policyMatrixText(app: App, input: GateGridInput = gateGridInput(app)): string {
  const gate = gateOf(app);
  const source = gate.source;
  const examples = ruleExampleResults(app);
  if (examples.results.some((r) => r.problem !== null)) throw new RuleExampleError({ results: examples.results, unrunnable: [] }, app.id);

  const cases = gateGridCases(input);
  const principals = gridPrincipals(input.matrix);
  const out: string[] = [
    `# policy.matrix: what the gate of "${app.id}" decides, for every action and every kind of caller.`,
    '# Written by `pnpm policy:matrix` from the compiled policy (policy.yaml, identity.yaml) and the',
    '# app\'s policy matrix (TestingHooks.policyMatrix); a test fails when it differs. Never edit it by',
    '# hand: a difference here is a change in what the agent may do, to be reviewed as the policy is.',
    '#',
    '# Under each action (its level and its rules as the file writes them), a row per kind of caller.',
    '# A row with one verdict holds for every call that caller can make; otherwise its lines split it',
    '# by what the call carries, a|b meaning either value. "as <caller>" repeats that caller\'s verdicts.',
    '#',
    '# callers',
  ];
  const labelWidth = Math.max(...principals.map(([l]) => l.length), 'every caller'.length) + 2;
  for (const [label, p] of principals) out.push(`#   ${pad(label, labelWidth)}${principalText(p, label, gate.subjectKind)}`);
  out.push(
    '# what a call carries',
    '#   purpose     none; entry-check, retry-check (the lifecycle\'s probes); a form\'s purpose',
    '#   subject     own; inScope (a subject the delegates act for); outOfScope; unknown; empty',
    '#   fields      exact; extra (one field more); missing (one field less: the subject\'s own when it is the only one)',
    '#   confirmed   none; match (the caller confirmed exactly these values); mismatch',
    `#   attempts    0; ${source.maxAttempts} (the maximum)`,
    '#   params      the policy matrix\'s named sets of values for the action',
    '# verdicts: ALLOW; BLOCK <reason>; STEP_UP to <level>; NEEDS_HUMAN <reason>',
    '',
    `purposes: ${Object.entries(source.purposes).map(([purpose, level]) => `${purpose} needs level ${level}`).join(', ') || 'none'}`,
  );

  const byTool = new Map<ToolName, GateGridCase[]>();
  for (const c of cases) {
    const list = byTool.get(c.tool);
    if (list) list.push(c);
    else byTool.set(c.tool, [c]);
  }
  const tools = [...Object.keys(source.actions), ...[...byTool.keys()].filter((t) => !Object.hasOwn(source.actions, t) && t !== UNLISTED_TOOL), UNLISTED_TOOL];
  for (const tool of tools) {
    const toolCases = byTool.get(tool) ?? [];
    if (toolCases.length === 0) continue;
    const action = Object.hasOwn(source.actions, tool) ? source.actions[tool] : undefined;
    out.push('', actionHeader(tool, action, source));
    const rows: { label: string; leaves: Leaf[] | null; as?: string }[] = [];
    const signatures = new Map<string, string>();
    for (const [label] of principals) {
      const points = toolCases.filter((c) => c.principal === label).map((c) => ({
        values: Object.fromEntries(AXES.map((a) => [a, axisValue(c, a)])) as Record<Axis, string>,
        verdict: verdictText(gate.evaluate(c.call, c.p, c.facts, input.lookups)),
      }));
      const sig = JSON.stringify(points.map((p) => [AXES.map((a) => p.values[a]), p.verdict]));
      const same = signatures.get(sig);
      if (same !== undefined) rows.push({ label, leaves: null, as: same });
      else {
        signatures.set(sig, label);
        rows.push({ label, leaves: summarize(points) });
      }
    }
    // Every caller alike: one row.
    const shown = rows.length > 0 && rows.slice(1).every((r) => r.as === rows[0]!.label) ? [{ ...rows[0]!, label: 'every caller' }] : rows;
    for (const row of shown) {
      if (row.leaves === null) {
        out.push(`  ${pad(row.label, labelWidth)}as ${row.as}`);
        continue;
      }
      // Aligned within the row, so a change to one caller's verdicts moves no other caller's lines.
      const condWidth = Math.max(...row.leaves.map((l) => condText(l.conds).length)) + 2;
      row.leaves.forEach((leaf, i) => {
        const lead = i === 0 ? pad(row.label, labelWidth) : ' '.repeat(labelWidth);
        out.push(`  ${lead}${row.leaves!.length === 1 && leaf.conds.size === 0 ? leaf.verdict : `${pad(condText(leaf.conds), condWidth)}${leaf.verdict}`}`);
      });
    }
  }

  const rules = Object.entries(source.customRules ?? {});
  if (rules.length > 0) {
    out.push('', 'custom rules, and their examples as the gate decides them in each action that names the rule');
    for (const [id, rule] of rules) {
      out.push(`  ${id}: ${isDefinedRule(rule) ? rule.description : '(a plain function, with no examples)'}`);
      const mine = examples.results.filter((r) => r.rule === id);
      const width = Math.max(0, ...mine.map((r) => `${r.tool}  ${r.example}`.length)) + 2;
      for (const r of mine) out.push(`    ${pad(`${r.tool}  ${r.example}`, width)}${verdictText(r.decision)}`);
    }
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// The golden
// ---------------------------------------------------------------------------------------------

/** A line diff of two texts, as hunks with `context` lines around each change: "-" the golden's, "+" the gate's. */
export function lineDiff(expected: string, actual: string, context = 2, limit = 80): string {
  const a = expected.split('\n');
  const b = actual.split('\n');
  // The longest common subsequence, by dynamic programming from the end.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const ops: { op: ' ' | '-' | '+'; line: string; at: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ op: ' ', line: a[i]!, at: i + 1 });
      i += 1;
      j += 1;
    } else if (i < a.length && (j >= b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      ops.push({ op: '-', line: a[i]!, at: i + 1 });
      i += 1;
    } else {
      ops.push({ op: '+', line: b[j]!, at: i + 1 });
      j += 1;
    }
  }
  // Every change, with `context` unchanged lines around it; "@@ line N" (the golden's line) where a run starts.
  const keep = ops.map(() => false);
  ops.forEach((o, k) => {
    if (o.op === ' ') return;
    for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x += 1) keep[x] = true;
  });
  const out: string[] = [];
  let prev = -2;
  ops.forEach((o, k) => {
    if (!keep[k]) return;
    if (k !== prev + 1) out.push(`@@ line ${o.at}`);
    out.push(`${o.op} ${o.line}`);
    prev = k;
  });
  if (out.length > limit) return [...out.slice(0, limit), `... and ${out.length - limit} more diff lines`].join('\n');
  return out.join('\n');
}

/**
 * Fails, with a readable diff, when `file` (an app's policy.matrix) is not what the app's gate
 * decides today. `regenerate` is the command the message tells the reader to run when the change is
 * meant (default: `pnpm policy:matrix <the file's folder, from the working directory>`). Never writes the file.
 */
export function expectPolicyMatrix(app: App, file: string, regenerate = `pnpm policy:matrix ${relative(process.cwd(), dirname(file)) || '.'}`): void {
  const actual = policyMatrixText(app);
  if (!existsSync(file)) throw new Error(`there is no policy matrix at ${file}: write it with \`${regenerate}\`, then review it and commit it`);
  const expected = readFileSync(file, 'utf8');
  if (expected === actual) return;
  throw new Error([
    `${file} is not what the gate of "${app.id}" decides ("-" the reviewed matrix, "+" the gate today):`,
    lineDiff(expected, actual),
    `If the change is meant, write it with \`${regenerate}\` and review the diff before you commit it.`,
  ].join('\n'));
}

/** Writes `app`'s policy matrix to `file`; whether it changed. For the policy:matrix command, never a test. */
export function writePolicyMatrix(app: App, file: string): { changed: boolean; lines: number } {
  const text = policyMatrixText(app);
  const changed = !existsSync(file) || readFileSync(file, 'utf8') !== text;
  if (changed) writeFileSync(file, text);
  return { changed, lines: text.split('\n').length - 1 };
}
