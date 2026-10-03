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
      'DEFAULT_LOCALE', 'defaultLocaleOf', 'localesOf', 'matchLocale', 'localeOf',
      'serviceResultEvent', 'speechEvent', 'sayAction', 'endAction', 'transferAction', 'VOICE_RELAY', 'WEB_CHAT',
      'isAnonymous', 'isParty', 'ANONYMOUS',
      'startServer', 'serverMain', 'validateRoutes', 'routeOwns',
      'regressMain', 'cliMain', 'sweepMain', 'cassetteTrimMain',
      'scripted', 'replayRecords', 'MemoryAuditLog',
      // the building blocks an app's hooks and slot parsers use
      'isChoice', 'isNoul', 'isScore', 'noulValue', 'rankProbabilities', 'topMargin', 'handoff', 'handoffPromptId', 'DEFAULT_THRESHOLDS',
      'parseIso', 'addDays', 'describeDay', 'describeDob', 'resolveDate', 'MONTHS', 'WEEKDAYS', 'spokenToDigits', 'tokenize', 'numbersSaid', 'matchesMask',
      'candidateSpans', 'candidateWordSpans', 'atLeast',
      // the slot library
      'defineSlot', 'defineSlots', 'slotsJsonSchema', 'buildSlot', 'SlotConfigError', 'isSlotConfigError', 'BUILT_IN_SLOT_TYPES', 'registerSlotType',
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
    expect(Object.keys(entry.BUILT_IN_SLOT_TYPES).sort()).toEqual(['birthdate', 'choice', 'date', 'digits', 'name', 'record', 'text']);
    expect(entry.BUILT_IN_SLOT_TYPES.text).toBe((await import('./slots/text/index')).textType);
    expect(entry.defineSlot('note', { type: 'text', what: 'a note' }).type).toBe('text');
    // the library's types are exported with the functions that take them
    const spec: import('./index').LibrarySlotSpec = entry.defineSlot('note', { type: 'text', what: 'a note' });
    const type: import('./index').SlotType<import('./index').TextOptions> = entry.BUILT_IN_SLOT_TYPES.text as import('./index').SlotType<import('./index').TextOptions>;
    const option: import('./index').ChoiceOption = { say: 'A' };
    expect([spec.id, type.type, option.say]).toEqual(['note', 'text', 'A']);
    // the options type is exported with the function it configures
    const options: import('./index').DefineAppOptions = { codeFile: 'src/app.ts' };
    expect(options.codeFile).toBe('src/app.ts');
  });

  it('keeps what an app author needs: the helpers a slot type is written with are in dialogwright/slot-kit, and the engine\'s own tables stay inside', () => {
    for (const name of [
      // dialogwright/slot-kit
      'defineSlotType', 'textParts', 'questionParts', 'questionText', 'renderTemplate', 'TemplateError', 'meetsThreshold', 'examplesFrom', 'parseSlotExamples', 'wordingFor',
      // internal
      'applySlotWording', 'isLibrarySlot', 'localeSlotsFile', 'slotTypeJsonSchema', 'slotLocaleOf', 'ENGLISH', 'SPANISH', 'foldAccents', 'lexiconOf', 'MONTHS_ES', 'WEEKDAYS_ES',
      'birthdateType', 'choiceType', 'dateType', 'digitsType', 'nameType', 'recordType', 'textType',
    ]) expect((entry as Record<string, unknown>)[name], name).toBeUndefined();
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
    expect(pkg.exports?.['./slot-kit']).toBe('./src/slots/kit.ts');
    expect(pkg.exports?.['./policy']).toBe('./src/define/policyEntry.ts');
  });
});

describe('the slot type author\'s entry', () => {
  it('"dialogwright/slot-kit" has the helpers a slot type is written with, which the root entry leaves out', async () => {
    const kit = await import('./slots/kit');
    expect(Object.keys(kit).sort()).toEqual([
      'TemplateError', 'defineSlotType', 'examplesFrom', 'meetsThreshold', 'parseSlotExamples', 'questionParts', 'questionText', 'renderTemplate', 'textParts', 'wordingFor',
    ]);
    for (const name of Object.keys(kit)) expect((entry as Record<string, unknown>)[name], name).toBeUndefined();
    expect(kit.defineSlotType).toBe((await import('./slots/slotType')).defineSlotType);
    expect(kit.meetsThreshold).toBe((await import('./slots/parts/thresholds')).meetsThreshold);
    // its types: an example, as a type's examples.yaml holds them, and what a type builds
    const example: import('./slots/kit').SlotExample = { name: 'a', slot: 'a', config: {}, utterances: [] };
    const parts: import('./slots/kit').TextPartDef = { template: 'a {noun}', vars: ['noun'] } as unknown as import('./slots/kit').TextPartDef;
    expect([example.name, typeof parts]).toEqual(['a', 'object']);
  });
});

describe('the test-support entry', () => {
  it('"dialogwright/testing" has the shadow harness, the cassette-miss test and the slot conformance kit, which the root entry leaves out', async () => {
    const testing = await import('./testing/index');
    for (const name of [
      'shadowSlot', 'withShadowSlots', 'shadowFromEnv', 'createShadowReport', 'ShadowMismatchError', 'isCassetteMiss',
      'runSlotConformance', 'slotConformanceChecks', 'ConformanceError', 'withShadowGate', 'shadowGate', 'createGateShadowReport', 'GateShadowMismatchError',
    ]) {
      expect(typeof (testing as Record<string, unknown>)[name], name).toBe('function');
      expect((entry as Record<string, unknown>)[name], name).toBeUndefined();
    }
    expect(testing.shadowSlot).toBe((await import('./testing/shadowSlot')).shadowSlot);
    expect(testing.runSlotConformance).toBe((await import('./slots/conformance/run')).runSlotConformance);
  });
});

describe('the policy entry', () => {
  it('"dialogwright/policy" has the policy and identity files\' API and the gate, which the root entry leaves out', async () => {
    const policy = await import('./define/policyEntry');
    for (const name of ['definePolicy', 'defineIdentity', 'compilePolicy', 'compileIdentity', 'compiledPolicyOf', 'compileGate', 'programFromTables', 'evaluateCall', 'confirmationHash', 'readRule', 'ruleIdOf', 'roleLine', 'isRuleId']) {
      expect(typeof (policy as Record<string, unknown>)[name], name).toBe('function');
      expect((entry as Record<string, unknown>)[name], name).toBeUndefined();
    }
    expect(policy.evaluateCall).toBe((await import('./gate/policy')).evaluateCall);
    expect(policy.compiledPolicyOf).toBe((await import('./gate/compiled')).compiledPolicyOf);
    expect(policy.definePolicy).toBe((await import('./define/definePolicy')).definePolicy);
    expect(policy.RULE_ID_OF).toEqual({ identity: 'R1', scope: 'R2', confirmed: 'R3', role: 'R5', attempts: 'R6', fields: 'R7' });
    expect([...policy.RULE_IDS]).toEqual(['R1', 'R2', 'R3', 'R5', 'R6', 'R7']);
    // the gate's types, for an app's own rules and its gate tests
    const rule = (c: import('./define/policyEntry').RuleContext): import('./define/policyEntry').RuleOutcome => ({ result: { id: 'x', description: c.call.tool, compared: '', pass: true } });
    const tables: Pick<import('./define/policyEntry').PolicyTables, 'customRules'> = { customRules: { x: rule } };
    expect(typeof tables.customRules?.x).toBe('function');
  });
});
