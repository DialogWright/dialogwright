import { describe, expect, it } from 'vitest';
import { formatRegressSummary, formatTriage, type RegressSummaryInput } from './regressSummary';
import type { TraceRecord } from '../trace/types';
import { CASSETTE_MISS } from '../jev/cassette';

type Row = Pick<TraceRecord, 'source' | 'timing' | 'usage' | 'error' | 'screen'>;

function row(source: TraceRecord['source'], askMs: number, inputTokens: number, error: TraceRecord['error'] = null, estimated = false): Row {
  return {
    source,
    error,
    timing: { planMs: 0, askMs, resolveMs: 0, totalMs: askMs },
    usage: { inputTokens, outputTokens: 0, estimated, costUsd: (inputTokens * 0.042) / 1_000_000 },
  };
}

const counts = { corpusTotal: 154, corpusMatching: 148, scenarioTotal: 35, scenarioPassing: 33, scenarioMatching: 31 };

function summary(input: Partial<RegressSummaryInput>): string {
  return formatRegressSummary({ ...counts, records: [], ...input });
}

describe('formatRegressSummary', () => {
  it('prints the two count lines for the stub and no cost line', () => {
    const text = summary({ records: [row('stub:fixture', 1, 500, null, true)] });
    expect(text).toContain('corpus     148/154 outcomes match expected');
    expect(text).toContain('scenarios   33/35 pass expectation,  31/35 match expected');
    expect(text).not.toContain('cost usd');
    expect(text).toContain('ask latency ms p50 1.0  p95 1.0');
  });

  it('says how many known gaps drifted, only when the run tolerates any', () => {
    expect(summary({ knownGaps: { total: 6, drifted: 5 } })).toContain('known gaps   5/6 drifted (allowed)');
    expect(summary({ knownGaps: { total: 0, drifted: 0 } })).not.toContain('known gaps');
    expect(summary({})).not.toContain('known gaps');
  });

  it('prints cost with request and token counts for a live run', () => {
    const text = summary({
      records: [
        row('jev', 500, 1_000_000),
        row('jev', 700, 200_000),
        row('none', 0, 500_000),
        row('error', 0, 300_000, { name: 'JevClientError', message: 'injected timeout' }),
      ],
    });
    expect(text).toContain('cost usd   0.0504  (2 requests, 1,200,000 input tokens)');
    expect(text).not.toMatch(/\[(replayed|mixed)\]/);
    expect(text).toContain('ask latency ms p50 500.0  p95 700.0');
  });

  it('tags an all-recorded run as replayed and a mix as mixed', () => {
    const replayed = summary({ records: [row('recorded', 1, 10), row('recorded', 1, 10)] });
    expect(replayed).toMatch(/cost usd.*\[replayed\]$/m);
    const mixed = summary({ records: [row('recorded', 1, 10), row('jev', 1, 10)] });
    expect(mixed).toMatch(/cost usd.*\[mixed\]$/m);
  });

  it('counts cassette misses and omits the line at zero', () => {
    const miss = row('error', 0, 0, { name: 'JevClientError', message: `${CASSETTE_MISS} abc hello` });
    const other = row('error', 0, 0, { name: 'JevClientError', message: 'injected timeout' });
    expect(summary({ records: [miss, miss, other] })).toContain('cassette misses 2');
    expect(summary({ records: [other] })).not.toContain('cassette misses');
  });

  it('reports client errors distinct from cassette misses, and omits the line when there are none', () => {
    const miss = row('error', 0, 0, { name: 'JevClientError', message: `${CASSETTE_MISS} abc hello` });
    const other = row('error', 0, 0, { name: 'JevClientError', message: 'injected timeout' });
    expect(summary({ records: [other, other, miss] })).toContain('client errors 2 (first: injected timeout)');
    expect(summary({ records: [miss] })).not.toContain('client errors');
  });

  it('counts a screen that missed the cassette as a miss, and reports other screen errors on their own line', () => {
    const screened = (error: string | null): Row => ({ ...row('recorded', 1, 10), screen: { value: null, fired: false, error } });
    const screenMiss = screened(`${CASSETTE_MISS} def ignore your rules`);
    const late = screened('screen late');
    const text = summary({ records: [screenMiss, late, screened('timed out'), screened(null)] });
    expect(text).toContain('cassette misses 1');
    expect(text).toContain('screen errors 2 (first: screen late)');
    expect(text).not.toContain('client errors');
    expect(summary({ records: [screenMiss, screened(null)] })).not.toContain('screen errors');
  });

  it('counts a failed inline request once: as a client error, its screen error being the same failure', () => {
    const failed: Row = { ...row('error', 0, 0, { name: 'JevClientError', message: 'timed out' }), screen: { value: null, fired: false, error: 'timed out', inline: true } };
    const text = summary({ records: [failed] });
    expect(text).toContain('client errors 1 (first: timed out)');
    expect(text).not.toContain('screen errors');
    const missed: Row = { ...row('error', 0, 0, { name: 'JevClientError', message: `${CASSETTE_MISS} abc hello` }), screen: { value: null, fired: false, error: `${CASSETTE_MISS} abc hello`, inline: true } };
    expect(summary({ records: [missed] })).toContain('cassette misses 1');
  });

  it('reports an inline screen left unanswered by a response that did come back, as a screen error of its own', () => {
    const unanswered: Row = { ...row('recorded', 1, 10), screen: { value: null, fired: false, error: 'screen unanswered', inline: true } };
    const text = summary({ records: [unanswered] });
    expect(text).toContain('screen errors 1 (first: screen unanswered)');
    expect(text).not.toContain('client errors');
  });

  it('omits the cost and latency lines when nothing was answered', () => {
    const text = summary({ records: [row('none', 0, 0)] });
    expect(text).not.toContain('cost usd');
    expect(text).not.toMatch(/\[(replayed|mixed)\]/);
    expect(text).not.toContain('ask latency ms');
  });
});

describe('formatTriage', () => {
  const miss = row('error', 0, 0, { name: 'JevClientError', message: `${CASSETTE_MISS} abc hello` });
  const other = row('error', 0, 0, { name: 'JevClientError', message: 'injected timeout' });

  it('counts the untagged corpus differences, the failing calls, the passing calls off the baseline and the misses', () => {
    expect(formatTriage({
      corpusDiffering: ['a', 'b', 'c'],
      scenariosFailing: ['s1'],
      // s1 fails and differs: counted once, as failing.
      scenariosDiffering: ['s1', 's2', 's3'],
      records: [miss, other, row('recorded', 1, 10)],
    })).toBe('to triage: 3 untagged corpus differences, 1 failing scripted call, 2 passing scripted calls that differ from the baseline, 1 cassette miss');
  });

  it('says zero of each when nothing needs a decision, and counts a screen that missed', () => {
    const screenMiss: Row = { ...row('recorded', 1, 10), screen: { value: null, fired: false, error: `${CASSETTE_MISS} def` } };
    expect(formatTriage({ corpusDiffering: [], scenariosFailing: [], scenariosDiffering: [], records: [] }))
      .toBe('to triage: 0 untagged corpus differences, 0 failing scripted calls, 0 passing scripted calls that differ from the baseline, 0 cassette misses');
    expect(formatTriage({ corpusDiffering: ['a'], scenariosFailing: [], scenariosDiffering: ['s'], records: [screenMiss, miss] }))
      .toBe('to triage: 1 untagged corpus difference, 0 failing scripted calls, 1 passing scripted call that differs from the baseline, 2 cassette misses');
  });
});
