import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkApp, formatProblem, loadAppFolder, testSlotContext, type LibrarySlotSpec } from 'dialogwright';
import { afterAll, describe, expect, it } from 'vitest';
import { CLINIC_DIR, clinicApp, code } from './app';
import { CLINIC_FORM_HOOKS } from './domain/forms';
import { EXCLUDED_NAME_TOKENS, PROVIDERS, providerDisplay, providerLibrarySlot } from './domain/roster';
import { ALL_SLOTS, SLOTS } from './domain/slots';
import { dateSlot } from './testing/oracles/date';
import { dobSlot } from './testing/oracles/dob';
import { memberIdSlot } from './testing/oracles/memberId';
import { nameSlot } from './testing/oracles/name';
import { providerSlot } from './testing/oracles/provider';

/**
 * The clinic as its folder builds it: a few pinned facts about what the YAML holds and how it meets
 * the code. The words themselves are guarded elsewhere: every line, criterion and question the model
 * is sent keys the recorded cassette, so a changed character is a cassette miss in the recorded
 * replay, and a changed behavior is a difference from the stub baseline (both run in CI, as does
 * `pnpm check`, which checks the folder against src/app.ts).
 */
const FORM_INTENTS = ['schedule_new', 'reschedule', 'cancel', 'confirm_appointment', 'billing'];

describe('the clinic folder: intents.yaml', () => {
  it('has the ten intents in the order the model is offered them, and no done: a call ends at its completion', () => {
    expect(Object.keys(clinicApp.intents)).toEqual([...FORM_INTENTS, 'agent', 'repeat_prompt', 'capabilities', 'other', 'none']);
    expect(clinicApp.intents).not.toHaveProperty('done');
    expect(clinicApp.intents.capabilities).toEqual({ criteria: expect.any(String), label: 'hear what I can do', kind: 'informational', promptId: 'capabilities' });
    for (const i of FORM_INTENTS) expect(clinicApp.intents[i]!.kind, i).toBe('form');
    for (const i of ['agent', 'repeat_prompt', 'other', 'none']) expect(clinicApp.intents[i]!.kind, i).toBe('control');
    // The billing intent is the one that names a bill or the caller's cover.
    expect(clinicApp.intents.billing!.criteria).toBe('Asks about a bill, charge, payment, or insurance coverage');
  });

  it('maps the keypad digits 1 to 5 to the five tasks in order, and 0 to a person', () => {
    expect(clinicApp.menu).toEqual([...FORM_INTENTS.map((intent, i) => ({ digit: String(i + 1), intent })), { digit: '0', intent: 'agent' }]);
  });
});

describe('the clinic folder: forms.yaml, joined with the hooks in src/domain/forms.ts', () => {
  it('has a form for each task, its slots the clinic\'s own', () => {
    expect(Object.keys(clinicApp.forms)).toEqual(FORM_INTENTS);
    const slots = Object.fromEntries(Object.entries(clinicApp.forms).map(([id, f]) => [id, [f.slots, f.summaryPromptId]]));
    expect(slots).toEqual({
      schedule_new: [['name', 'dob', 'provider', 'date'], 'confirm_schedule'],
      reschedule: [['name', 'dob', 'provider', 'date'], 'confirm_reschedule'],
      cancel: [['name', 'dob', 'provider'], 'confirm_cancel'],
      confirm_appointment: [['name', 'dob', 'provider'], 'confirm_appointment_details'],
      billing: [['memberId'], null],
    });
    for (const form of Object.values(clinicApp.forms)) for (const slot of form.slots) expect(ALL_SLOTS).toContain(slot);
  });

  it('carries every hook the code writes for a form, and no other', () => {
    for (const [id, hooks] of Object.entries(CLINIC_FORM_HOOKS)) {
      const form = clinicApp.forms[id] as unknown as Record<string, unknown>;
      const written = Object.keys(hooks).sort();
      expect(Object.keys(form).filter((k) => typeof form[k] === 'function').sort(), id).toEqual(written);
      for (const hook of written) expect(form[hook], `${id}.${hook}`).toBe((hooks as Record<string, unknown>)[hook]);
    }
    // The scheduling forms hear every turn and move the offer; the others only read their summary.
    expect(Object.keys(clinicApp.forms.reschedule!)).toEqual(['slots', 'summaryPromptId', 'onSummaryRead', 'onAnswers', 'onSummaryAnswer', 'keepsSlot', 'confirmedParams', 'complete']);
    expect(Object.keys(clinicApp.forms.billing!)).toEqual(['slots', 'summaryPromptId', 'complete']);
  });
});

describe('the clinic folder: slots.yaml', () => {
  it('lists all five slots, none as code: the name as a library name slot, the birth date as a library birthdate slot, the member ID as a library digits slot, the provider as a library choice slot and the day as a library date slot, and its order is the order of the app\'s slots (the order the engine fills and acknowledges them in)', () => {
    const slots = loadAppFolder(CLINIC_DIR).config?.slots;
    expect(Object.keys(slots ?? {})).toEqual([...ALL_SLOTS]);
    expect(Object.values(slots ?? {}).map((s) => s.type)).toEqual(['name', 'birthdate', 'digits', 'choice', 'date']);
    expect(Object.keys(clinicApp.slots)).toEqual(Object.keys(slots ?? {}));
    expect(Object.keys(clinicApp.slots)).toEqual([...ALL_SLOTS]);
    expect(Object.keys(SLOTS)).toEqual([]);
  });

  it('configures the name as the hand-written slot was: the words withheld are the roster\'s, its two questions word for word and its ids', () => {
    const lib = clinicApp.slots.name as LibrarySlotSpec;
    expect(lib.type).toBe('name');
    const q = nameSlot.questions(testSlotContext('')) as Record<string, { instructions: string; criteria: Record<string, string | null> }>;
    const given = nameSlot.questions(testSlotContext('')).nameGiven as { criteria: Record<string, string> };
    expect(lib.config).toEqual({
      exclude: ['dr', 'doctor', 'chen', 'cheng', 'patel', 'okafor', 'nguyen', 'rossi', 'kim', 'alvarez'],
      redact: 'none', handoff: 'display',
      text: { givenFalse: given.criteria.false, span: q.nameSpan!.instructions },
    });
    expect(lib).toMatchObject({ id: nameSlot.id, spokenConfirm: nameSlot.spokenConfirm, detect: true });
    expect(lib.redact).toBeUndefined();
    expect(lib.handoff).toBeUndefined();
    expect(lib.dtmf).toBeUndefined();
    expect(lib.questionIds).toEqual(['nameGiven', 'nameSpan']);
    expect(lib.prompts).toEqual([]);
  });

  it('withholds from the name exactly the roster\'s words: the list in slots.yaml is the one EXCLUDED_NAME_TOKENS derives from PROVIDERS, so adding a provider fails here until the list follows', () => {
    const listed = ((clinicApp.slots.name as LibrarySlotSpec).config as { exclude: string[] }).exclude;
    expect(new Set(listed)).toEqual(new Set(EXCLUDED_NAME_TOKENS));
    expect(listed).toEqual([...EXCLUDED_NAME_TOKENS]);
    expect(new Set(listed).size).toBe(listed.length);
    for (const p of PROVIDERS) {
      expect(listed, p.key).toContain(p.key);
      for (const word of p.name.toLowerCase().split(/\s+/)) expect(listed, p.name).toContain(word);
    }
    expect(listed).toEqual(expect.arrayContaining(['dr', 'doctor']));
  });

  it('configures the birth date as the hand-written slot was: its wording, its ids, the keypad, the year line, masked to its year', () => {
    const lib = clinicApp.slots.dob as LibrarySlotSpec;
    expect(lib.type).toBe('birthdate');
    expect(lib.config).toEqual({
      keypad: true,
      notThisDate: 'an appointment date',
      text: {
        givenFalse: "No birth date. An appointment date, a date they want to be seen on, or someone else's birth date is not the caller's date of birth",
        monthHint: 'A month may be said as a number rather than a name; answer with the month that number means, as in seven two sixty five, which is July 2nd, 1965.',
      },
      minYear: 1900, redact: 'mask', handoff: 'display', confirm: 'summary',
    });
    expect(lib).toMatchObject({
      id: dobSlot.id, spokenConfirm: dobSlot.spokenConfirm, redact: 'mask', valueKind: 'date', detect: true, partialPromptId: 'ask_dob_year',
    });
    expect(lib.handoff).toBeUndefined();
    expect(lib.dtmf?.length).toBe(8);
    expect(lib.questionIds).toEqual(['dobGiven', 'dobMonth', 'dobDay', 'dobYear']);
    expect(lib.prompts!.map((p) => p.id)).toEqual(['ask_dob_year', 'ask_dob_dtmf']);
  });

  it('configures the day as the hand-written slot was: ahead, spans of days narrowed with date_narrow_window, this or next, by confidence, keyed, its seven questions word for word and its ids', () => {
    const lib = clinicApp.slots.date as LibrarySlotSpec;
    expect(lib.type).toBe('date');
    const q = dateSlot.questions(testSlotContext('')) as Record<string, { instructions: string; criteria: Record<string, string | null> }>;
    expect(lib.config).toEqual({
      range: 'future', windows: true, qualifier: true, narrowPrompt: 'date_narrow_window', fillAt: 'confirm', whenUnsaid: 'absent', whenUnresolved: 'invalid',
      confirm: 'by-confidence', readBack: 'below-fill', keypad: true, preferMonthDay: true,
      ids: { relative: 'dateRelativeDay', qualifier: 'dateWeekdayQualifier' },
      text: {
        mode: q.dateMode!.instructions, modeNone: q.dateMode!.criteria.none, month: q.dateMonth!.instructions, day: q.dateDay!.instructions, weekday: q.dateWeekday!.instructions,
        qualifier: q.dateWeekdayQualifier!.instructions, relative: q.dateRelativeDay!.instructions, window: q.dateWindow!.instructions,
      },
    });
    expect(lib).toMatchObject({ id: dateSlot.id, spokenConfirm: dateSlot.spokenConfirm, valueKind: 'date', partialPromptId: 'date_narrow_window' });
    expect(lib.dtmf?.length).toBe(4);
    expect(lib.questionIds).toEqual(['dateMode', 'dateMonth', 'dateDay', 'dateWeekday', 'dateWeekdayQualifier', 'dateRelativeDay', 'dateWindow']);
    expect(lib.prompts!.map((p) => [p.id, p.vars])).toEqual([['date_narrow_window', ['window']], ['ack_date', ['date']], ['ask_date_dtmf', undefined]]);
  });

  it('configures the provider as the hand-written slot was: the roster in keypad order, taken at SLOT_CHOICE_CONFIRM and read back below SLOT_CHOICE_FILL, close names asked about, a hedge and a help question, its three questions word for word and its ids', () => {
    const lib = clinicApp.slots.provider as LibrarySlotSpec;
    expect(lib.type).toBe('choice');
    type Q = { instructions: string; criteria: Record<string, string> };
    const q = providerSlot.questions(testSlotContext('')) as unknown as Record<string, Q>;
    expect(lib.config).toEqual({
      options: Object.fromEntries(PROVIDERS.map((p) => [p.key, { say: `Dr. ${p.name}`, means: `Dr. ${p.name}, also said as just ${p.name}` }])),
      means: 'The caller names {say}',
      text: { instructions: q.provider!.instructions, none: q.provider!.criteria.none },
      keypad: true, fillAt: 'SLOT_CHOICE_CONFIRM', confirm: 'by-confidence', readBack: 'below-fill', disambiguate: 'margin',
      hedge: {
        threshold: 'PROVIDER_UNSURE', byName: true,
        text: { instructions: q.providerUnsure!.instructions, true: q.providerUnsure!.criteria.true, false: q.providerUnsure!.criteria.false },
      },
      help: {
        threshold: 'SLOT_HELP',
        labels: {
          neither: { means: q.providerNameStatus!.criteria.neither },
          has_name: { means: q.providerNameStatus!.criteria.has_name, prompt: 'ask_provider_name' },
          no_name: { means: q.providerNameStatus!.criteria.no_name, prompt: 'provider_list' },
        },
        text: { instructions: q.providerNameStatus!.instructions },
      },
      ids: { hedge: 'providerUnsure', help: 'providerNameStatus' },
    });
    // The help question has no none: the stub answers it with its first label, which must ask for nothing.
    expect(Object.keys(q.providerNameStatus!.criteria)).toEqual(['neither', 'has_name', 'no_name']);
    expect(lib).toMatchObject({ id: providerSlot.id, spokenConfirm: providerSlot.spokenConfirm });
    expect(lib.dtmf?.length).toBe(providerSlot.dtmf?.length);
    expect(lib.questionIds).toEqual(['provider', 'providerUnsure', 'providerNameStatus']);
    expect(lib.prompts!.map((p) => [p.id, p.vars])).toEqual([
      ['ack_provider', ['provider']], ['disambiguate_provider', ['a', 'b']], ['ask_provider_name', undefined], ['provider_list', undefined], ['ask_provider_dtmf', undefined],
    ]);
  });

  it('configures the member ID as the hand-written slot was: its wording and ids, eight digits in two groups, keyed, recorded by its last four', () => {
    const lib = clinicApp.slots.memberId as LibrarySlotSpec;
    expect(lib.type).toBe('digits');
    expect(lib.config).toEqual({
      noun: 'member ID', length: 8, mask: '^\\d{8}$', keypad: true, group: [4, 4], ids: { given: 'containsMemberId' },
      confirm: 'summary', readBack: 'implicit', minConfidence: 'none', redact: 'last4', handoff: 'last4',
    });
    expect(lib).toMatchObject({ id: memberIdSlot.id, spokenConfirm: memberIdSlot.spokenConfirm, redact: 'last4', handoff: 'last4', detect: true });
    expect(lib.dtmf?.length).toBe(8);
    expect(lib.questionIds).toEqual(['containsMemberId', 'memberIdSpan', 'memberIdComplete']);
    // never said: a summary slot is not acknowledged (the manifest keeps ack_memberId, pinned in index.test.ts)
    expect(lib.prompts).toEqual([{ id: 'ask_memberId_dtmf', why: 'it asks for a member ID on the keypad after spoken answers missed' }]);
  });
});

describe('the clinic folder: policy.yaml', () => {
  it('verifies no one: no identity, and every tool at level 0', () => {
    expect(clinicApp.identity).toBeUndefined();
    expect(clinicApp.policy.toolLevel).toEqual({ findAppointment: 0, listOpenings: 0, bookAppointment: 0, moveAppointment: 0, cancelAppointment: 0 });
  });

  it('holds the three writes to what the caller confirmed (R3), over who, with whom and when', () => {
    expect(clinicApp.policy.rulesFor).toEqual({
      findAppointment: ['R1'], listOpenings: ['R1'], bookAppointment: ['R1', 'R3'], moveAppointment: ['R1', 'R3'], cancelAppointment: ['R1', 'R3'],
    });
    expect(clinicApp.policy.confirmedFields).toEqual(['name', 'dob', 'provider', 'date', 'time']);
    expect(clinicApp.policy.maxAttempts).toBe(3);
    expect(Object.keys(clinicApp.policy.toolLevel)).toEqual(Object.keys(code.tools));
  });
});

describe('the clinic folder: app.yaml', () => {
  it('is the clinic, in en-US, with the folder\'s content hashes', () => {
    expect(clinicApp.id).toBe('clinic');
    expect(clinicApp.brand).toEqual({ name: 'Example Family Practice', mark: 'EF', key: 'example-family-practice' });
    expect(clinicApp.locales).toEqual({ default: 'en-US', prompts: {} });
    expect(Object.keys(clinicApp.configHashes?.files ?? {}).sort()).toEqual(['app.yaml', 'forms.yaml', 'intents.yaml', 'policy.yaml', 'prompts.yaml', 'slots.yaml']);
  });

  it('has the clinic\'s own thresholds, carries the caller\'s details, and finds its fixtures', () => {
    expect(clinicApp.thresholds).toEqual({ PROVIDER_UNSURE: 0.45, TIME_OF_DAY: 0.6, TIME_PREFERENCE: 0.6 });
    expect(clinicApp.carrySlots).toEqual(['name', 'dob', 'memberId']);
    expect(clinicApp.fixtures).toEqual({ dir: 'fixtures' });
  });

  it('names every slot the code has, in the console and in the change question', () => {
    expect(clinicApp.console?.slotOrder).toEqual([...ALL_SLOTS]);
    expect(Object.keys(clinicApp.console?.slotLabels ?? {}).sort()).toEqual([...ALL_SLOTS].sort());
    expect(clinicApp.wording?.changeSlot?.order).toEqual(['name', 'dob', 'provider', 'date', 'memberId']);
  });

  it('tells the recognizer every provider on the roster, and the keypad line names them in keypad order', () => {
    for (const p of PROVIDERS) expect(clinicApp.voice?.hints, p.name).toContain(p.name);
    const keypad = PROVIDERS.map((p, i) => `Dr. ${p.name}${i === 0 ? ' press' : ''} ${i + 1}`).join(', ');
    expect(clinicApp.prompts.manifest.ask_provider_dtmf!.text).toBe(`Using the keypad: for ${keypad}.`);
  });

  it('spells a member ID out in two groups of four, from the pattern compiled with the g flag', () => {
    const [rule] = clinicApp.voice?.spokenDigits ?? [];
    expect(rule?.spell).toBe('groups');
    expect([rule?.pattern.source, rule?.pattern.flags]).toEqual(['\\d{4,}(?: \\d{4,})+|\\d{5,}', 'g']);
    expect('member ID 5550 7788, ref A1001'.match(rule!.pattern)).toEqual(['5550 7788']);
  });
});

describe('the clinic folder: dialogwright check', () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });

  /** The clinic's YAML in a temporary folder, with prompts.yaml changed by `edit`. */
  const copy = (edit: (text: string) => string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'clinic-check-'));
    scratch.push(dir);
    for (const file of ['app.yaml', 'intents.yaml', 'forms.yaml', 'prompts.yaml', 'policy.yaml', 'slots.yaml']) cpSync(join(CLINIC_DIR, file), join(dir, file));
    writeFileSync(join(dir, 'prompts.yaml'), edit(readFileSync(join(dir, 'prompts.yaml'), 'utf8')));
    return dir;
  };

  it('passes: the folder, the code and the corpus agree', async () => {
    expect((await checkApp(CLINIC_DIR, { code })).map(formatProblem)).toEqual([]);
  });

  it('fails without a keypad line a slot with a keypad rung needs (ask_dob_dtmf)', async () => {
    const dir = copy((t) => t.replace(/^  ask_dob_dtmf:\n(    .*\n)+/m, ''));
    expect((await checkApp(dir, { code, fixturesRoot: CLINIC_DIR })).map(formatProblem)).toEqual([
      'prompts.yaml:7:1  prompts  prompt "ask_dob_dtmf" is missing from prompts.yaml; the engine says it when it asks for the slot "dob" on the keypad after spoken answers missed (its slot spec has dtmf)  ->  add "ask_dob_dtmf:" with its text and interruptible to prompts.yaml',
    ]);
  });
});

describe('the clinic\'s roster', () => {
  it('has unique provider keys, the close pair among them', () => {
    const keys = PROVIDERS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining(['chen', 'cheng']));
  });

  it('is written once, as the provider slot\'s options in slots.yaml: PROVIDERS and providerDisplay are read from the slot built from it, the one the app runs', () => {
    expect(PROVIDERS).toEqual([
      { key: 'chen', name: 'Chen' }, { key: 'cheng', name: 'Cheng' }, { key: 'patel', name: 'Patel' }, { key: 'okafor', name: 'Okafor' },
      { key: 'nguyen', name: 'Nguyen' }, { key: 'rossi', name: 'Rossi' }, { key: 'kim', name: 'Kim' }, { key: 'alvarez', name: 'Alvarez' },
    ]);
    expect(providerLibrarySlot.config).toEqual((clinicApp.slots.provider as LibrarySlotSpec).config);
    for (const p of PROVIDERS) {
      expect(providerDisplay(p.key)).toBe(`Dr. ${p.name}`);
      expect(clinicApp.slots.provider!.display(p.key)).toBe(`Dr. ${p.name}`);
      expect(providerLibrarySlot.config.options[p.key]!.means).toBe(`Dr. ${p.name}, also said as just ${p.name}`);
    }
    expect(providerDisplay('lee')).toBe('lee');
    PROVIDERS.forEach((p, i) => expect(clinicApp.slots.provider!.dtmf!.parse(String(i + 1), testSlotContext(''))).toEqual({ value: p.key, display: `Dr. ${p.name}` }));
  });
});
