import type { AnswerMap, QuestionMap } from '../jev/types';
import { rankProbabilities } from '../jev/types';
import type { GateRow } from '../core/gates';
import type { Decision } from '../core/decision';
import type { Action } from '../channel/actions';
import { endFrame } from '../channel/relay/frames';
import type { Metrics } from './metrics';
import type { SlotState } from '../core/session';
import type { SlotId } from '../core/app/types';

const f2 = (n: number): string => n.toFixed(2);

export function formatAnswers(questions: QuestionMap, answers: AnswerMap): string {
  const lines: string[] = [];
  const width = Math.max(...Object.keys(questions).map((k) => k.length));
  for (const [id, q] of Object.entries(questions)) {
    const a = answers[id];
    if (!a) continue;
    let cell: string;
    if (a.type === 'noul') cell = f2(a.noul);
    else if (a.type === 'score') cell = q.type === 'score' ? q.levels.map((l) => `${l.label} ${f2(a.probabilities[l.label] ?? 0)}`).join('  ') : '';
    else cell = rankProbabilities(a.probabilities).slice(0, 3).map((r) => `${r.label} ${f2(r.p)}`).join('  ');
    lines.push(`${id.padEnd(width)}  ${cell}`);
  }
  return lines.join('\n');
}

export function formatGates(rows: GateRow[]): string {
  const width = Math.max(...rows.map((r) => r.gate.length), 4);
  const lines = [`${'gate'.padEnd(width)}  value  thresh  result  outcome`];
  for (const r of rows) {
    const value = r.value === null ? '  -  ' : f2(r.value).padStart(5);
    const thresh = r.threshold === null ? '   -  ' : f2(r.threshold).padStart(6);
    const result = r.threshold === null ? 'info' : r.passed ? 'pass' : 'FAIL';
    lines.push(`${r.gate.padEnd(width)}  ${value}  ${thresh}  ${result.padEnd(6)}  ${r.outcome}${r.decided ? '  <==' : ''}`);
  }
  return lines.join('\n');
}

/** Filled slots only, one per line: id, stored value, spoken form, and whether the caller confirmed it. */
export function formatSlots(slots: Record<SlotId, SlotState>): string {
  const filled = Object.entries(slots).filter(([, s]) => s.value !== null);
  if (!filled.length) return '';
  const idWidth = Math.max(...filled.map(([id]) => id.length), 4);
  const valueWidth = Math.max(...filled.map(([, s]) => s.value!.length), 5);
  const lines = [`${'slot'.padEnd(idWidth)}  ${'value'.padEnd(valueWidth)}  display`];
  for (const [id, s] of filled) {
    lines.push(`${id.padEnd(idWidth)}  ${s.value!.padEnd(valueWidth)}  ${s.display ?? s.value}${s.confirmed ? '  confirmed' : ''}`);
  }
  return lines.join('\n');
}

export function formatDecision(decision: Decision, actions: readonly Action[]): string {
  const head = 'promptId' in decision ? `${decision.kind} ${decision.promptId}` : decision.kind;
  const extra = decision.kind === 'handoff' ? ` (${decision.reason})` : decision.kind === 'prompt' && decision.target ? ` -> ${decision.target}` : '';
  return [`decision: ${head}${extra}`, ...actions.flatMap(actionLines)].join('\n');
}

/**
 * One line per thing the caller hears or the call does, as the CLI has always printed them: words
 * after `>`, a clip as `[play]`, and the call's end with the handoff details the relay is handed.
 */
function actionLines(a: Action): string[] {
  switch (a.type) {
    case 'say': return a.parts.map((p) => ('text' in p ? `  > ${p.text}` : '  [play]'));
    case 'end': return [`  [end] ${endFrame('completed', a.completed).handoffData}`];
    case 'transfer': return [`  [end] ${endFrame(a.reason, a.completed, a.queued, a.slots).handoffData}`];
    case 'send_digits': return ['  [sendDigits]'];
    case 'set_language': return ['  [language]'];
  }
}

export function formatMetrics(m: Metrics): string {
  const lines = [
    `sessions ${m.sessions}   turns ${m.turns}   prompt turns ${m.promptTurns}`,
    `slots filled per utterance  ${m.slotsFilledPerUtterance.toFixed(2)}`,
    `decision latency ms  p50 ${m.latency.p50.toFixed(1)}  p95 ${m.latency.p95.toFixed(1)}`,
    `cost usd  total ${m.costUsd.toFixed(6)}  per session ${m.costPerSessionUsd.toFixed(6)}`,
  ];
  if (m.completions.length) {
    lines.push('turns to completion vs dtmf baseline');
    for (const c of m.completions) lines.push(`  ${c.form.padEnd(20)} ${String(c.turns).padStart(2)} / ${c.baseline}   (${c.sessionId})`);
  }
  lines.push('decisions by deciding gate  ' + Object.entries(m.byDecidingGate).map(([g, n]) => `${g}=${n}`).join('  '));
  lines.push('answers by source           ' + Object.entries(m.bySource).map(([s, n]) => `${s}=${n}`).join('  '));
  return lines.join('\n');
}
