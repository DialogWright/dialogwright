import { describe, expect, it } from 'vitest';
import { useTestkit } from '../../testing/apps';
import { testkitApp } from '../../testing/testkit';
import { FORM_INTENTS, INTENTS, MENU } from '../../testing/testkit/domain/intents';
import {
  formIntents, formLabel, labelIn, relabelled, informationalIntents, informationalPrompt, intentCriteria, intentLabel, intentList, isFormIntent,
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

describe('a label in a locale (AppLocales.labels)', () => {
  it('says a locale\'s own label for an intent and for an internal form, else the default\'s', async () => {
    const { routedApp } = await import('../../testing/routed/app');
    expect(intentLabel(routedApp, 'report_problem', 'es')).toBe('reportar un problema');
    expect(formLabel(routedApp, 'report_problem', 'es')).toBe('reportar un problema');
    expect(formLabel(routedApp, 'payment_plan', 'es')).toBe('preparar un plan de pago');
    // The default locale, a session with no locale, and an intent the locale leaves out: the default's.
    expect(intentLabel(routedApp, 'report_problem', 'en-US')).toBe('report a problem');
    expect(intentLabel(routedApp, 'report_problem')).toBe('report a problem');
    expect(formLabel(routedApp, 'payment_plan')).toBe('set up a payment plan');
    expect(intentLabel(routedApp, 'agent', 'es')).toBe('speak with someone');
    // An app whose locales give no labels: the default's in every locale.
    const { labels: _labels, ...without } = routedApp.locales!;
    expect(intentLabel({ ...routedApp, locales: without }, 'report_problem', 'es')).toBe('report a problem');
  });
});

describe('a label said again after a switch in the same turn (labelIn, relabelled)', () => {
  it('says a label of one locale in another, the request\'s, and leaves anything else as it was', async () => {
    const { routedApp } = await import('../../testing/routed/app');
    expect(labelIn(routedApp, 'report a problem', 'en-US', 'es')).toBe('reportar un problema');
    expect(labelIn(routedApp, 'preparar un plan de pago', 'es', 'en-US')).toBe('set up a payment plan');
    expect(labelIn(routedApp, 'something said', 'en-US', 'es')).toBe('something said');
    const acks: { promptId: string; vars: Record<string, string> }[] = [
      { promptId: 'ack_intent', vars: { intentLabel: 'check on a request' } },
      { promptId: 'ack_intent_then', vars: { a: 'report a problem', b: 'check on a request' } },
      { promptId: 'identity_verified', vars: { first: 'report a problem' } },
    ];
    expect(relabelled(routedApp, acks, 'en-US', 'es')).toEqual([
      { promptId: 'ack_intent', vars: { intentLabel: 'revisar una solicitud' } },
      { promptId: 'ack_intent_then', vars: { a: 'reportar un problema', b: 'revisar una solicitud' } },
      { promptId: 'identity_verified', vars: { first: 'report a problem' } },
    ]);
    expect(relabelled(routedApp, acks, 'es', 'es')).toEqual(acks);
  });
});
