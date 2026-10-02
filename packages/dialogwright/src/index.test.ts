import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as entry from './index';

describe('the package entry', () => {
  it('exports the registry, validation, lookups, channel model, server and harness by name', () => {
    for (const name of [
      'registerApp', 'getApp', 'defaultAppId', 'appOf', 'resetAppsForTest',
      'validateApp', 'formOf', 'slotSpecOf', 'toolOf',
      'serviceResultEvent', 'speechEvent', 'sayAction', 'endAction', 'transferAction', 'VOICE_RELAY', 'WEB_CHAT',
      'isAnonymous', 'isParty', 'ANONYMOUS',
      'startServer', 'serverMain', 'validateRoutes', 'routeOwns',
      'regressMain', 'cliMain', 'sweepMain', 'cassetteTrimMain',
      'scripted', 'replayRecords', 'MemoryAuditLog',
      // the building blocks an app's hooks and slot parsers use
      'isChoice', 'isNoul', 'isScore', 'noulValue', 'rankProbabilities', 'topMargin', 'handoff', 'handoffPromptId', 'DEFAULT_THRESHOLDS',
      'parseIso', 'addDays', 'describeDay', 'describeDob', 'resolveDate', 'MONTHS', 'WEEKDAYS', 'spokenToDigits', 'tokenize', 'matchesMask',
      'candidateSpans', 'candidateWordSpans',
      // an app's own tests and testing hooks
      'choice', 'noul', 'score', 'testSlotContext', 'newSession', 'resolveTurn', 'slotContext', 'mockCodeVerifier', 'spokenText',
      'buildQuestions', 'buildTurnState', 'FixtureStubClient', 'HeuristicStubClient', 'digitSpanLabel', 'dobParts', 'saysDob', 'saysExplicitYear',
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
  });
});
