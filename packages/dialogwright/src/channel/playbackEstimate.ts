/**
 * How long a line or a clip takes to play, estimated: the pure estimators the relay's playback
 * (channel/relay/playback.ts) sums for either runtime, kept apart from the prompts (which re-export
 * them, prompts/playback.ts) so a converse call reaches them without the scripted engine, and apart from
 * the relay so the prompts reach them without the wire.
 */

const WORDS_PER_SECOND = 2.5;
const MIN_TEXT_MS = 500;
/** A clip we could not measure (mp3, missing) is assumed to be this long. */
export const UNKNOWN_CLIP_MS = 1500;

/** Estimated speaking time at 2.5 words per second, at least 500ms. */
export function textEstimateMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(MIN_TEXT_MS, Math.round((words / WORDS_PER_SECOND) * 1000));
}
