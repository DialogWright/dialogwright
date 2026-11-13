import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AnswerMap } from '../jev/types';
import { ACCOUNT_JOURNEYS_YAML, JOURNEYS_YAML, LEAVE_NOTE_ACTION } from '../testing/converse/journeys';
import { agentBusinessProblems } from './business/load';
import type { AgentBusiness } from './business/schema';
import { completeJourney, decideRoute, hasJourneys, initialJourney, isUnclear, NONE_TASK, openJourneys, QUESTION_TASK, readRoute, routeQuestions, routeState, type RouteReading } from './journeys';
import type { JourneyState } from './state';

const base = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'testing', 'converse', 'agent.yaml'), 'utf8');
const build = (yaml: string): AgentBusiness => {
  const { value, problems } = agentBusinessProblems(base + LEAVE_NOTE_ACTION + yaml);
  expect(problems).toEqual([]);
  return value!;
};
const plain = build(JOURNEYS_YAML);
const acct = build(ACCOUNT_JOURNEYS_YAML);
const recognised = { number: '+15555550100', account: 'Example Account' };
const anon = { number: '+15555550100', account: null };
const root: JourneyState = { active: null, phase: 'working', paused: null, done: [] };
const inVisit: JourneyState = { ...root, active: 'visit' };
const reading = (r: Partial<RouteReading>): RouteReading => ({ task: null, drops: null, again: null, fits: null, ...r });
const open = ['visit', 'note'];

describe('open journeys and the start', () => {
  it('hasJourneys is false for a business without them', () => {
    expect(hasJourneys(agentBusinessProblems(base).value!)).toBe(false);
    expect(hasJourneys(plain)).toBe(true);
  });
  it('a recognised caller is open to the account journey, not the one closed to accounts', () => {
    expect(openJourneys(acct, recognised)).toEqual(['visit_account', 'note']);
  });
  it('a caller with no account is open to the other', () => {
    expect(openJourneys(acct, anon)).toEqual(['visit', 'note']);
    expect(openJourneys(acct, { number: '+15555550100' })).toEqual(['visit', 'note']);
  });
  it('a journey with no `for` is open to everyone', () => {
    expect(openJourneys(plain, recognised)).toEqual(['visit', 'note']);
  });
  it('initialJourney starts the `start` journey only for a recognised account', () => {
    expect(initialJourney(acct, recognised)).toEqual({ active: 'visit_account', phase: 'working', paused: null, done: [] });
    expect(initialJourney(acct, anon)).toEqual(root);
    expect(initialJourney(plain, recognised)).toEqual(root);
  });
});

describe('routeQuestions', () => {
  it('task lists the open journeys by their trigger and the none option, never a closed one', () => {
    const q = routeQuestions(acct, root, anon).task!;
    expect(q.type).toBe('choice');
    if (q.type !== 'choice') throw new Error('choice');
    expect(Object.keys(q.criteria)).toEqual(['visit', 'note', QUESTION_TASK, NONE_TASK]);
    expect(q.criteria.visit).toBe(acct.journeys!.visit!.when);
    expect(q.criteria[NONE_TASK]).toBe('none of these: nothing the line can act on or answer (unrelated to the business, a request for something it does not do, or words with no clear meaning on their own)');
    expect(Object.keys(q.criteria)).not.toContain('visit_account');
  });
  it('task asks what the caller wants done, not what they ask about', () => {
    const q = routeQuestions(plain, root, anon).task!;
    expect(q.instructions).toMatch(/want done/i);
    expect(q.instructions).toMatch(/only ask about/i);
  });
  it('drops is asked only in a working journey', () => {
    expect(Object.keys(routeQuestions(plain, root, anon))).toEqual(['task']);
    expect(Object.keys(routeQuestions(plain, inVisit, anon))).toEqual(['task', 'drops', 'fits']);
    expect(Object.keys(routeQuestions(plain, { ...inVisit, phase: 'after', done: ['visit'] }, anon))).toEqual(['task', 'again']);
  });
  it('again names the active journey goal', () => {
    const q = routeQuestions(plain, { ...inVisit, phase: 'after', done: ['visit'] }, anon).again!;
    expect(q.type).toBe('noul');
    expect(q.instructions).toContain(plain.journeys!.visit!.goal);
  });
});

describe('routeState', () => {
  it('names the caller words, the last reply and the triggers of the active and paused journeys', () => {
    expect(routeState(plain, root, 'hello', null)).toEqual({ said: 'hello', lastReply: null, active: null, paused: null });
    expect(routeState(plain, { ...inVisit, paused: 'note' }, 'hi', 'Which day?')).toEqual({
      said: 'hi',
      lastReply: 'Which day?',
      active: plain.journeys!.visit!.when,
      paused: plain.journeys!.note!.when,
    });
  });
  it('in the after phase it also names what finished', () => {
    const s = routeState(plain, { ...inVisit, phase: 'after', done: ['visit'] }, 'again', 'Done.') as Record<string, unknown>;
    expect(s.finished).toBe(plain.journeys!.visit!.goal);
  });
});

describe('readRoute', () => {
  it('a missing answer set is all null, and decides carry', () => {
    expect(readRoute(null)).toEqual({ task: null, drops: null, again: null, fits: null });
    expect(decideRoute(plain, inVisit, readRoute(null), open)).toEqual({ outcome: 'carry', next: inVisit });
    expect(decideRoute(plain, root, readRoute(null), open)).toEqual({ outcome: 'carry', next: root });
  });
  it('reads the choice probabilities and the noul answers', () => {
    const answers: AnswerMap = {
      task: { type: 'choice', choice: 'note', probabilities: { note: 0.7, none: 0.3 }, confidence: 0.9 },
      drops: { type: 'noul', noul: 0.8 },
    };
    expect(readRoute(answers)).toEqual({ task: { note: 0.7, none: 0.3 }, drops: 0.8, again: null, fits: null });
  });
});

describe('decideRoute', () => {
  it('at the root, a journey above the bar starts', () => {
    const r = decideRoute(plain, root, reading({ task: { visit: 0.9, none: 0.1 } }), open);
    expect(r).toEqual({ outcome: 'start', next: { ...root, active: 'visit' } });
  });
  it('at the root, none on top stays at the root, unclear; a journey below the start bar with none not on top is clear', () => {
    const unclear = { outcome: 'root', unclear: true, next: { ...root, unclear: 1 } };
    expect(decideRoute(plain, root, reading({ task: { visit: 0.2, none: 0.8 } }), open)).toEqual(unclear);
    expect(decideRoute(plain, root, reading({ task: { visit: 0.79, none: 0.21 } }), open)).toEqual({ outcome: 'root', next: root });
  });
  it('a probability exactly at the start bar counts as a start', () => {
    expect(decideRoute(plain, root, reading({ task: { visit: 0.8, none: 0.2 } }), open).outcome).toBe('start');
  });
  it('a closed journey named by Jev is never routed to', () => {
    const o = openJourneys(acct, anon);
    const r = reading({ task: { visit_account: 0.95, visit: 0.02, none: 0.03 } });
    expect(decideRoute(acct, root, r, o)).toEqual({ outcome: 'root', unclear: true, next: { ...root, unclear: 1 } });
    expect(decideRoute(acct, { ...root, active: 'note' }, r, o).outcome).toBe('carry');
  });
  it('active A, task A or none: carry', () => {
    expect(decideRoute(plain, inVisit, reading({ task: { visit: 0.9, none: 0.1 }, drops: 0.1 }), open)).toEqual({ outcome: 'carry', next: inVisit });
    expect(decideRoute(plain, inVisit, reading({ task: { visit: 0.2, none: 0.8 }, drops: 0.1 }), open)).toEqual({ outcome: 'carry', next: inVisit });
  });
  it('active A, drops above the bar and task none: dropped, paused kept', () => {
    const j = { ...inVisit, paused: 'note' };
    expect(decideRoute(plain, j, reading({ task: { none: 0.9, note: 0.1 }, drops: 0.9 }), open)).toEqual({ outcome: 'dropped', next: { ...root, paused: 'note' } });
    expect(decideRoute(plain, inVisit, reading({ task: { visit: 0.5, none: 0.5 }, drops: 0.6 }), open)).toEqual({ outcome: 'dropped', next: root });
  });
  it('active A, drops and task another journey B: B starts, A not paused', () => {
    const r = decideRoute(plain, inVisit, reading({ task: { note: 0.9, none: 0.1 }, drops: 0.9 }), open);
    expect(r).toEqual({ outcome: 'switch', next: { ...root, active: 'note' } });
  });
  it('active A, drops and task the paused journey B: B resumes, A not paused', () => {
    const r = decideRoute(plain, { ...inVisit, paused: 'note' }, reading({ task: { note: 0.9, none: 0.1 }, drops: 0.9 }), open);
    expect(r).toEqual({ outcome: 'return', next: { ...root, active: 'note' } });
  });
  it('active A, task B above the bar, B not paused: switch, A paused', () => {
    const r = decideRoute(plain, inVisit, reading({ task: { note: 0.8, none: 0.2 }, drops: 0.1 }), open);
    expect(r).toEqual({ outcome: 'switch', next: { ...root, active: 'note', paused: 'visit' } });
  });
  it('a switch below the bar carries on', () => {
    expect(decideRoute(plain, inVisit, reading({ task: { note: 0.59, none: 0.41 }, drops: 0.1 }), open).outcome).toBe('carry');
  });
  it('a switch while another is paused drops the older one and names it', () => {
    const three = build(JOURNEYS_YAML.replace('journeys:\n', 'journeys:\n  extra:\n    when: The caller wants something extra.\n    goal: Do the extra.\n    actions: []\n'));
    const r = decideRoute(three, { ...inVisit, paused: 'extra' }, reading({ task: { note: 0.9, none: 0.1 }, drops: 0.1 }), ['extra', 'visit', 'note']);
    expect(r).toEqual({ outcome: 'switch', next: { ...root, active: 'note', paused: 'visit' }, droppedPaused: 'extra' });
  });
  it('active A, task the paused journey B: return, A paused', () => {
    const r = decideRoute(plain, { ...inVisit, paused: 'note' }, reading({ task: { note: 0.9, none: 0.1 }, drops: 0.1 }), open);
    expect(r).toEqual({ outcome: 'return', next: { ...root, active: 'note', paused: 'visit' } });
  });
  it('after phase, task A and again above the bar: again, working', () => {
    const j: JourneyState = { ...inVisit, phase: 'after', done: ['visit'] };
    expect(decideRoute(plain, j, reading({ task: { visit: 0.9, none: 0.1 }, again: 0.8 }), open)).toEqual({ outcome: 'again', next: { ...j, phase: 'working' } });
  });
  it('after phase, task A and again below the bar: carry', () => {
    const j: JourneyState = { ...inVisit, phase: 'after', done: ['visit'] };
    expect(decideRoute(plain, j, reading({ task: { visit: 0.9, none: 0.1 }, again: 0.59 }), open)).toEqual({ outcome: 'carry', next: j });
  });
  it('after phase, another journey: switch, the finished one is not paused', () => {
    const j: JourneyState = { ...inVisit, phase: 'after', done: ['visit'] };
    expect(decideRoute(plain, j, reading({ task: { note: 0.9, none: 0.1 } }), open)).toEqual({ outcome: 'switch', next: { active: 'note', phase: 'working', paused: null, done: ['visit'] } });
  });
  it('at the root with a journey set aside, choosing it again is a return: active, working, nothing set aside', () => {
    const j: JourneyState = { ...root, paused: 'note' };
    expect(decideRoute(plain, j, reading({ task: { note: 0.9, none: 0.1 } }), open)).toEqual({ outcome: 'return', next: { ...root, active: 'note' } });
    // Another journey from there starts, the set-aside one kept.
    expect(decideRoute(plain, j, reading({ task: { visit: 0.9, none: 0.1 } }), open)).toEqual({ outcome: 'start', next: { ...j, active: 'visit' } });
  });
  it('a journey done earlier that comes up again while not active starts fresh', () => {
    const j: JourneyState = { ...root, done: ['visit'] };
    expect(decideRoute(plain, j, reading({ task: { visit: 0.9, none: 0.1 } }), open)).toEqual({ outcome: 'start', next: { ...j, active: 'visit' } });
  });
  it('anything else carries', () => {
    expect(decideRoute(plain, inVisit, reading({ task: null, drops: 0.9 }), open)).toEqual({ outcome: 'carry', next: inVisit });
  });
});

describe('unclear turns', () => {
  const unclearOf = (n: number): JourneyState => ({ ...inVisit, unclear: n });
  const fit = (task: Record<string, number>, fits: number | null, extra: Partial<RouteReading> = {}): RouteReading => reading({ task, fits, drops: 0.1, ...extra });

  it('task has a question option, and fits is asked only in a working journey', () => {
    const q = routeQuestions(plain, root, anon).task!;
    if (q.type !== 'choice') throw new Error('choice');
    expect(q.criteria[QUESTION_TASK]).toBe("a question about the business or about this line: its hours, prices, where it is, what it fixes or doesn't, how things work, or whether this is a person or an automated line");
    expect(Object.keys(routeQuestions(plain, root, anon))).toEqual(['task']);
    expect(Object.keys(routeQuestions(plain, { ...inVisit, phase: 'after', done: ['visit'] }, anon))).not.toContain('fits');
    expect(routeQuestions(plain, inVisit, anon).fits).toMatchObject({ type: 'noul' });
    expect(routeQuestions(plain, inVisit, anon).fits!.instructions).toMatch(/anything to do with this task/);
  });
  it('readRoute reads fits', () => {
    expect(readRoute({ fits: { type: 'noul', noul: 0.3 } }).fits).toBe(0.3);
  });
  it('at the root, a question about the business is answered, not unclear', () => {
    const r = decideRoute(plain, { ...root, unclear: 2 }, reading({ task: { question: 0.7, visit: 0.2, none: 0.1 } }), open);
    expect(r).toEqual({ outcome: 'root', next: root });
    expect(isUnclear(r)).toBe(false);
  });
  it('at the root, a journey at 0.55 with the question at 0.45 (below the start bar, none not on top) is answered at the root, clear, the count reset', () => {
    const r = decideRoute(plain, { ...root, unclear: 2 }, reading({ task: { visit: 0.55, question: 0.45, none: 0.1 } }), open);
    expect(r).toEqual({ outcome: 'root', next: root });
    expect(isUnclear(r)).toBe(false);
  });
  it('at the root, none on top is unclear and counted', () => {
    const r = decideRoute(plain, root, reading({ task: { visit: 0.3, none: 0.7 } }), open);
    expect(isUnclear(r)).toBe(true);
    expect(r).toMatchObject({ outcome: 'root', next: { ...root, unclear: 1 } });
    expect(decideRoute(plain, { ...root, unclear: 1 }, reading({ task: { none: 0.9, visit: 0.1 } }), open).next.unclear).toBe(2);
  });
  it('a switch between journeys still uses switchAt, not startAt', () => {
    const r = decideRoute(plain, inVisit, fit({ note: 0.7, none: 0.3 }, 0.1), open);
    expect(r.outcome).toBe('switch');
    expect(isUnclear(r)).toBe(false);
  });
  it('a start from the root clears the count', () => {
    const r = decideRoute(plain, { ...root, unclear: 2 }, reading({ task: { visit: 0.9, none: 0.1 } }), open);
    expect(r).toEqual({ outcome: 'start', next: { ...root, active: 'visit' } });
  });
  it('in a working journey, a turn that does not fit and is no switch or question is unclear, counting on', () => {
    const r = decideRoute(plain, inVisit, fit({ none: 0.9, visit: 0.1 }, 0.2), open);
    expect(isUnclear(r)).toBe(true);
    expect(r).toEqual({ outcome: 'carry', unclear: true, next: { ...inVisit, unclear: 1 } });
    expect(decideRoute(plain, unclearOf(1), fit({ none: 0.9, visit: 0.1 }, 0.2), open).next.unclear).toBe(2);
  });
  it('in a working journey, fits exactly 0.5 fits; a question or a fitting turn clears the count', () => {
    expect(isUnclear(decideRoute(plain, inVisit, fit({ none: 0.9, visit: 0.1 }, 0.5), open))).toBe(false);
    const asked = decideRoute(plain, unclearOf(2), fit({ question: 0.8, none: 0.2 }, 0.1), open);
    expect(asked).toEqual({ outcome: 'carry', next: inVisit });
    expect(decideRoute(plain, unclearOf(2), fit({ visit: 0.9, none: 0.1 }, 0.9), open).next).toEqual(inVisit);
  });
  it('in a working journey, a drop is not unclear', () => {
    const r = decideRoute(plain, unclearOf(1), fit({ none: 0.9, visit: 0.1 }, 0.1, { drops: 0.9 }), open);
    expect(r).toEqual({ outcome: 'dropped', next: root });
  });
  it('in the after phase fits is not used: never unclear, and the count clears', () => {
    const j: JourneyState = { ...inVisit, phase: 'after', done: ['visit'], unclear: 1 };
    const r = decideRoute(plain, j, reading({ task: { none: 0.9, visit: 0.1 }, fits: 0.0 }), open);
    expect(isUnclear(r)).toBe(false);
    expect(r).toEqual({ outcome: 'carry', next: { ...inVisit, phase: 'after', done: ['visit'] } });
  });
  it('in a working journey, the active journey chosen as the task with fits below 0.5 is unclear', () => {
    const r = decideRoute(plain, inVisit, fit({ visit: 0.9, none: 0.1 }, 0.3), open);
    expect(r).toEqual({ outcome: 'carry', unclear: true, next: { ...inVisit, unclear: 1 } });
  });
  it('at the root, a journey below startAt with none on top is unclear', () => {
    const r = decideRoute(plain, root, reading({ task: { visit: 0.4, none: 0.6 } }), open);
    expect(r).toEqual({ outcome: 'root', unclear: true, next: { ...root, unclear: 1 } });
  });
  it('at the root, a journey set aside read between switchAt and startAt is not a return, and is clear', () => {
    const j: JourneyState = { ...root, paused: 'visit' };
    const r = decideRoute(plain, j, reading({ task: { visit: 0.7, none: 0.3 } }), open);
    expect(r).toEqual({ outcome: 'root', next: j });
  });
  it('a null reading starts the count again and is never unclear', () => {
    expect(decideRoute(plain, unclearOf(2), readRoute(null), open)).toEqual({ outcome: 'carry', next: inVisit });
    expect(isUnclear(decideRoute(plain, unclearOf(2), reading({ task: null, fits: 0 }), open))).toBe(false);
    expect(isUnclear(decideRoute(plain, inVisit, reading({ task: { none: 1 }, fits: null }), open))).toBe(false);
  });
});

describe('completeJourney', () => {
  it('a completing action puts the journey in its after phase and records it done', () => {
    expect(completeJourney(plain, inVisit, 'book')).toEqual({ active: 'visit', phase: 'after', paused: null, done: ['visit'] });
  });
  it('an action that does not complete it changes nothing', () => {
    expect(completeJourney(plain, inVisit, 'availability')).toEqual(inVisit);
    expect(completeJourney(plain, root, 'book')).toEqual(root);
  });
  it('a done journey is listed once per run, in order', () => {
    const j: JourneyState = { ...inVisit, done: ['note'] };
    expect(completeJourney(plain, j, 'book').done).toEqual(['note', 'visit']);
  });
});
