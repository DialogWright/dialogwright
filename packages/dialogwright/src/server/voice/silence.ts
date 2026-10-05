/**
 * The silent clip BARGE_IN=server stops a carrier's playback with (VoiceProvider.stopPlayback
 * `silent-clip`): a `play` frame of it replaces what the carrier is playing, and what the caller then
 * hears is a fifth of a second of nothing. The server hosts it itself, at SILENCE_PATH, whether or not
 * CLIPS is on (server/http.ts), so the stop never depends on an app's recordings.
 *
 * The bytes are made here rather than kept as a file: a WAV header and zero samples, 16-bit PCM, mono,
 * 8 kHz (the telephone rate, so the carrier has nothing to resample), the plainest WAV a carrier that
 * plays WAV takes.
 */

/** Where the server serves the silent clip; an engine path, so no app route may sit on it (server/appRoutes.ts). */
export const SILENCE_PATH = '/relay/silence.wav';

/** How long the silent clip lasts, in milliseconds: long enough to replace the playback, too short to be heard as a pause. */
export const SILENCE_MS = 200;

/** The telephone rate. */
const SAMPLE_RATE = 8_000;

/**
 * A WAV of `ms` of silence: RIFF header, a 16-byte PCM `fmt ` chunk (format 1, mono, 16 bits a sample at
 * `sampleRate`), and a `data` chunk of zero samples. Valid as any PCM WAV is (prompts/playback.ts
 * wavDurationMs reads its length back).
 */
export function silentWav(ms: number = SILENCE_MS, sampleRate: number = SAMPLE_RATE): Buffer {
  const channels = 1;
  const bytesPerSample = 2;
  const samples = Math.round((sampleRate * ms) / 1000);
  const dataSize = samples * channels * bytesPerSample;
  const b = Buffer.alloc(44 + dataSize);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + dataSize, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  b.writeUInt16LE(channels * bytesPerSample, 32);
  b.writeUInt16LE(bytesPerSample * 8, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(dataSize, 40);
  return b;
}

/** The silent clip as the server serves it, made once. */
export const SILENCE_WAV: Buffer = silentWav();

/** The silent clip's URL on a deployment's public host, as a `play` frame's `source` names it. */
export function silenceSource(publicHost: string): string {
  return `https://${publicHost}${SILENCE_PATH}`;
}
