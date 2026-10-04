import { describe, expect, it } from 'vitest';
import {
  buildClient, buildThresholds, defaultCorpusFile, loadCorpus, loadScenarios, normalizeText, readBaseline,
  REGRESS_TODAY, runAll, scenariosDir, type Scenario,
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

/**
 * Calls on the stub that are not in the scripted calls: each turn after the first is spoken in a
 * state the cassette never recorded, so as a scripted call each would be a cassette miss in the
 * recorded replay. Their words are corpus lines, so the stub answers them from the labels.
 */
describe('what an answer on the opening turn leaves behind', () => {
  const corpus = loadCorpus(defaultCorpusFile());
  const call = async (id: string, says: string[]) => {
    const thresholds = buildThresholds([]);
    const scenario: Scenario = { id, steps: says.map((say) => ({ say })), expect: { decision: 'prompt' } };
    const actual = await runAll(corpus, [scenario], {
      client: buildClient('stub', defaultCorpusFile(), thresholds, REGRESS_TODAY),
      thresholds,
      todayIso: REGRESS_TODAY,
      now: () => 0,
    });
    return actual.scenarios[id]!;
  };

  it('does not keep the outage map as the topic of a question asked after it', async () => {
    const outcome = await call('map-then-question', ['where is the outage map', 'I have a question']);
    expect(outcome).toMatchObject({ form: 'ask_question', promptId: 'ask_subject', acks: ['ack_intent'] });
    expect(outcome.slots.subject).toBeNull();
  });

  it('does not carry the Saturday of an office-hours question into a payment arrangement', async () => {
    const hours = await call('hours', ['are you open on Saturday']);
    expect(hours).toMatchObject({ form: null, promptId: 'ask_intent', acks: ['kb_answer'] });
    expect(hours.slots).toMatchObject({ firstDate: null, subject: null });
    const plan = await call('hours-then-plan', ['are you open on Saturday', "I'd like to set up a payment arrangement"]);
    expect(plan).toMatchObject({ form: 'set_up_plan' });
    expect(plan.slots.firstDate).toBeNull();
  });
});
