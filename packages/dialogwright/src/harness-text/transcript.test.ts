import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../jev/corpus';
import { buildClient, buildThresholds } from '../run/client';
import { defaultCorpusFile, scenariosDir } from '../run/fixtures';
import { useTestkit } from '../testing/apps';
import { REGRESS_TODAY } from './baseline';
import { loadScenarios, runCorpusEntry, runScenario, type RunOptions } from './runner';
import { corpusTranscript, describeStep, scenarioTranscript } from './transcript';

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

  it('a step as the scenario file writes it', () => {
    expect(describeStep({ say: 'yes' })).toBe('say "yes"');
    expect(describeStep({ say: 'yes', fail: true })).toBe('say "yes" (the model fails)');
    expect(describeStep({ dtmf: '1' })).toBe('keys 1');
    expect(describeStep({ silence: true })).toBe('silence');
    expect(describeStep({ signIn: 'S-1' })).toBe('signs in as S-1');
    expect(describeStep({ serviceDown: true })).toBe('the next service is down');
  });
});
