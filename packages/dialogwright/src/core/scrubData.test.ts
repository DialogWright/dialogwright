import { describe, expect, it } from 'vitest';
import { bothScrubs, scrubberFor, scrubberOfValues, scrubFromParts, scrubParts, spokenValuesScrubber, withheldScrubber } from './recording';
import { useTestkit } from '../testing/apps';
import { testkitApp } from '../testing/testkit';

useTestkit();

/**
 * A scrub as data (scrubParts, scrubFromParts): what a request a call was waiting on keeps of its scrub
 * when the call is saved (StoredCall.pending), so the answer to it, sent again after a restart, is
 * recorded masked as the first answer would have been.
 */
describe('a scrub as data', () => {
  const call = { tool: 'createReport', params: { accountId: '55501234', missingNote: 'a small brown box left at the side gate', expectedDate: '2026-09-15' } };
  const LINE = 'report for 55501234 (...1234): A Small Brown Box Left At The Side Gate, due 2026-09-15; also secret-value';

  it("is a call's scrub and a result's withheld values, rebuilt to mask the same line the same way after a JSON round trip", () => {
    const scrub = bothScrubs(scrubberFor(testkitApp, call), withheldScrubber(['secret-value']))!;
    const parts = scrubParts(scrub);
    expect(parts).not.toBeNull();
    const back = scrubFromParts(JSON.parse(JSON.stringify(parts)))!;
    expect(back(LINE)).toBe(scrub(LINE));
    expect(back(LINE)).not.toContain('55501234');
    expect(back(LINE)).not.toContain('secret-value');
  });

  it('is null for no scrub, and for one it cannot write down (a spoken line\'s)', () => {
    expect(scrubParts(null)).toBeNull();
    expect(scrubParts(spokenValuesScrubber([{ raw: '55501234', shown: '<8 chars>' }]))).toBeNull();
    expect(scrubParts(bothScrubs(scrubberOfValues([['abcdef', '•']]), spokenValuesScrubber([{ raw: '55501234', shown: '<8 chars>' }])))).toBeNull();
    expect(scrubFromParts([])).toBeNull();
  });
});
