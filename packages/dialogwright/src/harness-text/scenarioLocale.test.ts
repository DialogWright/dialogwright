import { afterAll, describe, expect, it } from 'vitest';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { libraryApp } from '../define/fixture/app';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { useTestkit } from '../testing/apps';
import { runScenario, type Scenario } from './runner';
import { promptText, spokenText } from '../prompts/render';
import { appOf } from '../core/app/registry';

/** A scenario's `locale`: a scripted call or chat that starts in a language, as a channel's start asks for one. */
resetAppsForTest();
registerApp(libraryApp);
afterAll(() => useTestkit());

const opts = { client: new HeuristicStubClient({ todayIso: '2026-09-18' }), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0 };
const greeting = (s: Scenario) => runScenario(s, opts).then((r) => {
  const first = r.runs[0]!.result;
  return { locale: first.session.locale, said: spokenText(appOf(first.session), first.decision, first.session.locale) };
});

describe('a scenario that starts in a language', () => {
  it('starts in the app\'s matching locale', async () => {
    const r = await greeting({ id: 'es-start', locale: 'es', steps: [], expect: { decision: 'prompt' } });
    expect(r.locale).toBe('es');
    expect(r.said).toMatch(/^Gracias por llamar/);
    expect(r.said).toBe(promptText(libraryApp, 'greeting', {}, 'es'));
  });

  it('without one, starts as it always has, in the default', async () => {
    const r = await greeting({ id: 'default-start', steps: [], expect: { decision: 'prompt' } });
    expect(r.locale).toBe('en-US');
    expect(r.said).toMatch(/^Thanks for calling/);
  });
});

describe('a scenario file with a locale', () => {
  it('refuses a locale that is not a string', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { loadScenarios } = await import('./runner');
    const dir = mkdtempSync(join(tmpdir(), 'scenarios-'));
    try {
      writeFileSync(join(dir, 'a.json'), JSON.stringify([{ id: 'x', locale: 'es', steps: [], expect: { decision: 'prompt' } }]));
      expect(loadScenarios(dir)[0]?.locale).toBe('es');
      writeFileSync(join(dir, 'a.json'), JSON.stringify([{ id: 'x', locale: 7, steps: [], expect: { decision: 'prompt' } }]));
      expect(() => loadScenarios(dir)).toThrow('has a locale that is not a language tag');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
