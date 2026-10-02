import { describe, expect, it } from 'vitest';
import { playbackEstimateMs } from './playback';

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
