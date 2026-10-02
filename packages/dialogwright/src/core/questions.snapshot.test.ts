import { describe, expect, it } from 'vitest';
import { buildQuestions } from './questions';
import { newSession, setForm } from './session';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { useTestkit } from '../testing/apps';
import { CUSTOMERS } from '../testing/testkit/domain/data';
import { customerPrincipal } from '../testing/testkit/domain/principals';
import type { SlotContext } from './slots/types';
import { VOICE_RELAY } from '../channel/caps';

useTestkit();

const ctx: SlotContext = {
  text: 'hi', candidateSpans: [], candidateWordSpans: [], todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS },
  window: null, current: null, records: [], prompted: false,
};
const verified = () => ({ ...newSession('s', 0, VOICE_RELAY), principal: customerPrincipal(CUSTOMERS[0]!, 2) });

/** the same three views of the question set the model sees, over the testkit's forms. */
describe('the questions the model sees, on the testkit', () => {
  it('pins every question outside a form', () => {
    expect(buildQuestions(newSession('s', 0, VOICE_RELAY), ctx)).toMatchSnapshot();
  });
  it('pins every question inside a form', () => {
    expect(buildQuestions(setForm(verified(), 'report_missing'), ctx)).toMatchSnapshot();
  });
  it('pins every question at the summary', () => {
    const s = setForm(verified(), 'report_missing');
    s.pendingConfirmation = { target: 'form', form: 'report_missing', attempts: 0 };
    expect(buildQuestions(s, ctx)).toMatchSnapshot();
  });
});
