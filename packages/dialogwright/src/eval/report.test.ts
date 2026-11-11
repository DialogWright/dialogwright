import { describe, expect, it } from 'vitest';
import { scrubNumbers, summaryMarkdown, type RunRecord } from './report';

const record = (notes: string, claims: string[]): RunRecord => ({
  persona: 'p', run: 0, actions: [], failures: [], agentCostUsd: null,
  call: { persona: 'p', turns: [], ended: 'caller', firstWordMs: [100] },
  judged: { completed: false, correct: false, unsupportedClaims: claims, honestWhenAsked: null, repeatedQuestions: 0, notes },
});

describe('the summary page', () => {
  it('scrubs phone numbers and long digit runs from the judge\'s words, and names the decision model and the calls judged', () => {
    const text = summaryMarkdown([record('The number +15555550142 and 5555550111 and 555-555-0112 were used.', ['called (555) 555 0113'])], { app: 'a', callerModel: 'c', judgeModel: 'j', decisionClient: 'the heuristic stub', runsPerPersona: 1, spentUsd: 0, budgetUsd: 1, stoppedByBudget: false, limits: [] });
    expect(text).not.toMatch(/\d{7}/);
    expect(text).not.toMatch(/\+1/);
    expect(text).toContain('Decision model: the heuristic stub');
    expect(text).toContain('| Calls judged | 1 of 1 |');
    expect(scrubNumbers('call 12 of 34')).toBe('call 12 of 34');
  });

  it('names the line\'s model and gives the tails, the timeouts against the line\'s own time, and the cooperative calls', () => {
    const r: RunRecord = { ...record('', []), cooperative: true, judged: { completed: true, correct: true, unsupportedClaims: [], honestWhenAsked: null, repeatedQuestions: 0, notes: '' }, turns: [{ requests: [{ firstMs: 3500, ms: 4000 }] }, { requests: [{ firstMs: 100, ms: 200 }] }] };
    const text = summaryMarkdown([r], { app: 'a', callerModel: 'c', judgeModel: 'j', decisionClient: 'd', runsPerPersona: 1, spentUsd: 0, budgetUsd: 1, stoppedByBudget: false, limits: [], lineModel: 'meta:muse-ember-1.0 (effort minimal)', timeoutMs: 6000 });
    expect(text).toContain('Line: meta:muse-ember-1.0 (effort minimal).');
    expect(text).toContain('| Cooperative calls done correctly | 100% of 1 |');
    expect(text).toContain('| First sentence, p95 | 100 ms |');
    expect(text).toContain("| Timeouts (at the line's 6000 ms) | 50.0% of 2 turns |");
    expect(text).toContain('| Would time out at 1.8 s / 3 s / 4 s / 6 s | 50.0% / 50.0% / 50.0% / 50.0% |');
  });
});
