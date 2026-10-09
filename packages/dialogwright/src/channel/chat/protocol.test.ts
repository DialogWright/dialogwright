import { describe, expect, it } from 'vitest';
import { contextBytes } from '../callData';
import { parseClientMessage, serializeServerMessage, actionsToChatMessages, CHAT_CONTEXT_BYTES, CHAT_CONTEXT_KEYS, CHAT_CONTEXT_VALUE_MAX, CHAT_TEXT_MAX } from './protocol';

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

describe('a start\'s context (the page\'s data, which an app\'s callData reads as chat.<key>)', () => {
  it('takes an object of short strings, and a start without one as before', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'start', v: 1, context: { page: '/orders/1042', 'utm.source': 'mail-2' } }))).toEqual({ ok: true, message: { type: 'start', v: 1, context: { page: '/orders/1042', 'utm.source': 'mail-2' } } });
    expect(parseClientMessage(JSON.stringify({ type: 'start', v: 1 }))).toEqual({ ok: true, message: { type: 'start', v: 1 } });
  });

  it('takes one at its bytes, and refuses one over them, counted as UTF-8', () => {
    const fits = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, 'x'.repeat(500)]));
    expect(contextBytes(fits)).toBeLessThanOrEqual(CHAT_CONTEXT_BYTES);
    expect(parseClientMessage(JSON.stringify({ type: 'start', v: 1, context: fits })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: 'start', v: 1, context: { ...fits, k12: 'x'.repeat(500) } })).ok).toBe(false);
    // 500 characters of three bytes each: few keys, many bytes.
    const wide = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, '€'.repeat(500)]));
    expect(parseClientMessage(JSON.stringify({ type: 'start', v: 1, context: wide })).ok).toBe(false);
  });

  it('never echoes a key it refuses', () => {
    const r = parseClientMessage(JSON.stringify({ type: 'start', v: 1, context: { 'bad key<script>': 'x' } }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).not.toContain('script');
      expect(r.message.startsWith('context ')).toBe(true);
    }
  });

  it('refuses one that is not, saying what it must be and never the value', () => {
    const refused = [
      { page: 42 },
      { page: 'x'.repeat(CHAT_CONTEXT_VALUE_MAX + 1) },
      { 'a key': 'x' },
      Object.fromEntries(Array.from({ length: CHAT_CONTEXT_KEYS + 1 }, (_, i) => [`k${i}`, 'v'])),
      ['page'],
    ];
    for (const context of refused) {
      const r = parseClientMessage(JSON.stringify({ type: 'start', v: 1, context }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('bad_message');
        expect(r.message).toContain('context');
        expect(r.message).not.toContain('xxxx');
      }
    }
  });
});
