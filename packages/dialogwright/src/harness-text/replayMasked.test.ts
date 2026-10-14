import { describe, expect, it } from 'vitest';
import { replayFrameLines } from './replay';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { ReadFrameLogLine } from '../server/frameLog';

/** A frame log that keeps no caller's words (an app with a slot whose redact is length-summarized) is refused by replay, plainly. */
describe('replaying a frame log whose caller words are masked', () => {
  it('refuses it, naming the line and why', async () => {
    const lines = [
      { line: 1, dir: 'in', ts: '2026-10-14T00:00:00.000Z', msg: { type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} } },
      { line: 2, dir: 'in', ts: '2026-10-14T00:00:01.000Z', msg: { type: 'prompt', voicePrompt: '<30 chars>', lang: 'en-US', last: true } },
    ] as unknown as ReadFrameLogLine[];
    await expect(replayFrameLines(lines, [], { client: new HeuristicStubClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-10-14' })).rejects.toThrow("frame log line 2: the caller's words are kept by their length only");
  });
});
