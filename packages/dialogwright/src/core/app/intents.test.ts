import { describe, expect, it } from 'vitest';
import { useTestkit } from '../../testing/apps';
import { testkitApp } from '../../testing/testkit';
import { FORM_INTENTS, INTENTS, MENU } from '../../testing/testkit/domain/intents';
import {
  formIntents, informationalIntents, informationalPrompt, intentCriteria, intentLabel, intentList, isFormIntent,
} from './intents';

useTestkit();

const ALL = ['track_parcel', 'delivery_window', 'report_missing', 'agent', 'repeat_prompt', 'capabilities', 'done', 'other', 'none'];
const LABELS: Record<string, string> = {
  track_parcel: 'track a parcel',
  delivery_window: 'book a delivery window',
  report_missing: 'report a missing parcel',
  agent: 'speak with someone',
  repeat_prompt: 'hear that again',
  capabilities: 'hear what I can do',
  done: 'finish up',
  other: 'something else',
  none: 'nothing',
};

describe('intent helpers, over the testkit app', () => {
  it('lists the intents in definition order', () => {
    expect(intentList(testkitApp)).toEqual(ALL);
    expect(intentList(testkitApp)).toEqual(Object.keys(INTENTS));
  });

  it('lists the form intents in definition order', () => {
    expect(formIntents(testkitApp)).toEqual(['track_parcel', 'delivery_window', 'report_missing']);
    expect(formIntents(testkitApp)).toEqual([...FORM_INTENTS]);
  });

  it('knows a form intent from every other intent and from strangers', () => {
    for (const i of ALL) expect(isFormIntent(testkitApp, i)).toBe((FORM_INTENTS as readonly string[]).includes(i));
    for (const i of ['bogus', '', 'digit_1', 'toString']) expect(isFormIntent(testkitApp, i)).toBe(false);
  });

  it('gives the label for every intent', () => {
    for (const i of ALL) expect(intentLabel(testkitApp, i)).toBe(LABELS[i]);
  });

  it('gives the informational prompt for every intent', () => {
    for (const i of ALL) expect(informationalPrompt(testkitApp, i)).toBe(i === 'capabilities' ? 'capabilities' : undefined);
    expect(informationalPrompt(testkitApp, 'bogus')).toBeUndefined();
    expect(informationalIntents(testkitApp)).toEqual({ capabilities: 'capabilities' });
  });

  it('gives the criteria record as the app wrote it, in the same order', () => {
    const got = intentCriteria(testkitApp);
    expect(got).toEqual(Object.fromEntries(Object.entries(INTENTS).map(([k, d]) => [k, d.criteria])));
    expect(Object.keys(got)).toEqual(ALL);
  });

  it('keeps the menu order', () => {
    expect(testkitApp.menu).toEqual(MENU);
    expect(testkitApp.menu.map((m) => m.digit)).toEqual(['1', '2', '3', '0']);
  });
});
