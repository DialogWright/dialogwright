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
import { nameSlot } from './domain/slots/name';
import { providerSlot } from './domain/slots/provider';
import { CLINIC_SHADOW_PAIRS } from './testing/shadowPairs';

/**
 * The shadow harness over whole runs of the clinic. First the name, the birth date, the member ID, the provider and the day
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
    name: ['questions', 'fill', 'display'], dob: ['questions', 'fill', 'display', 'partialVars'], memberId: ['questions', 'fill', 'display'], provider: ['questions', 'fill', 'display'],
    date: ['questions', 'fill', 'display', 'partialVars', 'dtmf.parse'],
  } as const;

  function expectPairsAgree(report: ShadowReport): void {
    expect(report.mismatches, formatShadowReport(report, Object.keys(PAIRED))).toEqual([]);
    for (const [slot, methods] of Object.entries(PAIRED)) {
      for (const method of methods) expect(report.calls[`${slot}.${method}`] ?? 0, `${slot}.${method}`).toBeGreaterThan(0);
    }
  }

  it('pairs the name, the birth date, the member ID, the provider and the day, now library slots, with the hand-written slots they replaced', () => {
    expect(CLINIC_SHADOW_PAIRS.map((s) => s.id)).toEqual(['name', 'dob', 'memberId', 'provider', 'date']);
    expect(CLINIC_SHADOW_PAIRS[0]).toBe(nameSlot);
    expect(CLINIC_SHADOW_PAIRS[1]).toBe(dobSlot);
    expect(CLINIC_SHADOW_PAIRS[2]).toBe(memberIdSlot);
    expect(CLINIC_SHADOW_PAIRS[3]).toBe(providerSlot);
    expect(CLINIC_SHADOW_PAIRS[4]).toBe(dateSlot);
    expect((clinicApp.slots.provider as LibrarySlotSpec).type).toBe('choice');
    expect((clinicApp.slots.name as LibrarySlotSpec).type).toBe('name');
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

  /**
   * Every mix of answers the name reads. Over texts that give a name alone, a name beside each
   * provider and each title, a correction to a provider's name, a surname that holds a provider's name
   * as a part, a literal "none", a single word and a long opener, and on a stricter and a laxer
   * SLOT_DETECT: the question for each, then the first question at, below and above the threshold
   * against every span the engine finds in the text (offered or withheld), spans it never found
   * (reversed, odd spacing and case, empty, a provider's alone) and none, at two probabilities, with
   * and without the choice's own probabilities; a span answer of the wrong kind and answers missing.
   */
  function nameGrid(shadow: SlotSpec): void {
    const T = buildThresholds([]);
    const texts = [
      '', 'my name is Morgan Ellis', "it's Cher", 'this is Dana Whitfield', 'Priya Raghunathan', 'none of your business', 'no, it\'s Sam Lee',
      'this is Morgan Ellis, seeing Dr. Chen', 'this is Morgan Ellis calling for doctor Patel', 'not Chen, Cheng', "not Dr. Alder, Dr. Ames", 'Cheng, not Chen',
      'my name is Kim Alvarez', 'this is Dana Kim', 'Okafor', 'it is Chenoweth Drummond', 'Nguyen Rossi', 'I want to see Dr Okafor, my name is Anna Petrov',
      "it's Mary Kate O'Neil", 'yes', 'um uh hello hi', 'one two three', 'the quick brown fox jumps over the lazy dog and then my name is Alex Moreno',
    ];
    const answers = (given: number, span: string, p: number, own: boolean): AnswerMap => ({
      nameGiven: noul(given),
      nameSpan: own ? { type: 'choice', choice: span, probabilities: { [span]: p, none: 1 - p }, confidence: p } : { type: 'choice', choice: span, probabilities: {}, confidence: p },
    });
    for (const text of texts) {
      for (const todayIso of ['2026-09-18']) {
        for (const thresholds of [T, { ...T, SLOT_DETECT: 0.95 }, { ...T, SLOT_DETECT: 0.2 }]) {
          const c = testSlotContext(text, { todayIso, thresholds });
          shadow.questions(c);
          shadow.fill({}, c);
          shadow.fill({ nameGiven: noul(0.9) }, c);
          shadow.fill({ nameGiven: noul(0.9), nameSpan: noul(0.9) }, c);
          shadow.fill({ nameSpan: choice({ none: 1 }) }, c);
          const spans = [...c.candidateWordSpans, 'none', '', 'someone else', 'ellis morgan', ' morgan   ellis ', 'MORGAN ELLIS', 'chen', 'dr', 'dr chen', 'doctor patel', 'kim alvarez'];
          for (const given of [0, 0.2, 0.59, T.SLOT_DETECT, T.SLOT_DETECT + 0.001, 0.8, 0.95, 1]) {
            for (const span of spans) {
              for (const p of [0.3, 0.9]) {
                shadow.fill(answers(given, span, p, true), c);
                shadow.fill(answers(given, span, p, false), c);
              }
            }
            shadow.fill({ nameGiven: noul(given), nameSpan: choice({ none: 1 }) }, c);
          }
        }
      }
    }
    for (const value of ['morgan ellis', 'cher', 'mary kate o neil', 'MORGAN', '', 'o neil', 'anna-maria']) shadow.display(value);
  }

  it('the names agree on branches no run reaches: every mix of texts, spans offered and withheld, and answers around the threshold', () => {
    const report = createShadowReport();
    nameGrid(shadowSlot(nameSlot, clinicApp.slots.name!, { report }));
    expect(report.mismatches).toEqual([]);
    expect(report.calls['name.fill']).toBeGreaterThan(30_000);
    expect(report.calls['name.questions']).toBeGreaterThan(60);
    expect(report.calls['name.display']).toBeGreaterThan(0);
  });

  it('the name\'s grid would find a slot that differs by one option (one word of the roster not withheld)', () => {
    const config = (clinicApp.slots.name as LibrarySlotSpec).config as { exclude: string[] };
    const off = defineSlot('name', { ...config, type: 'name', exclude: config.exclude.filter((w) => w !== 'alvarez') });
    expect(() => nameGrid(shadowSlot(nameSlot, off))).toThrow(/questions/);
    const nothing = defineSlot('name', { ...config, type: 'name', exclude: [] });
    expect(() => nameGrid(shadowSlot(nameSlot, nothing))).toThrow(/questions/);
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

  /**
   * Every mix of answers the provider reads. Over texts that name no one, one provider, two in a
   * hedge, three, a correction, a provider's name inside another word, and on the engine's
   * thresholds with the clinic's PROVIDER_UNSURE, a stricter PROVIDER_UNSURE, a lower
   * SLOT_CHOICE_CONFIRM (which makes the hedged-rival rule reachable) and a wider SLOT_CHOICE_MARGIN:
   * the questions, asked and not; then the top label each of five providers and none, below, at,
   * between and above the thresholds, against every second provider (and none) at gaps on both
   * sides of SLOT_CHOICE_MARGIN, with the unsure question below, at and above PROVIDER_UNSURE and
   * unanswered; then, nothing chosen (none on top, a provider below SLOT_CHOICE_CONFIRM, no answer),
   * the name-status question's every label around SLOT_HELP, and unanswered; then every key and
   * every display. A label the question never offers is left out: the one difference (below).
   */
  function providerGrid(shadow: SlotSpec): void {
    const T = { ...buildThresholds([]), PROVIDER_UNSURE: clinicApp.thresholds!.PROVIDER_UNSURE! };
    const thresholdSets = [T, { ...T, PROVIDER_UNSURE: 0.8 }, { ...T, SLOT_CHOICE_CONFIRM: 0.3 }, { ...T, SLOT_CHOICE_MARGIN: 0.3 }];
    const texts = [
      '', 'Dr. Chen', "either Dr. Chen or Dr. Cheng, I'm not sure which", 'Dr. Kim or maybe Dr. Rossi, or Patel', 'Cheng, not Chen', 'kimberly said', 'not Nguyen, Alvarez',
    ];
    for (const text of texts) for (const prompted of [false, true]) shadow.questions(testSlotContext(text, { prompted, thresholds: T }));
    const keys = ['chen', 'cheng', 'kim', 'rossi', 'patel'];
    const unsures: (number | null)[] = [null, 0, 0.44, 0.45, 0.46, 0.9];
    const withUnsure = (answers: AnswerMap, u: number | null): AnswerMap => (u === null ? answers : { ...answers, providerUnsure: noul(u) });
    for (const thresholds of thresholdSets) {
      for (const text of texts) {
        const c = testSlotContext(text, { thresholds });
        for (const top of [...keys, 'none']) {
          for (const p of [0.2, 0.3, 0.44, 0.45, 0.5, 0.55, 0.7, 0.9]) {
            for (const u of unsures) {
              shadow.fill(withUnsure({ provider: choice({ [top]: p, ...(top === 'none' ? {} : { none: 1 - p }) }) }, u), c);
              for (const second of [...keys, 'none']) {
                if (second === top) continue;
                for (const gap of [0, 0.05, 0.14, 0.16, 0.29, 0.31, 0.5]) {
                  const rival = Math.max(0, p - gap);
                  const rest = Math.max(0, 1 - p - rival);
                  const probabilities = { [top]: p, [second]: rival, ...(top !== 'none' && second !== 'none' ? { none: rest } : {}) };
                  shadow.fill(withUnsure({ provider: { type: 'choice', choice: top, probabilities, confidence: p } }, u), c);
                }
              }
            }
          }
        }
        for (const provider of [choice({ none: 0.9, chen: 0.1 }), choice({ chen: 0.3, kim: 0.1, none: 0.6 }), undefined]) {
          const base: AnswerMap = provider ? { provider } : {};
          shadow.fill(base, c);
          for (const label of ['neither', 'has_name', 'no_name']) {
            for (const p of [0.34, 0.5, 0.59, 0.6, 0.61, 0.9]) {
              const others = ['neither', 'has_name', 'no_name'].filter((l) => l !== label);
              shadow.fill({ ...base, providerNameStatus: choice({ [label]: p, [others[0]!]: (1 - p) * 0.7, [others[1]!]: (1 - p) * 0.3 }) }, c);
              shadow.fill({ ...base, providerNameStatus: choice({ [label]: p, [others[0]!]: (1 - p) * 0.7, [others[1]!]: (1 - p) * 0.3 }), providerUnsure: noul(0.9) }, c);
            }
          }
        }
      }
    }
    for (const keysPressed of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#', '']) shadow.dtmf!.parse(keysPressed, testSlotContext(''));
    for (const value of [...keys, 'okafor', 'nguyen', 'alvarez', 'lee', '']) shadow.display(value);
  }

  it('the providers agree on branches no run reaches: every mix of names, margins, hedges and name-status answers around the thresholds, and the keypad', () => {
    const report = createShadowReport();
    providerGrid(shadowSlot(providerSlot, clinicApp.slots.provider!, { report }));
    expect(report.mismatches).toEqual([]);
    expect(report.calls['provider.fill']).toBe(293_412);
    expect(report.calls['provider.questions']).toBe(14);
    expect(report.calls['provider.dtmf.parse']).toBe(13);
  });

  it('the provider\'s grid would find a slot that differs by one option', () => {
    const config = (clinicApp.slots.provider as LibrarySlotSpec).config as Record<string, unknown> & { hedge: object; help: { labels: Record<string, object> } };
    const off = (over: Record<string, unknown>) => defineSlot('provider', { ...config, type: 'choice', ...over });
    expect(() => providerGrid(shadowSlot(providerSlot, off({ readBack: 'implicit' })))).toThrow(/fill/);
    expect(() => providerGrid(shadowSlot(providerSlot, off({ disambiguate: undefined })))).toThrow(/fill/);
    expect(() => providerGrid(shadowSlot(providerSlot, off({ hedge: { ...config.hedge, byName: false } })))).toThrow(/fill/);
    expect(() => providerGrid(shadowSlot(providerSlot, off({ fillAt: 'SLOT_CHOICE_FILL' })))).toThrow(/fill/);
    const { neither, ...rest } = config.help.labels;
    expect(() => providerGrid(shadowSlot(providerSlot, off({ help: { ...config.help, labels: { ...rest, neither } } })))).toThrow();
  });

  it('the provider differs from the hand-written slot only on a label its question never offers, which no model answer has', () => {
    // The hand-written slot took any top label but none, and any second label but none as a rival;
    // the library takes only the roster (a choice slot's value is always one of its options).
    const c = testSlotContext('', { thresholds: { ...buildThresholds([]), PROVIDER_UNSURE: 0.45 } });
    expect(providerSlot.fill({ provider: choice({ lee: 0.9, none: 0.1 }) }, c)).toMatchObject({ kind: 'filled', value: 'lee' });
    expect(clinicApp.slots.provider!.fill({ provider: choice({ lee: 0.9, none: 0.1 }) }, c)).toEqual({ kind: 'absent' });
    expect(providerSlot.fill({ provider: choice({ chen: 0.5, lee: 0.45, none: 0.05 }) }, c)).toMatchObject({ kind: 'disambiguate', b: { value: 'lee' } });
    expect(clinicApp.slots.provider!.fill({ provider: choice({ chen: 0.5, lee: 0.45, none: 0.05 }) }, c)).toMatchObject({ kind: 'filled', value: 'chen', confirm: 'implicit' });
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
