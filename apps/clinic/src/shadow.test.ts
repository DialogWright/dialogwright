import { afterAll, describe, expect, it } from 'vitest';
import {
  buildClient, buildThresholds, choice, defaultCorpusFile, defineSlot, loadCorpus, loadScenarios, noul, readBaseline, registerApp, REGRESS_TODAY,
  resetAppsForTest, runAll, scenariosDir, testSlotContext, type AnswerMap, type App, type LibrarySlotSpec, type SlotPartial, type SlotSpec,
} from 'dialogwright';
import { createShadowReport, formatShadowReport, isCassetteMiss, shadowSlot, withShadowSlots, type ShadowReport } from 'dialogwright/testing';
import { clinicApp, registerClinic } from './index';
import { dateSlot } from './domain/slots/date';
import { dobSlot } from './domain/slots/dob';
import { memberIdSlot } from './domain/slots/memberId';
import { CLINIC_SHADOW_PAIRS } from './testing/shadowPairs';

/**
 * The shadow harness over whole runs of the clinic. First the birth date, the member ID and the day
 * against the hand-written slots they replaced (CLINIC_SHADOW_PAIRS), then every clinic slot shadowed by a copy of itself
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

  /** The library slots and the methods every whole run must have compared for each. */
  const PAIRED = {
    dob: ['questions', 'fill', 'display', 'partialVars'], memberId: ['questions', 'fill', 'display'], date: ['questions', 'fill', 'display', 'partialVars', 'dtmf.parse'],
  } as const;

  function expectPairsAgree(report: ShadowReport): void {
    expect(report.mismatches, formatShadowReport(report, Object.keys(PAIRED))).toEqual([]);
    for (const [slot, methods] of Object.entries(PAIRED)) {
      for (const method of methods) expect(report.calls[`${slot}.${method}`] ?? 0, `${slot}.${method}`).toBeGreaterThan(0);
    }
  }

  it('pairs the birth date, the member ID and the day, now library slots, with the hand-written slots they replaced', () => {
    expect(CLINIC_SHADOW_PAIRS.map((s) => s.id)).toEqual(['dob', 'memberId', 'date']);
    expect(CLINIC_SHADOW_PAIRS[0]).toBe(dobSlot);
    expect(CLINIC_SHADOW_PAIRS[1]).toBe(memberIdSlot);
    expect(CLINIC_SHADOW_PAIRS[2]).toBe(dateSlot);
    expect((clinicApp.slots.dob as LibrarySlotSpec).type).toBe('birthdate');
    expect((clinicApp.slots.memberId as LibrarySlotSpec).type).toBe('digits');
    expect((clinicApp.slots.date as LibrarySlotSpec).type).toBe('date');
  });

  it('compares the library slots with the hand-written ones on every call of a full stub run, and nothing changes', async () => {
    const report = createShadowReport();
    const actual = await run('stub', withShadowSlots(clinicApp, CLINIC_SHADOW_PAIRS, { mode: 'report', report }));
    const expected = readBaseline();
    expect(actual.scenarios).toEqual(expected.scenarios);
    expect(actual.corpus).toEqual(expected.corpus);
    expectPairsAgree(report);
  });

  it('the member IDs agree on branches no run reaches: every mix of answers around the thresholds, spans, and keypad entries', () => {
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

  it('the birth dates agree on branches no run reaches: every mix of parts around the thresholds, with and without a month and day pending, and the keypad', () => {
    // The clinic's own: "no_year" for a month or a day missing, no whole-date re-ask, no verified handoff.
    const report = createShadowReport();
    const shadow = shadowSlot(dobSlot, clinicApp.slots.dob!, { report });
    const T = buildThresholds([]);
    const chose = (label: string, p: number) =>
      label === 'none' ? choice({ none: 1 }) : { type: 'choice' as const, choice: label, probabilities: { [label]: p, none: 1 - p }, confidence: p };
    const pending: SlotPartial = { kind: 'dob', month: 6, day: 14 };
    const windows: (SlotPartial | null)[] = [null, pending, { kind: 'dob', month: 2, day: 29 }, { kind: 'week', from: '2026-09-21' }];
    for (const window of windows) {
      for (const text of ['', 'june fourteenth nineteen seventy five', 'seventy five', 'oh six one four seventy five']) {
        for (const prompted of [false, true]) shadow.questions(testSlotContext(text, { window, prompted }));
      }
    }
    for (const todayIso of ['2026-09-18', '2001-03-01']) {
      for (const window of windows) {
        const ctx = testSlotContext('', { window, todayIso });
        shadow.fill({}, ctx);
        for (const given of [0.2, T.SLOT_DETECT, 0.9]) {
          for (const month of ['june', 'february', 'september', 'none']) {
            for (const day of ['14', '17', '18', '29', '30', '31', 'none']) {
              for (const year of ['nineteen seventy five', 'seventy five', 'eighteen ninety nine', 'nineteen hundred', 'nineteen seventy six', 'twenty twenty six', 'twenty thirty', 'oh', 'none']) {
                for (const p of [0.3, T.SLOT_CHOICE_CONFIRM, 0.9]) {
                  shadow.fill({ dobGiven: noul(given), dobMonth: chose(month, p), dobDay: chose(day, p), dobYear: chose(year, p) }, ctx);
                  shadow.fill({ dobGiven: noul(given), dobMonth: chose(month, 0.9), dobDay: chose(day, p), dobYear: chose(year, 0.3) }, ctx);
                }
              }
            }
          }
        }
      }
    }
    const pad = (n: number, w: number) => String(n).padStart(w, '0');
    for (const todayIso of ['2026-09-18', '2001-03-01']) {
      const ctx = testSlotContext('', { todayIso });
      for (const m of [0, 1, 2, 6, 9, 12, 13]) {
        for (const d of [0, 1, 14, 17, 18, 28, 29, 30, 31, 32]) {
          for (const y of [1899, 1900, 1975, 1976, 2001, 2026, 2030]) shadow.dtmf!.parse(`${pad(m, 2)}${pad(d, 2)}${pad(y, 4)}`, ctx);
        }
      }
      for (const keys of ['0614197*', '#6141975', '06*41975', 'A6141975', '00000000', '99999999']) shadow.dtmf!.parse(keys, ctx);
    }
    expect(shadow.display('1975-06-14')).toBe('June 14th, 1975');
    expect(report.mismatches).toEqual([]);
    expect(report.calls['dob.fill']).toBeGreaterThan(30_000);
    expect(report.calls['dob.dtmf.parse']).toBeGreaterThan(900);
  });

  /**
   * Every mix of answers the day reads, in slices so the mixes that interact are crossed with each
   * other: on three todays (a Friday, the Sunday after February 28th, New Year's Eve), asked and not,
   * with no span pending, a week, a month, a span too short for most weekdays, and another kind's
   * partial, the mode chosen below, at and above SLOT_CHOICE_CONFIRM (each mode, and a label the
   * question does not offer), then: the month and day with the weekday (a month and day over a
   * weekday); the weekday with "this" or "next"; the span with the weekday; the relative day. Each part
   * is chosen below SLOT_CHOICE_CONFIRM, between the thresholds, at SLOT_CHOICE_FILL and above it, and
   * again with the weekday sure while the rest are not. Then every four keys a keypad can send.
   */
  function dateGrid(shadow: SlotSpec): void {
    const T = buildThresholds([]);
    const chose = (label: string, p: number) =>
      label === 'none' ? choice({ none: 1 }) : { type: 'choice' as const, choice: label, probabilities: { [label]: p, none: 1 - p }, confidence: p };
    const windows: (SlotPartial | null)[] = [
      null, { kind: 'dob', month: 6, day: 14 },
      { kind: 'window', start: '2026-09-21', end: '2026-09-27', label: 'next_week' },
      { kind: 'window', start: '2026-12-01', end: '2026-12-31', label: 'december' },
      { kind: 'window', start: '2026-12-01', end: '2026-12-02', label: 'december' },
    ];
    for (const window of windows) {
      for (const text of ['', 'next tuesday', 'sometime in december', 'one zero zero five']) {
        for (const prompted of [false, true]) shadow.questions(testSlotContext(text, { window, prompted }));
      }
    }
    const quiet: AnswerMap = Object.fromEntries(
      ['dateMode', 'dateMonth', 'dateDay', 'dateWeekday', 'dateWeekdayQualifier', 'dateRelativeDay', 'dateWindow'].map((id) => [id, choice({ none: 1 })]),
    );
    for (const todayIso of ['2026-09-18', '2026-03-01', '2026-12-31']) {
      for (const window of windows) {
        for (const prompted of [false, true]) {
          const c = testSlotContext('', { window, todayIso, prompted });
          shadow.fill({}, c);
          for (const mode of ['absolute', 'relative_day', 'weekday', 'window', 'none', 'someday']) {
            for (const mp of [0.3, T.SLOT_CHOICE_CONFIRM, 0.6]) {
              const base: AnswerMap = { ...quiet, dateMode: chose(mode, mp) };
              for (const p of [0.3, 0.5, T.SLOT_CHOICE_FILL, 0.9]) {
                for (const month of ['september', 'february', 'december', 'none']) {
                  for (const day of ['12', '19', '29', '31', 'none']) {
                    for (const weekday of ['saturday', 'tuesday', 'none']) {
                      shadow.fill({ ...base, dateMonth: chose(month, p), dateDay: chose(day, p), dateWeekday: chose(weekday, p) }, c);
                      shadow.fill({ ...base, dateMonth: chose(month, p), dateDay: chose(day, p), dateWeekday: chose(weekday, 0.9) }, c);
                    }
                  }
                }
                for (const weekday of ['friday', 'tuesday', 'wednesday', 'none']) {
                  for (const qualifier of ['this', 'next', 'none']) {
                    shadow.fill({ ...base, dateWeekday: chose(weekday, p), dateWeekdayQualifier: chose(qualifier, p) }, c);
                    shadow.fill({ ...base, dateWeekday: chose(weekday, 0.9), dateWeekdayQualifier: chose(qualifier, p) }, c);
                  }
                }
                for (const span of ['this_week', 'next_week', 'this_month', 'next_month', 'none']) {
                  for (const weekday of ['friday', 'sunday', 'none']) {
                    shadow.fill({ ...base, dateWindow: chose(span, p), dateWeekday: chose(weekday, p) }, c);
                    shadow.fill({ ...base, dateWindow: chose(span, p), dateWeekday: chose(weekday, 0.9) }, c);
                  }
                }
                for (const relative of ['today', 'tomorrow', 'day_after_tomorrow', 'yesterday', 'none']) shadow.fill({ ...base, dateRelativeDay: chose(relative, p) }, c);
              }
            }
          }
        }
      }
    }
    const pad = (n: number) => String(n).padStart(2, '0');
    for (const todayIso of ['2026-09-18', '2026-03-01', '2026-12-31']) {
      const c = testSlotContext('', { todayIso });
      for (let m = 0; m <= 13; m++) for (let d = 0; d <= 32; d++) shadow.dtmf!.parse(`${pad(m)}${pad(d)}`, c);
      for (const keys of ['100*', '#005', '10*5', '0000', '9999']) shadow.dtmf!.parse(keys, c);
    }
    for (const iso of ['2026-09-22', '2026-10-05', '2027-01-01']) shadow.display(iso);
  }

  it('the days agree on branches no run reaches: every mix of parts around the thresholds, with and without a span pending, and the keypad', () => {
    const report = createShadowReport();
    dateGrid(shadowSlot(dateSlot, clinicApp.slots.date!, { report }));
    expect(report.mismatches).toEqual([]);
    expect(report.calls['date.fill']).toBeGreaterThan(30_000);
    expect(report.calls['date.dtmf.parse']).toBeGreaterThan(1_000);
    expect(report.calls['date.partialVars']).toBeGreaterThan(0);
  });

  it('the day\'s grid would find a slot that differs by one option (a day that does not resolve: invalid only when asked)', () => {
    const off = defineSlot('date', { ...(clinicApp.slots.date as LibrarySlotSpec).config as object, type: 'date', whenUnresolved: 'invalid-if-prompted' });
    expect(() => dateGrid(shadowSlot(dateSlot, off))).toThrow(/fill/);
  });

  it('compares them on every call of a full replay of the recorded calls: no mismatch and no cassette miss', async () => {
    const plain = await run('recorded', clinicApp);
    const report = createShadowReport();
    const shadowed = await run('recorded', withShadowSlots(clinicApp, CLINIC_SHADOW_PAIRS, { mode: 'report', report }));
    expect(shadowed.records.filter((r) => isCassetteMiss(r))).toEqual([]);
    expect(shadowed.records.length).toBe(plain.records.length);
    expect(shadowed.scenarios).toEqual(plain.scenarios);
    expect(shadowed.corpus).toEqual(plain.corpus);
    expectPairsAgree(report);
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
