import { afterAll, describe, expect, it } from 'vitest';
import type { AnswerMap } from '../jev/types';
import { choice, noul } from '../testing/answers';
import { call, cleanScratch, heard, libraryKbApp, nominated, say } from './__fixtures__/libraryKbApp';

/**
 * A question asked with the request that no topic answers (a topic slot's `unanswered: retry`, the
 * default): the slot holds it as a miss (SlotState.missed), and when the form comes to the slot the
 * caller hears its retry line, which says nothing answers that, rather than its question as if nothing
 * had been asked. On Example Town Library's line with its knowledge base (./__fixtures__/libraryKbApp.ts).
 */

afterAll(cleanScratch);

const APP = libraryKbApp('library-unanswered');

const LATE_FEES = 'Late books on an adult card cost 25 cents a day, up to 5 dollars a book. Your card has 2 dollars in late fees right now.';
/** A knowledge question at the open, its topic question read as `topic`. */
const ASKED = (topic: Record<string, number>): AnswerMap => ({ intent: choice({ ask_library: 0.95, none: 0.05 }), libraryTopicTopic: choice(topic) });
const ANSWER = (topic: Record<string, number>): AnswerMap => ({ intent: choice({ none: 0.95, other: 0.05 }), libraryTopicTopic: choice(topic) });

describe('a question no topic answers, asked with the request (unanswered: retry, the default)', () => {
  it('is said at once as the slot\'s miss, its retry line, with an attempt counted', () => {
    const c = call(APP);
    const r = say(c, 'can i bring my dog to the library', ASKED({ unanswered: 0.85, late_fees: 0.1, none: 0.05 }), nominated('late_fees'));
    expect(r.decision).toMatchObject({ promptId: 'ask_libraryTopic_retry' });
    expect(heard(c)).toContain('Sorry, what would you like to know about the library?');
    expect(r.session.form).toBe('ask_library');
    expect(r.session.slots.libraryTopic).toMatchObject({ value: null, attempts: 1 });
    expect(r.session.slots.libraryTopic!.missed).toBeUndefined();
    // A topic then asked is answered.
    say(c, 'what are the late fees', ANSWER({ late_fees: 0.92, none: 0.08 }), nominated('late_fees'));
    expect(heard(c)).toContain(LATE_FEES);
  });

  it('asking nothing yet ("I have a question", none) is asked the question, as before', () => {
    const c = call(APP);
    const r = say(c, 'i have a question', ASKED({ none: 0.9, late_fees: 0.05, unanswered: 0.05 }), nominated('late_fees'));
    expect(r.decision).toMatchObject({ promptId: 'ask_libraryTopic' });
    expect(r.session.slots.libraryTopic).toMatchObject({ attempts: 0 });
  });

  it('not sure enough that nothing answers it (under fillAt, the bar a topic fills at): the question, as before', () => {
    const c = call(APP);
    const r = say(c, 'can i bring my dog', ASKED({ unanswered: 0.5, none: 0.35, late_fees: 0.15 }), nominated('late_fees'));
    expect(r.decision).toMatchObject({ promptId: 'ask_libraryTopic' });
  });

  it('at the question itself, unanswered is the miss it always was: the retry line, then the next rung', () => {
    const c = call(APP);
    say(c, 'i have a question', ASKED({ none: 0.9, unanswered: 0.1 }), nominated('late_fees'));
    const r = say(c, 'can i bring my dog', ANSWER({ unanswered: 0.9, none: 0.1 }), nominated('late_fees'));
    expect(r.decision).toMatchObject({ promptId: 'ask_libraryTopic_retry' });
    expect(r.session.slots.libraryTopic).toMatchObject({ attempts: 1 });
  });

  it('in the middle of a task, the aside says the miss in place of its question; a topic then asked is answered and the task resumes', () => {
    const c = call(APP);
    say(c, 'I want to renew a book', { intent: choice({ renew_loan: 0.95, none: 0.05 }) });
    expect(c.last.decision).toMatchObject({ promptId: 'ask_book' });
    const r = say(c, 'can i bring my dog', {
      intent: choice({ ask_library: 0.92, renew_loan: 0.04, none: 0.04 }),
      intentChange: choice({ replacing: 0.9, answering: 0.05, adding: 0.05 }),
      libraryTopicTopic: choice({ unanswered: 0.88, none: 0.12 }),
    }, nominated('late_fees'));
    expect(r.decision).toMatchObject({ promptId: 'ask_libraryTopic_retry' });
    expect(r.session.form).toBe('ask_library');
    expect(r.session.parked?.form).toBe('renew_loan');
    say(c, 'late fees then', { ...ANSWER({ late_fees: 0.92, none: 0.08 }), confirmsYes: noul(0.03) }, nominated('late_fees'));
    expect(heard(c)).toBe(`${LATE_FEES} Which book is it?`);
    expect(c.last.session.form).toBe('renew_loan');
  });
});
