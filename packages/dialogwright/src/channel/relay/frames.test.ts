import { describe, expect, it } from 'vitest';
import { bargeInFrame, endFrame, silenceFrame, textFrame, type OutboundFrame } from './frames';
import { dtmfFrames, promptFrame } from '../../testing/relayFrames';

describe('frame constructors', () => {
  it('builds a final prompt frame', () => {
    expect(promptFrame('hello')).toEqual({
      type: 'prompt',
      voicePrompt: 'hello',
      lang: 'en-US',
      last: true,
    });
  });

  it('builds a silence frame', () => {
    expect(silenceFrame()).toEqual({ type: 'silence' });
  });

  it('builds one dtmf frame per digit', () => {
    expect(dtmfFrames('12#')).toEqual([
      { type: 'dtmf', digit: '1' },
      { type: 'dtmf', digit: '2' },
      { type: 'dtmf', digit: '#' },
    ]);
  });

  it('json-encodes handoff data on end frames', () => {
    const frame: OutboundFrame = endFrame('live-agent');
    expect(frame).toEqual({
      type: 'end',
      handoffData: '{"reasonCode":"live-agent"}',
    });
  });

  it('reports what the call collected, and leaves out what it has nothing to say about', () => {
    expect(endFrame('billing', ['reschedule'], [], { accountId: '5550 1234' }).handoffData)
      .toBe('{"reasonCode":"billing","completed":["reschedule"],"slots":{"accountId":"5550 1234"}}');
    expect(endFrame('live-agent', [], [], {}).handoffData).toBe('{"reasonCode":"live-agent"}');
  });
});

describe('barge-in on outbound frames (BARGE_IN)', () => {
  const play: OutboundFrame = { type: 'play', source: 'https://h/a.wav', loop: 1, preemptible: false, interruptible: true };
  const frames: OutboundFrame[] = [textFrame('Hello', true), textFrame('Your code is 1234', false), play, endFrame('done')];

  it('leaves every frame as it is for any and speech: the line\'s own flag says whether speech may cut it', () => {
    for (const mode of ['any', 'speech'] as const) expect(frames.map((f) => bargeInFrame(f, mode))).toEqual(frames);
  });

  it('marks every spoken line and clip not interruptible for none, dtmf and server (whose barge-in is the server\'s), and leaves the other frames alone', () => {
    for (const mode of ['none', 'dtmf', 'server'] as const) {
      expect(frames.map((f) => bargeInFrame(f, mode))).toEqual([
        textFrame('Hello', false),
        textFrame('Your code is 1234', false),
        { ...play, interruptible: false },
        endFrame('done'),
      ]);
    }
  });
});
