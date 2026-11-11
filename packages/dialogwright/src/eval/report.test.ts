import { describe, expect, it } from 'vitest';
import { NOT_JUDGED } from './judge';
import type { Persona } from './personas';
import { PUBLISHED_LIMIT, publishedText, scrubNumbers, summaryMarkdown, withheldNames, type RunRecord } from './report';

const record = (notes: string, claims: string[]): RunRecord => ({
  persona: 'p', run: 0, actions: [], failures: [], agentCostUsd: null,
  call: { persona: 'p', turns: [], ended: 'caller', firstWordMs: [100] },
  judged: { completed: false, correct: false, unsupportedClaims: claims, honestWhenAsked: null, repeatedQuestions: 0, notes },
});

describe('the summary page', () => {
  it('gives each persona\'s rates over its judged calls alone, with how many wait, never a waiting call as a failure', () => {
    const judged = (persona: string, run: number): RunRecord => ({ ...record('', []), persona, run, judged: { completed: true, correct: true, unsupportedClaims: [], materialClaims: [], benignClaims: [], honestWhenAsked: null, repeatedQuestions: 0, notes: '' } });
    const waiting = (persona: string, run: number): RunRecord => ({ ...record(NOT_JUDGED, []), persona, run });
    const text = summaryMarkdown([judged('a', 0), waiting('a', 1), waiting('a', 2), waiting('b', 0), waiting('b', 1), judged('c', 0)], { app: 'x', callerModel: 'c', judgeModel: 'j', decisionClient: 'd', runsPerPersona: 3, spentUsd: 0, budgetUsd: 1, stoppedByBudget: false, limits: [] });
    expect(text).toContain('| a | 1 of 3 judged | 100% | 100% |');
    expect(text).toContain('| b | 0 of 2 judged | – | – |');
    expect(text).toContain('| c | 1 | 100% | 100% |');
  });

  it('says how many calls the simulation ended and leaves them out of the completed rate', () => {
    const ok = { completed: true, correct: true, unsupportedClaims: [], materialClaims: [], benignClaims: [], honestWhenAsked: null, repeatedQuestions: 0, notes: '' };
    const base = record('', []);
    const info = { app: 'x', callerModel: 'c', judgeModel: 'j', decisionClient: 'd', runsPerPersona: 2, spentUsd: 0, budgetUsd: 1, stoppedByBudget: false, limits: [] };
    const simEnded: RunRecord = { ...base, run: 1, call: { ...base.call, callerEnded: { how: 'empty' } }, judged: { ...ok, completed: false } };
    const text = summaryMarkdown([{ ...base, judged: ok }, simEnded], info);
    expect(text).toContain('| Calls ended by the simulation');
    expect(text).toMatch(/\| Completed[^|]*\| 100% \|/);
    expect(text).toContain('| p | 2 | 100% | 100% |');
    expect(summaryMarkdown([{ ...base, judged: ok }], info)).not.toContain('ended by the simulation');
  });

  it('scrubs phone numbers and long digit runs from the judge\'s words, and names the decision model and the calls judged', () => {
    const text = summaryMarkdown([record('The number +15555550142 and 5555550111 and 555-555-0112 were used.', ['called (555) 555 0113'])], { app: 'a', callerModel: 'c', judgeModel: 'j', decisionClient: 'the heuristic stub', runsPerPersona: 1, spentUsd: 0, budgetUsd: 1, stoppedByBudget: false, limits: [] });
    expect(text).not.toMatch(/\d{7}/);
    expect(text).not.toMatch(/\+1/);
    expect(text).toContain('Decision model: the heuristic stub');
    expect(text).toContain('| Calls judged | 1 of 1 |');
    expect(scrubNumbers('call 12 of 34')).toBe('call 12 of 34');
  });

  it('scrubs a phone number written with Unicode hyphens, dashes or spaces (a model writes non-breaking ones)', () => {
    for (const n of ['555\u2011555\u20110111', '(555) 123\u20114567', '555\u2010555\u20100111', '555\u2013555\u20140111', '555\u00a0555\u202f0111', '+1\u00a0555\u2011555\u20110111']) {
      expect(scrubNumbers(`call ${n} today`), JSON.stringify(n)).toBe('call [number] today');
    }
  });

  it('a page to publish: no per-call notes, each material claim by its sentence alone, and the names given withheld', () => {
    const r: RunRecord = { ...record('Pat Example asked for a Tuesday visit at $40 and was told $50.', ['It is $50, Pat.']), judged: { completed: true, correct: false, unsupportedClaims: ['It is $50, Pat.'], materialClaims: [{ said: 'It is $50, Pat.', kind: 'price', why: 'Visits cost $40 on 2026-11-17.' }], benignClaims: [], honestWhenAsked: null, repeatedQuestions: 0, notes: 'Pat Example asked for a Tuesday visit at $40 and was told $50.' } };
    const text = summaryMarkdown([r], { app: 'a', callerModel: 'c', judgeModel: 'j', decisionClient: 'd', runsPerPersona: 1, spentUsd: 0, budgetUsd: 1, stoppedByBudget: false, limits: [], published: { withheld: ['Pat Example', 'Pat'] } });
    expect(text).not.toContain('What the judge noted');
    expect(text).not.toContain('Unsupported:');
    expect(text).not.toContain('Visits cost $40');
    expect(text).not.toContain('Pat');
    expect(text).toContain('- p (run 1): "It is $50, [name]."');
    expect(text).toContain(`- ${PUBLISHED_LIMIT}`);
  });

  it('a page to publish: a phone number with its area code in brackets is withheld whole, and an em dash is a comma', () => {
    const r: RunRecord = { ...record('', []), judged: { completed: true, correct: false, unsupportedClaims: ['x'], materialClaims: [{ said: 'Call the shop line (555) 123-4567 — or drop by—any day.', kind: 'policy', why: '' }], benignClaims: [], honestWhenAsked: null, repeatedQuestions: 0, notes: '' } };
    const text = summaryMarkdown([r], { app: 'a', callerModel: 'c', judgeModel: 'j', decisionClient: 'd', runsPerPersona: 1, spentUsd: 0, budgetUsd: 1, stoppedByBudget: false, limits: [PUBLISHED_LIMIT], published: { withheld: [] } });
    expect(text).toContain('"Call the shop line [number], or drop by, any day."');
    expect(text).not.toContain('(555)');
    expect(text).not.toContain('—');
    // The limit is said once, whether or not the run's limits already had it.
    expect(text.split(PUBLISHED_LIMIT)).toHaveLength(2);
  });

  it('withholds each persona\'s name, whole and by its first word, and nothing else of the truth', () => {
    const personas: Persona[] = [
      { id: 'a', goal: 'g', truth: { name: 'Dana Example', vehicle: 'a 2019 hatchback' }, manner: 'm', expects: 'request' },
      { id: 'b', goal: 'g', truth: { contactName: 'Lee Sample', account: 'Northside Auto Sales' }, manner: 'm', expects: 'booking' },
    ];
    expect(withheldNames(personas)).toEqual(['Dana Example', 'Dana', 'Lee Sample', 'Lee']);
    expect(publishedText('Dana Example, Dana and Example Wheel Works.', withheldNames(personas))).toBe('[name], [name] and Example Wheel Works.');
  });

  it('gives the contradicted material claims (what the bar counts, by kind, each listed under its kind with numbers scrubbed), the gaps apart, and the benign ones beside them', () => {
    const r: RunRecord = { ...record('It quoted a price.', ['It is $50 at 555 555 0142.']), judged: { completed: true, correct: false, unsupportedClaims: ['It is $50 at 555 555 0142.'], materialClaims: [{ said: 'It is $50 at 555 555 0142.', kind: 'price', basis: 'contradicted', why: 'No such price.' }, { said: 'It takes about an hour.', kind: 'time', basis: 'gap', why: 'The business says nothing on how long.' }], benignClaims: [{ said: 'Drive safe!', kind: 'friendly', why: 'A pleasantry.' }], honestWhenAsked: null, repeatedQuestions: 0, notes: 'It quoted a price.' } };
    const text = summaryMarkdown([r], { app: 'a', callerModel: 'c', judgeModel: 'j', decisionClient: 'd', runsPerPersona: 1, spentUsd: 0, budgetUsd: 1, stoppedByBudget: false, limits: [] });
    expect(text).toContain('| Contradicted material claims, what the bar counts (price / time / policy / done) | 1 (1 / 0 / 0 / 0) |');
    expect(text).toContain('| Gaps in the business information (price / time / policy / done) | 1 (0 / 1 / 0 / 0) |');
    expect(text).toContain('| Benign claims (not counted) | 1 |');
    expect(text).toContain('## Contradicted material claims by kind');
    expect(text).toContain('### price');
    expect(text).toContain('- p (run 1): "It is $50 at [number]." No such price.');
    const gaps = text.slice(text.indexOf('## Gaps in the business information, by kind'));
    expect(gaps).toContain('### time');
    expect(gaps).toContain('- p (run 1): "It takes about an hour." The business says nothing on how long.');
    expect(gaps).not.toContain('It is $50');
    expect(text).not.toContain('Drive safe!');
    // The page to commit lists each gap the same way, by its sentence alone.
    const published = summaryMarkdown([r], { app: 'a', callerModel: 'c', judgeModel: 'j', decisionClient: 'd', runsPerPersona: 1, spentUsd: 0, budgetUsd: 1, stoppedByBudget: false, limits: [], published: { withheld: [] } });
    expect(published).toContain('- p (run 1): "It takes about an hour."\n');
    expect(published).not.toContain('says nothing on how long');
  });

  it('keeps a verdict given before the bases readable: each material claim listed and counted as the bar counted it', () => {
    const r: RunRecord = { ...record('', []), judged: { completed: true, correct: false, unsupportedClaims: ['It is $50.'], materialClaims: [{ said: 'It is $50.', kind: 'price', why: 'No such price.' }], benignClaims: [], honestWhenAsked: null, repeatedQuestions: 0, notes: '' } };
    const text = summaryMarkdown([r], { app: 'a', callerModel: 'c', judgeModel: 'j', decisionClient: 'd', runsPerPersona: 1, spentUsd: 0, budgetUsd: 1, stoppedByBudget: false, limits: [] });
    expect(text).toContain('| Contradicted material claims, what the bar counts (price / time / policy / done) | 1 (1 / 0 / 0 / 0) |');
    expect(text).toContain('- p (run 1): "It is $50." No such price.');
    expect(text).not.toContain('## Gaps in the business information, by kind');
  });

  it('gives the replies the check after speaking corrected and could not read, where the run\'s traces have any', () => {
    const info = { app: 'a', callerModel: 'c', judgeModel: 'j', decisionClient: 'd', runsPerPersona: 1, spentUsd: 0, budgetUsd: 1, stoppedByBudget: false, limits: [] };
    const checked = summaryMarkdown([{ ...record('', []), checks: { read: 5, corrected: 2, declined: 1, carried: 1, unread: 1 } }], info);
    expect(checked).toContain('| Replies the check after speaking read as wrong: corrected on the call / declined by the model / carried to the next message | 2 / 1 / 1 of 5 read (1 could not be read) |');
    expect(summaryMarkdown([record('', [])], info)).not.toContain('check after speaking');
  });

  it('says how many calls wait for verdicts, and leaves them out of the calls judged', () => {
    const waiting: RunRecord = { ...record(NOT_JUDGED, []), judged: { completed: false, correct: false, unsupportedClaims: [], materialClaims: [], benignClaims: [], honestWhenAsked: null, repeatedQuestions: 0, notes: NOT_JUDGED } };
    const text = summaryMarkdown([waiting, waiting, { ...record('', []), judged: { completed: true, correct: true, unsupportedClaims: [], honestWhenAsked: null, repeatedQuestions: 0, notes: '' } }], { app: 'a', callerModel: 'c', judgeModel: 'none', decisionClient: 'd', runsPerPersona: 3, spentUsd: 0, budgetUsd: 1, stoppedByBudget: false, limits: [] });
    expect(text).toContain('| Calls judged | 1 of 3 |');
    expect(text).toContain('2 of 3 calls wait for verdicts: each one\'s judge input is in judge-inputs/');
    expect(text).not.toContain('What the judge noted');
  });

  it('says a page was re-judged from stored transcripts, by which judge', () => {
    const text = summaryMarkdown([record('', [])], { app: 'a', callerModel: 'c', judgeModel: 'anthropic:claude-sonnet-5-5', decisionClient: 'd', runsPerPersona: 1, spentUsd: 0.5, budgetUsd: 1, stoppedByBudget: false, limits: [], rejudged: true });
    expect(text).toContain('Re-judged by anthropic:claude-sonnet-5-5 from the stored transcripts');
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
