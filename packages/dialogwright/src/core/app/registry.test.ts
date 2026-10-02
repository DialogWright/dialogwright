import { describe, expect, it, beforeEach } from 'vitest';
import { registerApp, getApp, appOf, resetAppsForTest, defaultAppId } from './registry';
import type { App } from './types';

/** The smallest app that validates: no forms or slots, just the control intents the engine reads. */
const stub = (id: string): App => ({
  id,
  intents: Object.fromEntries(['agent', 'repeat_prompt', 'done'].map((i) => [i, { criteria: '', label: i, kind: 'control' }])),
  menu: [],
  forms: {},
  slots: {},
  identity: { subjectKind: 'subject', factorSlots: [], verifyTool: 'v', codeTool: 'c', sendCodeTool: 's' },
  tools: { v: {}, c: {}, s: {} },
  policy: { rulesFor: { v: [], c: [], s: [] }, toolLevel: {}, subjects: {} },
} as unknown as App);

describe('app registry', () => {
  beforeEach(() => resetAppsForTest());
  it('registers apps by id, the first as default', () => {
    registerApp(stub('a'));
    registerApp(stub('b'));
    expect(getApp('b').id).toBe('b');
    expect(defaultAppId()).toBe('a');
  });
  it("resolves a session's app by its appId, falling back to the default", () => {
    registerApp(stub('a'));
    expect(appOf({ appId: 'a' } as never).id).toBe('a');
    expect(appOf({} as never).id).toBe('a');
  });
  it('throws on an unknown app id, naming it', () => {
    registerApp(stub('a'));
    expect(() => getApp('nope')).toThrow(/nope/);
  });
  it('refuses a second app with the same id', () => {
    registerApp(stub('a'));
    expect(() => registerApp(stub('a'))).toThrow(/already registered/);
  });
});
