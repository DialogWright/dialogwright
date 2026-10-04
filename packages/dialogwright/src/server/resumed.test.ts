import { describe, expect, it } from 'vitest';
import { RESUMED_TEXT, resumedLine } from './adapter';
import { newSession } from '../core/session';
import { registerApp } from '../core/app/registry';
import { VOICE_RELAY } from '../channel/caps';
import { useTestkit } from '../testing/apps';
import { testkitApp } from '../testing/testkit';
import type { App } from '../core/app/types';

useTestkit();

/** The line a call resumed after a restart hears first (adapter.ts resumedLine). */
describe('the resumed line', () => {
  it("is the engine's, for an app whose prompts have no `resumed`", () => {
    expect(RESUMED_TEXT).toBe('Sorry, I lost you for a moment.');
    expect(resumedLine(newSession('CA1', 0, VOICE_RELAY))).toBe(RESUMED_TEXT);
  });

  it("is the app's own `resumed` prompt where it has one", () => {
    const own: App = {
      ...testkitApp,
      id: 'resumed-own',
      prompts: { ...testkitApp.prompts, manifest: { ...testkitApp.prompts.manifest, resumed: { text: 'Apologies, the line dropped for a second.', interruptible: true } } },
    };
    registerApp(own);
    expect(resumedLine(newSession('CA1', 0, VOICE_RELAY, undefined, 'resumed-own'))).toBe('Apologies, the line dropped for a second.');
  });
});
