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
});
