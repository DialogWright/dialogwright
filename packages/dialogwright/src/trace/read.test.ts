import { describe, expect, it } from 'vitest';
import { framesToActions, upgradeTraceRecord } from './read';
import { endFrame, textFrame, type OutboundFrame } from '../channel/relay/frames';
import { setupFrame } from '../testing/relayFrames';
import { actionsToFrames } from '../channel/relay/map';
import { endAction, sayAction, transferAction } from '../channel/actions';
import { keyEvents, signedInEvent, silenceEvent, speechEvent } from '../channel/events';

/** A v1 record as it sits on disk: the turn's event was the ConversationRelay frame. */
function v1(event: unknown): Record<string, unknown> {
  return { v: 1, sessionId: 'CA1', turnIndex: 1, ts: '2026-09-21T00:00:00.000Z', event, decision: { kind: 'ignore' }, slots: {}, form: null, gates: [], frames: [], timing: {}, usage: {} };
}

describe('upgradeTraceRecord', () => {
  it('reads a v1 record as v2, its frame the event it was, and keeps every other field', () => {
    const raw = v1({ type: 'prompt', voicePrompt: 'where is my parcel', lang: 'en-US', last: true });
    const r = upgradeTraceRecord(JSON.parse(JSON.stringify(raw)));
    expect(r.v).toBe(2);
    expect(r.event).toEqual(speechEvent('where is my parcel'));
    expect(r.actions).toEqual([]);
    const { v: _v, event: _e, actions: _a, ...rest } = r as unknown as Record<string, unknown>;
    const { v: _rv, event: _re, frames: _rf, ...restRaw } = raw;
    expect(rest).toEqual(restRaw);
  });

  it('upgrades every kind of v1 event: setup, a masked digit, silence, a sign-in, an agent result', () => {
    expect(upgradeTraceRecord(v1(setupFrame('VX1'))).event).toEqual({ type: 'session.start', provider: { sessionId: 'VX1', callSid: 'CA-VX1', from: '+15550000001', to: '+15550000002' } });
    expect(upgradeTraceRecord(v1({ type: 'dtmf', digit: '•' })).event).toEqual(keyEvents('•')[0]);
    expect(upgradeTraceRecord(v1({ type: 'silence' })).event).toEqual(silenceEvent());
    const principal = { kind: 'customer', level: 2, id: '...1234', first: 'Alex' } as never;
    expect(upgradeTraceRecord(v1({ type: 'signed_in', principal })).event).toEqual(signedInEvent(principal));
    expect(upgradeTraceRecord(v1({ type: 'service_result', service: 'depot', result: null })).event).toEqual({ type: 'service.result', service: 'depot', result: null });
    expect(upgradeTraceRecord(v1({ type: 'error', description: 'x' })).event).toEqual({ type: 'channel.error', description: 'x' });
  });

  it('reads a hand-written v1 setup with no custom parameters', () => {
    expect(upgradeTraceRecord(v1({ type: 'setup', from: '+15550000003' })).event).toEqual({ type: 'session.start', provider: { from: '+15550000003' } });
  });

  it('upgrades a v1 interrupt and a v1 prompt that was not final', () => {
    expect(upgradeTraceRecord(v1({ type: 'interrupt', utteranceUntilInterrupt: 'Your parcel is', durationUntilInterruptMs: 800 })).event)
      .toEqual({ type: 'user.interrupt', heard: 'Your parcel is', afterMs: 800 });
    expect(upgradeTraceRecord(v1({ type: 'prompt', voicePrompt: 'check on my', lang: 'en-US', last: false })).event)
      .toEqual(speechEvent('check on my', false));
  });

  it('returns a v1 record with an event type it does not know as it is, and survives a setup with null parameters', () => {
    const unknown = v1({ type: 'telepathy', thought: 'hi' });
    expect(upgradeTraceRecord(unknown)).toBe(unknown);
    const inherited = v1({ type: 'toString' });
    expect(upgradeTraceRecord(inherited)).toBe(inherited);
    expect(upgradeTraceRecord(v1({ type: 'setup', from: '+15550000003', customParameters: null })).event)
      .toEqual({ type: 'session.start', provider: { from: '+15550000003' } });
  });

  it('returns a v2 record as it is, and a v1 record with no event untouched', () => {
    const v2 = { ...v1(speechEvent('hi')), v: 2 };
    expect(upgradeTraceRecord(v2)).toBe(v2);
    const odd = v1(null);
    expect(upgradeTraceRecord(odd)).toBe(odd);
  });

  it("reads a v1 record's frames as the actions they were sent for", () => {
    const play = (source: string, interruptible: boolean): OutboundFrame => ({ type: 'play', source, loop: 1, preemptible: false, interruptible });
    const frames: OutboundFrame[] = [
      textFrame('Your report is filed.', false), play('https://h/audio/report.mp3', false),
      textFrame('Anything else?', true),
      endFrame('completed', ['report_missing']),
    ];
    const r = upgradeTraceRecord({ ...v1({ type: 'silence' }), frames });
    expect(r.actions).toEqual([
      sayAction([{ text: 'Your report is filed.' }, { audio: 'https://h/audio/report.mp3' }], false),
      sayAction([{ text: 'Anything else?' }], true),
      endAction(['report_missing']),
    ]);
    expect('frames' in r).toBe(false);
  });

  it('skips a frame type it does not know instead of reading it as a language switch', () => {
    const unknown = { type: 'mark', name: 'x' } as unknown as OutboundFrame;
    expect(framesToActions([textFrame('Hello.', true), unknown, endFrame('completed')])).toEqual([
      sayAction([{ text: 'Hello.' }], true),
      endAction(),
    ]);
  });

  it("reads a v1 handoff's end frame as a transfer with its reason, completed, queued and slots", () => {
    const end = endFrame('needs-human', ['track_parcel'], ['report_missing'], { accountId: '...1234' });
    expect(framesToActions([end])).toEqual([transferAction('needs-human', ['track_parcel'], ['report_missing'], { accountId: '...1234' })]);
    expect(framesToActions([endFrame('identity')])).toEqual([transferAction('identity')]);
    // An end the record cannot read is still the end of the call.
    expect(framesToActions([{ type: 'end', handoffData: 'not json' }])).toEqual([endAction()]);
  });

  it('puts the same frames back on the wire as the v1 record sent', () => {
    const frames: OutboundFrame[] = [
      textFrame('Thanks, Alex.', true), textFrame('Which parcel is it?', true),
      textFrame('Connecting you now.', false),
      endFrame('live-agent', ['track_parcel'], ['report_missing'], { accountId: '...1234', dob: 'verified' }),
      { type: 'sendDigits', digits: '12' }, { type: 'language', ttsLanguage: 'es-US', transcriptionLanguage: 'es-US' },
    ];
    expect(actionsToFrames(framesToActions(frames))).toEqual(frames);
    expect(actionsToFrames(framesToActions([endFrame('completed', ['track_parcel'])]))).toEqual([endFrame('completed', ['track_parcel'])]);
  });
});
