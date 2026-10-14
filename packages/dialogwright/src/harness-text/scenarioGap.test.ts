import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestkit } from '../testing/apps';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { loadCorpus } from '../jev/corpus';
import { defaultCorpusFile } from '../run/fixtures';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import type { JevClient } from '../jev/types';
import { checkExpectation, loadScenarios, runScenario, type Outcome, type Scenario } from './runner';
import type { ScenarioOutcome } from './baseline';
import { diff, differingIds, failingScenarios, gapsNowMatching, knownGapsFor } from './regressDiff';
import { formatTriage } from './regressSummary';
import { mismatchField, scenarioGapProblems, scenarioShowsGap } from './scenarioGap';

useTestkit();

/**
 * A scripted call's known gap (Scenario.knownGap) at the regression's level: a call run on the stub
 * (the baseline), and again on a client that reads its opener as a real model is known to (the
 * request said at 0.55, so the engine checks it with a yes or no first), compared as `regress` does.
 */
const stub = new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: 0.9, fallback: new HeuristicStubClient({ todayIso: '2026-09-18' }) });

/** The stub, but the request it reads at 0.55 rather than its label's sharpness (or `none` at 0.9, with `unsure: false`). */
function modelClient(unsure = true): JevClient {
  return {
    ask: async (req) => {
      const r = await stub.ask(req);
      const intent = r.answers.intent;
      if (intent?.type === 'choice' && intent.choice === 'track_parcel') {
        r.answers.intent = unsure
          ? { type: 'choice', choice: 'track_parcel', probabilities: { track_parcel: 0.55, none: 0.45 }, confidence: 0.55 }
          : { type: 'choice', choice: 'none', probabilities: { track_parcel: 0.1, none: 0.9 }, confidence: 0.9 };
      }
      return r;
    },
  };
}

const REASON = 'the opener read at 0.55, so the request is checked with a yes or no first: one more question, safe';
const KNOWN_END = { promptId: 'confirm_intent_explicit', acks: [], form: null, gate: null };
const call: Scenario = {
  id: 'parcel-opener',
  steps: [{ say: 'where is my parcel' }],
  expect: { decision: 'prompt', promptId: 'ask_accountId', form: 'track_parcel', text: 'account ID' },
  knownGap: { reason: REASON, outcome: KNOWN_END },
};
const opts = { thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0 };

async function outcome(client: JevClient, scenario: Scenario = call): Promise<ScenarioOutcome> {
  const r = await runScenario(scenario, { ...opts, client });
  return { ...r.outcome, pass: r.pass, mismatches: r.mismatches };
}

let baseline: Record<string, ScenarioOutcome>;
let known: Record<string, ScenarioOutcome>;
beforeAll(async () => {
  baseline = { [call.id]: await outcome(stub) };
  known = { [call.id]: await outcome(modelClient()) };
});

describe('a scripted call with a known gap, run against a real model', () => {
  it('the stub reaches the expectation, and the model the known end, missing the expectation', () => {
    expect(baseline[call.id]).toMatchObject({ promptId: 'ask_accountId', form: 'track_parcel', pass: true, mismatches: [] });
    expect(known[call.id]).toMatchObject({ ...KNOWN_END, pass: false });
    expect(known[call.id]!.mismatches.map(mismatchField)).toEqual(['promptId', 'form', 'text']);
  });

  it('is allowed when its end is the known one: not failing, not differing, each line marked with the reason', () => {
    const gaps = knownGapsFor('recorded', [call]);
    const d = diff('scenario', baseline, known, new Set(), gaps);
    expect(d.lines).toEqual([]);
    expect(d.gapped).toEqual([call.id]);
    expect(d.allowed).toContain(`~ scenario ${call.id}.promptId: "ask_accountId" -> "confirm_intent_explicit" (allowed: knownGap: ${REASON})`);
    expect(d.allowed).toContain(`~ scenario ${call.id}.pass: true -> false (allowed: knownGap: ${REASON})`);
    expect(d.allowed.every((l) => l.endsWith(`(allowed: knownGap: ${REASON})`))).toBe(true);
    expect(failingScenarios(baseline, known, gaps)).toEqual([]);
    expect(differingIds('scenario', baseline, known, new Set(), gaps)).toEqual([]);
    expect(gapsNowMatching(baseline, known, gaps)).toEqual([]);
    expect(formatTriage({ corpusDiffering: [], scenariosFailing: failingScenarios(baseline, known, gaps), scenariosDiffering: differingIds('scenario', baseline, known, new Set(), gaps), records: [] }))
      .toBe('to triage: 0 untagged corpus differences, 0 failing scripted calls, 0 passing scripted calls that differ from the baseline, 0 cassette misses');
  });

  it('allows one of a few known ends, as a corpus line does', () => {
    const tagged = { ...call, knownGap: { reason: REASON, outcomes: [{ promptId: 'ask_intent' }, KNOWN_END] } };
    expect(failingScenarios(baseline, known, knownGapsFor('jev', [tagged]))).toEqual([]);
  });

  it('still fails on any other end, naming what the pin expected', async () => {
    const other = { [call.id]: await outcome(modelClient(false)) };
    expect(other[call.id]!.promptId).not.toBe('confirm_intent_explicit');
    const gaps = knownGapsFor('recorded', [call]);
    expect(failingScenarios(baseline, other, gaps)).toEqual([call.id]);
    const d = diff('scenario', baseline, other, new Set(), gaps);
    expect(d.allowed).toEqual([]);
    expect(d.gapped).toEqual([]);
    expect(d.lines).toContainEqual(expect.stringMatching(new RegExp(`^~ scenario ${call.id}\\.promptId: "ask_accountId" -> ".*" \\(knownGap pins "confirm_intent_explicit"\\)$`)));
    // A pin that names only part of the known end does not show it either.
    const partial = knownGapsFor('recorded', [{ ...call, knownGap: { reason: REASON, outcome: { promptId: 'confirm_intent_explicit' } } }]);
    expect(failingScenarios(baseline, known, partial)).toEqual([call.id]);
  });

  it('a stub run ignores it: the call is held to its expectation and the baseline exactly', async () => {
    for (const kind of ['stub', 'heuristic']) {
      const gaps = knownGapsFor(kind, [call]);
      expect(gaps.size).toBe(0);
      expect(failingScenarios(baseline, known, gaps)).toEqual([call.id]);
      expect(diff('scenario', baseline, known, new Set(), gaps).allowed).toEqual([]);
    }
    const again = { [call.id]: await outcome(stub) };
    expect(diff('scenario', baseline, again, new Set(), knownGapsFor('stub', [call])).lines).toEqual([]);
  });

  it('says when the model reaches the expectation again, so the tag can go', async () => {
    const gaps = knownGapsFor('recorded', [call]);
    const matching = { [call.id]: await outcome(stub) };
    expect(gapsNowMatching(baseline, matching, gaps)).toEqual([call.id]);
    expect(diff('scenario', baseline, matching, new Set(), gaps)).toMatchObject({ lines: [], allowed: [], gapped: [], matching: 1 });
  });
});

describe('scenarioShowsGap', () => {
  const base = (over: Partial<ScenarioOutcome> = {}): ScenarioOutcome => ({
    id: 's', decision: 'prompt', promptId: 'ask_name', acks: [], reason: null, decidedGate: 'intent', verdict: 'route', form: 'f', slots: {}, queued: [], principalLevel: 0, gate: null, pass: true, mismatches: [], ...over,
  });

  it('explains a missed text or transfer only when the pin changes what the last turn does', () => {
    const said = { reason: 'r', outcome: { promptId: 'ask_other' } };
    expect(scenarioShowsGap(base(), base({ promptId: 'ask_other', pass: false, mismatches: ['promptId: expected ask_name, got ask_other', 'text: expected to contain "name", got "x"'] }), said)).toBe(true);
    const unsaid = { reason: 'r', outcome: { decidedGate: 'other' } };
    expect(scenarioShowsGap(base(), base({ decidedGate: 'other' }), unsaid)).toBe(true);
    expect(scenarioShowsGap(base(), base({ decidedGate: 'other', pass: false, mismatches: ['text: expected to contain "name", got "x"'] }), unsaid)).toBe(false);
    expect(scenarioShowsGap(base(), base({ decidedGate: 'other', pass: false, mismatches: ['transfer target: expected A, got B'] }), unsaid)).toBe(false);
  });

  it('never explains a missed field the pin leaves as the baseline had it', () => {
    const gap = { reason: 'r', outcome: { promptId: 'ask_other' } };
    expect(scenarioShowsGap(base(), base({ promptId: 'ask_other', pass: false, mismatches: ['gate: expected x, got null'] }), gap)).toBe(false);
  });

  it('reads every line the expectation check writes', () => {
    const o: Outcome = { id: 's', decision: 'prompt', promptId: 'a', acks: [], reason: 'r', decidedGate: null, verdict: null, form: 'f', slots: { x: '1' }, queued: [], principalLevel: 0, gate: 'g:ALLOW' };
    const lines = checkExpectation(o, { decision: 'handoff', promptId: 'b', reason: 'q', form: null, slots: { x: '2' }, principalLevel: 2, gate: null, text: 'hello', transfer: { target: 'T', headers: { a: '1' }, data: { b: '2' } } }, 'bye');
    expect(lines.map(mismatchField)).toEqual(['decision', 'promptId', 'reason', 'form', 'slots', 'principalLevel', 'gate', 'text', 'transfer', 'transfer', 'transfer']);
  });
});

describe('a scripted call\'s knownGap, as read', () => {
  it('needs a reason and an outcome of outcome fields, as a corpus line\'s', () => {
    expect(scenarioGapProblems({ id: 's', expect: { decision: 'prompt' }, knownGap: { reason: ' ', outcome: { promptId: 'x' } } })).toEqual([
      { kind: 'shape', message: 'scenario s: knownGap must be { reason, outcome } or { reason, outcomes }, a one-line reason and the outcome fields the model is known to produce (outcomes: a list of them, any one allowed); the reason is missing' },
    ]);
    expect(scenarioGapProblems({ id: 's', expect: { decision: 'prompt' }, knownGap: { reason: 'r', outcome: { said: 'x' } } })[0]!.message).toBe(
      'scenario s: knownGap.outcome pins said, which is not an outcome field (decision, promptId, acks, reason, decidedGate, verdict, form, slots, queued, principalLevel, gate)',
    );
    expect(scenarioGapProblems({ id: 's', expect: { decision: 'prompt' } })).toEqual([]);
  });

  it('refuses a pin that is the call\'s own expectation, and takes one that names a field the expectation does not', () => {
    const expect_ = { decision: 'prompt', promptId: 'ask_accountId', form: 'track_parcel' };
    expect(scenarioGapProblems({ id: 's', expect: expect_, knownGap: { reason: 'r', outcome: { promptId: 'ask_accountId', form: 'track_parcel' } } })).toEqual([
      { kind: 'restates', message: 'scenario s: knownGap.outcome {"form":"track_parcel","promptId":"ask_accountId"} is the call\'s own expectation, so it allows nothing: a known gap pins the end the model gives instead' },
    ]);
    expect(scenarioGapProblems({ id: 's', expect: expect_, knownGap: { reason: 'r', outcomes: [{ promptId: 'confirm_intent_explicit' }, { decision: 'prompt' }] } }).map((p) => p.message)).toEqual([
      'scenario s: knownGap.outcomes[1] {"decision":"prompt"} is the call\'s own expectation, so it allows nothing: a known gap pins the end the model gives instead',
    ]);
    expect(scenarioGapProblems({ id: 's', expect: expect_, knownGap: { reason: 'r', outcome: { promptId: 'ask_accountId', decidedGate: 'other' } } })).toEqual([]);
  });

  it('loadScenarios refuses a call whose tag is not one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scenario-gap-'));
    writeFileSync(join(dir, 'calls.json'), JSON.stringify([{ ...call, knownGap: { reason: REASON, outcome: { promptId: 'ask_accountId' } } }]));
    expect(() => loadScenarios(dir)).toThrow(`scenarios calls.json: scenario ${call.id}: knownGap.outcome {"promptId":"ask_accountId"} is the call's own expectation`);
    writeFileSync(join(dir, 'calls.json'), JSON.stringify([call]));
    expect(loadScenarios(dir)[0]!.knownGap).toEqual(call.knownGap);
  });
});
