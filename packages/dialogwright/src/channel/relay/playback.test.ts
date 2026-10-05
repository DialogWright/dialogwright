import { describe, expect, it } from 'vitest';
import { cutShort, playbackEstimateMs } from './playback';

const durations = new Map([['greeting.0.wav', 2000]]);

describe('playbackEstimateMs', () => {
  it('sums a frame list: clips by their measured length, text by estimate, an unknown clip at the default', () => {
    const frames = [
      { type: 'play' as const, source: 'https://h/audio/greeting.0.wav', loop: 1, preemptible: false, interruptible: true },
      { type: 'text' as const, token: '4471 8293', last: true, lang: 'en-US', interruptible: false, preemptible: false },
      { type: 'play' as const, source: 'https://h/audio/missing.wav', loop: 1, preemptible: false, interruptible: true },
      { type: 'end' as const, handoffData: '{}' },
    ];
    expect(playbackEstimateMs(frames, durations)).toBe(2000 + 800 + 1500);
  });

  it('finds a clip duration through a content-hash query string on the source', () => {
    const frames = [
      { type: 'play' as const, source: 'https://h/audio/greeting.0.wav?v=abc1234567', loop: 1, preemptible: false, interruptible: true },
    ];
    expect(playbackEstimateMs(frames, durations)).toBe(2000);
  });
});

describe('cutShort', () => {
  it('is a playback that finished under the fraction of its estimate', () => {
    // The live call: a 24-word line (9.6 s by the estimate) reported played after 0.67 s.
    expect(cutShort(670, 9600, 0.35)).toBe(true);
    expect(cutShort(3359, 9600, 0.35)).toBe(true);
  });
  it('is not one that took the fraction or more, nor one with nothing to measure', () => {
    expect(cutShort(3360, 9600, 0.35)).toBe(false);
    expect(cutShort(9500, 9600, 0.35)).toBe(false);
    expect(cutShort(12_000, 9600, 0.35)).toBe(false);
    expect(cutShort(0, 0, 0.35)).toBe(false);
    expect(cutShort(-5, 9600, 0.35)).toBe(false);
  });
  it('follows the fraction it is given', () => {
    expect(cutShort(670, 9600, 0.05)).toBe(false);
    expect(cutShort(8000, 9600, 0.95)).toBe(true);
  });
});
