import { describe, expect, it } from 'vitest';
import { barsSvg, bytesText, callsSeries, insightsRange, lengthBucketText, moneyText, peakOf, percentText, splitSvg } from './view.js';
import { LENGTH_EDGES_S } from './figures';

/** The page's own pieces for Insights, Knowledge and Health (view.js): ranges, series and the inline SVG charts. */

const local = (y: number, m: number, d: number, h = 0): number => new Date(y, m - 1, d, h).getTime();

describe('the ranges Insights offers, as the viewer\'s days', () => {
  const now = local(2026, 10, 12, 15);
  it('today, yesterday, and the last 7, 30 and 90 days with today', () => {
    expect(insightsRange('today', null, now)).toEqual({ from: local(2026, 10, 12), to: now });
    expect(insightsRange('yesterday', null, now)).toEqual({ from: local(2026, 10, 11), to: local(2026, 10, 12) - 1 });
    expect(insightsRange('7d', null, now)).toEqual({ from: local(2026, 10, 6), to: now });
    expect(insightsRange('90d', null, now)!.from).toBe(local(2026, 7, 15));
  });
  it('a custom range from one day to another, refused backwards, malformed or past 92 days', () => {
    expect(insightsRange('custom', { from: '2026-09-01', to: '2026-09-02' }, now)).toEqual({ from: local(2026, 9, 1), to: local(2026, 9, 3) - 1 });
    expect(insightsRange('custom', { from: '2026-09-02', to: '2026-09-01' }, now)).toBeNull();
    expect(insightsRange('custom', { from: 'x', to: '2026-09-01' }, now)).toBeNull();
    expect(insightsRange('custom', { from: '2026-01-01', to: '2026-09-01' }, now)).toBeNull();
  });
});

describe('calls over a range: by the hour up to two days, else by the day; quiet ones at zero', () => {
  it('by the hour', () => {
    const from = local(2026, 9, 18);
    const s = callsSeries([{ hour: local(2026, 9, 18, 9), calls: 4, peak: 2 }], from, from + 86_400_000 - 1);
    expect(s.unit).toBe('hour');
    expect(s.points).toHaveLength(24);
    expect(s.points[9]).toEqual({ at: local(2026, 9, 18, 9), label: '09:00', calls: 4, peak: 2 });
    expect(peakOf(s)).toBe(s.points[9]);
  });
  it('by the day, the most at once of the day\'s hours', () => {
    const s = callsSeries([{ hour: local(2026, 9, 18, 9), calls: 4, peak: 2 }, { hour: local(2026, 9, 18, 15), calls: 1, peak: 3 }], local(2026, 9, 12), local(2026, 9, 18, 23));
    expect(s.unit).toBe('day');
    expect(s.points).toHaveLength(7);
    expect(s.points.at(-1)).toMatchObject({ calls: 5, peak: 3 });
    expect(peakOf({ points: [] })).toBeNull();
  });
});

describe('the charts: inline SVG, every mark with its tooltip, named for a screen reader', () => {
  it('bars: one per point, heights by value, the label escaped', () => {
    const svg = barsSvg([{ n: 2, t: 'a' }, { n: 0, t: 'b' }, { n: 4, t: '<x>' }], { label: 'Calls by hour <today>', valueOf: (p) => p.n, titleOf: (p) => `${p.t}: ${p.n}` });
    expect(svg).toMatch(/^<svg class="chart bars" viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label="Calls by hour &lt;today&gt;">/);
    expect(svg.match(/<rect /g)).toHaveLength(3);
    expect(svg).toContain('height="100.00"');
    expect(svg).toContain('height="50.00"');
    expect(svg).toContain('<title>&lt;x&gt;: 4</title>');
    expect(svg).not.toMatch(/<script|on\w+=/);
  });
  it('a split bar: each part by its share, nothing for an empty one, none at all with no total', () => {
    const svg = splitSvg([{ label: 'handled', value: 3, cls: 'k-handled' }, { label: 'error', value: 0, cls: 'k-error' }, { label: 'hung up', value: 1, cls: 'k-hangup' }], 'How calls ended');
    expect(svg.match(/<rect /g)).toHaveLength(2);
    expect(svg).toContain('<title>handled: 3</title>');
    expect(splitSvg([{ label: 'a', value: 0, cls: 'x' }], 'none')).toBe('');
  });
});

describe('numbers in words', () => {
  it('percent, money, length buckets, bytes', () => {
    expect([percentText(0.4249), percentText(null)]).toEqual(['42%', '–']);
    expect([moneyText(0.0123456), moneyText(12.5), moneyText(null)]).toEqual(['$0.0123', '$12.50', '–']);
    expect(LENGTH_EDGES_S.map((_, i) => lengthBucketText(i, LENGTH_EDGES_S)).concat(lengthBucketText(LENGTH_EDGES_S.length, LENGTH_EDGES_S)))
      .toEqual(['under 30 s', '30 s to 1 min', '1 min to 2 min', '2 min to 5 min', '5 min to 10 min', '10 min to 20 min', '20 min or more']);
    expect([bytesText(512), bytesText(3.5 * 1024 * 1024), bytesText(undefined)]).toEqual(['512 B', '3.5 MB', '–']);
  });
});
