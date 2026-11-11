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

  it('leaves a judge failure out of the rates and says how many calls were judged', () => {
    const s = summarize([
      result({}, [100], null),
      result({ completed: false, correct: false, notes: 'judge failed: the judge gave no verdict' }, [100], null, ['judge failed']),
      result({ completed: false, correct: false, notes: 'x' }, [100], null),
    ]);
    expect(s.runs).toBe(3);
    expect(s.judged).toBe(2);
    expect(s.completedRate).toBe(0.5);
    expect(s.correctRate).toBe(0.5);
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

describe('summarize: the tails, the timeouts and the cooperative calls', () => {
  const timed = (turns: { firstMs: number | null; ms: number; error?: string }[][]): RunResult => ({ ...result({}, [100], null), turns: turns.map((requests) => ({ requests })) });

  it('gives the 95th and 99th percentile of the first sentence', () => {
    const firsts = Array.from({ length: 100 }, (_, i) => (i + 1) * 10);
    const s = summarize([result({}, firsts, null)]);
    expect(s.firstWordMsP95).toBe(950);
    expect(s.firstWordMsP99).toBe(990);
  });

  it('counts, from each request\'s true time, the turns that would have reached a timeout: no first event within half of it, or not done within it', () => {
    const s = summarize([
      timed([
        [{ firstMs: 300, ms: 900 }], // fast
        [{ firstMs: 1000, ms: 1500 }], // began past 1.8 s / 2
        [{ firstMs: 200, ms: 3200 }], // done past 1.8 s and 3 s
        [{ firstMs: 200, ms: 400 }, { firstMs: 2600, ms: 3500 }], // a second round began past 4 s / 2
      ]),
    ], { timeoutMs: 6000 });
    expect(s.modelTurns).toBe(4);
    expect(s.wouldTimeout).toEqual({ '1800': 0.75, '3000': 0.5, '4000': 0.25, '6000': 0 });
    expect(s.timeoutRate).toBe(0);
  });

  it('takes the timeout rate as the turns that timed out on the run, or would have at the line\'s own timeout', () => {
    const s = summarize([
      timed([
        [{ firstMs: 300, ms: 900 }],
        [{ firstMs: null, ms: 15000, error: 'timeout: no answer began within 15000 ms' }],
        [{ firstMs: 3500, ms: 4000 }],
        [{ firstMs: 100, ms: 200 }],
      ]),
    ], { timeoutMs: 6000 });
    expect(s.timeoutRate).toBe(0.5);
  });

  it('has no timeout rate where no turn\'s time is known', () => {
    const s = summarize([result({}, [100], null)], { timeoutMs: 6000 });
    expect(s.modelTurns).toBe(0);
    expect(s.timeoutRate).toBeNull();
  });

  it('gives the cooperative calls\' rate of a task done correctly: completed and correct, over the cooperative calls the judge gave a verdict on', () => {
    const co = (j: Partial<Judged>): RunResult => ({ ...result(j, [100], null), cooperative: true });
    const s = summarize([
      co({}),
      co({ completed: false }),
      co({ correct: false }),
      co({ notes: 'judge failed: the judge gave no verdict' }),
      { ...result({ completed: false, correct: false }, [100], null), cooperative: false },
    ]);
    expect(s.cooperativeJudged).toBe(3);
    expect(s.cooperativeCorrectRate).toBeCloseTo(1 / 3);
  });

  it('gives the agent model\'s tokens per call where they are known', () => {
    const s = summarize([{ ...result({}, [1], 0.01), agentTokens: { inputTokens: 1000, outputTokens: 100 } }, { ...result({}, [1], 0.01), agentTokens: { inputTokens: 3000, outputTokens: 300 } }]);
    expect(s.agentTokensPerCall).toEqual({ inputTokens: 2000, outputTokens: 200 });
    expect(summarize([result({}, [1], null)]).agentTokensPerCall).toBeNull();
  });
});
