import { describe, expect, it } from 'vitest';
import { parseAllowedOrigins, originAllowed } from './origins';

describe('chat origins', () => {
  it('allows exactly the listed origins', () => {
    const allowed = parseAllowedOrigins('https://www.example.com, https://help.example.com', 'voice.example.com');
    expect(originAllowed(allowed, 'https://www.example.com')).toBe(true);
    expect(originAllowed(allowed, 'https://help.example.com')).toBe(true);
    expect(originAllowed(allowed, 'https://www.example.com.evil.test')).toBe(false);
    expect(originAllowed(allowed, 'http://www.example.com')).toBe(false);
    expect(originAllowed(allowed, 'https://www.example.com:8443')).toBe(false);
    expect(originAllowed(allowed, 'null')).toBe(false);
    expect(originAllowed(allowed, undefined)).toBe(false);
  });

  it('takes a port when the origin has one', () => {
    const allowed = parseAllowedOrigins('http://localhost:5173', 'voice.example.com');
    expect(originAllowed(allowed, 'http://localhost:5173')).toBe(true);
    expect(originAllowed(allowed, 'http://localhost:5174')).toBe(false);
  });

  it('allows any origin only on a laptop', () => {
    expect(originAllowed(parseAllowedOrigins('*', 'localhost'), 'http://localhost:5173')).toBe(true);
    expect(() => parseAllowedOrigins('*', 'voice.example.com')).toThrow('CHAT_ALLOWED_ORIGINS may be * only when PUBLIC_HOST is localhost');
    expect(() => parseAllowedOrigins('https://www.example.com, *', 'localhost')).toThrow('CHAT_ALLOWED_ORIGINS must be origins like https://www.example.com, got "*"');
  });

  it('refuses what is not an origin', () => {
    expect(() => parseAllowedOrigins('www.example.com', 'voice.example.com')).toThrow('CHAT_ALLOWED_ORIGINS must be origins like https://www.example.com, got "www.example.com"');
    expect(() => parseAllowedOrigins('https://www.example.com/chat', 'voice.example.com')).toThrow('got "https://www.example.com/chat"');
    expect(() => parseAllowedOrigins('https://www.example.com/', 'voice.example.com')).toThrow('got "https://www.example.com/"');
    expect(() => parseAllowedOrigins('ftp://www.example.com', 'voice.example.com')).toThrow('got "ftp://www.example.com"');
    expect(() => parseAllowedOrigins('https://user@www.example.com', 'voice.example.com')).toThrow('got "https://user@www.example.com"');
    expect(() => parseAllowedOrigins(' , ', 'voice.example.com')).toThrow('CHAT_ALLOWED_ORIGINS must name at least one origin');
  });
});
