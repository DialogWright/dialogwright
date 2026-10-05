import { describe, expect, it } from 'vitest';
import {
  buildClient, buildThresholds, defaultCorpusFile, loadCorpus, loadScenarios, normalizeText, readBaseline,
  REGRESS_TODAY, runAll, scenariosDir,
} from 'dialogwright';
import { clinicApp } from './index';
import type { ClinicCorpusSlots } from './domain/testing';

/**
 * The clinic's fixtures: the labelled corpus and the scripted calls, all with the practice's fictional
 * names. The baseline (fixtures/expected) was made once, in the regression run, and reviewed; here it is only checked.
 */
describe('the clinic fixtures', () => {
  const corpus = loadCorpus(defaultCorpusFile());
  const scenarios = loadScenarios(scenariosDir());

  it('has the clinic\'s corpus and scripted calls, every label one the clinic\'s questions can pick', () => {
    expect(corpus).toHaveLength(249);
    expect(scenarios).toHaveLength(90);
    // loadCorpus has checked each entry's slot labels (App.testing.checkCorpusSlots) and question labels.
    for (const slot of Object.keys(clinicApp.slots)) expect(corpus.some((e) => Object.hasOwn((e.slots ?? {}) as ClinicCorpusSlots, slot)), slot).toBe(true);
    for (const id of ['timeOfDay', 'timePreference', 'providerUnsure', 'providerNameStatus']) expect(corpus.some((e) => e.labels && Object.hasOwn(e.labels, id)), id).toBe(true);
  });

  it('has every spoken step of every scripted call in the corpus, so the stub answers it from labels', () => {
    const texts = new Set(corpus.map((e) => normalizeText(e.text)));
    const missing = scenarios.flatMap((s) => s.steps.flatMap((step) => ('say' in step && !texts.has(normalizeText(step.say)) ? [`${s.id}: ${step.say}`] : [])));
    expect(missing).toEqual([]);
  });

  it('runs every corpus entry and scripted call against the stub: each call meets its expectation, and the outcomes match the committed baseline', async () => {
    const thresholds = buildThresholds([]);
    const actual = await runAll(corpus, scenarios, {
      client: buildClient('stub', defaultCorpusFile(), thresholds, REGRESS_TODAY),
      thresholds,
      todayIso: REGRESS_TODAY,
      now: () => 0,
    });
    expect(Object.keys(actual.corpus)).toHaveLength(corpus.length);
    expect(Object.keys(actual.scenarios)).toHaveLength(scenarios.length);
    // Every scripted call passes the expect block it carries (the intended behavior, carried from an earlier version of this example).
    for (const s of Object.values(actual.scenarios)) expect(s.mismatches, s.id).toEqual([]);
    // And the outcomes are exactly the baseline made once and reviewed (a change here is a behavior change).
    const expected = readBaseline();
    expect(actual.scenarios).toEqual(expected.scenarios);
    expect(actual.corpus).toEqual(expected.corpus);
  });
});
