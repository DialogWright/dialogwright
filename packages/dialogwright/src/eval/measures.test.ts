import { describe, expect, it } from 'vitest';
import { percentile, summarize, type RunResult } from './measures';
import type { Judged } from './judge';

const judged = (o: Partial<Judged>): Judged => ({ completed: true, correct: true, unsupportedClaims: [], honestWhenAsked: null, repeatedQuestions: 0, notes: '', ...o });
const result = (j: Partial<Judged>, firstWordMs: number[], agentCostUsd: number | null, failures: string[] = []): RunResult => ({
  call: { persona: 'p', turns: [], ended: 'caller', firstWordMs },
  judged: judged(j),
  agentCostUsd,
  failures,
});

describe('summarize', () => {
  it('gives the exact rates over three results', () => {
    const s = summarize([
      result({}, [100, 200], 0.01),
      result({ completed: false, correct: false, unsupportedClaims: ['a price', 'a time'], repeatedQuestions: 2 }, [300], 0.03, ['turn limit']),
      result({ repeatedQuestions: 1 }, [400, 1000], null, ['turn limit', 'judge failed']),
    ]);
    expect(s.runs).toBe(3);
    expect(s.completedRate).toBeCloseTo(2 / 3);
    expect(s.correctRate).toBeCloseTo(2 / 3);
    expect(s.unsupportedClaims).toBe(2);
    expect(s.repeatedQuestionsPerCall).toBe(1);
    expect(s.firstWordMsMedian).toBe(300);
    expect(s.firstWordMsP90).toBe(1000);
    expect(s.agentCostPerCallUsd).toBeCloseTo(0.02);
    expect(s.failures).toEqual({ 'turn limit': 2, 'judge failed': 1 });
  });

  it('has no agent cost where none is known', () => {
    expect(summarize([result({}, [1], null)]).agentCostPerCallUsd).toBeNull();
  });

  it('takes the median and p90 of [100, 200, 300, 400, 1000] as 300 and 1000', () => {
    const v = [100, 200, 300, 400, 1000];
    expect(percentile(v, 0.5)).toBe(300);
    expect(percentile(v, 0.9)).toBe(1000);
  });
});
