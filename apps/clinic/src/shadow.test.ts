import { afterAll, describe, expect, it } from 'vitest';
import {
  buildClient, buildThresholds, choice, defaultCorpusFile, loadCorpus, loadScenarios, noul, readBaseline, registerApp, REGRESS_TODAY,
  resetAppsForTest, runAll, scenariosDir, testSlotContext, type App, type LibrarySlotSpec, type SlotSpec,
} from 'dialogwright';
import { createShadowReport, formatShadowReport, isCassetteMiss, shadowSlot, withShadowSlots, type ShadowReport } from 'dialogwright/testing';
import { clinicApp, registerClinic } from './index';
import { memberIdSlot } from './domain/slots/memberId';
import { CLINIC_SHADOW_PAIRS } from './testing/shadowPairs';

/**
 * The shadow harness over whole runs of the clinic. First the member ID against the hand-written slot
 * it replaced (CLINIC_SHADOW_PAIRS), then every clinic slot shadowed by a copy of itself
 * (the same behavior, so any mismatch is the harness's own), through the full stub regression and
 * the full replay of the recorded calls. Nothing may change: the stub run is the committed
 * baseline, the replay is the unshadowed replay with no cassette miss, and the report is empty
 * though every slot was compared on every turn it was asked.
 */
describe('the shadow harness on the clinic', () => {
  afterAll(() => {
    resetAppsForTest();
    registerClinic();
  });

  const selves: SlotSpec[] = Object.values(clinicApp.slots).map((spec) => ({ ...spec }));

  async function run(kind: 'stub' | 'recorded', app: App) {
    resetAppsForTest();
    registerApp(app);
    const thresholds = buildThresholds([]);
    return runAll(loadCorpus(defaultCorpusFile()), loadScenarios(scenariosDir()), {
      client: buildClient(kind, defaultCorpusFile(), thresholds, REGRESS_TODAY),
      thresholds,
      todayIso: REGRESS_TODAY,
      now: () => 0,
    });
  }

  function expectExercised(report: ShadowReport): void {
    expect(report.mismatches, formatShadowReport(report, selves.map((s) => s.id))).toEqual([]);
    for (const spec of selves) {
      expect(report.calls[`${spec.id}.questions`] ?? 0, `${spec.id}.questions`).toBeGreaterThan(0);
      expect(report.calls[`${spec.id}.fill`] ?? 0, `${spec.id}.fill`).toBeGreaterThan(0);
    }
  }

  it('pairs the member ID, now a library digits slot, with the hand-written slot it replaced', () => {
    expect(CLINIC_SHADOW_PAIRS.map((s) => s.id)).toEqual(['memberId']);
    expect(CLINIC_SHADOW_PAIRS[0]).toBe(memberIdSlot);
    expect((clinicApp.slots.memberId as LibrarySlotSpec).type).toBe('digits');
  });

  it('compares the library member ID with the hand-written one on every call of a full stub run, and nothing changes', async () => {
    const report = createShadowReport();
    const actual = await run('stub', withShadowSlots(clinicApp, CLINIC_SHADOW_PAIRS, { mode: 'report', report }));
    const expected = readBaseline();
    expect(actual.scenarios).toEqual(expected.scenarios);
    expect(actual.corpus).toEqual(expected.corpus);
    expect(report.mismatches, formatShadowReport(report, ['memberId'])).toEqual([]);
    for (const method of ['questions', 'fill', 'display'] as const) expect(report.calls[`memberId.${method}`] ?? 0, method).toBeGreaterThan(0);
  });

  it('agree on branches no run reaches: every mix of answers around the thresholds, spans, and keypad entries', () => {
    const shadow = shadowSlot(memberIdSlot, clinicApp.slots.memberId!);
    const spans = ['five five five zero seven seven eight eight', '5550 7788', 'double five zero seven seven eight eight', 'five five five', 'five five five zero seven seven eight eight nine', 'none'];
    for (const text of ['', 'my id is five five five zero seven seven eight eight', 'it is 5550 7788', 'five five five']) {
      const ctx = testSlotContext(text);
      shadow.questions(ctx);
      for (const given of [0, 0.59, 0.6, 0.95]) {
        for (const complete of [0, 0.59, 0.6, 0.95]) {
          for (const span of spans) {
            for (const p of [0.3, 0.9]) {
              shadow.fill({ containsMemberId: noul(given), memberIdComplete: noul(complete), memberIdSpan: choice({ [span]: p, ...(span === 'none' ? {} : { none: 1 - p }) }) }, ctx);
            }
          }
        }
      }
      shadow.fill({}, ctx);
    }
    for (const keys of ['55507788', '5550778#', '555077889', '', '12345678', '0'.repeat(8)]) shadow.dtmf!.parse(keys, testSlotContext(''));
    expect(shadow.display('55507788')).toBe('5550 7788');
  });

  it('compares them on every call of a full replay of the recorded calls: no mismatch and no cassette miss', async () => {
    const plain = await run('recorded', clinicApp);
    const report = createShadowReport();
    const shadowed = await run('recorded', withShadowSlots(clinicApp, CLINIC_SHADOW_PAIRS, { mode: 'report', report }));
    expect(shadowed.records.filter((r) => isCassetteMiss(r))).toEqual([]);
    expect(shadowed.records.length).toBe(plain.records.length);
    expect(shadowed.scenarios).toEqual(plain.scenarios);
    expect(shadowed.corpus).toEqual(plain.corpus);
    expect(report.mismatches, formatShadowReport(report, ['memberId'])).toEqual([]);
    for (const method of ['questions', 'fill', 'display'] as const) expect(report.calls[`memberId.${method}`] ?? 0, method).toBeGreaterThan(0);
  });

  it('changes nothing in a full stub regression run, every slot shadowed by itself', async () => {
    const report = createShadowReport();
    const actual = await run('stub', withShadowSlots(clinicApp, selves, { mode: 'report', report }));
    const expected = readBaseline();
    expect(actual.scenarios).toEqual(expected.scenarios);
    expect(actual.corpus).toEqual(expected.corpus);
    expectExercised(report);
  });

  it('changes nothing in a full replay of the recorded calls, with no cassette miss, every slot shadowed by itself', async () => {
    const plain = await run('recorded', clinicApp);
    const report = createShadowReport();
    const shadowed = await run('recorded', withShadowSlots(clinicApp, selves, { mode: 'report', report }));
    expect(shadowed.records.filter((r) => isCassetteMiss(r))).toEqual([]);
    expect(shadowed.records.length).toBe(plain.records.length);
    expect(shadowed.scenarios).toEqual(plain.scenarios);
    expect(shadowed.corpus).toEqual(plain.corpus);
    expectExercised(report);
  });
});
