import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The pure estimators live in channel/playbackEstimate.ts, which the relay's playback reads for either
// runtime without the prompts; re-exported here for the prompts' own users.
export { textEstimateMs, UNKNOWN_CLIP_MS } from '../channel/playbackEstimate';

/**
 * Duration of a PCM WAV from its header, or null when the buffer is not a parseable WAV.
 *
 * The chunk walk runs until both `fmt ` and `data` have been seen rather than stopping at
 * `data`: RIFF does not promise an order, and a file that puts its samples first would
 * otherwise measure as unparseable and fall back to the fixed unknown-clip estimate.
 */
export function wavDurationMs(b: Buffer): number | null {
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
  let pos = 12;
  let byteRate = 0;
  let dataSize: number | null = null;
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    if (id === 'fmt ' && pos + 8 + 16 <= b.length) byteRate = b.readUInt32LE(pos + 16);
    else if (id === 'data' && dataSize === null) dataSize = Math.min(size, b.length - pos - 8);
    if (byteRate && dataSize !== null) break;
    pos += 8 + size + (size & 1);
  }
  if (!byteRate || dataSize === null) return null;
  return Math.round((dataSize / byteRate) * 1000);
}

/** filename → ms for every wav directly under dir; mp3s are skipped (estimated at playback). */
export function clipDurations(dir: string): Map<string, number> {
  const out = new Map<string, number>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/\.wav$/i.test(name)) continue;
    const ms = wavDurationMs(readFileSync(join(dir, name)));
    if (ms !== null) out.set(name, ms);
  }
  return out;
}
