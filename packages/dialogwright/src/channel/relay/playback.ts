import type { OutboundFrame } from './frames';
import { textEstimateMs, UNKNOWN_CLIP_MS } from '../../prompts/playback';

/**
 * How long the frames take to play, for the no-input timer; approximate by design. The clip
 * and text estimates it sums are the prompts' own (prompts/playback.ts); only the frames are Twilio's.
 * An mp3 clip (no header we parse) falls back to the fixed
 * unknown-clip estimate rather than the recording text's word count, because the
 * adapter does not have the recording text at send time, only the file name.
 */
export function playbackEstimateMs(frames: readonly OutboundFrame[], durations: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const f of frames) {
    if (f.type === 'text') total += textEstimateMs(f.token);
    else if (f.type === 'play') {
      // A content-hash query string (clipVersions) is part of the URL, not the filename the
      // duration map is keyed by, so it is stripped before the lookup.
      const name = f.source.slice(f.source.lastIndexOf('/') + 1).replace(/\?.*$/, '');
      total += (durations.get(name) ?? UNKNOWN_CLIP_MS) * Math.max(1, f.loop);
    }
  }
  return total;
}

/**
 * Whether a playback the carrier reported finished was cut short: it took less than `minFraction` of
 * what the frames were estimated to take (playbackEstimateMs). The estimate is rough by design, so the
 * fraction is well under one: a line said a little fast is not cut. Nothing to measure, nothing cut.
 */
export function cutShort(heardMs: number, expectedMs: number, minFraction: number): boolean {
  if (!(expectedMs > 0) || !(heardMs >= 0)) return false;
  return heardMs < expectedMs * minFraction;
}
