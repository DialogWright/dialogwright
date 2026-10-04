import { describe, expect, it } from 'vitest';
import { describeConfig, loadConfig } from '../config';

const base = { PUBLIC_HOST: 'voice.example.com', TWILIO_AUTH_TOKEN: 'tok', HANDOFF_NUMBER: '+15551234567' };
const on = { ...base, CHAT: 'on', CHAT_ALLOWED_ORIGINS: 'https://www.example.com' };

describe('chat config', () => {
  it('is off by default, and off leaves the config without chat', () => {
    expect(loadConfig(base).chat).toBeUndefined();
    expect(loadConfig({ ...base, CHAT: 'off' }).chat).toBeUndefined();
    expect(describeConfig(loadConfig(base))).not.toContain('chat');
    // Off, the other chat variables are not read.
    expect(loadConfig({ ...base, CHAT_ALLOWED_ORIGINS: 'nonsense', CHAT_IDLE_MS: 'x' }).chat).toBeUndefined();
  });

  it('on, takes the allowed origins and the idle limit', () => {
    const c = loadConfig({ ...on, CHAT_ALLOWED_ORIGINS: 'https://www.example.com, https://help.example.com' });
    expect(c.chat?.idleMs).toBe(1_800_000);
    expect(c.chat?.origins).toEqual({ any: false, set: new Set(['https://www.example.com', 'https://help.example.com']) });
    expect(loadConfig({ ...on, CHAT_IDLE_MS: '60000' }).chat?.idleMs).toBe(60_000);
    expect(describeConfig(c)).toContain('chat on (https://www.example.com, https://help.example.com)');
  });

  it('says what is wrong, in the usual words', () => {
    expect(() => loadConfig({ ...base, CHAT: 'yes' })).toThrow('CHAT must be on or off, got "yes"');
    expect(() => loadConfig({ ...base, CHAT: 'on' })).toThrow('missing required environment variable CHAT_ALLOWED_ORIGINS (CHAT=on)');
    expect(() => loadConfig({ ...on, CHAT_ALLOWED_ORIGINS: 'www.example.com' })).toThrow('CHAT_ALLOWED_ORIGINS must be origins like https://www.example.com, got "www.example.com"');
    expect(() => loadConfig({ ...on, CHAT_ALLOWED_ORIGINS: '*' })).toThrow('CHAT_ALLOWED_ORIGINS may be * only when PUBLIC_HOST is localhost');
    expect(loadConfig({ ...on, PUBLIC_HOST: 'localhost', CHAT_ALLOWED_ORIGINS: '*' }).chat?.origins).toEqual({ any: true });
    expect(() => loadConfig({ ...on, CHAT_IDLE_MS: '-1' })).toThrow('CHAT_IDLE_MS must be a non-negative integer, got "-1"');
    expect(() => loadConfig({ ...on, CHAT_IDLE_MS: '0' })).toThrow('CHAT_IDLE_MS must be a positive number of milliseconds, got "0"');
  });
});
