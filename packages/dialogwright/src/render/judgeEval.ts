import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CASSETTE_MISS } from '../jev/cassette';
import { stubAnswerDrift, stubDocumentsDrift, stubSpanDrift } from '../jev/heuristicStub';
import { isNoul, type JevClient, type JsonValue } from '../jev/types';
import { ADDED_FIRE, addedReading, compareQuestions, compareReading, compareState, DRIFT_ALONE_FIRE, figuresToCompare, type FigureComparison, ANSWER_DRIFT_QUESTION_ID, DOCUMENTS_ADDED_QUESTION_ID, renderDocumentsAddedQuestion, DOCUMENTS_DRIFT_QUESTION_ID, renderDocumentsDriftQuestion, renderDocumentsDriftState, checkAnswer, checkSpan, cleanAnswer, cleanSpan, DRIFT_FIRE, renderAnswerDriftQuestion, renderAnswerDriftState, renderSpanDriftQuestion, renderSpanDriftState, sameWords, SPAN_DRIFT_QUESTION_ID, wordCount } from './checks';
import { answerWordBudget, DEFAULT_DOCUMENTS_WORDS } from './config';
import { spanSentence } from './prompt';
import { DEFAULT_RENDER_CHECK_TIMEOUT_MS, type RenderFallback, type SpanAct } from './types';

/**
 * Measuring the span drift judge (`render:judge-eval`, live findings items 23 and 25). A set of cases,
 * each a caller's message (`content`) and a summary of it (`span`) labelled faithful or unfaithful by a
 * person, is put to three readers, each as a call puts a span to it: the data checks (checkSpan: a
 * span's data and shape), the stub regression's judge (stubSpanDrift, a test double), and the real
 * drift judge (the decision model asked renderSpanDriftQuestion with the state renderSpanDriftState
 * makes, nothing else). The tables say, per family, how many unfaithful spans each catches, alone and
 * together, and how many faithful ones each refuses, so how well the judge reads meaning is a
 * measurement, and a change to its question is measured before it ships. Nothing here is asked of a
 * model by itself: the judge is a client handed in (a cassette, recording or replaying:
 * ../harness-text/judgeEvalCommand.ts).
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
/**
 * The framed line each case's span is said in, by its perspective (its act's `sentence`, as a call sends
 * one; live findings item 24): spoken to the caller, the secretary demo's read-back; in the caller's own
 * terms, the message fixture's. The span is `{summary}`; a to-caller case's names fill their variables
 * (`{recipient}`), every other variable stays a placeholder, as on a call.
 */
export const JUDGE_FRAMES: Readonly<Record<'as-caller' | 'to-caller', string>> = {
  'as-caller': "Okay, thanks! I'll make sure {recipient} hears that {caller}, on {phone}, called and left this message: {summary}. Shall I pass it on?",
  'to-caller': "Thanks! I'll make sure {recipient} gets your message, in short: {summary}. I have you as {caller}, on {phone}. Shall I pass it on?",
};

/** The word budget a case's span is held to when it names none: wide, so `words` measures nothing here. */
export const DEFAULT_WORDS = 25;

const caseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and hyphens'),
  family: z.string().regex(/^[a-z][a-z-]*$/, 'lowercase letters and hyphens'),
  expected: z.enum(['faithful', 'unfaithful']),
  /**
   * Whose words the span gives: a caller's message, in their own terms or spoken to them; or `answer`, a
   * knowledge answer worded for the caller's question (a span `from: answer`): `content` is then the
   * approved passage, `question` the caller's question, and `span` the wording; or `documents`, an answer
   * worded from sections of approved documents (a span `from: sections`): `content` is then the sections,
   * each as `Heading: text`, apart by a blank line.
   */
  speaks: z.enum(['as-caller', 'to-caller', 'answer', 'documents']),
  /** An answer case's question, in the caller's own words (required with `speaks: answer`). */
  question: z.string().min(1).optional(),
  /**
   * A documents case's earlier question on the call, in the caller's own words, which `question` may
   * continue (kb.yaml documents.followUps): the judge is sent it and asked the follow-up wording of its
   * question, as a call that reads follow-ups asks it.
   */
  earlier: z.string().min(1).optional(),
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
    if ((c.question !== undefined) !== (c.speaks === 'answer' || c.speaks === 'documents')) throw new Error(`${path}:${i + 1}: ${c.id}: an answer case (speaks: answer or documents) has a question, and only an answer case does`);
    if (c.earlier !== undefined && c.speaks !== 'documents') throw new Error(`${path}:${i + 1}: ${c.id}: only a documents case (speaks: documents) has an earlier question`);
    seen.add(c.id);
    cases.push(c);
  });
  if (cases.length === 0) throw new Error(`${path}: no cases`);
  return cases;
}

/** The goal an answer case is given when it names none (a member line's, as an app's answer line would say it). */
export const DEFAULT_ANSWER_GOAL = "Answer the caller's question from the passage, in a sentence or two.";
/** The goal a documents case is given when it names none. */
export const DEFAULT_DOCUMENTS_GOAL = "Answer the caller's question from the sections, in a sentence or two.";

/**
 * A case's span act, as the engine builds one for a framed line's span: its content quoted under
 * `message`, said in its perspective's frame (JUDGE_FRAMES); an answer case's as render/turn.ts builds a
 * knowledge answer's: the passage under `answer`, the line `{answer}` alone, its budget the passage's own
 * word count unless the case sets one, and the caller's question.
 */
export function actOf(c: JudgeCase): SpanAct {
  if (c.speaks === 'documents') {
    return {
      kind: 'span',
      goal: c.goal ?? DEFAULT_DOCUMENTS_GOAL,
      sentence: spanSentence('{answer}', 'answer'),
      content: c.content.split('\n\n').map((value) => ({ name: 'answer', value })),
      channel: 'voice',
      language: 'en-US',
      style: { persona: 'a plain-spoken agent', words: c.words ?? DEFAULT_DOCUMENTS_WORDS, avoid: [] },
      answer: { question: c.question ?? '', from: 'sections', ...(c.earlier !== undefined ? { earlier: c.earlier } : {}) },
    };
  }
  if (c.speaks === 'answer') {
    return {
      kind: 'span',
      goal: c.goal ?? DEFAULT_ANSWER_GOAL,
      sentence: spanSentence('{answer}', 'answer'),
      content: [{ name: 'answer', value: c.content }],
      channel: 'voice',
      language: 'en-US',
      style: { persona: 'a plain-spoken agent', words: c.words ?? answerWordBudget(wordCount(c.content)), avoid: [] },
      answer: { question: c.question ?? '' },
    };
  }
  const names = Object.entries(c.names ?? {}).map(([name, value]) => ({ name, value }));
  return {
    kind: 'span',
    goal: c.goal ?? DEFAULT_GOALS[c.speaks],
    sentence: spanSentence(JUDGE_FRAMES[c.speaks], 'summary', c.speaks === 'to-caller' ? names : []),
    content: [{ name: 'message', value: c.content }],
    channel: 'voice',
    language: 'en-US',
    style: { persona: 'a warm receptionist', words: c.words ?? DEFAULT_WORDS, avoid: [] },
    ...(c.speaks === 'to-caller' ? { speaks: 'to-caller' as const, ...(names.length > 0 ? { names } : {}) } : {}),
  };
}

/** The question a case's judge is asked, by its id: a knowledge answer's, or a span's. */
const questionIdOf = (c: JudgeCase, documentsAsk: DocumentsAsk = 'drift'): string => (c.speaks === 'documents' ? (documentsAsk === 'added' ? DOCUMENTS_ADDED_QUESTION_ID : DOCUMENTS_DRIFT_QUESTION_ID) : c.speaks === 'answer' ? ANSWER_DRIFT_QUESTION_ID : SPAN_DRIFT_QUESTION_ID);

/** What the documents judge asks (style.yaml judge.documentsAsk): the drift yes-or-no, how much of the wording is its own, or both. */
export type DocumentsAsk = 'drift' | 'added' | 'both';

/** The judge's request for a case: exactly what a call sends for this span (its state and its question). */
export function judgeRequest(c: JudgeCase, documentsAsk: DocumentsAsk = 'drift'): { state: JsonValue; questions: ReturnType<typeof renderSpanDriftQuestion> } {
  const act = actOf(c);
  if (c.speaks === 'documents') {
    const earlier = c.earlier !== undefined;
    const questions = documentsAsk === 'added' ? renderDocumentsAddedQuestion(earlier) : documentsAsk === 'both' ? { ...renderDocumentsDriftQuestion(earlier), ...renderDocumentsAddedQuestion(earlier) } : renderDocumentsDriftQuestion(earlier);
    return { state: renderDocumentsDriftState(act, cleanAnswer(c.span, act)) as unknown as JsonValue, questions };
  }
  if (c.speaks === 'answer') return { state: renderAnswerDriftState(act, cleanAnswer(c.span, act)) as unknown as JsonValue, questions: renderAnswerDriftQuestion() };
  return { state: renderSpanDriftState(act, cleanSpan(c.span)) as unknown as JsonValue, questions: renderSpanDriftQuestion(act.speaks) };
}

/** What the shape checks make of a span: a check's name (refused), `unchanged` (the content's own words, said as they are), or null (passed). */
export type CodeVerdict = RenderFallback | 'unchanged' | null;
/**
 * The real judge's answer: its probability that the span is unfaithful (with the added judge, that it adds
 * anything; refused at `fire`, DRIFT_FIRE where absent), with `both` the added reading beside it (refused only
 * where both reach their cutoffs), or why there is none.
 */
export type JudgeVerdict = { p: number; fire?: number; added?: { p: number; fire: number; alone: number }; compare?: { figure: string; said: string; p: number; lines: readonly string[]; fire: number } } | { missing: string } | { error: string };

export interface CaseResult {
  readonly case: JudgeCase;
  /** checkSpan, as a call runs it: the checks of its data and shape (values, figures, the budget, the phrases to avoid, no question, no other recipient). */
  readonly checks: CodeVerdict;
  /** The stub regression's judge: true where it holds the span unfaithful. */
  readonly stub: boolean;
  readonly judge: JudgeVerdict;
}

function codeVerdict(c: JudgeCase): CodeVerdict {
  const act = actOf(c);
  // An answer from documents: no shortcut for the sections' own words, as a call has none.
  if (c.speaks === 'documents') return checkAnswer(cleanAnswer(c.span, act), act);
  if (c.speaks === 'answer') {
    const worded = cleanAnswer(c.span, act);
    // As a call does: a wording that is the passage's own words is said as the passage, with nothing asked.
    return sameWords(worded, c.content) ? 'unchanged' : checkAnswer(worded, act);
  }
  const text = cleanSpan(c.span);
  // As a call does: a wording that is its content's own words is said unchanged, with nothing asked.
  if (sameWords(text, c.content)) return 'unchanged';
  return checkSpan(text, act, { conflicts: c.conflicts ?? [] });
}

/** Whether a reader refuses the span (the data checks: a check's name; the judge: at or above its cutoff, DRIFT_FIRE unless it says). */
export const refusedByCode = (v: CodeVerdict): boolean => v !== null && v !== 'unchanged';
export const refusedByJudge = (v: JudgeVerdict): boolean | null =>
  'p' in v ? (v.added !== undefined && v.p >= v.added.alone) || (v.p >= (v.fire ?? DRIFT_FIRE) && (v.added === undefined || v.added.p >= v.added.fire)) || (v.compare !== undefined && v.compare.p >= v.compare.fire) : null;

export interface EvalProgress {
  (line: string): void;
}

/**
 * Puts every case to the three readers. The judge (`judge`) is asked one case at a time, in order; a
 * request that fails is that case's `error` (a cassette's miss, its `missing`), and three failures running
 * that are not misses stop the asking (a key refused, the endpoint down): the cases after are `error` too.
 * `redact` is applied to every error text kept (the command passes the key, so it is never printed).
 */
export async function evaluateCases(cases: readonly JudgeCase[], judge: JevClient, opts: { timeoutMs?: number; redact?: (s: string) => string; progress?: EvalProgress; documentsAsk?: DocumentsAsk; compareFigures?: FigureComparison } = {}): Promise<CaseResult[]> {
  const ask = opts.documentsAsk ?? 'drift';
  const redact = opts.redact ?? ((s: string) => s);
  const out: CaseResult[] = [];
  let failedRunning = 0;
  let stopped: string | null = null;
  for (const [i, c] of cases.entries()) {
    const base = judgeRequest(c, ask);
    // An app's question of each figure (judge.compareFigures), asked as a call asks it, for an answer from documents.
    const cmp = c.speaks === 'documents' ? opts.compareFigures : undefined;
    const figures = cmp !== undefined ? figuresToCompare(cleanAnswer(c.span, actOf(c)), c.content.split('\n\n')) : [];
    const req = base;
    // The comparison is a request of its own, the wording alone in its state, as a call sends it.
    const compareReq = cmp !== undefined && figures.length > 0 ? { state: compareState(cleanAnswer(c.span, actOf(c))) as unknown as JsonValue, questions: compareQuestions(cmp, figures) } : null;
    let verdict: JudgeVerdict;
    if (stopped !== null) verdict = { error: stopped };
    else {
      try {
        const r = await judge.ask({ ...req, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
        const a = r.answers[questionIdOf(c, ask)];
        const documents = c.speaks === 'documents';
        const p = documents && ask === 'added' ? addedReading(a) : isNoul(a) ? a.noul : null;
        const addedP = documents && ask === 'both' ? addedReading(r.answers[DOCUMENTS_ADDED_QUESTION_ID]) : undefined;
        const compared = compareReq !== null ? await judge.ask({ ...compareReq, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) }) : null;
        const mismatch = cmp !== undefined && compared !== null ? compareReading(cmp, figures, compared.answers) : null;
        verdict = p === null || addedP === null
          ? { error: 'the answer was not a probability' }
          : {
              p,
              ...(documents && ask === 'added' ? { fire: ADDED_FIRE } : {}),
              ...(addedP !== undefined ? { added: { p: addedP, fire: ADDED_FIRE, alone: DRIFT_ALONE_FIRE } } : {}),
              ...(mismatch !== null && cmp !== undefined ? { compare: { figure: mismatch.figure, said: mismatch.said, p: mismatch.score, lines: mismatch.lines, fire: cmp.refuseAt } } : {}),
            };
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
    out.push({ case: c, checks: codeVerdict(c), stub: c.speaks === 'documents' ? stubDocumentsDrift(req.state) : c.speaks === 'answer' ? stubAnswerDrift(req.state) : stubSpanDrift(req.state), judge: verdict });
    if (opts.progress && (i + 1) % 20 === 0) opts.progress(`  ${i + 1} of ${cases.length} cases`);
  }
  return out;
}

/** A row of a table: how many cases, and how many each reader, and the data checks and the judge together, refuse. */
export interface Tally {
  readonly label: string;
  readonly cases: number;
  readonly checks: number;
  readonly stub: number;
  /** Cases the judge answered; the judge's counts are of these. */
  readonly answered: number;
  readonly judge: number;
  /** Refused by the data checks or the judge: what a call does. */
  readonly together: number;
  /** Refused by neither (for unfaithful cases, missed by both). */
  readonly neither: number;
}

export function tally(label: string, results: readonly CaseResult[]): Tally {
  const judged = results.filter((r) => refusedByJudge(r.judge) !== null);
  const j = (r: CaseResult): boolean => refusedByJudge(r.judge) === true;
  const code = (r: CaseResult): boolean => refusedByCode(r.checks);
  return {
    label,
    cases: results.length,
    checks: results.filter(code).length,
    stub: results.filter((r) => r.stub).length,
    answered: judged.length,
    judge: judged.filter(j).length,
    together: judged.filter((r) => code(r) || j(r)).length,
    neither: judged.filter((r) => !code(r) && !j(r)).length,
  };
}

/** How often a faithful span is said (the data checks pass it, and the judge does, or is not asked for words said unchanged). */
export interface SaidRates {
  readonly cases: number;
  readonly answered: number;
  /** The data checks and the judge together: what a call does. */
  readonly together: number;
  readonly judgeAlone: number;
  readonly checksAlone: number;
}

export function saidRates(faithful: readonly CaseResult[]): SaidRates {
  const judged = faithful.filter((r) => r.checks === 'unchanged' || refusedByJudge(r.judge) !== null);
  const judgeSays = (r: CaseResult): boolean => r.checks === 'unchanged' || refusedByJudge(r.judge) === false;
  return {
    cases: faithful.length,
    answered: judged.length,
    together: judged.filter((r) => !refusedByCode(r.checks) && judgeSays(r)).length,
    judgeAlone: judged.filter(judgeSays).length,
    checksAlone: faithful.filter((r) => !refusedByCode(r.checks)).length,
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
  /** What the documents judge was asked (style.yaml judge.documentsAsk); absent: drift. */
  readonly documentsAsk?: DocumentsAsk;
  /** The app's question of each figure (style.yaml judge.compareFigures), where it was asked. */
  readonly compareFigures?: FigureComparison;
  /** How long the judge took, timed on the requests this run sent it (none when every answer was replayed). */
  readonly latency?: JudgeLatency;
}

/** The judge's latency over the requests a run sent it: what a call waits after a wording. */
export interface JudgeLatency {
  readonly measured: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

/** The latency of the requests timed (milliseconds), or undefined when none was. */
export function judgeLatency(ms: readonly number[]): JudgeLatency | undefined {
  if (ms.length === 0) return undefined;
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (q: number): number => Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!);
  return { measured: sorted.length, p50: at(0.5), p95: at(0.95), max: Math.round(sorted[sorted.length - 1]!) };
}

const pct = (n: number, of: number): string => (of === 0 ? '-' : `${n} (${Math.round((100 * n) / of)}%)`);
const judgeCell = (n: number, t: Tally): string => (t.answered === 0 ? '-' : t.answered === t.cases ? pct(n, t.answered) : `${pct(n, t.answered)} of ${t.answered}`);
const families = (results: readonly CaseResult[]): string[] => [...new Set(results.map((r) => r.case.family))].sort();
const quote = (s: string): string => `"${s.replace(/\|/g, '\\|')}"`;
const codeText = (v: CodeVerdict): string => (v === null ? 'pass' : v);
const judgeText = (v: JudgeVerdict): string => ('p' in v ? v.p.toFixed(2) : 'missing' in v ? 'not recorded' : 'error');

function unfaithfulTable(rows: readonly Tally[]): string[] {
  return [
    '| | cases | data checks | stub | judge | together | missed by both |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((t) => `| ${t.label} | ${t.cases} | ${pct(t.checks, t.cases)} | ${pct(t.stub, t.cases)} | ${judgeCell(t.judge, t)} | ${judgeCell(t.together, t)} | ${judgeCell(t.neither, t)} |`),
  ];
}
function faithfulTable(rows: readonly Tally[]): string[] {
  return [
    '| | cases | data checks | stub | judge | together |',
    '|---|---|---|---|---|---|',
    ...rows.map((t) => `| ${t.label} | ${t.cases} | ${pct(t.checks, t.cases)} | ${pct(t.stub, t.cases)} | ${judgeCell(t.judge, t)} | ${judgeCell(t.together, t)} |`),
  ];
}
const caseLine = (r: CaseResult): string =>
  `- \`${r.case.id}\` (${r.case.family}, ${r.case.speaks}${r.case.names ? `, names ${Object.values(r.case.names).join(', ')}` : ''}): ${r.case.speaks === 'answer' || r.case.speaks === 'documents' ? `${quote(r.case.question ?? '')} of ${quote(r.case.content)}, worded ${quote(r.case.span)}` : `${quote(r.case.content)} read back ${quote(r.case.span)}`}; judge ${judgeText(r.judge)}, data checks ${codeText(r.checks)}, stub ${r.stub ? 'refused' : 'passed'}. ${r.case.note}`;

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
    '# The span drift judge and the data checks',
    '',
    `${all.length} cases (${unfaithful.length} unfaithful, ${faithful.length} faithful) from ${report.casesFile}. The judge: ${report.model} (${report.provider}), ${report.replay ? 'replayed from' : 'recorded into'} ${report.cassette}; it refuses at ${DRIFT_FIRE} or above${report.documentsAsk === 'added' ? `, and an answer from documents is asked how much of it is its own (judge.documentsAsk: added), refused where the probability that it adds anything is ${ADDED_FIRE} or above` : report.documentsAsk === 'both' ? `, and an answer from documents is asked that and how much of it is its own (judge.documentsAsk: both), refused where the first is ${DRIFT_FIRE} or above and the probability that it adds anything ${ADDED_FIRE} or above, or the first alone ${DRIFT_ALONE_FIRE} or above` : ''}${report.compareFigures !== undefined ? `; each figure of an answer from documents is also asked "${report.compareFigures.question}" of the answer and of each line that gives it, refused where the answer's pick is ${report.compareFigures.refuseAt} or more likely and differs from every line's` : ''}. ${answered} of ${all.length} answered${missing > 0 ? `, ${missing} not recorded (record them: the command without --replay)` : ''}${errors.length > 0 ? `, ${errors.length} failed` : ''}.`,
    '',
    ...(report.latency
      ? [`The judge's latency, timed on the ${report.latency.measured} requests this run sent it (the connection opened first; answers replayed from the cassette are not timed): p50 ${report.latency.p50} ms, p95 ${report.latency.p95} ms, max ${report.latency.max} ms. On a call it has RENDER_CHECK_TIMEOUT_MS after the wording (default ${DEFAULT_RENDER_CHECK_TIMEOUT_MS.voice} ms by voice, ${DEFAULT_RENDER_CHECK_TIMEOUT_MS.chat} ms in a chat); a judge that answers later leaves the fixed text said.`, '']
      : []),
    ...(all.some((r) => r.case.speaks === 'documents')
      ? ['Documents cases (speaks: documents): an answer worded for the caller\'s question from sections of approved documents (`content`, each section as `Heading: text`); data checks: checkAnswer as a call runs it (empty, format, question, frame, the word budget, 60 unless the case sets one, avoid, a figure the sections do not have); stub: stubDocumentsDrift; judge: the decision model asked renderDocumentsDriftQuestion with the state a call sends (the goal, the wording heard in its line, the sections and the question).', '']
      : []),
    ...(all.some((r) => r.case.speaks === 'answer')
      ? ['Answer cases (speaks: answer): a knowledge answer worded for the caller\'s question from its approved passage (`content`); data checks: checkAnswer as a call runs it (empty, format, question, frame, the word budget, the passage\'s word count and a quarter more (ten more at least) unless the case sets one, avoid, a figure the passage does not have); stub: stubAnswerDrift; judge: the decision model asked renderAnswerDriftQuestion with the state a call sends (the goal, the wording heard in its line, the passage and the question).', '']
      : []),
    'data checks: checkSpan as a call runs it, the checks of a span\'s data and shape (empty, format, question, conflict, the word budget, avoid, foreign figures). stub: the stub regression\'s judge, a simple test double. judge: the decision model asked renderSpanDriftQuestion with the state a call sends, the span heard in a representative sentence (spoken to the caller, the secretary demo\'s read-back; in the caller\'s terms, the message fixture\'s). together: the data checks and the judge, as a call runs them.',
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
      `A good read-back of an everyday message is said (otherwise the caller hears their exact words): with the data checks and the judge, as a call runs them, ${rate(s.together, s.answered)}; with the judge alone ${rate(s.judgeAlone, s.answered)}; with the data checks alone ${rate(s.checksAlone, s.cases)}.`,
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
  const codeRefusedFaithful = faithful.filter((r) => refusedByCode(r.checks));
  const missedByBoth = unfaithful.filter((r) => refusedByJudge(r.judge) === false && !refusedByCode(r.checks));
  lines.push(
    `## Unfaithful spans the judge passed (${missedByJudge.length})`,
    '',
    ...(missedByJudge.length > 0 ? missedByJudge.map(caseLine) : ['None.']),
    '',
    `## Faithful spans the judge refused (${refusedFaithful.length})`,
    '',
    ...(refusedFaithful.length > 0 ? refusedFaithful.map(caseLine) : ['None.']),
    '',
    `## Unfaithful spans both the data checks and the judge passed (${missedByBoth.length})`,
    '',
    ...(missedByBoth.length > 0 ? missedByBoth.map(caseLine) : ['None.']),
    '',
    `## Faithful spans the data checks refused (${codeRefusedFaithful.length})`,
    '',
    ...(codeRefusedFaithful.length > 0 ? codeRefusedFaithful.map(caseLine) : ['None.']),
    '',
  );
  if (errors.length > 0) lines.push(`## The judge failed (${errors.length})`, '', ...errors.map((r) => `- \`${r.case.id}\`: ${'error' in r.judge ? r.judge.error : ''}`), '');
  lines.push(
    '## Every case',
    '',
    '| id | family | speaks | expected | data checks | stub | judge p |',
    '|---|---|---|---|---|---|---|',
    ...all.map((r) => `| ${r.case.id} | ${r.case.family} | ${r.case.speaks} | ${r.case.expected} | ${codeText(r.checks)} | ${r.stub ? 'refused' : 'passed'} | ${judgeText(r.judge)} |`),
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
    ...(report.documentsAsk !== undefined && report.documentsAsk !== 'drift' ? { documentsAsk: report.documentsAsk, addedFire: ADDED_FIRE } : {}),
    ...(report.latency ? { latency: report.latency } : {}),
    realisticSaid: saidRates(realFaithful),
    unfaithful: tally('unfaithful', report.results.filter((r) => r.case.expected === 'unfaithful')),
    faithful: tally('faithful', report.results.filter((r) => r.case.expected === 'faithful')),
    cases: report.results.map((r) => ({ id: r.case.id, family: r.case.family, speaks: r.case.speaks, expected: r.case.expected, checks: r.checks, stub: r.stub, judge: r.judge })),
  }, null, 2);
}
