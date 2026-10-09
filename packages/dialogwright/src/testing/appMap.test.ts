import { describe, expect, it } from 'vitest';
import { libraryApp } from '../define/fixture/app';
import type { App, FormDef } from '../core/app/types';
import type { SlotSpec } from '../core/slots/types';
import { appMapText, danglingReferences } from './appMap';
import { useTestkit } from './apps';

/**
 * What the app map names that it cannot connect, apart from the goldens that pin it whole: each
 * dangling reference, drawn marked and listed, and what an app that does not declare its calls gets.
 */

useTestkit();

describe('the app map: what it cannot connect', () => {
  const form = (calls?: readonly string[]): FormDef => ({ ...libraryApp.forms.check_loans!, ...(calls ? { calls } : {}) });

  it('names an intent with no form, a line that is not there, a menu digit to no intent, and a form no intent starts', () => {
    const app: App = {
      ...libraryApp,
      intents: { ...libraryApp.intents, renew_loan: { ...libraryApp.intents.renew_loan!, kind: 'form' }, hours: { ...libraryApp.intents.hours!, promptId: 'no_such_line' }, check_hold: { ...libraryApp.intents.check_hold!, kind: 'control' } },
      forms: { ...libraryApp.forms, ghost: form() },
      menu: [...libraryApp.menu, { digit: '9', intent: 'nobody' }],
    };
    delete (app.forms as Record<string, FormDef>).renew_loan;
    expect(danglingReferences(app).map((d) => `${d.kind}: ${d.id}`)).toEqual([
      'intent-without-form: renew_loan',
      'informational-without-line: hours',
      'menu-without-intent: nobody',
      'form-without-intent: check_hold',
      'form-without-intent: ghost',
    ]);
    const map = appMapText(app);
    expect(map).toContain('- the intent `renew_loan` starts a form, and there is no form `renew_loan`');
    expect(map).toContain('  class nf_renew_loan,i_nobody,p_hours dangling');
    expect(map).toContain('line no_such_line<br/>not in the prompts');
  });

  it('names a call to an action the policy does not list, and an action no form reaches, once forms say what they call', () => {
    const forms = {
      renew_loan: { ...libraryApp.forms.renew_loan!, calls: ['renewLoan', 'sendLetter'] },
      check_hold: { ...libraryApp.forms.check_hold!, calls: ['findHold'] },
      check_loans: { ...libraryApp.forms.check_loans!, calls: [] },
    };
    const app: App = { ...libraryApp, forms };
    expect(danglingReferences(app).map((d) => `${d.kind}: ${d.id}`)).toEqual(['form-calls-unlisted: renew_loan', 'action-unreached: listLoans']);
    const map = appMapText(app);
    expect(map).toContain('a_sendLetter["sendLetter<br/>not in the policy"]');
    expect(map).toContain('  class a_sendLetter dangling');
    expect(map).toContain('- no form reaches the action `listLoans`, and the identity flow does not call it');
  });

  it('draws an intent that switches the language, alone or with its line, and finds nothing dangling in it', () => {
    const app: App = {
      ...libraryApp,
      intents: {
        ...libraryApp.intents,
        spanish: { kind: 'informational', label: 'continue in Spanish', criteria: 'x', locale: 'es' },
        hours: { ...libraryApp.intents.hours!, locale: 'es' },
      },
    };
    expect(danglingReferences(app)).toEqual([]);
    const map = appMapText(app);
    expect(map).toContain('p_spanish[/"switches to es"/]');
    expect(map).toContain('p_hours[/"line hours<br/>switches to es"/]');
    expect(map).toContain('| `spanish` | informational | continue in Spanish | switches the call to es and goes back to the question |');
    expect(map).toMatch(/\| `hours` \| informational \| hear the opening hours \| switches the call to es, says "[^"]+" and goes back to the question \|/);
  });

  it('says so when forms do not declare their calls, and finds no action unreached then', () => {
    expect(danglingReferences(libraryApp)).toEqual([]);
    expect(appMapText(libraryApp)).toContain('the forms do not declare which actions they call (`calls`), so which actions are reached is not checked.');
  });
});

describe('the app map: a slot that runs out, and an outcome that enters a form', () => {
  const slots = libraryApp.forms.renew_loan!.slots;
  const slot = slots[0]!;
  const withOutcome = (onMaxAttempts: SlotSpec['onMaxAttempts'], attempts?: number): App => ({
    ...libraryApp,
    slots: { ...libraryApp.slots, [slot]: { ...(libraryApp.slots[slot] as SlotSpec), onMaxAttempts, ...(attempts !== undefined ? { attempts } : {}) } },
  });

  it('draws each onMaxAttempts that is not the default handoff beside its slot, with its attempts where it has its own', () => {
    expect(appMapText(withOutcome('handoff'))).not.toContain('runs out');
    expect(appMapText(withOutcome({ then: 'handoff' }))).not.toContain('runs out');
    const skip = appMapText(withOutcome({ say: 'hours', then: 'skip' }, 4));
    expect(skip).toContain(`  x_${slot}>"When it runs out, after 4 attempts<br/>say hours, skip"]`);
    expect(skip).toContain(`  s_${slot} -.->|"runs out"| x_${slot}`);
    expect(appMapText(withOutcome({ then: 'handoff', reason: 'loan-desk' }))).toContain(`x_${slot}>"When it runs out<br/>handoff loan-desk"]`);
    expect(appMapText(withOutcome({ then: 'form', form: 'check_hold' }))).toContain(`x_${slot}>"When it runs out<br/>form check_hold"]`);
  });

  it('an internal form an outcome enters is drawn after the form the outcome leaves', () => {
    const app: App = {
      ...withOutcome({ then: 'form', form: 'desk' }),
      forms: { ...libraryApp.forms, desk: { slots: [], summaryPromptId: null, internal: true, label: 'talk to the desk', complete: (c) => ({ kind: 'said', acks: c.acks }) } },
    };
    const map = appMapText(app);
    expect(map).toContain('after("After<br/>renew_loan, as an outcome: Renew a book<br/>check_hold, as an outcome: Check a hold")');
    expect(map).toContain('After `renew_loan` (an outcome), `check_hold` (an outcome): the internal form `desk`');
  });
});
