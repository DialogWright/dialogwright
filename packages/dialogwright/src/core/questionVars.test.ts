import { describe, expect, it } from 'vitest';
import { withQuestionVars } from './questionVars';
import type { App } from './app/types';
import type { Decision } from './decision';
import { testkitApp } from '../testing/testkit';
import { testSlotContext } from '../testing/slots';
import { defineSlot } from '../slots/defineSlot';

/** A slot's own question with the values its lines may say (SlotSpec.questionVars: a record slot's {choices}). */

const booking = defineSlot('booking', { type: 'record', key: 'code', keyPattern: '[A-Z0-9]{6}', labelPrefix: 'b_', label: 'The {say}', display: 'your {say}' });
const app: App = { ...testkitApp, slots: { ...testkitApp.slots, booking } };
const BOOKINGS = [{ code: 'RTW4CM', say: 'deep clean on Saturday' }, { code: 'MK8Q2D', say: 'light clean on Wednesday' }];
const ctx = () => testSlotContext('', { records: BOOKINGS });
const ask = (promptId: string, target = 'booking'): Decision => ({ kind: 'prompt', promptId, vars: {}, acks: [], target, options: [] });

describe('a slot\'s question with its values', () => {
  it('gives its question, its other wordings and its retries the slot\'s values', () => {
    for (const id of ['ask_booking', 'ask_booking.v2', 'ask_booking_retry', 'ask_booking_retry2']) {
      const d = ask(id);
      withQuestionVars(app, d, ctx);
      expect(d.kind === 'prompt' && d.vars).toEqual({ choices: 'your deep clean on Saturday or your light clean on Wednesday' });
    }
  });

  it('leaves every other line as it was, and a value the decision gives wins', () => {
    for (const d of [ask('disambiguate_booking'), ask('ask_booking_dtmf'), ask('ask_intent', 'intent')]) {
      withQuestionVars(app, d, ctx);
      expect(d.kind === 'prompt' && d.vars).toEqual({});
    }
    const own: Decision = { ...ask('ask_booking'), vars: { choices: 'its own' } } as Decision;
    withQuestionVars(app, own, ctx);
    expect(own.kind === 'prompt' && own.vars).toEqual({ choices: 'its own' });
  });
});
