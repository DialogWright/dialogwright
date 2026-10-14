import { describe, expect, it } from 'vitest';
import {
  buildClient, buildThresholds, defaultCorpusFile, loadCorpus, loadScenarios, normalizeText, readBaseline,
  REGRESS_TODAY, runAll, scenariosDir,
} from 'dialogwright';

/**
 * The fixtures: the labelled corpus and the scripted calls. The baseline (fixtures/expected) holds
 * the stub's outcomes for them, made once and reviewed; here it is only checked, never rewritten.
 */
describe('the fixtures', () => {
  const corpus = loadCorpus(defaultCorpusFile());
  const scenarios = loadScenarios(scenariosDir());

  it('has a corpus and scripted calls', () => {
    expect(corpus.length).toBeGreaterThan(0);
    expect(scenarios.length).toBeGreaterThan(0);
  });

  it('has every spoken step of every scripted call in the corpus, so the stub answers it from labels', () => {
    const texts = new Set(corpus.map((e) => normalizeText(e.text)));
    const missing = scenarios.flatMap((s) => s.steps.flatMap((step) => ('say' in step && !texts.has(normalizeText(step.say)) ? [`${s.id}: ${step.say}`] : [])));
    expect(missing).toEqual([]);
  });

  it('runs every corpus line and scripted call against the stub: each call meets its expectation, and the outcomes match the baseline', async () => {
    const thresholds = buildThresholds([]);
    const actual = await runAll(corpus, scenarios, {
      client: buildClient('stub', defaultCorpusFile(), thresholds, REGRESS_TODAY),
      thresholds,
      todayIso: REGRESS_TODAY,
      now: () => 0,
    });
    for (const s of Object.values(actual.scenarios)) expect(s.mismatches, s.id).toEqual([]);
    const expected = readBaseline();
    expect(actual.scenarios).toEqual(expected.scenarios);
    expect(actual.corpus).toEqual(expected.corpus);
  });
});
