import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linesForTest, STOP_SETTLE_MS } from './adapter';
import { playbackEstimateMs } from '../channel/relay/playback';
import { textFrame } from '../channel/relay/frames';

/**
 * Which line a carrier's report of playback ends (server/adapter.ts linesPlayed; the agent-mode design, call 61 and
 * its review): the earliest line not yet reported whose words end the report, the lines before it with it, and the
 * lines queued behind starting from it; a stop that names no line, once it has stayed stopped, ends only the lines
 * sent before it.
 */

const CALL = 'CA-lines';
const est = (text: string): number => playbackEstimateMs([textFrame(text, true)], new Map());
const NAME = "What's your name?";
const THANKS = "Thanks. What's your name?";
const SORRY = 'Sorry, I missed that.';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  linesForTest.forget(CALL);
  vi.useRealTimers();
});

describe('a report of a line played names the earliest line not yet reported', () => {
  it('a line sent twice: the report of the first ends the first, and the second, queued, starts from it', async () => {
    linesForTest.sent(CALL, NAME);
    linesForTest.sent(CALL, NAME);
    expect(linesForTest.end(CALL)).toBe(2 * est(NAME));
    await vi.advanceTimersByTimeAsync(800);
    linesForTest.report(CALL, { kind: 'playback', state: 'finished', text: NAME });
    expect(linesForTest.played(CALL)).toEqual([true, false]);
    expect(linesForTest.end(CALL)).toBe(800 + est(NAME));
    await vi.advanceTimersByTimeAsync(700);
    linesForTest.report(CALL, { kind: 'playback', state: 'finished', text: NAME });
    expect(linesForTest.played(CALL)).toEqual([true, true]);
    expect(linesForTest.end(CALL)).toBe(1_500);
  });

  it('a line whose words end the playing one\'s, queued behind it, is not ended by the playing one\'s report', async () => {
    linesForTest.sent(CALL, THANKS);
    linesForTest.sent(CALL, NAME);
    await vi.advanceTimersByTimeAsync(900);
    linesForTest.report(CALL, { kind: 'playback', state: 'finished', text: THANKS });
    expect(linesForTest.played(CALL)).toEqual([true, false]);
    expect(linesForTest.end(CALL)).toBe(900 + est(NAME));
  });

  it('two lines sent together and reported as one, run together: both end at the report', async () => {
    linesForTest.sent(CALL, SORRY);
    linesForTest.sent(CALL, NAME);
    await vi.advanceTimersByTimeAsync(1_200);
    linesForTest.report(CALL, { kind: 'playback', state: 'finished', text: `${SORRY} ${NAME}` });
    expect(linesForTest.played(CALL)).toEqual([true, true]);
    expect(linesForTest.end(CALL)).toBe(1_200);
  });

  it('a report later than the estimate changes nothing', async () => {
    linesForTest.sent(CALL, NAME);
    await vi.advanceTimersByTimeAsync(est(NAME) + 400);
    linesForTest.report(CALL, { kind: 'playback', state: 'finished', text: NAME });
    expect(linesForTest.played(CALL)).toEqual([false]);
    expect(linesForTest.end(CALL)).toBe(est(NAME));
  });
});

describe('a stop that names no line', () => {
  it('ends the lines sent before it once it has stayed stopped, never one sent in its very millisecond (call 61)', async () => {
    linesForTest.sent(CALL, THANKS);
    await vi.advanceTimersByTimeAsync(700);
    // The filler's stop and the reply sent in the same millisecond, as on call 61.
    linesForTest.report(CALL, { kind: 'playback', state: 'finished' });
    linesForTest.sent(CALL, NAME);
    await vi.advanceTimersByTimeAsync(STOP_SETTLE_MS - 1);
    expect(linesForTest.played(CALL)).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(1);
    expect(linesForTest.played(CALL)).toEqual([true, false]);
    // The reply, queued behind the first's estimate, starts at the stop.
    expect(linesForTest.end(CALL)).toBe(700 + est(NAME));
  });

  it('a start within STOP_SETTLE_MS cancels it: a frame sent mid-line gave a stop and a start 230 ms apart', async () => {
    linesForTest.sent(CALL, THANKS);
    await vi.advanceTimersByTimeAsync(700);
    linesForTest.report(CALL, { kind: 'playback', state: 'finished' });
    await vi.advanceTimersByTimeAsync(230);
    linesForTest.report(CALL, { kind: 'playback', state: 'started' });
    await vi.advanceTimersByTimeAsync(STOP_SETTLE_MS);
    expect(linesForTest.played(CALL)).toEqual([false]);
    expect(linesForTest.end(CALL)).toBe(est(THANKS));
  });
});
