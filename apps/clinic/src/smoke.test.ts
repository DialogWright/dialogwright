import { describe, expect, it } from 'vitest';
import { choice } from 'dialogwright';
import { DemoDirectory } from './domain/directory';
import { factsOf } from './domain/facts';
import { describeWhen } from './domain/scheduling';
import { ANSWERING, DOB, NAME, TODAY, YES, calls, heard, intent, provider, say, started, weekday } from './testing/turns';

/** A reschedule from the greeting to the confirmation, turn by turn, with hand-built model answers. */
describe('a reschedule, greeting to confirmation', () => {
  it('asks for the caller, reads the move back, and makes it on yes', () => {
    const dir = new DemoDirectory(TODAY);
    const greeting = started();
    expect(greeting.lastPromptText).toBe('Thanks for calling Example Family Practice. How can I help you today?');

    const opener = say(greeting, 'Hi, I need to reschedule my appointment with Dr. Chen', { ...intent('reschedule'), ...provider('chen') });
    expect(opener.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_name' });
    expect(heard(opener)).toBe("I'd be happy to help you reschedule your appointment. What's your first and last name?");

    const named = say(opener.session, 'Morgan Ellis', { intentChange: ANSWERING, ...NAME });
    expect(heard(named)).toBe('And your date of birth?');

    const born = say(named.session, 'June fourteenth nineteen seventy five', { intentChange: ANSWERING, ...DOB });
    expect(heard(born)).toBe('What day works for you?');
    expect(calls(born)).toEqual([]);

    const summary = say(born.session, 'Tuesday', { intentChange: ANSWERING, ...weekday('tuesday') });
    const found = dir.find('morgan ellis', '1975-06-14', 'chen');
    const [first] = dir.openings('chen', '2026-09-22');
    expect(summary.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_reschedule', target: 'confirm' });
    expect(heard(summary)).toBe(`Your appointment with Dr. Chen is on ${describeWhen(found.date, found.time)}. It would move to Tuesday, September 22 at ${first}, for Morgan Ellis, born June 14th, 1975. Shall I make that change?`);
    // The booking found and the openings listed are reads through the gate.
    expect(calls(summary)).toEqual(['findAppointment:ALLOW', 'listOpenings:ALLOW']);

    const done = say(summary.session, 'yes', YES);
    expect(done.decision).toMatchObject({ kind: 'complete', form: 'reschedule', promptId: 'reschedule_confirmed', completed: ['reschedule'] });
    expect(heard(done)).toBe(`Your appointment is moved to Tuesday, September 22 at ${first}. Goodbye.`);
    // The write goes through the gate, R3 armed by the yes over exactly what was read.
    expect(calls(done)).toEqual(['moveAppointment:ALLOW']);
    expect(done.gateEvents[0]!.decision.rules.map((r) => `${r.id}:${r.pass}`)).toEqual(['R1:true', 'R3:true']);
    expect(done.session).toMatchObject({ ended: true, form: 'reschedule' });
    expect(done.session.slots.date).toMatchObject({ value: '2026-09-22', confirmed: true });
    expect(factsOf(done.session).offer).toMatchObject({ provider: 'chen', date: '2026-09-22', index: 0 });
  });
});

describe('two tasks on the opener', () => {
  it('starts the first and says the second will follow, in one line', () => {
    const r = say(started(), 'cancel my appointment with Dr. Patel, and I have a billing question', {
      ...intent('cancel'), ...provider('patel'), secondIntent: choice({ billing: 0.9, none: 0.1 }),
    });
    expect(r.session).toMatchObject({ form: 'cancel', queued: ['billing'] });
    expect(heard(r)).toBe("I'd be happy to help you cancel your appointment, and then talk to billing. What's your first and last name?");
  });
});
