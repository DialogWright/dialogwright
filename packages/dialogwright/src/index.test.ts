import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as entry from './index';

describe('the package entry', () => {
  it('exports the registry, validation, lookups, channel model, server and harness by name', () => {
    for (const name of [
      'registerApp', 'getApp', 'defaultAppId', 'appOf', 'resetAppsForTest',
      'validateApp', 'formOf', 'slotSpecOf', 'toolOf',
      // the app definition: a folder's YAML joined with the app's code
      'defineApp', 'AppDefinitionError', 'isAppDefinitionError', 'formatProblem', 'checkApp', 'loadAppFolder',
      // the languages an app speaks
      'DEFAULT_LOCALE', 'defaultLocaleOf', 'localesOf', 'matchLocale', 'localeOf', 'slotLocaleOf',
      'serviceResultEvent', 'speechEvent', 'sayAction', 'endAction', 'transferAction', 'VOICE_RELAY', 'WEB_CHAT',
      'isAnonymous', 'isParty', 'ANONYMOUS',
      'startServer', 'serverMain', 'validateRoutes', 'routeOwns',
      'regressMain', 'cliMain', 'sweepMain', 'cassetteTrimMain',
      'scripted', 'replayRecords', 'MemoryAuditLog',
      // the building blocks an app's hooks and slot parsers use
      'isChoice', 'isNoul', 'isScore', 'noulValue', 'rankProbabilities', 'topMargin', 'handoff', 'handoffPromptId', 'DEFAULT_THRESHOLDS',
      'parseIso', 'addDays', 'describeDay', 'describeDob', 'resolveDate', 'MONTHS', 'WEEKDAYS', 'spokenToDigits', 'tokenize', 'matchesMask',
      'candidateSpans', 'candidateWordSpans', 'atLeast',
      // the slot library
      'defineSlot', 'defineSlots', 'slotsJsonSchema', 'buildSlot', 'SlotConfigError', 'isSlotConfigError', 'BUILT_IN_SLOT_TYPES', 'registerSlotType', 'defineSlotType', 'textType', 'digitsType', 'choiceType',
      'textParts', 'questionParts', 'renderTemplate', 'meetsThreshold',
      // an app's own tests and testing hooks
      'choice', 'noul', 'score', 'testSlotContext', 'newSession', 'resolveTurn', 'slotContext', 'mockCodeVerifier', 'spokenText',
      'buildQuestions', 'ENGINE_QUESTION_IDS', 'buildTurnState', 'FixtureStubClient', 'HeuristicStubClient', 'digitSpanLabel', 'dobParts', 'saysDob', 'saysExplicitYear',
      'loadCorpus', 'parseCorpus', 'normalizeText', 'buildClient', 'buildThresholds', 'defaultCorpusFile', 'scenariosDir', 'loadScenarios',
      'readBaseline', 'REGRESS_TODAY', 'runAll',
    ]) expect(typeof (entry as Record<string, unknown>)[name], name).not.toBe('undefined');
  });

  it('the exported functions are the engine ones', async () => {
    expect(entry.registerApp).toBe((await import('./core/app/registry')).registerApp);
    expect(entry.startServer).toBe((await import('./server/index')).startServer);
    expect(entry.serviceResultEvent('intake', { ok: true })).toEqual({ type: 'service.result', service: 'intake', result: { ok: true } });
    expect(entry.isAnonymous(entry.ANONYMOUS)).toBe(true);
    expect(entry.resolveTurn).toBe((await import('./core/turn')).resolve);
    expect(entry.defineApp).toBe((await import('./define/defineApp')).defineApp);
    expect(entry.checkApp).toBe((await import('./define/check')).checkApp);
    expect(entry.loadAppFolder).toBe((await import('./define/load')).loadAppFolder);
    expect(entry.defineSlot).toBe((await import('./slots/defineSlot')).defineSlot);
    expect(entry.defineSlots).toBe((await import('./slots/defineSlots')).defineSlots);
    expect(entry.BUILT_IN_SLOT_TYPES.text).toBe(entry.textType);
    expect(entry.BUILT_IN_SLOT_TYPES.digits).toBe(entry.digitsType);
    expect(entry.BUILT_IN_SLOT_TYPES.choice).toBe(entry.choiceType);
    expect(entry.defineSlot('note', { type: 'text', what: 'a note' }).type).toBe('text');
    // the library's types are exported with the functions that take them
    const spec: import('./index').LibrarySlotSpec = entry.defineSlot('note', { type: 'text', what: 'a note' });
    const example: import('./index').SlotExample = { name: 'a', slot: 'a', config: {}, utterances: [] };
    const type: import('./index').SlotType<import('./index').TextOptions> = entry.textType;
    expect([spec.id, example.name, type.type]).toEqual(['note', 'a', 'text']);
    // the options type is exported with the function it configures
    const options: import('./index').DefineAppOptions = { codeFile: 'src/app.ts' };
    expect(options.codeFile).toBe('src/app.ts');
  });

  it('importing it registers nothing', () => {
    // setup.ts registers the default test app; the entry adds no other.
    expect(() => entry.getApp('no-such-app')).toThrow();
  });
});

describe('subpath imports', () => {
  it('"./*" maps dialogwright/<dir>/<file> to src/<dir>/<file>.ts, and the entry to src/index.ts', () => {
    // In the repository this test runs from, package.json has no exports map; in the exported package it does.
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string; exports?: Record<string, string> };
    if (pkg.name !== 'dialogwright') return;
    expect(pkg.exports?.['.']).toBe('./src/index.ts');
    expect(pkg.exports?.['./*']).toBe('./src/*.ts');
    expect(pkg.exports?.['./testing']).toBe('./src/testing/index.ts');
  });
});

describe('the test-support entry', () => {
  it('"dialogwright/testing" has the shadow harness, the cassette-miss test and the slot conformance kit, which the root entry leaves out', async () => {
    const testing = await import('./testing/index');
    for (const name of [
      'shadowSlot', 'withShadowSlots', 'shadowFromEnv', 'createShadowReport', 'ShadowMismatchError', 'isCassetteMiss',
      'runSlotConformance', 'slotConformanceChecks', 'ConformanceError',
    ]) {
      expect(typeof (testing as Record<string, unknown>)[name], name).toBe('function');
      expect((entry as Record<string, unknown>)[name], name).toBeUndefined();
    }
    expect(testing.shadowSlot).toBe((await import('./testing/shadowSlot')).shadowSlot);
    expect(testing.runSlotConformance).toBe((await import('./slots/conformance/run')).runSlotConformance);
  });
});
