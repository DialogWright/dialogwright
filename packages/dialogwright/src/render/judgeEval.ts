import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CASSETTE_MISS } from '../jev/cassette';
import { stubSpanDrift } from '../jev/heuristicStub';
import { isNoul, type JevClient, type JsonValue } from '../jev/types';
import { checkSpan, cleanSpan, type SpanCheckLevel, DRIFT_FIRE, renderSpanDriftQuestion, renderSpanDriftState, sameWords, SPAN_DRIFT_QUESTION_ID } from './checks';
import type { RenderFallback, SpanAct } from './types';

/**
 * Measuring the span drift judge against the span's shape checks (`render:judge-eval`, live findings
 * item 23). A set of cases, each a caller's message (`content`) and a summary of it (`span`) labelled
 * faithful or unfaithful by a person, is put to three readers, each as a call puts a span to it: the
 * shape checks (checkSpan at `standard`, the default, the checks of values, shape and voice, and at `strict`, every check), the
 * stub regression's judge (stubSpanDrift), and the real drift judge (the decision model asked
 * renderSpanDriftQuestion with the state renderSpanDriftState makes, nothing else). The tables say, per
 * family, how many unfaithful spans each catches and how many faithful ones each refuses, so how strict
 * the span's checks should be is decided on a measurement. Nothing here is asked of a model by itself:
 * the judge is a client handed in (a cassette, recording or replaying: ../harness-text/judgeEvalCommand.ts).
 */

/** The cases the command reads when none are named: written by hand, invented names, 555 numbers. */
export const DEFAULT_CASES_FILE = fileURLToPath(new URL('./judgeCases/spans.jsonl', import.meta.url));

/** The family whose cases are everyday messages and their read-backs: tabled first, apart from the hard cases. */
export const REALISTIC = 'realistic';

/** The goal a case's span is given when it names none (a receptionist's, as the secretary's read-back). */
export const DEFAULT_GOALS: Readonly<Record<'as-caller' | 'to-caller', string>> = {
  'as-caller': "Summarize the caller's message briefly, in their own terms, as a receptionist reading it back.",
  'to-caller': 'Give the caller their message back briefly, speaking to them, as a receptionist reading it back.',
};
/** The word budget a case's span is held to when it names none: wide, so `words` measures nothing here. */
export const DEFAULT_WORDS = 25;

const caseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and hyphens'),
  family: z.string().regex(/^[a-z][a-z-]*$/, 'lowercase letters and hyphens'),
  expected: z.enum(['faithful', 'unfaithful']),
  speaks: z.enum(['as-caller', 'to-caller']),
  /** A to-caller span's names (who the message is for), each under its variable: `{ recipient: "Sam Ortiz" }`. */
  names: z.record(z.string().regex(/^[a-z][A-Za-z0-9_]*$/), z.string().min(1)).optional(),
  content: z.string().min(1),
  span: z.string().min(1),
  goal: z.string().min(1).optional(),
  words: z.number().int().positive().optional(),
  /** Other values of the frame's items (another recipient), the `conflict` check's. */
  conflicts: z.array(z.string().min(1)).optional(),
  note: z.string().min(1),
});
export type JudgeCase = z.infer<typeof caseSchema>;

/** Reads a case file (JSON Lines); throws with the line and what is wrong at the first bad case, or an id given twice. */
export function loadJudgeCases(path: string): JudgeCase[] {
  const cases: JudgeCase[] = [];
  const seen = new Set<string>();
  readFileSync(path, 'utf8').split('\n').forEach((raw, i) => {
    if (raw.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${path}:${i + 1}: not JSON`);
    }
    const r = caseSchema.safeParse(parsed);
    if (!r.success) throw new Error(`${path}:${i + 1}: ${r.error.issues.map((x) => `${x.path.join('.') || 'case'}: ${x.message}`).join('; ')}`);
    const c = r.data;
    if (seen.has(c.id)) throw new Error(`${path}:${i + 1}: the id ${c.id} is given twice`);
    if (c.names !== undefined && c.speaks !== 'to-caller') throw new Error(`${path}:${i + 1}: ${c.id}: names are for a to-caller span only`);
    seen.add(c.id);
    cases.push(c);
  });
  if (cases.length === 0) throw new Error(`${path}: no cases`);
  return cases;
}

/** A case's span act, as the engine builds one for a framed line's span: its content quoted under `message`. */
export function actOf(c: JudgeCase): SpanAct {
  const names = Object.entries(c.names ?? {}).map(([name, value]) => ({ name, value }));
  return {
    kind: 'span',
    goal: c.goal ?? DEFAULT_GOALS[c.speaks],
    content: [{ name: 'message', value: c.content }],
    channel: 'voice',
    language: 'en-US',
    style: { persona: 'a warm receptionist', words: c.words ?? DEFAULT_WORDS, avoid: [] },
    ...(c.speaks === 'to-caller' ? { speaks: 'to-caller' as const, ...(names.length > 0 ? { names } : {}) } : {}),
  };
}

/** The judge's request for a case: exactly what a call sends for this span (its state and its question). */
export function judgeRequest(c: JudgeCase): { state: JsonValue; questions: ReturnType<typeof renderSpanDriftQuestion> } {
  const act = actOf(c);
  return { state: renderSpanDriftState(act, cleanSpan(c.span)) as unknown as JsonValue, questions: renderSpanDriftQuestion(act.speaks) };
}

/** What the shape checks make of a span: a check's name (refused), `unchanged` (the content's own words, said as they are), or null (passed). */
export type CodeVerdict = RenderFallback | 'unchanged' | null;
/** The real judge's answer: its probability that the span is unfaithful, or why there is none. */
export type JudgeVerdict = { p: number } | { missing: string } | { error: string };

export interface CaseResult {
  readonly case: JudgeCase;
  /** checkSpan at `strict`: every check. */
  readonly strict: CodeVerdict;
  /** checkSpan at `standard`, the default: its checks of values, shape and voice (values, foreign figures and names, the budget, a plain negation, a person the content does not use, gender). */
  readonly standard: CodeVerdict;
  /** The stub regression's judge: true where it holds the span unfaithful. */
  readonly stub: boolean;
  readonly judge: JudgeVerdict;
}

function codeVerdict(c: JudgeCase, level: SpanCheckLevel): CodeVerdict {
  const act = actOf(c);
  const text = cleanSpan(c.span);
  // As a call does: a wording that is its content's own words is said unchanged, with nothing asked.
  if (sameWords(text, c.content)) return 'unchanged';
  return checkSpan(text, act, { conflicts: c.conflicts ?? [] }, level);
}

/** Whether a reader refuses the span (the shape checks: a check's name; the judge: at or above DRIFT_FIRE). */
export const refusedByCode = (v: CodeVerdict): boolean => v !== null && v !== 'unchanged';
export const refusedByJudge = (v: JudgeVerdict): boolean | null => ('p' in v ? v.p >= DRIFT_FIRE : null);

export interface EvalProgress {
  (line: string): void;
}

/**
 * Puts every case to the three readers. The judge (`judge`) is asked one case at a time, in order; a
 * request that fails is that case's `error` (a cassette's miss, its `missing`), and three failures running
 * that are not misses stop the asking (a key refused, the endpoint down): the cases after are `error` too.
 * `redact` is applied to every error text kept (the command passes the key, so it is never printed).
 */
export async function evaluateCases(cases: readonly JudgeCase[], judge: JevClient, opts: { timeoutMs?: number; redact?: (s: string) => string; progress?: EvalProgress } = {}): Promise<CaseResult[]> {
  const redact = opts.redact ?? ((s: string) => s);
  const out: CaseResult[] = [];
  let failedRunning = 0;
  let stopped: string | null = null;
  for (const [i, c] of cases.entries()) {
    const req = judgeRequest(c);
    let verdict: JudgeVerdict;
    if (stopped !== null) verdict = { error: stopped };
    else {
      try {
        const r = await judge.ask({ ...req, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
        const a = r.answers[SPAN_DRIFT_QUESTION_ID];
        verdict = isNoul(a) ? { p: a.noul } : { error: 'the answer was not a probability' };
        failedRunning = 0;
      } catch (e) {
        const message = redact(e instanceof Error ? e.message : String(e));
        if (message.startsWith(CASSETTE_MISS)) verdict = { missing: 'not recorded' };
        else {
          verdict = { error: message };
          if (++failedRunning >= 3) stopped = `not asked: the judge failed 3 cases running (${message})`;
        }
      }
    }
    out.push({ case: c, strict: codeVerdict(c, 'strict'), standard: codeVerdict(c, 'standard'), stub: stubSpanDrift(req.state), judge: verdict });
    if (opts.progress && (i + 1) % 20 === 0) opts.progress(`  ${i + 1} of ${cases.length} cases`);
  }
  return out;
}

/** A row of a table: how many cases, and how many each reader (and pair of readers) refuses. */
export interface Tally {
  readonly label: string;
  readonly cases: number;
  readonly strict: number;
  readonly standard: number;
  readonly stub: number;
  /** Cases the judge answered; the judge's counts are of these. */
  readonly answered: number;
  readonly judge: number;
  readonly strictOrJudge: number;
  readonly standardOrJudge: number;
  /** Refused by neither the strict checks nor the judge (for unfaithful cases, missed by both). */
  readonly strictNeither: number;
  readonly standardNeither: number;
}

export function tally(label: string, results: readonly CaseResult[]): Tally {
  const judged = results.filter((r) => refusedByJudge(r.judge) !== null);
  const j = (r: CaseResult): boolean => refusedByJudge(r.judge) === true;
  const strict = (r: CaseResult): boolean => refusedByCode(r.strict);
  const standard = (r: CaseResult): boolean => refusedByCode(r.standard);
  return {
    label,
    cases: results.length,
    strict: results.filter(strict).length,
    standard: results.filter(standard).length,
    stub: results.filter((r) => r.stub).length,
    answered: judged.length,
    judge: judged.filter(j).length,
    strictOrJudge: judged.filter((r) => strict(r) || j(r)).length,
    standardOrJudge: judged.filter((r) => standard(r) || j(r)).length,
    strictNeither: judged.filter((r) => !strict(r) && !j(r)).length,
    standardNeither: judged.filter((r) => !standard(r) && !j(r)).length,
  };
}

/** How often a faithful span is said (its checks pass it, and the judge does, or is not asked for words said unchanged), under each level. */
export interface SaidRates {
  readonly cases: number;
  readonly answered: number;
  readonly standardAndJudge: number;
  readonly strictAndJudge: number;
  readonly judgeAlone: number;
  readonly strictAlone: number;
}

export function saidRates(faithful: readonly CaseResult[]): SaidRates {
  const judged = faithful.filter((r) => r.strict === 'unchanged' || refusedByJudge(r.judge) !== null);
  const judgeSays = (r: CaseResult): boolean => r.strict === 'unchanged' || refusedByJudge(r.judge) === false;
  return {
    cases: faithful.length,
    answered: judged.length,
    standardAndJudge: judged.filter((r) => !refusedByCode(r.standard) && judgeSays(r)).length,
    strictAndJudge: judged.filter((r) => !refusedByCode(r.strict) && judgeSays(r)).length,
    judgeAlone: judged.filter(judgeSays).length,
    strictAlone: faithful.filter((r) => !refusedByCode(r.strict)).length,
  };
}

/** What the command prints and writes: the cases, the judge, and every result. */
export interface JudgeEvalReport {
  readonly casesFile: string;
  readonly model: string;
  readonly provider: string;
  readonly replay: boolean;
  readonly cassette: string;
  readonly results: readonly CaseResult[];
}

const pct = (n: number, of: number): string => (of === 0 ? '-' : `${n} (${Math.round((100 * n) / of)}%)`);
const judgeCell = (n: number, t: Tally): string => (t.answered === 0 ? '-' : t.answered === t.cases ? pct(n, t.answered) : `${pct(n, t.answered)} of ${t.answered}`);
const families = (results: readonly CaseResult[]): string[] => [...new Set(results.map((r) => r.case.family))].sort();
const quote = (s: string): string => `"${s.replace(/\|/g, '\\|')}"`;
const codeText = (v: CodeVerdict): string => (v === null ? 'pass' : v);
const judgeText = (v: JudgeVerdict): string => ('p' in v ? v.p.toFixed(2) : 'missing' in v ? 'not recorded' : 'error');

function unfaithfulTable(rows: readonly Tally[]): string[] {
  return [
    '| | cases | standard | strict | stub | judge | standard or judge | strict or judge | missed by standard and judge | missed by strict and judge |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((t) => `| ${t.label} | ${t.cases} | ${pct(t.standard, t.cases)} | ${pct(t.strict, t.cases)} | ${pct(t.stub, t.cases)} | ${judgeCell(t.judge, t)} | ${judgeCell(t.standardOrJudge, t)} | ${judgeCell(t.strictOrJudge, t)} | ${judgeCell(t.standardNeither, t)} | ${judgeCell(t.strictNeither, t)} |`),
  ];
}
function faithfulTable(rows: readonly Tally[]): string[] {
  return [
    '| | cases | standard | strict | stub | judge | standard or judge | strict or judge |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map((t) => `| ${t.label} | ${t.cases} | ${pct(t.standard, t.cases)} | ${pct(t.strict, t.cases)} | ${pct(t.stub, t.cases)} | ${judgeCell(t.judge, t)} | ${judgeCell(t.standardOrJudge, t)} | ${judgeCell(t.strictOrJudge, t)} |`),
  ];
}
const caseLine = (r: CaseResult): string =>
  `- \`${r.case.id}\` (${r.case.family}, ${r.case.speaks}${r.case.names ? `, names ${Object.values(r.case.names).join(', ')}` : ''}): ${quote(r.case.content)} read back ${quote(r.case.span)}; judge ${judgeText(r.judge)}, standard ${codeText(r.standard)}, strict ${codeText(r.strict)}, stub ${r.stub ? 'refused' : 'passed'}. ${r.case.note}`;

/** The report as Markdown lines: the everyday cases first, then the hard cases by family, every case, and the lists to read. */
export function formatJudgeEval(report: JudgeEvalReport): string[] {
  const all = report.results;
  const faithful = all.filter((r) => r.case.expected === 'faithful');
  const unfaithful = all.filter((r) => r.case.expected === 'unfaithful');
  const realistic = all.filter((r) => r.case.family === REALISTIC);
  const edge = all.filter((r) => r.case.family !== REALISTIC);
  const by = (rs: readonly CaseResult[], expected: 'faithful' | 'unfaithful') => rs.filter((r) => r.case.expected === expected);
  const answered = all.filter((r) => 'p' in r.judge).length;
  const missing = all.filter((r) => 'missing' in r.judge).length;
  const errors = all.filter((r) => 'error' in r.judge);
  const lines: string[] = [
    '# The span drift judge against the shape checks',
    '',
    `${all.length} cases (${unfaithful.length} unfaithful, ${faithful.length} faithful) from ${report.casesFile}. The judge: ${report.model} (${report.provider}), ${report.replay ? 'replayed from' : 'recorded into'} ${report.cassette}; it refuses at ${DRIFT_FIRE} or above. ${answered} of ${all.length} answered${missing > 0 ? `, ${missing} not recorded (record them: the command without --replay)` : ''}${errors.length > 0 ? `, ${errors.length} failed` : ''}.`,
    '',
    'standard: checkSpan at `checks: standard`, the default (its checks of values, shape and voice: empty, format, question, conflict, a plain negation against the content\'s words, the word budget, avoid, foreign figures and names, a person the content does not use, a to-caller span\'s own I or we, a he or she of another gender; the rest is the judge\'s). strict: checkSpan at `checks: strict` (every check: besides, `omitted`, and `person`: who does what to whom, the message\'s own "you", a "your" for no "my"). stub: the stub regression\'s judge, which holds the strict reading too. judge: the decision model asked renderSpanDriftQuestion with the state a call sends.',
    '',
  ];
  // The everyday picture first.
  const realFaithful = by(realistic, 'faithful');
  const realSlips = by(realistic, 'unfaithful');
  if (realistic.length > 0) {
    const s = saidRates(realFaithful);
    const rate = (n: number, of: number): string => (of === 0 ? '-' : `${n} of ${of} (${Math.round((100 * n) / of)}%)`);
    lines.push(
      '## Everyday messages (the realistic family)',
      '',
      `A good read-back of an everyday message is said (otherwise the caller hears their exact words): under checks: standard (the default: its checks and the judge) ${rate(s.standardAndJudge, s.answered)}; under checks: strict (every check and the judge) ${rate(s.strictAndJudge, s.answered)}; with the judge alone ${rate(s.judgeAlone, s.answered)}; with the strict checks alone ${rate(s.strictAlone, s.cases)}.`,
      '',
      'Good read-backs wrongly refused (each one costs the caller the summary; they hear their exact words):',
      '',
      ...faithfulTable([tally('as-caller', realFaithful.filter((r) => r.case.speaks === 'as-caller')), tally('to-caller', realFaithful.filter((r) => r.case.speaks === 'to-caller')), tally('all', realFaithful)]),
      '',
      'Everyday slips caught (each one missed is a wrong message said):',
      '',
      ...unfaithfulTable([tally('as-caller', realSlips.filter((r) => r.case.speaks === 'as-caller')), tally('to-caller', realSlips.filter((r) => r.case.speaks === 'to-caller')), tally('all', realSlips)]),
      '',
    );
  }
  const edgeUnfaithful = by(edge, 'unfaithful');
  const edgeFaithful = by(edge, 'faithful');
  lines.push(
    '## The hard cases, by family',
    '',
    'Unfaithful spans caught:',
    '',
    ...unfaithfulTable([...families(edgeUnfaithful).map((f) => tally(f, edgeUnfaithful.filter((r) => r.case.family === f))), tally('all', edgeUnfaithful)]),
    '',
    'Faithful spans wrongly refused:',
    '',
    ...faithfulTable([...families(edgeFaithful).map((f) => tally(f, edgeFaithful.filter((r) => r.case.family === f))), tally('all', edgeFaithful)]),
    '',
    '## Every case together',
    '',
    ...unfaithfulTable([tally('unfaithful', unfaithful)]),
    '',
    ...faithfulTable([tally('faithful', faithful)]),
    '',
  );
  const missedByJudge = unfaithful.filter((r) => refusedByJudge(r.judge) === false);
  const refusedFaithful = faithful.filter((r) => refusedByJudge(r.judge) === true);
  const codeRefusedFaithful = faithful.filter((r) => refusedByCode(r.strict));
  const missedByBoth = unfaithful.filter((r) => refusedByJudge(r.judge) === false && !refusedByCode(r.strict));
  lines.push(
    `## Unfaithful spans the judge passed (${missedByJudge.length})`,
    '',
    ...(missedByJudge.length > 0 ? missedByJudge.map(caseLine) : ['None.']),
    '',
    `## Faithful spans the judge refused (${refusedFaithful.length})`,
    '',
    ...(refusedFaithful.length > 0 ? refusedFaithful.map(caseLine) : ['None.']),
    '',
    `## Unfaithful spans both the strict checks and the judge passed (${missedByBoth.length})`,
    '',
    ...(missedByBoth.length > 0 ? missedByBoth.map(caseLine) : ['None.']),
    '',
    `## Faithful spans the strict checks refused (${codeRefusedFaithful.length})`,
    '',
    ...(codeRefusedFaithful.length > 0 ? codeRefusedFaithful.map(caseLine) : ['None.']),
    '',
  );
  if (errors.length > 0) lines.push(`## The judge failed (${errors.length})`, '', ...errors.map((r) => `- \`${r.case.id}\`: ${'error' in r.judge ? r.judge.error : ''}`), '');
  lines.push(
    '## Every case',
    '',
    '| id | family | speaks | expected | standard | strict | stub | judge p |',
    '|---|---|---|---|---|---|---|---|',
    ...all.map((r) => `| ${r.case.id} | ${r.case.family} | ${r.case.speaks} | ${r.case.expected} | ${codeText(r.standard)} | ${codeText(r.strict)} | ${r.stub ? 'refused' : 'passed'} | ${judgeText(r.judge)} |`),
  );
  return lines;
}

/** The report as JSON: the run, the everyday rates, and every case with each reader's verdict. */
export function judgeEvalJson(report: JudgeEvalReport): string {
  const realFaithful = report.results.filter((r) => r.case.family === REALISTIC && r.case.expected === 'faithful');
  return JSON.stringify({
    casesFile: report.casesFile,
    model: report.model,
    provider: report.provider,
    replay: report.replay,
    cassette: report.cassette,
    fire: DRIFT_FIRE,
    realisticSaid: saidRates(realFaithful),
    unfaithful: tally('unfaithful', report.results.filter((r) => r.case.expected === 'unfaithful')),
    faithful: tally('faithful', report.results.filter((r) => r.case.expected === 'faithful')),
    cases: report.results.map((r) => ({ id: r.case.id, family: r.case.family, speaks: r.case.speaks, expected: r.case.expected, standard: r.standard, strict: r.strict, stub: r.stub, judge: r.judge })),
  }, null, 2);
}
