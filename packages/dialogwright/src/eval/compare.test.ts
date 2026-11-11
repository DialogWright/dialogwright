import { describe, expect, it } from 'vitest';
import { addModelPrice } from '../converse/model/price';
import { Budget } from './budget';
import { clears, compareMarkdown, compareModels, DEFAULT_BARS, missed, parseCandidate, type CandidateRun } from './compare';
import type { RunSummary } from './measures';

/** A summary exactly at the bars. */
const atBars = (o: Partial<RunSummary> = {}): RunSummary => ({
  runs: 60, judged: 60, completedRate: 1, correctRate: 1, cooperativeJudged: 40, cooperativeCorrectRate: 0.95, unsupportedClaims: 0, materialByKind: { price: 0, time: 0, policy: 0, done: 0 }, benignClaims: 4, repeatedQuestionsPerCall: 0,
  firstWordMsMedian: 1200, firstWordMsP90: 2000, firstWordMsP95: 2500, firstWordMsP99: 4000, modelTurns: 500, timeoutRate: 0.01,
  wouldTimeout: { '1800': 0.1, '3000': 0.02, '4000': 0.01, '6000': 0.01 }, agentCostPerCallUsd: 0.004, agentTokensPerCall: { inputTokens: 20000, outputTokens: 500 }, failures: {}, ...o,
});

for (const id of ['inception:cheap-test', 'openrouter:vendor/mid-test', 'anthropic:dear-test', 'anthropic:dearest-test']) addModelPrice(id, { input: 1, output: 5, source: 'a test, 2026-11-11' });

describe('clears', () => {
  it('is true exactly at the bars, and false a step past any of them', () => {
    expect(clears(atBars(), DEFAULT_BARS)).toBe(true);
    expect(missed(atBars(), DEFAULT_BARS)).toEqual([]);
    for (const past of [{ firstWordMsMedian: 1201 }, { firstWordMsP95: 2501 }, { timeoutRate: 0.0101 }, { cooperativeCorrectRate: 0.949 }, { unsupportedClaims: 1 }]) {
      expect(clears(atBars(past), DEFAULT_BARS)).toBe(false);
    }
  });

  it('names each bar missed and by how much', () => {
    expect(missed(atBars({ firstWordMsP95: 3100, unsupportedClaims: 4 }), DEFAULT_BARS)).toEqual([
      { bar: 'firstWordMsP95', value: 3100, limit: 2500, by: '600 ms over' },
      { bar: 'unsupportedClaims', value: 4, limit: 0, by: '4 over' },
    ]);
  });

  it('does not clear with no turn timed or no cooperative call judged', () => {
    expect(missed(atBars({ timeoutRate: null }), DEFAULT_BARS)).toMatchObject([{ bar: 'timeoutRate', value: null }]);
    expect(missed(atBars({ cooperativeJudged: 0 }), DEFAULT_BARS)).toMatchObject([{ bar: 'correctRate' }]);
  });
});

describe('parseCandidate', () => {
  it('reads a model and its effort after #, none for none sent', () => {
    expect(parseCandidate('inception:mercury-3#minimal')).toEqual({ model: 'inception:mercury-3', effort: 'minimal' });
    expect(parseCandidate('openrouter:openai/gpt-oss-120b@groq#low')).toEqual({ model: 'openrouter:openai/gpt-oss-120b@groq', effort: 'low' });
    expect(parseCandidate('anthropic:claude-haiku-5-5#none')).toEqual({ model: 'anthropic:claude-haiku-5-5', effort: null });
    expect(parseCandidate('anthropic:claude-haiku-5-5')).toEqual({ model: 'anthropic:claude-haiku-5-5' });
    expect(() => parseCandidate('inception:mercury-3#fast')).toThrow(/effort/);
  });
});

/** A fake runner: each model's summary, the cost it spends per call, and the models it was asked to run. */
function fakeRun(summaries: Record<string, RunSummary>, usdPerCall = 0.01, stopAfter?: { model: string; calls: number }) {
  const ran: { model: string; runs: number }[] = [];
  const run = async (c: CandidateRun, budget: Budget) => {
    ran.push({ model: c.model, runs: c.runs });
    const planned = c.runs * 12;
    let calls = 0;
    for (; calls < planned; calls++) {
      if (budget.exceeded() || (stopAfter?.model === c.model && calls === stopAfter.calls)) break;
      budget.addUsd(usdPerCall);
    }
    return { summary: { ...summaries[c.model]!, runs: calls }, planned, stoppedByBudget: calls < planned };
  };
  return { run, ran };
}

describe('compareModels', () => {
  const failing = atBars({ unsupportedClaims: 3 });
  const base = { runs: 5, personas: 12, bars: DEFAULT_BARS, stopWhenClear: true };

  it('runs cheapest first and stops after the first that clears, marking the rest skipped', async () => {
    const f = fakeRun({ 'inception:cheap-test': failing, 'openrouter:vendor/mid-test': atBars(), 'anthropic:dear-test': atBars() });
    const out = await compareModels({ ...base, candidates: ['inception:cheap-test#minimal', 'openrouter:vendor/mid-test', 'anthropic:dear-test'], expensive: ['anthropic:dearest-test'], budget: new Budget(45), run: f.run });
    expect(f.ran.map((r) => r.model)).toEqual(['inception:cheap-test', 'openrouter:vendor/mid-test']);
    expect(out.map((r) => [r.model, r.cleared ?? null, r.skipped ?? null])).toEqual([
      ['inception:cheap-test', false, null],
      ['openrouter:vendor/mid-test', true, null],
      ['anthropic:dear-test', null, 'a cheaper model cleared the bars'],
      ['anthropic:dearest-test', null, 'a cheaper model cleared the bars'],
    ]);
    expect(out[0]!.effort).toBe('minimal');
    expect(out[2]!.summary).toBeNull();
  });

  it('runs the expensive group only when nothing cheaper cleared', async () => {
    const f = fakeRun({ 'inception:cheap-test': failing, 'anthropic:dearest-test': atBars() });
    const out = await compareModels({ ...base, candidates: ['inception:cheap-test'], expensive: ['anthropic:dearest-test'], budget: new Budget(45), run: f.run });
    expect(f.ran.map((r) => r.model)).toEqual(['inception:cheap-test', 'anthropic:dearest-test']);
    expect(out[1]).toMatchObject({ model: 'anthropic:dearest-test', cleared: true });
  });

  it('runs an expensive model as a short reference, once one cleared, only when asked and the budget left exceeds its estimate', async () => {
    const f = fakeRun({ 'inception:cheap-test': atBars(), 'anthropic:dearest-test': failing });
    const out = await compareModels({ ...base, candidates: ['inception:cheap-test'], expensive: ['anthropic:dearest-test'], reference: { runs: 1 }, budget: new Budget(45), run: f.run });
    expect(f.ran).toEqual([{ model: 'inception:cheap-test', runs: 5 }, { model: 'anthropic:dearest-test', runs: 1 }]);
    expect(out[1]).toMatchObject({ reference: true });
    const poor = fakeRun({ 'inception:cheap-test': atBars(), 'anthropic:dearest-test': failing });
    const refused = await compareModels({ ...base, candidates: ['inception:cheap-test'], expensive: ['anthropic:dearest-test'], reference: { runs: 1 }, budget: new Budget(0.61), run: poor.run });
    expect(poor.ran.map((r) => r.model)).toEqual(['inception:cheap-test']);
    expect(refused[1]!.skipped).toMatch(/^the budget left \(\$0\.01\) is less than a reference run's estimate/);
  });

  it('stops when the budget is spent mid-run, keeping what it has, and runs nothing after', async () => {
    const f = fakeRun({ 'inception:cheap-test': failing, 'openrouter:vendor/mid-test': atBars() }, 0.01);
    const out = await compareModels({ ...base, candidates: ['inception:cheap-test', 'openrouter:vendor/mid-test', 'anthropic:dear-test'], budget: new Budget(0.9), run: f.run });
    expect(f.ran.map((r) => r.model)).toEqual(['inception:cheap-test', 'openrouter:vendor/mid-test']);
    expect(out[1]).toMatchObject({ model: 'openrouter:vendor/mid-test', stoppedByBudget: true, cleared: false });
    expect(out[1]!.summary!.runs).toBeLessThan(60);
    expect(out[2]).toMatchObject({ model: 'anthropic:dear-test', skipped: 'the budget was spent' });
  });

  it('refuses a candidate whose price is not known, since the budget would under-count it', async () => {
    const f = fakeRun({ 'inception:cheap-test': failing });
    const out = await compareModels({ ...base, candidates: ['openrouter:vendor/never-priced', 'inception:cheap-test'], budget: new Budget(45), run: f.run });
    expect(f.ran.map((r) => r.model)).toEqual(['inception:cheap-test']);
    expect(out[0]!.skipped).toMatch(/no price is known/);
  });
});

describe('compareMarkdown', () => {
  it('gives a row per candidate with its price and source, the bars it missed, and the stop point and spend', () => {
    const text = compareMarkdown([
      { model: 'inception:cheap-test', effort: 'minimal', summary: atBars({ unsupportedClaims: 2 }), spentUsd: 1.5, cleared: false, price: { input: 1, output: 5, source: 'a test, 2026-11-11' } },
      { model: 'anthropic:dear-test', summary: null, skipped: 'a cheaper model cleared the bars', price: { input: 1, output: 5, source: 'a test, 2026-11-11' } },
    ], { app: 'a', bars: DEFAULT_BARS, spentUsd: 1.5, budgetUsd: 45, runsPerPersona: 5 });
    expect(text).toContain('| inception:cheap-test (minimal) |');
    expect(text).toContain('unsupported material claims 2 over');
    expect(text).toContain('| Unsupported material claims (benign beside them) |');
    expect(text).toContain('| 2 (4 benign) |');
    expect(text).toContain('unsupported material claims ≤ 0');
    expect(text).toContain('a test, 2026-11-11');
    expect(text).toContain('| anthropic:dear-test | skipped: a cheaper model cleared the bars |');
    expect(text).toContain('$1.50 of $45.00');
  });
});
