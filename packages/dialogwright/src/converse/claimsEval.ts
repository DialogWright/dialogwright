import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requestKey } from '../jev/cassette';
import type { AnswerMap, JevClient, JsonValue, QuestionMap } from '../jev/types';
import { askWithin } from './confirm';

/**
 * Measuring the check after speaking's questions offline (`dialogwright converse:claims-eval`,
 * docs/designs/2026-11-11-claims-check.md): replies kept by `pnpm eval --claims-cases`, a label a person gave
 * each (wrong or not), and a variant, a set of questions with the rules that turn the answers into a score.
 * Each variant asks the decision model once per case; the answers are kept in a cassette, so a rule can be
 * changed and scored again with no new request. The report says how well each rule separates the wrong replies
 * from the right ones. It holds the case ids and the labels' kinds, never the words of a call.
 */

/** One reply the check read: the state it was sent, and the reading the run had. */
export interface ClaimsCase {
  /** `<folder>/<id>`: the id the eval gave it, prefixed with the folder of the cases file it came from. */
  id: string;
  /** The state exactly as the check was sent it: `{business, today, actions, reply}`. */
  state: JsonValue;
}

/** What a person (or a reviewer) said of a reply. */
export interface ClaimsLabel {
  id: string;
  /** The reply states something the business information or the call's actions contradict, or says something was done that the actions do not show. */
  wrong: boolean;
  /** How bad, 0 (none) to 4. */
  severity: number;
  kinds: string[];
  /** The reply commits the business to what its information does not address. */
  gap: boolean;
  why: string;
}

/** A rule: one request's answers turned into a number (higher: more likely the label it targets); null: unread. */
export interface ClaimsRule {
  target: 'wrong' | 'gap';
  score: (answers: AnswerMap) => number | null;
}

/** A set of questions and the rules that read their answers. */
export interface ClaimsVariant {
  name: string;
  questions: QuestionMap;
  rules: Record<string, ClaimsRule>;
}

export const THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] as const;

/** The cases of cases files: each file's lines after its business line, ids prefixed with the folder's name; the business a case is sent with is the latest line before it. */
export function loadCases(files: readonly string[]): ClaimsCase[] {
  const out: ClaimsCase[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const folder = basename(dirname(resolve(file)));
    let business: string | null = null;
    readFileSync(file, 'utf8').split('\n').forEach((raw, i) => {
      if (raw.trim() === '') return;
      let line: Record<string, unknown>;
      try {
        line = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new Error(`${file} line ${i + 1}: not JSON`);
      }
      if (typeof line.business === 'string' && line.id === undefined) {
        business = line.business;
        return;
      }
      if (typeof line.id !== 'string' || typeof line.today !== 'string' || typeof line.reply !== 'string' || line.actions === undefined) throw new Error(`${file} line ${i + 1}: expected a case with id, today, actions and reply`);
      if (business === null) throw new Error(`${file} line ${i + 1}: a case before any business line`);
      const id = `${folder}/${line.id}`;
      if (seen.has(id)) throw new Error(`${file} line ${i + 1}: the case id ${id} is not unique; the files' folders must have different names`);
      seen.add(id);
      out.push({ id, state: { business, today: line.today, actions: line.actions as JsonValue, reply: line.reply } });
    });
  }
  return out;
}

/** The labels file's labels by id. */
export function loadLabels(file: string): Map<string, ClaimsLabel> {
  const out = new Map<string, ClaimsLabel>();
  readFileSync(file, 'utf8').split('\n').forEach((raw, i) => {
    if (raw.trim() === '') return;
    let l: Partial<ClaimsLabel>;
    try {
      l = JSON.parse(raw) as Partial<ClaimsLabel>;
    } catch {
      throw new Error(`${file} line ${i + 1}: not JSON`);
    }
    if (typeof l.id !== 'string' || typeof l.wrong !== 'boolean') throw new Error(`${file} line ${i + 1}: expected a label with id and wrong`);
    out.set(l.id, {
      id: l.id,
      wrong: l.wrong,
      severity: typeof l.severity === 'number' ? l.severity : 0,
      kinds: Array.isArray(l.kinds) ? l.kinds.filter((k): k is string => typeof k === 'string') : [],
      gap: l.gap === true,
      why: typeof l.why === 'string' ? l.why : '',
    });
  });
  return out;
}

/** A variant module's default export, held to the shape. */
export async function loadVariant(file: string): Promise<ClaimsVariant> {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new Error(`${file}: no such file`);
  const mod = (await import(pathToFileURL(abs).href)) as { default?: Partial<ClaimsVariant> };
  const v = mod.default;
  if (v === undefined || typeof v.name !== 'string' || typeof v.questions !== 'object' || v.questions === null || typeof v.rules !== 'object' || v.rules === null) {
    throw new Error(`${file}: expected a default export { name, questions, rules }`);
  }
  for (const [rule, r] of Object.entries(v.rules)) {
    if ((r.target !== 'wrong' && r.target !== 'gap') || typeof r.score !== 'function') throw new Error(`${file}: rule ${rule} needs a target (wrong or gap) and a score function`);
  }
  return v as ClaimsVariant;
}

/** Each case's answers to a variant's questions (null: the model erred or was late), by case id. */
export type VariantAnswers = Map<string, AnswerMap | null>;

/**
 * Asks the variant's questions of each case, a few at a time, through `jev` (the cassette). Identical requests
 * in flight at once are asked once. Never throws for a case: an unanswered one is null.
 */
export async function askVariant(jev: JevClient, v: ClaimsVariant, cases: readonly ClaimsCase[], o: { timeoutMs: number; concurrency?: number; progress?: (done: number, of: number) => void }): Promise<VariantAnswers> {
  const out: VariantAnswers = new Map();
  const inFlight = new Map<string, Promise<AnswerMap | null>>();
  const ask = (c: ClaimsCase): Promise<AnswerMap | null> => {
    const key = requestKey({ state: c.state, questions: v.questions });
    let p = inFlight.get(key);
    if (p === undefined) {
      p = askWithin(jev, c.state, v.questions, o.timeoutMs);
      inFlight.set(key, p);
    }
    return p;
  };
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const c = cases[next++];
      if (c === undefined) return;
      out.set(c.id, await ask(c));
      o.progress?.(++done, cases.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 4) }, worker));
  return out;
}

/** What a threshold does to a rule's scores. */
export interface ThresholdRow {
  threshold: number;
  flagged: number;
  tp: number;
  fp: number;
  fn: number;
  recall: number | null;
  precision: number | null;
}

export interface RuleReport {
  variant: string;
  rule: string;
  target: 'wrong' | 'gap';
  /** The labelled cases the rule was asked of, and how many of them it could not read. */
  cases: number;
  scored: number;
  unread: number;
  /** The cases the label says are the target (wrong, or gap). */
  positives: number;
  thresholds: ThresholdRow[];
  /** Recall over the positives of severity 2 or more, at each threshold (null: there are none). */
  severeRecall: { positives: number; at: Array<number | null> };
  /** Recall over the positives of each kind, at each threshold. */
  kindRecall: Array<{ kind: string; positives: number; at: Array<number | null> }>;
  /** Average precision: the area under the precision-recall curve, the unread positives last. */
  averagePrecision: number | null;
}

const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);

/** Average precision of scored cases (positive or not), over `positives` positives in all (the unread among them). Tied scores share one precision. */
export function averagePrecision(scored: ReadonlyArray<{ score: number; positive: boolean }>, positives: number): number | null {
  if (positives === 0) return null;
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  let seen = 0;
  let hit = 0;
  let sum = 0;
  for (let i = 0; i < sorted.length;) {
    let j = i;
    let groupHits = 0;
    while (j < sorted.length && sorted[j]!.score === sorted[i]!.score) {
      if (sorted[j]!.positive) groupHits += 1;
      j += 1;
    }
    seen += j - i;
    hit += groupHits;
    sum += groupHits * (hit / seen);
    i = j;
  }
  return sum / positives;
}

/** One rule's figures over the labelled cases. `score` is the rule's number for a case id, or null. */
export function measureRule(variant: string, rule: string, r: ClaimsRule, labelled: ReadonlyArray<{ label: ClaimsLabel; score: number | null }>): RuleReport {
  const isPositive = (l: ClaimsLabel): boolean => (r.target === 'wrong' ? l.wrong : l.gap);
  const positives = labelled.filter((c) => isPositive(c.label));
  const scored = labelled.filter((c): c is { label: ClaimsLabel; score: number } => c.score !== null);
  const recallOf = (set: typeof labelled, t: number): number | null => ratio(set.filter((c) => c.score !== null && c.score >= t).length, set.length);
  const thresholds: ThresholdRow[] = THRESHOLDS.map((threshold) => {
    const flagged = scored.filter((c) => c.score >= threshold);
    const tp = flagged.filter((c) => isPositive(c.label)).length;
    return { threshold, flagged: flagged.length, tp, fp: flagged.length - tp, fn: positives.length - tp, recall: ratio(tp, positives.length), precision: ratio(tp, flagged.length) };
  });
  const severe = positives.filter((c) => c.label.severity >= 2);
  const kinds = [...new Set(positives.flatMap((c) => c.label.kinds))].sort();
  return {
    variant,
    rule,
    target: r.target,
    cases: labelled.length,
    scored: scored.length,
    unread: labelled.length - scored.length,
    positives: positives.length,
    thresholds,
    severeRecall: { positives: severe.length, at: THRESHOLDS.map((t) => recallOf(severe, t)) },
    kindRecall: kinds.map((kind) => {
      const set = positives.filter((c) => c.label.kinds.includes(kind));
      return { kind, positives: set.length, at: THRESHOLDS.map((t) => recallOf(set, t)) };
    }),
    averagePrecision: averagePrecision(scored.map((c) => ({ score: c.score, positive: isPositive(c.label) })), positives.length),
  };
}

/** The whole measurement's figures. */
export interface ClaimsEvalReport {
  cases: number;
  labelled: number;
  /** Cases with no label, skipped. */
  unlabelled: number;
  /** Labels naming no case. */
  orphanLabels: number;
  wrong: number;
  gap: number;
  rules: RuleReport[];
  /** The live requests' times, per variant (absent where all were recorded). */
  latency: Array<{ variant: string; requests: number; medianMs: number; p95Ms: number }>;
  /** Each wrong (or gap) case under each rule: no words of the call. */
  wrongCases: Array<{ id: string; kinds: string[]; severity: number; wrong: boolean; gap: boolean; scores: Record<string, number | null> }>;
}

export function measure(cases: readonly ClaimsCase[], labels: ReadonlyMap<string, ClaimsLabel>, variants: ReadonlyArray<{ variant: ClaimsVariant; answers: VariantAnswers }>, latency: ClaimsEvalReport['latency'] = []): ClaimsEvalReport {
  const labelled = cases.filter((c) => labels.has(c.id));
  const ids = new Set(cases.map((c) => c.id));
  const rules: RuleReport[] = [];
  const scoreOf = new Map<string, Map<string, number | null>>();
  for (const { variant, answers } of variants) {
    for (const [name, rule] of Object.entries(variant.rules)) {
      const scores = new Map<string, number | null>();
      const rows = labelled.map((c) => {
        const a = answers.get(c.id) ?? null;
        const score = a === null ? null : rule.score(a);
        scores.set(c.id, score !== null && Number.isFinite(score) ? score : null);
        return { label: labels.get(c.id)!, score: scores.get(c.id) ?? null };
      });
      scoreOf.set(`${variant.name}/${name}`, scores);
      rules.push(measureRule(variant.name, name, rule, rows));
    }
  }
  const flaggedCases = labelled.filter((c) => labels.get(c.id)!.wrong || labels.get(c.id)!.gap);
  return {
    cases: cases.length,
    labelled: labelled.length,
    unlabelled: cases.length - labelled.length,
    orphanLabels: [...labels.keys()].filter((id) => !ids.has(id)).length,
    wrong: labelled.filter((c) => labels.get(c.id)!.wrong).length,
    gap: labelled.filter((c) => labels.get(c.id)!.gap).length,
    rules,
    latency,
    wrongCases: flaggedCases.map((c) => {
      const l = labels.get(c.id)!;
      return { id: c.id, kinds: l.kinds, severity: l.severity, wrong: l.wrong, gap: l.gap, scores: Object.fromEntries([...scoreOf].map(([k, m]) => [k, m.get(c.id) ?? null])) };
    }),
  };
}

const pct = (n: number | null): string => (n === null ? '-' : n.toFixed(2));
const sec = (n: number): string => `${Math.round(n)} ms`;

/** The latency figures of a list of request times. */
export function latencyOf(variant: string, times: readonly number[]): ClaimsEvalReport['latency'][number] | null {
  if (times.length === 0) return null;
  const s = [...times].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
  return { variant, requests: s.length, medianMs: at(0.5), p95Ms: at(0.95) };
}

/** The report as Markdown lines. */
export function formatClaimsEval(r: ClaimsEvalReport): string[] {
  const out: string[] = ['# The check after speaking, measured', ''];
  out.push(`${r.cases} cases, ${r.labelled} labelled (${r.wrong} wrong, ${r.gap} with a gap), ${r.unlabelled} without a label skipped${r.orphanLabels > 0 ? `, ${r.orphanLabels} labels naming no case` : ''}.`, '');
  for (const rule of r.rules) {
    out.push(`## ${rule.variant} / ${rule.rule} (target: ${rule.target})`, '');
    out.push(`Cases scored ${rule.scored} of ${rule.cases}, unread ${rule.unread}; ${rule.positives} ${rule.target === 'wrong' ? 'wrong' : 'with a gap'}; average precision ${pct(rule.averagePrecision)}.`, '');
    out.push('| threshold | flagged | true positives | false positives | false negatives | recall | precision |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const t of rule.thresholds) out.push(`| ${t.threshold} | ${t.flagged} | ${t.tp} | ${t.fp} | ${t.fn} | ${pct(t.recall)} | ${pct(t.precision)} |`);
    out.push('');
    const head = `| | cases | ${THRESHOLDS.join(' | ')} |`;
    const rule2 = `| --- | --- | ${THRESHOLDS.map(() => '---').join(' | ')} |`;
    out.push('Recall at each threshold:', '', head, rule2);
    out.push(`| severity 2 or more | ${rule.severeRecall.positives} | ${rule.severeRecall.at.map(pct).join(' | ')} |`);
    for (const k of rule.kindRecall) out.push(`| kind: ${k.kind} | ${k.positives} | ${k.at.map(pct).join(' | ')} |`);
    out.push('');
  }
  if (r.latency.length > 0) {
    out.push('## Live requests', '', '| variant | requests | median | p95 |', '| --- | --- | --- | --- |');
    for (const l of r.latency) out.push(`| ${l.variant} | ${l.requests} | ${sec(l.medianMs)} | ${sec(l.p95Ms)} |`);
    out.push('');
  }
  const keys = r.rules.map((x) => `${x.variant}/${x.rule}`);
  out.push('## Each wrong or gap case under each rule', '');
  if (r.wrongCases.length === 0) out.push('None.');
  else {
    out.push(`| id | label | kinds | severity | ${keys.join(' | ')} |`, `| --- | --- | --- | --- | ${keys.map(() => '---').join(' | ')} |`);
    for (const c of r.wrongCases) out.push(`| ${c.id} | ${[c.wrong ? 'wrong' : '', c.gap ? 'gap' : ''].filter(Boolean).join(', ')} | ${c.kinds.join(', ') || '-'} | ${c.severity} | ${keys.map((k) => pct(c.scores[k] ?? null)).join(' | ')} |`);
  }
  out.push('');
  return out;
}
