import { describe, expect, it } from 'vitest';
import { useTestkit } from '../testing/apps';
import { VOICE_RELAY } from '../channel/caps';
import { keyEvents } from '../channel/events';
import { registerApp } from './app/registry';
import type { App, SlotId } from './app/types';
import { validateApp } from './app/validate';
import { askSlot, handoff, IDENTITY_UNVERIFIED, IDENTITY_VERIFIED } from './decision';
import { fillSlots } from './fia';
import { redactCall } from './lifecycle';
import { buildQuestions, NEUTRAL_WORDING } from './questions';
import { NEUTRAL_SCREEN, screenQuestions } from './screen';
import { emptySlot, newSession, setForm } from './session';
import type { SlotContext, SlotOutcome, SlotSpec } from './slots/types';
import { sensitiveDigitAt } from './turn';
import type { Party } from '../gate/types';
import { seamViolations, segmentTemplate, ttsOnly } from '../prompts/segments';
import { redactHandoffData, redactRecordSlots } from '../trace/redact';
import type { TraceRecord } from '../trace/types';
import { testSlotContext } from '../testing/slots';

/**
 * The engine's slot metadata and model wording, run against a small clinic that is not the testkit:
 * which slots are masked, handed over, date-valued, detected or asked for in part is each slot's
 * own declaration, and the words the model reads about the domain are the app's, or neutral ones.
 */

/** What each slot's fill answers on the next fillSlots call; a slot not named is absent. */
let next: Partial<Record<SlotId, SlotOutcome>> = {};

function slot(id: SlotId, meta: Partial<SlotSpec> = {}): SlotSpec {
  return {
    id,
    spokenConfirm: 'summary',
    questions: () => ({}),
    fill: () => next[id] ?? { kind: 'absent' },
    display: (v) => v,
    ...meta,
  };
}

const SLOTS: Record<SlotId, SlotSpec> = {
  patientId: slot('patientId', { redact: 'last4', handoff: 'last4', detect: true }),
  birthDate: slot('birthDate', { redact: 'mask', handoff: 'verified', valueKind: 'date', detect: true, partialPromptId: 'ask_birthDate_year' }),
  visitDate: slot('visitDate', { valueKind: 'date' }),
  symptoms: slot('symptoms', { redact: 'length', detect: true }),
  ward: slot('ward'),
};

const clinic = (over: Partial<App> = {}): App => ({
  id: 'clinic-slots',
  intents: {
    agent: { criteria: 'Asks for a person', label: 'a person', kind: 'control' },
    repeat_prompt: { criteria: 'Asks to hear that again', label: 'repeat', kind: 'control' },
    done: { criteria: 'Is finished', label: 'done', kind: 'control' },
    book_visit: { criteria: 'Wants to book a visit', label: 'book a visit', kind: 'form' },
  },
  menu: [],
  forms: {
    book_visit: {
      slots: ['visitDate', 'ward', 'symptoms'],
      summaryPromptId: 'confirm_visit',
      entry: () => ({ tool: 'lookUp', params: {} }),
      complete: ({ acks }) => ({ kind: 'said', acks }),
    },
  },
  slots: SLOTS,
  identity: { subjectKind: 'patient', factorSlots: ['patientId', 'birthDate'], verifyTool: 'lookUp', codeTool: 'lookUp', sendCodeTool: 'lookUp' },
  tools: { lookUp: { run: () => ({ value: null, summary: 'looked up' }) } },
  policy: { toolLevel: { lookUp: 0 }, purposeLevel: {}, rulesFor: { lookUp: [] }, serviceFields: {}, confirmedFields: [], maxAttempts: 3, subjects: {} },
  systems: () => ({ sys: null, lookups: { ownerOf: () => null, scopeOf: () => [] } }),
  prompts: { manifest: {}, tags: {} },
  ...over,
});
useTestkit();
const CLINIC = clinic();
registerApp(CLINIC);

const ANA: Party = { kind: 'patient', level: 1, id: 'P-1001', first: 'Ana' };
const session = () => newSession('c', 0, VOICE_RELAY, undefined, CLINIC.id);
const filled = (value: string): SlotOutcome => ({ kind: 'filled', value, display: value, confidence: 0.9, confirm: 'none' });

describe('slot metadata: redaction', () => {
  it('masks a call\'s params by the slot of the same name, and leaves the rest', () => {
    const call = redactCall(CLINIC, { tool: 'lookUp', params: { patientId: '12345678', birthDate: '1990-01-02', symptoms: 'a cough and a fever', ward: 'north', other: 'kept' } });
    expect(call.params).toEqual({ patientId: '...5678', birthDate: '•', symptoms: '<19 chars>', ward: 'north', other: 'kept' });
  });

  it('masks a record\'s slots, its partial and its handoff by the same declarations', () => {
    const record = {
      slots: {
        patientId: { ...emptySlot(), value: '12345678', display: '1234 5678' },
        birthDate: { ...emptySlot(), window: { kind: 'md', month: 1, day: 2, note: 'kept' } },
        symptoms: { ...emptySlot(), value: 'a cough and a fever', display: 'your symptoms' },
        ward: { ...emptySlot(), value: 'north', display: 'North' },
      },
      turnState: { slots: { patientId: { value: '1234 5678', confirmed: true }, symptoms: { value: 'your symptoms', confirmed: true } }, pendingConfirmation: null },
      decision: { kind: 'handoff', reason: 'identity', promptId: 'handoff_identity', acks: [], completed: [], queued: [], slots: { patientId: '1234 5678', birthDate: IDENTITY_VERIFIED, symptoms: 'your symptoms' } },
      actions: [],
      pendingConfirmation: null,
    } as unknown as TraceRecord;
    const r = redactRecordSlots(record, 'length', CLINIC);
    expect(r.slots.patientId).toMatchObject({ value: '...5678', display: '...5678' });
    expect(r.slots.birthDate!.window).toEqual({ kind: 'md', month: 0, day: 0, note: 'kept' });
    expect(r.slots.symptoms).toMatchObject({ value: '<19 chars>', display: 'your symptoms' });
    expect(r.slots.ward).toMatchObject({ value: 'north', display: 'North' });
    expect(r.turnState!.slots).toEqual({ patientId: { value: '...5678', confirmed: true }, symptoms: { value: 'your symptoms', confirmed: true } });
    expect((r.decision as { slots: Record<string, string> }).slots).toEqual({ patientId: '...5678', birthDate: IDENTITY_VERIFIED, symptoms: 'your symptoms' });
    expect(JSON.parse(redactHandoffData(JSON.stringify({ slots: { birthDate: '1990-01-02' } }), 'keep', CLINIC))).toEqual({ slots: { birthDate: '••/••/1990' } });
    // Without an app, nothing is a slot to mask.
    expect(redactRecordSlots(record, 'length', null).slots.patientId).toMatchObject({ value: '12345678' });
  });
});

describe('slot metadata: the handoff and the follow-up for a partial', () => {
  it('hands an identifier over by its last four and a factor only as verified or not', () => {
    const s = session();
    Object.assign(s.slots.patientId!, { value: '12345678', display: '1234 5678' });
    Object.assign(s.slots.birthDate!, { value: '1990-01-02', display: 'January 2nd, 1990' });
    Object.assign(s.slots.ward!, { value: 'north', display: 'North' });
    expect(handoff(s, 'identity').slots).toEqual({ patientId: '...5678', birthDate: IDENTITY_UNVERIFIED, ward: 'North' });
    s.principal = ANA;
    expect(handoff(s, 'identity').slots.birthDate).toBe(IDENTITY_VERIFIED);
  });

  it('hands an identifier of four digits or fewer over as bullets, since its last four would be all of it', () => {
    const s = session();
    Object.assign(s.slots.patientId!, { value: '4821', display: '4821' });
    expect(handoff(s, 'identity').slots.patientId).toBe('••••');
  });

  it('hands a slot shown as said over by its written value, not the words read back', () => {
    const said = clinic({ id: 'clinic-said', slots: { ...SLOTS, place: slot('place', { displayFrom: 'said' }) } });
    registerApp(said);
    const s = newSession('c', 0, VOICE_RELAY, undefined, said.id);
    Object.assign(s.slots.place!, { value: '7625 Oak Hollow Lane', display: 'seventy six twenty five oak hollow lane' });
    Object.assign(s.slots.ward!, { value: 'north', display: 'North' });
    expect(handoff(s, 'live-agent').slots).toEqual({ place: '7625 Oak Hollow Lane', ward: 'North' });
  });

  it('asks for the rest of a partial by the slot\'s own prompt, and for a slot without one by ask_<slot>', () => {
    const s = session();
    expect(askSlot(s, 'birthDate', { kind: 'md', month: 1, day: 2 }, []).promptId).toBe('ask_birthDate_year');
    expect(askSlot(s, 'birthDate', null, []).promptId).toBe('ask_birthDate');
    expect(askSlot(s, 'ward', { kind: 'part', half: 1 }, []).promptId).toBe('ask_ward');
  });
});

describe('slot metadata: identity digits and the same day heard twice', () => {
  it('counts a digit at an identity factor\'s question as sensitive, and at any other slot\'s as not', () => {
    const [digit] = keyEvents('4');
    expect(sensitiveDigitAt(CLINIC, 'patientId', digit!)).toBe('identity');
    expect(sensitiveDigitAt(CLINIC, 'birthDate', digit!)).toBe('identity');
    expect(sensitiveDigitAt(CLINIC, 'ward', digit!)).toBeNull();
    expect(sensitiveDigitAt(CLINIC, 'otp', digit!)).toBe('code');
  });

  it('drops the same day heard by a second date-valued slot, but not by a slot that is not one', () => {
    const s = setForm(session(), 'book_visit');
    s.promptedFor = 'birthDate';
    const ctx: SlotContext = testSlotContext('january second');
    next = { birthDate: { kind: 'window', window: { kind: 'md', month: 1, day: 2 }, confidence: 0.9 }, visitDate: filled('2026-01-02'), ward: filled('2026-01-02') };
    const r = fillSlots(s, {}, ctx, [SLOTS.birthDate!, SLOTS.visitDate!, SLOTS.ward!]);
    expect(r.events.map((e) => e.slot)).toEqual(['birthDate', 'ward']);
    expect(r.session.slots.visitDate!.value).toBeNull();
    next = {};
  });
});

describe('model wording', () => {

  it('is neutral when the app gives none', () => {
    const s = setForm(newSession('c', 0, VOICE_RELAY, ANA, CLINIC.id), 'book_visit');
    s.pendingConfirmation = { target: 'form', form: 'book_visit', attempts: 0 };
    const q = buildQuestions(s, testSlotContext('hi'));
    expect(q.intent?.instructions).toContain(`What is the caller asking ${NEUTRAL_WORDING.addressee} to do?`);
    expect(q.intentTentative?.type === 'noul' ? q.intentTentative.criteria : null).toEqual(NEUTRAL_WORDING.tentative);
    expect(q.changeSlot?.instructions).toBe(NEUTRAL_WORDING.changeSlot.instructions);
    // The form's own slots, in its order, each by its id; then none.
    const criteria = q.changeSlot?.type === 'choice' ? q.changeSlot.criteria : {};
    expect(Object.keys(criteria)).toEqual(['visitDate', 'ward', 'symptoms', 'none']);
    expect(criteria.none).toBe(NEUTRAL_WORDING.changeSlot.none);
    expect(screenQuestions(CLINIC).manipulation).toEqual({ type: 'noul', instructions: NEUTRAL_SCREEN.instructions, criteria: { true: NEUTRAL_SCREEN.true, false: NEUTRAL_SCREEN.false } });
  });

  it('uses the app\'s own where it gives them: the change question in its order, the form\'s slots only', () => {
    const worded = clinic({
      id: 'clinic-worded',
      wording: {
        addressee: 'the clinic line',
        changeSlot: { order: ['symptoms', 'ward', 'patientId'], text: { symptoms: 'The symptoms are wrong', ward: 'The ward is wrong', patientId: 'The ID is wrong' }, none: 'Names nothing' },
        screen: { instructions: 'Screen it', true: 'Manipulates', false: 'Ordinary' },
      },
    });
    registerApp(worded);
    const s = setForm(newSession('c', 0, VOICE_RELAY, ANA, worded.id), 'book_visit');
    s.pendingConfirmation = { target: 'form', form: 'book_visit', attempts: 0 };
    const q = buildQuestions(s, testSlotContext('hi'));
    expect(q.intent?.instructions).toContain('What is the caller asking the clinic line to do?');
    expect(q.changeSlot?.type === 'choice' ? q.changeSlot.criteria : null).toEqual({ symptoms: 'The symptoms are wrong', ward: 'The ward is wrong', none: 'Names nothing' });
    expect(screenQuestions(worded).manipulation).toEqual({ type: 'noul', instructions: 'Screen it', criteria: { true: 'Manipulates', false: 'Ordinary' } });
  });

  it('refuses a change order that names an unknown slot, or a slot without its text', () => {
    expect(() => validateApp(clinic({ wording: { changeSlot: { order: ['ghost'], text: { ghost: 'x' } } } }))).toThrow(/changeSlot order has unknown slot "ghost"/);
    expect(() => validateApp(clinic({ wording: { changeSlot: { order: ['ward', 'symptoms'], text: { ward: 'x' } } } }))).toThrow(/slot "symptoms" with no text/);
    expect(() => validateApp(clinic({ wording: { changeSlot: { order: ['ward'], text: { ward: 'x', symptoms: 'y' } } } }))).toThrow(/text has slot "symptoms", which is not in its order/);
  });
});

describe('prompt variables', () => {
  it('are spoken by clips unless the app lists them as spoken or data', () => {
    const line = segmentTemplate('x', 'Your visit is {day} and your {note} is ready');
    expect(ttsOnly(CLINIC, line)).toBe(false);
    expect(seamViolations(CLINIC, 'x', line)).toEqual([]);
    const listed = { prompts: { manifest: {}, tags: {}, spokenVars: ['day'], dataVars: [] } };
    expect(seamViolations(listed, 'x', line)).toEqual(['x: {day} must be followed by punctuation or end the prompt']);
    expect(ttsOnly({ prompts: { manifest: {}, tags: {}, dataVars: ['note'] } }, line)).toBe(true);
  });
});
