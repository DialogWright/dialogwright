import { wordsOf } from '../channel/events';
import type { TraceRecord } from '../trace/types';
import { defaultAppOrNull } from '../core/app/registry';

export interface Completion {
  sessionId: string;
  form: string;
  turns: number;
  baseline: number;
}

export interface Metrics {
  sessions: number;
  turns: number;
  promptTurns: number;
  slotsFilledPerUtterance: number;
  completions: Completion[];
  latency: { p50: number; p95: number };
  costUsd: number;
  costPerSessionUsd: number;
  byDecidingGate: Record<string, number>;
  bySource: Record<string, number>;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function filledCount(slots: TraceRecord['slots']): number {
  return Object.values(slots).filter((s) => s.value !== null).length;
}

/**
 * `baseline`: caller turns per form on the keypad menu, which each whole call's completions are
 * compared against; by default the default app's (App.testing.dtmfBaseline), else none (0).
 */
export function summarize(records: TraceRecord[], baseline: Readonly<Record<string, number>> = defaultAppOrNull()?.testing?.dtmfBaseline ?? {}): Metrics {
  const bySession = new Map<string, TraceRecord[]>();
  for (const r of records) {
    const list = bySession.get(r.sessionId) ?? [];
    list.push(r);
    bySession.set(r.sessionId, list);
  }

  let promptTurns = 0;
  let slotsFilled = 0;
  const completions: Completion[] = [];
  const latencies: number[] = [];
  const byDecidingGate: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  let costUsd = 0;

  for (const [sessionId, list] of bySession) {
    let prevFilled = 0;
    // Caller turns so far: every words, keypad or silence turn that was not ignored or held.
    let callerTurns = 0;
    let done = 0;
    const found: Array<{ form: string; turns: number }> = [];
    for (const r of list) {
      costUsd += r.usage.costUsd;
      bySource[r.source] = (bySource[r.source] ?? 0) + 1;
      // ignore/hold decisions neither advance the flow nor were meant to fill a slot;
      // their cost and source are still counted above, but they don't count as turns.
      const counted = r.decision.kind !== 'ignore' && r.decision.kind !== 'hold';
      const said = wordsOf(r.event) !== null;
      if (counted && (said || r.event.type === 'user.key' || r.event.type === 'user.silence')) callerTurns += 1;
      if (said) {
        if (counted) {
          promptTurns += 1;
          const now = filledCount(r.slots);
          slotsFilled += Math.max(0, now - prevFilled);
          prevFilled = now;
          if (r.source !== 'error' && r.source !== 'none') latencies.push(r.timing.totalMs);
          const gate = r.gates.find((g) => g.decided)?.gate ?? 'none';
          byDecidingGate[gate] = (byDecidingGate[gate] ?? 0) + 1;
        }
      } else {
        // setup and dtmf turns are not caller utterances: they only re-baseline the
        // slot count, so a seeded session's placeholders are never credited to a turn.
        prevFilled = filledCount(r.slots);
      }
      // A form is complete on the turn that adds it to the call's completed list: its answer was
      // given (a refused form is never added). A downstream service's answer, which completes a new
      // report, is not a caller turn, so it adds no turn of its own.
      const completed = r.completed ?? [];
      for (const form of completed.slice(done)) found.push({ form, turns: callerTurns });
      done = Math.max(done, completed.length);
    }
    // A session whose very first record already has a form, or a form behind it, was seeded
    // mid-call by the corpus runner, so it is not a whole call to compare against the DTMF baseline.
    const first = list[0];
    const preSeeded = first !== undefined && (first.form !== null || (first.completed ?? []).length > 0);
    if (!preSeeded) {
      for (const f of found) completions.push({ sessionId, form: f.form, turns: f.turns, baseline: Object.hasOwn(baseline, f.form) ? baseline[f.form]! : 0 });
    }
  }

  return {
    sessions: bySession.size,
    turns: records.length,
    promptTurns,
    slotsFilledPerUtterance: promptTurns ? slotsFilled / promptTurns : 0,
    completions,
    latency: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    costUsd,
    costPerSessionUsd: bySession.size ? costUsd / bySession.size : 0,
    byDecidingGate,
    bySource,
  };
}
