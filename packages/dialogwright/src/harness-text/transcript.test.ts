import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../jev/corpus';
import { buildClient, buildThresholds } from '../run/client';
import { defaultCorpusFile, scenariosDir } from '../run/fixtures';
import { useTestkit } from '../testing/apps';
import { REGRESS_TODAY } from './baseline';
import { loadScenarios, runCorpusEntry, runScenario, type RunOptions } from './runner';
import { barName, corpusTranscript, describeStep, modelAnswerLines, questionLines, scenarioTranscript } from './transcript';
import { DEFAULT_THRESHOLDS, withOverrides } from '../core/thresholds';
import { JevClientError } from '../jev/types';
import { join } from 'node:path';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { CALLBACK_DIR, callbackApp } from '../testing/callback/app';

useTestkit();

function options(): RunOptions {
  const thresholds = buildThresholds([]);
  return { client: buildClient('stub', defaultCorpusFile(), thresholds), thresholds, todayIso: REGRESS_TODAY, now: () => 0 };
}

describe('the regression transcript', () => {
  it('a scripted call: each step, what the agent said, the slots and every gate decision, then the expectation', async () => {
    const scenario = loadScenarios(scenariosDir()).find((s) => s.id === 'track-other-customers-parcel')!;
    const run = await runScenario(scenario, options());
    const lines = scenarioTranscript(scenario, run);
    expect(lines[0]).toBe('scenario track-other-customers-parcel  (a phone call, anonymous)');
    expect(lines).toContain('  start');
    expect(lines).toContain('  1. say "where is parcel 7201"');
    expect(lines).toContain('       -> prompt ask_accountId');
    expect(lines).toContain('          acks   ack_intent');
    expect(lines).toContain('          gate   listParcels STEP_UP to level 2; identity Identity strong enough for this action: identity.level 0 >= 2');
    expect(lines).toContain('          form   track_parcel   level 0   slots accountId=55501234, parcelSelect=7201');
    // The code is keyed one turn per key; the keys that said nothing are counted, not shown.
    expect(lines).toContain('  4. keys 123456');
    expect(lines).toContain('       (6 keys, one turn each; 5 said nothing and are not shown)');
    expect(lines).toContain('          acks   otp_verified, parcel_blocked_scope');
    expect(lines.filter((l) => l.includes('gate   getParcel BLOCK reason=scope; scope '))).toHaveLength(1);
    expect(lines.some((l) => l.startsWith('          says   "Thank you, you\'re verified.'))).toBe(true);
    expect(lines.at(-1)).toBe('  pass');
    expect(lines.at(-2)).toMatch(/^ {2}expect decision=prompt, promptId=anything_else, /);
  });

  it('a transfer: its target, the rule taken and what goes with it, each value as recorded; none for an app without transfer', async () => {
    resetAppsForTest();
    registerApp(callbackApp);
    try {
      const fixtures = join(CALLBACK_DIR, 'fixtures');
      const thresholds = buildThresholds([]);
      const opts = { client: buildClient('stub', join(fixtures, 'corpus.jsonl'), thresholds), thresholds, todayIso: REGRESS_TODAY, now: () => 0 };
      const scenario = loadScenarios(join(fixtures, 'scenarios')).find((s) => s.id === 'transfer-priority')!;
      const lines = scenarioTranscript(scenario, await runScenario(scenario, opts));
      expect(lines).toContain('          transfer PRIORITY_LINE (rule 1)   headers X-Account-Ref=...1234, X-Reason=live-agent, X-Source=ivr, X-Queue=priority   data reason=live-agent');
    } finally {
      useTestkit();
    }
    const plain = loadScenarios(scenariosDir()).find((s) => s.id === 'track-other-customers-parcel')!;
    expect(scenarioTranscript(plain, await runScenario(plain, options())).some((l) => l.includes('transfer '))).toBe(false);
  });

  it('a call that misses its expectation says what it missed', async () => {
    const scenario = loadScenarios(scenariosDir()).find((s) => s.id === 'track-other-customers-parcel')!;
    const run = await runScenario({ ...scenario, expect: { ...scenario.expect, promptId: 'goodbye' } }, options());
    expect(scenarioTranscript(scenario, run).at(-1)).toBe('  FAIL promptId: expected goodbye, got anything_else');
  });

  it('a corpus line: the state it is seeded in, then its one turn', async () => {
    const entry = loadCorpus(defaultCorpusFile()).find((e) => e.id === 'tk-01')!;
    const lines = corpusTranscript(entry, await runCorpusEntry(entry, options()));
    expect(lines.slice(0, 4)).toEqual([
      'corpus tk-01  (intent track_parcel)',
      '  seeded  the opening of a phone call',
      '          form -   level 0   slots none',
      '  1. say "where is my parcel"',
    ]);
    expect(lines).toContain('       -> prompt ask_accountId');
  });

  it("a corpus line's model answers: each question with its probabilities, the screen, and nothing for a turn that asked none", async () => {
    const entry = loadCorpus(defaultCorpusFile()).find((e) => e.id === 'tk-01')!;
    const r = await runCorpusEntry(entry, options());
    expect(modelAnswerLines(r.setup)).toEqual([]);
    const lines = modelAnswerLines(r.run);
    expect(lines[0]).toBe('  model answers (stub:fixture)');
    expect(lines.find((l) => l.trimStart().startsWith('intent '))).toMatch(/^ {5}intent +choice {2}track_parcel \d\.\d\d/);
    expect(lines.some((l) => / {2}noul {4}\d\.\d\d$/.test(l))).toBe(true);
    expect(lines.at(-1)).toMatch(/^ {5}screen +\d\.\d\d {3}\(in the same request\)$/);
  });

  it('a turn the model did not answer says why', async () => {
    const entry = loadCorpus(defaultCorpusFile()).find((e) => e.id === 'tk-01')!;
    const failing = { ...options(), client: { ask: async () => { throw new JevClientError('cassette miss abc where is my parcel'); } } };
    const r = await runCorpusEntry(entry, failing);
    expect(modelAnswerLines(r.run)).toEqual(['  model answers: none (cassette miss abc where is my parcel)']);
  });

  it("a scripted call's model answers under each turn, with `answers`; none without", async () => {
    const scenario = loadScenarios(scenariosDir()).find((s) => s.id === 'track-other-customers-parcel')!;
    const run = await runScenario(scenario, options());
    expect(scenarioTranscript(scenario, run).some((l) => l.includes('model answers'))).toBe(false);
    const lines = scenarioTranscript(scenario, run, { answers: true });
    // Under the first step's turn, after its gate lines: every question the turn asked, indented as the turn's details.
    const step = lines.indexOf('  1. say "where is parcel 7201"');
    const answers = lines.indexOf('          model answers (stub:fixture)', step);
    expect(answers).toBeGreaterThan(step);
    expect(lines.slice(answers + 1).find((l) => l.trimStart().startsWith('intent '))).toMatch(/^ {13}intent +choice {2}track_parcel \d\.\d\d/);
    // One block per turn that asked the model, none for the call's start (the greeting asks nothing).
    expect(lines.filter((l) => l === '          model answers (stub:fixture)').length).toBeGreaterThan(1);
    expect(lines.slice(0, step).some((l) => l.includes('model answers'))).toBe(false);
  });

  it('`questions`: each question in its words once, then the turn\'s gates with their bars named, and the one that decided', async () => {
    const entry = loadCorpus(defaultCorpusFile()).find((e) => e.id === 'tk-01')!;
    const r = await runCorpusEntry(entry, options());
    const seen = new Map<string, string>();
    const lines = questionLines(r.run, '  ', DEFAULT_THRESHOLDS, seen);
    expect(lines[0]).toBe('  questions');
    expect(lines.find((l) => l.startsWith('     intent  '))).toMatch(/^ {5}intent {2}Read asr\.text\. What is the caller asking/);
    expect(lines).toContain('        track_parcel: Asks where a parcel is, whether it has been delivered, or about a parcel by its number or by what is in it');
    expect(lines.find((l) => l.startsWith('     wantsHuman  '))).toBe('     wantsHuman  Read asr.text. The caller is talking to the parcel delivery line, which is automated. Does the caller ask to talk to a person instead, such as an agent, a representative, or an operator?');
    const gates = lines.indexOf('  gates  (each reading, the bar it was held to, and what it led to; <== decided the turn)');
    expect(gates).toBeGreaterThan(0);
    const rows = lines.slice(gates + 1);
    expect(rows.find((l) => l.trimStart().startsWith('addressedToSystem '))).toMatch(/ \d\.\d\d {2}bar 0\.65 GATE_ADDRESSED +pass {2}pass$/);
    expect(rows.find((l) => l.trimStart().startsWith('intent '))).toMatch(/bar 0\.40 INTENT_EXPLICIT +pass {2}route:track_parcel {2}<==$/);
    expect(rows.find((l) => l.trimStart().startsWith('rephrasingLastTurn '))).toMatch(/bar {4}- +info {2}info$/);
    // The same questions again in this transcript: named on one line.
    const again = questionLines(r.run, '  ', DEFAULT_THRESHOLDS, seen);
    expect(again[1]).toMatch(/^ {5}as above: intent, intentTentative, addressedToSystem, /);
    expect(again.some((l) => l.includes('Read asr.text'))).toBe(false);
  });

  it("a gate row's bar is named by the threshold whose value it is in the run; a row with none, or an app's own, by its number alone", () => {
    const row = (gate: string, threshold: number | null) => ({ gate, value: 0.5, threshold, passed: true, outcome: 'pass', decided: false });
    const t = DEFAULT_THRESHOLDS;
    expect(barName(row('wantsHuman', 0.7), t)).toBe('GATE_WANTS_HUMAN');
    expect(barName(row('intent', t.INTENT_SWITCH), t)).toBe('INTENT_SWITCH');
    expect(barName(row('opening:addressedToSystem', t.GATE_ADDRESSED), t)).toBe('GATE_ADDRESSED');
    expect(barName(row('slot:accountId', t.SLOT_CHOICE_CONFIRM), t)).toBe('SLOT_CHOICE_CONFIRM');
    expect(barName(row('slot:accountId', t.SLOT_DETECT), t)).toBe('SLOT_DETECT');
    // Two thresholds of a gate at the same value: both.
    expect(barName(row('confirmation', 0.7), t)).toBe('CONFIRM_YES/CONFIRM_NO');
    // An override moves the name with the value.
    expect(barName(row('wantsHuman', 0.55), withOverrides({ GATE_WANTS_HUMAN: 0.55 }))).toBe('GATE_WANTS_HUMAN');
    expect(barName(row('wantsHuman', 0.55), t)).toBe('');
    expect(barName(row('rephrasingLastTurn', null), t)).toBe('');
    expect(barName(row('priorityIntent', 0.9), { ...t, URGENT_BAR: 0.9 })).toBe('URGENT_BAR');
  });

  it('a step as the scenario file writes it', () => {
    expect(describeStep({ say: 'yes' })).toBe('say "yes"');
    expect(describeStep({ say: 'yes', fail: true })).toBe('say "yes" (the model fails)');
    expect(describeStep({ dtmf: '1' })).toBe('keys 1');
    expect(describeStep({ silence: true })).toBe('silence');
    expect(describeStep({ signIn: 'S-1' })).toBe('signs in as S-1');
    expect(describeStep({ serviceDown: true })).toBe('the next service is down');
  });
});
