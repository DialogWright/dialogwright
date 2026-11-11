import { describe, expect, it } from 'vitest';
import { converseModelKeyVar, openRouterHosts, resolveConverseModel } from './resolve';

describe('resolveConverseModel', () => {
  it('names the missing key variable', () => {
    expect(() => resolveConverseModel('anthropic:claude-haiku-5-5', {})).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => resolveConverseModel('inception:mercury-3', {})).toThrow(/INCEPTION_API_KEY/);
    expect(() => resolveConverseModel('openrouter:vendor/model', {})).toThrow(/OPENROUTER_API_KEY/);
    expect(() => resolveConverseModel('meta:muse-ember-1.0', {})).toThrow(/META_API_KEY/);
  });
  it('names each provider\'s key variable', () => {
    expect(converseModelKeyVar('meta:muse-ember-1.0')).toBe('META_API_KEY');
    expect(converseModelKeyVar('openrouter:vendor/model@host')).toBe('OPENROUTER_API_KEY');
    expect(converseModelKeyVar('other:x')).toBeNull();
  });
  it('reads the hosts an OpenRouter spec pins after @, and refuses @ elsewhere or empty', () => {
    expect(openRouterHosts('vendor/model')).toEqual({ model: 'vendor/model', only: [] });
    expect(openRouterHosts('vendor/model@groq')).toEqual({ model: 'vendor/model', only: ['groq'] });
    expect(openRouterHosts('vendor/model@groq,cerebras')).toEqual({ model: 'vendor/model', only: ['groq', 'cerebras'] });
    expect(resolveConverseModel('openrouter:vendor/model@groq', { OPENROUTER_API_KEY: 'k' }).id).toBe('openrouter:vendor/model@groq');
    expect(() => resolveConverseModel('openrouter:vendor/model@', { OPENROUTER_API_KEY: 'k' })).toThrow(/after @/);
    expect(() => resolveConverseModel('inception:mercury-3@x', { INCEPTION_API_KEY: 'k' })).toThrow(/only an OpenRouter/);
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
    expect(resolveConverseModel('meta:muse-ember-1.0', { META_API_KEY: 'k' }).id).toBe('meta:muse-ember-1.0');
  });
});
