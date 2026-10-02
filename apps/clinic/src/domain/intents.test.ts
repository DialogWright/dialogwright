import { describe, expect, it } from 'vitest';
import { CLINIC_INTENTS, FORM_INTENTS, INTENTS, MENU } from './intents';
import { FORMS } from './forms';
import { PROVIDERS } from './roster';
import { ALL_SLOTS } from './slots';

describe('the clinic domain tables', () => {
  it('has the ten intents, and no done: a call ends at its completion', () => {
    expect(INTENTS).toEqual(['schedule_new', 'reschedule', 'cancel', 'confirm_appointment', 'billing', 'agent', 'repeat_prompt', 'capabilities', 'other', 'none']);
    expect(Object.keys(CLINIC_INTENTS)).toEqual([...INTENTS]);
    expect(CLINIC_INTENTS).not.toHaveProperty('done');
    expect(CLINIC_INTENTS.capabilities).toMatchObject({ kind: 'informational', promptId: 'capabilities' });
    for (const i of FORM_INTENTS) expect(CLINIC_INTENTS[i].kind).toBe('form');
    for (const i of ['agent', 'repeat_prompt', 'other', 'none'] as const) expect(CLINIC_INTENTS[i].kind).toBe('control');
  });

  it('gives every form intent a form whose slots are known', () => {
    expect(Object.keys(FORMS)).toEqual([...FORM_INTENTS]);
    for (const form of Object.values(FORMS)) for (const slot of form.slots) expect(ALL_SLOTS).toContain(slot);
  });

  it('has unique provider keys, the close pair among them', () => {
    const keys = PROVIDERS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining(['chen', 'cheng']));
  });

  it('maps menu digits to form intents, and 0 to a person', () => {
    for (const { digit, intent } of MENU) expect(CLINIC_INTENTS[intent].kind === 'form' || (digit === '0' && intent === 'agent')).toBe(true);
  });
});
