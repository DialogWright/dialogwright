import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildClient, buildThresholds, defaultCorpusFile, loadCorpus, REGRESS_TODAY, runAll, type Scenario,
} from 'dialogwright';
import { passed } from 'dialogwright/policy';
import { app } from './app';

/**
 * The outage address said in number words, as a recognizer on the phone gives it: the summary reads
 * the words back as said, and code writes the value reportOutage gets ("7625 Oak Hollow Lane"), which
 * the gate checks against the values the caller confirmed. Run on the stub, from the corpus with two
 * lines more (in a scratch copy: the app's corpus and its recording are not changed).
 */
describe('an address said in number words', () => {
  const SAID = 'the power is out at seventy six twenty five oak hollow lane';
  const dir = mkdtempSync(join(tmpdir(), 'utility-written-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const corpusFile = join(dir, 'corpus.jsonl');
  writeFileSync(corpusFile, [
    readFileSync(defaultCorpusFile(), 'utf8').trimEnd(),
    JSON.stringify({
      id: 'wp-01', text: SAID, intent: 'report_outage', context: 'no_form',
      labels: { placeGiven: true, symptom: 'no_power', placePick: 'seventy six twenty five oak hollow lane' },
    }),
    '',
  ].join('\n'));

  const run = async (steps: string[]) => {
    const scenario: Scenario = { id: 'written-place', steps: steps.map((say) => ({ say })), expect: { decision: 'prompt' } };
    const thresholds = buildThresholds([]);
    const out = await runAll([], [scenario], {
      client: buildClient('stub', corpusFile, thresholds, REGRESS_TODAY), thresholds, todayIso: REGRESS_TODAY, now: () => 0,
    });
    return { outcome: out.scenarios['written-place']!, records: out.scenarioRecords['written-place']! };
  };

  it('reads the words back at the summary, and holds the written value', async () => {
    const { outcome, records } = await run([SAID]);
    expect(outcome).toMatchObject({ promptId: 'confirm_report_outage', slots: { place: '7625 Oak Hollow Lane', symptom: 'no_power' } });
    const last = records.at(-1)!;
    expect(last.slots.place).toMatchObject({ value: '7625 Oak Hollow Lane', display: 'seventy six twenty five oak hollow lane' });
    const spoken = last.actions.flatMap((a) => (a.type === 'say' ? a.parts.map((p) => ('text' in p ? p.text : '')) : [])).join(' ');
    expect(spoken).toContain('at this address: seventy six twenty five oak hollow lane. Shall I file that?');
    expect(spoken).not.toContain('7625');
  });

  it('asks the model about the words, never the written value: the requests are the ones without the options', async () => {
    const { records } = await run([SAID, 'that\'s right']);
    const sent = JSON.stringify(records.map((r) => [r.turnState, r.questions]));
    expect(sent).toContain('seventy six twenty five oak hollow lane');
    expect(sent).not.toContain('7625');
  });

  it('files the report with the written value, which the gate finds is what the caller confirmed', async () => {
    const { outcome, records } = await run([SAID, 'that\'s right']);
    expect(outcome).toMatchObject({ decision: 'prompt', promptId: 'anything_else', gate: 'reportOutage:ALLOW' });
    const decisions = records.flatMap((r) => r.gateEvents ?? []).map((e) => e.decision).filter((d) => d.call.tool === 'reportOutage');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.call.params).toMatchObject({ place: '7625 Oak Hollow Lane', symptom: 'no_power' });
    expect(decisions[0]!.verdict).toBe('ALLOW');
    expect(passed(decisions[0]!, 'confirmed')).toBe(true);
  });

  it('is a slot shown as said, so the console and a handoff show the written value', () => {
    expect(app.slots.place!.displayFrom).toBe('said');
  });
});

describe('the corpus the regression runs', () => {
  it('has its two lines with the address in number words, whose value is written', () => {
    const lines = loadCorpus(defaultCorpusFile()).filter((e) => /twelve oak hollow road/.test(e.text)).map((e) => e.id);
    expect(lines).toEqual(['ro-11', 'pl-07']);
  });
});
