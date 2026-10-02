import { describe, expect, it } from 'vitest';
import { actionsToFrames, frameToEvent } from './map';
import { serviceResultFrame, endFrame, silenceFrame, textFrame } from './frames';
import { dtmfFrames, promptFrame, setupFrame, signedInFrame } from '../../testing/relayFrames';
import { serviceResultEvent, errorEvent, interruptEvent, keyEvents, signedInEvent, silenceEvent, speechEvent } from '../events';
import { endAction, sayAction, transferAction, type Action } from '../actions';

const play = (source: string, interruptible: boolean) => ({ type: 'play', source, loop: 1, preemptible: false, interruptible });

describe('actionsToFrames', () => {
  it('maps a text-only say to one text frame', () => {
    expect(actionsToFrames([sayAction([{ text: 'Hello.' }], true)])).toEqual([textFrame('Hello.', true)]);
  });

  it('maps each part of a say in order, carrying its interruptible flag, and not interruptible when false', () => {
    const frames = actionsToFrames([sayAction([{ text: 'one' }, { audio: 'https://x/a.mp3' }, { text: 'two' }], false)]);
    expect(frames).toEqual([textFrame('one', false), play('https://x/a.mp3', false), textFrame('two', false)]);
  });

  it('keeps the interruptible flag on audio parts too', () => {
    expect(actionsToFrames([sayAction([{ audio: 'u' }], true)])).toEqual([play('u', true)]);
  });

  it('maps end to a completed end frame carrying what was done', () => {
    expect(actionsToFrames([endAction(['a', 'b'])])).toEqual([endFrame('completed', ['a', 'b'])]);
  });

  it('maps transfer to an end frame with its reason, completed, queued and slots', () => {
    expect(actionsToFrames([transferAction('policy-limit', ['a'], ['b'], { k: 'v' })])).toEqual([endFrame('policy-limit', ['a'], ['b'], { k: 'v' })]);
  });

  it('omits empty completed, queued and slots from the handoff data', () => {
    const [end] = actionsToFrames([endAction()]);
    expect(end).toEqual({ type: 'end', handoffData: '{"reasonCode":"completed"}' });
    const [handoff] = actionsToFrames([transferAction('agent-request')]);
    expect(handoff).toEqual({ type: 'end', handoffData: '{"reasonCode":"agent-request"}' });
    const [full] = actionsToFrames([transferAction('r', ['c'], ['q'], { s: '1' })]);
    expect(JSON.parse((full as { handoffData: string }).handoffData)).toEqual({ reasonCode: 'r', completed: ['c'], queued: ['q'], slots: { s: '1' } });
  });

  it('maps send_digits and set_language', () => {
    expect(actionsToFrames([{ type: 'send_digits', digits: '12#' }])).toEqual([{ type: 'sendDigits', digits: '12#' }]);
    expect(actionsToFrames([{ type: 'set_language', tts: 'es-ES', transcription: 'es-ES' }])).toEqual([{ type: 'language', ttsLanguage: 'es-ES', transcriptionLanguage: 'es-ES' }]);
  });

  it('keeps actions in order and maps none to none', () => {
    const actions: Action[] = [sayAction([{ text: 'a' }], true), sayAction([{ text: 'b' }], false), endAction()];
    expect(actionsToFrames(actions).map((f) => f.type)).toEqual(['text', 'text', 'end']);
    expect(actionsToFrames([])).toEqual([]);
  });
});

describe('frameToEvent', () => {
  it('maps a setup to a session start whose provider details are its ids, and its custom parameters prefixed', () => {
    expect(frameToEvent(setupFrame('VX1'))).toEqual({
      type: 'session.start',
      provider: { sessionId: 'VX1', callSid: 'CA-VX1', from: '+15550000001', to: '+15550000002' },
    });
    const full = { ...setupFrame('VX2'), accountSid: 'AC1', direction: 'inbound', customParameters: { token: 't', lang: 'en' } };
    expect(frameToEvent(full)).toEqual({
      type: 'session.start',
      provider: { sessionId: 'VX2', callSid: 'CA-VX2', from: '+15550000001', to: '+15550000002', accountSid: 'AC1', direction: 'inbound', 'param.token': 't', 'param.lang': 'en' },
    });
  });

  it('maps a prompt to speech, final or partial, keeping its language', () => {
    expect(frameToEvent(promptFrame('hello'))).toEqual(speechEvent('hello'));
    expect(frameToEvent(promptFrame('hel', false))).toEqual(speechEvent('hel', false));
    expect(frameToEvent({ type: 'prompt', voicePrompt: 'hola', lang: 'es-ES', last: true })).toEqual({ type: 'user.speech', text: 'hola', final: true, lang: 'es-ES' });
  });

  it('maps a dtmf to one key', () => {
    expect(frameToEvent(dtmfFrames('7')[0]!)).toEqual(keyEvents('7')[0]);
    expect(frameToEvent({ type: 'dtmf', digit: '#' })).toEqual({ type: 'user.key', digit: '#' });
  });

  it('maps an interrupt to what was heard and how far in', () => {
    expect(frameToEvent({ type: 'interrupt', utteranceUntilInterrupt: 'Thanks for', durationUntilInterruptMs: 400 })).toEqual(interruptEvent('Thanks for', 400));
  });

  it('maps an error to a channel error', () => {
    expect(frameToEvent({ type: 'error', description: 'TTS failed' })).toEqual(errorEvent('TTS failed'));
  });

  it('maps the server-made frames: silence, an agent result with or without its note, a sign-in', () => {
    expect(frameToEvent(silenceFrame())).toEqual(silenceEvent());
    expect(frameToEvent(serviceResultFrame('depot', null))).toEqual(serviceResultEvent('depot', null));
    expect(frameToEvent(serviceResultFrame('depot', null))).not.toHaveProperty('note');
    const note = { outcome: 'refused', reason: 'unapproved-document', ignoredTextParts: 1 };
    expect(frameToEvent(serviceResultFrame('depot', null, note))).toEqual(serviceResultEvent('depot', null, note));
    const principal = { kind: 'customer', level: 2, id: '55501234', first: 'Alex' } as never;
    expect(frameToEvent(signedInFrame(principal))).toEqual(signedInEvent(principal));
  });
});
