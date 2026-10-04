import { describe, expect, it } from 'vitest';
import { parseClientMessage, serializeServerMessage, actionsToChatMessages, CHAT_TEXT_MAX } from './protocol';

describe('the chat wire', () => {
  it('reads each client message', () => {
    expect(parseClientMessage('{"type":"start","v":1,"locale":"es"}')).toEqual({ ok: true, message: { type: 'start', v: 1, locale: 'es' } });
    expect(parseClientMessage('{"type":"start","v":1,"resume":"0123456789abcdef0123456789abcdef","token":"abc"}')).toEqual({ ok: true, message: { type: 'start', v: 1, resume: '0123456789abcdef0123456789abcdef', token: 'abc' } });
    expect(parseClientMessage('{"type":"text","text":"my power is out"}')).toEqual({ ok: true, message: { type: 'text', text: 'my power is out' } });
    expect(parseClientMessage('{"type":"sign_in","token":"abc"}')).toEqual({ ok: true, message: { type: 'sign_in', token: 'abc' } });
    expect(parseClientMessage('{"type":"ping"}')).toEqual({ ok: true, message: { type: 'ping' } });
  });

  it('refuses what is not the protocol, saying why', () => {
    expect(parseClientMessage('not json')).toMatchObject({ ok: false, code: 'bad_message' });
    expect(parseClientMessage('[1]')).toMatchObject({ ok: false, code: 'bad_message' });
    expect(parseClientMessage('{"type":"start","v":2}')).toMatchObject({ ok: false, code: 'bad_message' });
    expect(parseClientMessage('{"type":"start"}')).toMatchObject({ ok: false, code: 'bad_message' });
    expect(parseClientMessage(JSON.stringify({ type: 'text', text: 'x'.repeat(CHAT_TEXT_MAX + 1) }))).toMatchObject({ ok: false, code: 'too_long' });
    expect(parseClientMessage(JSON.stringify({ type: 'text', text: 'x'.repeat(CHAT_TEXT_MAX) }))).toMatchObject({ ok: true });
    expect(parseClientMessage('{"type":"text","text":""}')).toMatchObject({ ok: false, code: 'bad_message' });
    expect(parseClientMessage('{"type":"start","v":1,"extra":1}')).toMatchObject({ ok: false, code: 'bad_message' });
    expect(parseClientMessage('{"type":"start","v":1,"resume":"not-a-resume-token"}')).toMatchObject({ ok: false, code: 'bad_message' });
    expect(parseClientMessage('{"type":"start","v":1,"locale":"es\\u0000x"}')).toMatchObject({ ok: false, code: 'bad_message' });
    expect(parseClientMessage(JSON.stringify({ type: 'sign_in', token: 't'.repeat(8193) }))).toMatchObject({ ok: false, code: 'bad_message' });
    expect(parseClientMessage('{"type":"shout"}')).toMatchObject({ ok: false, code: 'bad_message' });
  });

  it('never repeats a token in why it refused a message', () => {
    const token = 'eyJhbGciOiJSUzI1NiJ9.c2VjcmV0.c2lnbmF0dXJl';
    const r = parseClientMessage(JSON.stringify({ type: 'sign_in', token, extra: true }));
    expect(r).toMatchObject({ ok: false, code: 'bad_message' });
    expect(JSON.stringify(r)).not.toContain(token);
  });

  it('turns the core actions into chat messages, with the line language', () => {
    expect(actionsToChatMessages([
      { type: 'say', parts: [{ text: 'Hola.' }, { audio: '/audio/x.mp3' }, { text: 'Adios.' }], interruptible: true, lang: 'es-US' },
      { type: 'say', parts: [{ text: 'Hello.' }], interruptible: true },
      { type: 'say', parts: [{ audio: '/audio/only.mp3' }], interruptible: true },
      { type: 'transfer', reason: 'live-agent', completed: [], queued: [], slots: { accountId: '55501234' } },
      { type: 'set_language', tts: 'es-US', transcription: 'es-US' },
      { type: 'send_digits', digits: '1' },
      { type: 'end', completed: [] },
    ], 'en-US')).toEqual([
      { type: 'say', text: 'Hola. Adios.', lang: 'es-US' },
      { type: 'say', text: 'Hello.', lang: 'en-US' },
      { type: 'transfer', reason: 'live-agent' },
      { type: 'end' },
    ]);
  });

  it('never sends the collected slots to the browser', () => {
    const [transfer] = actionsToChatMessages([{ type: 'transfer', reason: 'live-agent', completed: ['x'], queued: ['y'], slots: { accountId: '55501234' } }], 'en-US');
    expect(serializeServerMessage(transfer!)).toBe('{"type":"transfer","reason":"live-agent"}');
  });
});
