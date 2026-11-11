import { describe, expect, it } from 'vitest';
import { resolveConverseModel } from './resolve';

describe('resolveConverseModel', () => {
  it('names the missing key variable', () => {
    expect(() => resolveConverseModel('anthropic:claude-haiku-5-5', {})).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => resolveConverseModel('inception:mercury-3', {})).toThrow(/INCEPTION_API_KEY/);
    expect(() => resolveConverseModel('openrouter:vendor/model', {})).toThrow(/OPENROUTER_API_KEY/);
  });
  it('refuses a Claude model on OpenRouter', () => {
    expect(() => resolveConverseModel('openrouter:anthropic/claude-haiku-5.5', { OPENROUTER_API_KEY: 'k' })).toThrow(/Claude models go through the Anthropic API/);
  });
  it('refuses a spec it cannot read', () => {
    expect(() => resolveConverseModel('mercury-3', {})).toThrow(/<provider>:<model>/);
    expect(() => resolveConverseModel('other:x', {})).toThrow(/provider/);
  });
  it('resolves each provider with its key', () => {
    expect(resolveConverseModel('anthropic:claude-haiku-5-5', { ANTHROPIC_API_KEY: 'k' }).id).toBe('anthropic:claude-haiku-5-5');
    expect(resolveConverseModel('inception:mercury-3', { INCEPTION_API_KEY: 'k' }).id).toBe('inception:mercury-3');
    expect(resolveConverseModel('openrouter:vendor/model', { OPENROUTER_API_KEY: 'k' }).id).toBe('openrouter:vendor/model');
  });
});
