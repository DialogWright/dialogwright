import { describe, expect, it } from 'vitest';
import { SILENCE_MS, SILENCE_PATH, SILENCE_WAV, silenceSource, silentWav } from './silence';
import { wavDurationMs } from '../../prompts/playback';

describe('the silent clip BARGE_IN=server stops a playback with', () => {
  it('is a valid PCM WAV: RIFF/WAVE, a 16-byte fmt chunk (PCM, mono, 8 kHz, 16-bit), and a data chunk of zeros', () => {
    const b = SILENCE_WAV;
    expect(b.toString('ascii', 0, 4)).toBe('RIFF');
    expect(b.readUInt32LE(4)).toBe(b.length - 8);
    expect(b.toString('ascii', 8, 12)).toBe('WAVE');
    expect(b.toString('ascii', 12, 16)).toBe('fmt ');
    expect(b.readUInt32LE(16)).toBe(16);
    expect(b.readUInt16LE(20)).toBe(1); // PCM
    expect(b.readUInt16LE(22)).toBe(1); // mono
    expect(b.readUInt32LE(24)).toBe(8_000);
    expect(b.readUInt32LE(28)).toBe(16_000); // byte rate
    expect(b.readUInt16LE(32)).toBe(2); // block align
    expect(b.readUInt16LE(34)).toBe(16);
    expect(b.toString('ascii', 36, 40)).toBe('data');
    expect(b.readUInt32LE(40)).toBe(b.length - 44);
    expect(b.length).toBe(44 + 3_200);
    expect(b.subarray(44).every((x) => x === 0)).toBe(true);
  });

  it('lasts SILENCE_MS, as the clips\' own reader measures it', () => {
    expect(SILENCE_MS).toBe(200);
    expect(wavDurationMs(SILENCE_WAV)).toBe(SILENCE_MS);
    expect(wavDurationMs(silentWav(500))).toBe(500);
    expect(wavDurationMs(silentWav(100, 16_000))).toBe(100);
  });

  it('is served from a fixed path on the public host', () => {
    expect(SILENCE_PATH).toBe('/relay/silence.wav');
    expect(silenceSource('demo.example.app')).toBe('https://demo.example.app/relay/silence.wav');
  });
});
