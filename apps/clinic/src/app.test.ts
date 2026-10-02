import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkApp, formatProblem, loadAppFolder } from 'dialogwright';
import { afterAll, describe, expect, it } from 'vitest';
import { CLINIC_DIR, clinicApp, code } from './app';
import { CLINIC_FORM_HOOKS } from './domain/forms';
import { PROVIDERS } from './domain/roster';
import { ALL_SLOTS, SLOTS } from './domain/slots';

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
  it('lists all five slots as code, and its order is the order of the app\'s slots (the order the engine fills and acknowledges them in)', () => {
    const slots = loadAppFolder(CLINIC_DIR).config?.slots;
    expect(slots).toEqual({ name: { type: 'code' }, dob: { type: 'code' }, memberId: { type: 'code' }, provider: { type: 'code' }, date: { type: 'code' } });
    expect(Object.keys(clinicApp.slots)).toEqual(Object.keys(slots ?? {}));
    expect(Object.keys(clinicApp.slots)).toEqual([...ALL_SLOTS]);
    for (const id of Object.keys(SLOTS)) expect(clinicApp.slots[id], id).toBe(SLOTS[id as keyof typeof SLOTS]);
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
    expect(Object.keys(clinicApp.console?.slotLabels ?? {}).sort()).toEqual(Object.keys(SLOTS).sort());
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
});
