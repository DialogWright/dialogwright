import { describe, expect, it } from 'vitest';
import { VOICE_RELAY } from '../../channel/caps';
import { silenceEvent, speechEvent, startEvent } from '../../channel/events';
import { ANONYMOUS } from '../../gate/principal';
import { seedCorpusSession } from '../../harness-text/runner';
import { parseCorpus } from '../../jev/corpus';
import { FixtureStubClient } from '../../jev/fixtureStub';
import { HeuristicStubClient } from '../../jev/heuristicStub';
import { isChoice, noulValue, rankProbabilities, type Answer, type AnswerMap, type Question, type QuestionMap } from '../../jev/types';
import { choice, noul, score } from '../../testing/answers';
import { useTestkit } from '../../testing/apps';
import { testkitApp } from '../../testing/testkit';
import type { Ack } from '../fia';
import { buildQuestions, ENGINE_QUESTION_IDS } from '../questions';
import { newSession, type Session } from '../session';
import type { SlotSpec } from '../slots/types';
import { buildTurnState } from '../state';
import { DEFAULT_THRESHOLDS } from '../thresholds';
import { mockCodeVerifier } from '../tools';
import { resolve, slotContext, type TurnContext, type TurnResult } from '../turn';
import { registerApp } from './registry';
import type { App, FormDef } from './types';
import { validateApp } from './validate';

/**
 * App-defined perception questions (App.questions) and the form hooks that read their answers
 * (FormDef.onAnswers, onSummaryAnswer, keepsSlot), with corpus labels for them (CorpusEntry.labels),
 * on a minimal booking app: a visit on a day, at one of the day's times, which the caller may steer
 * with a part of the day said anywhere or an earlier/later at the summary. The cases come from the
 * turn tests of an earlier version of the clinic example (apps/clinic) for its daypart and offer
 * moves, made generic: where in the turn each hook runs, and what the engine does with its answer.
 */
useTestkit();

/** The day's times, two in the morning and two in the afternoon. */
const TIMES = ['9:00 AM', '10:30 AM', '1:00 PM', '3:30 PM'] as const;
const partOf = (t: string): string => (t.endsWith('AM') ? 'morning' : 'afternoon');

/** What the visit form keeps in the facts: the part of the day asked for, the time offered, and what the hooks saw. */
interface VisitFacts {
  part: string | null;
  index: number;
  /** Each onAnswers call, with the day slot's value at the time (the hook runs before the turn fills). */
  heard: Array<string | null>;
  /** onSummaryAnswer calls. */
  asked: number;
}
const factsOf = (s: Session): VisitFacts => s.facts as unknown as VisitFacts;

/** A choice answer's label, when the model is sure enough of one that is not none. */
function topOf(a: Answer | undefined): string | null {
  const [top] = isChoice(a) ? rankProbabilities(a.probabilities) : [];
  return top && top.label !== 'none' && top.p >= 0.6 ? top.label : null;
}

const PART_OF_DAY: Question = {
  type: 'choice',
  instructions: 'Read asr.text. Which part of the day does the caller want the visit in?',
  criteria: { morning: 'The morning', afternoon: 'The afternoon', none: 'Says nothing about the part of the day' },
};
const MOVE: Question = {
  type: 'choice',
  instructions: 'Read asr.text and node.promptJustPlayed. Does the caller ask for an earlier or a later time on the same day?',
  criteria: { earlier: 'An earlier time', later: 'A later time', none: 'Neither' },
};

const EDGE_EARLIER: Ack = { promptId: 'edge_earlier', vars: {} };
const EDGE_LATER: Ack = { promptId: 'edge_later', vars: {} };

/** The day: read from the words, with a side question of its own (whether the caller is unsure of it). */
const day: SlotSpec = {
  id: 'day',
  spokenConfirm: 'summary',
  questions: () => ({ dayUnsure: { type: 'noul', instructions: 'Read asr.text. Is the caller unsure which day they want?' } }),
  fill: (_answers, ctx) => {
    const m = /\b(tuesday|thursday)\b/.exec(ctx.text);
    return m ? { kind: 'filled', value: m[1]!, display: m[1]![0]!.toUpperCase() + m[1]!.slice(1), confidence: 0.95, confirm: 'none' } : { kind: 'absent' };
  },
  display: (v) => v,
};

const visit: FormDef = {
  slots: ['day'],
  summaryPromptId: 'confirm_visit',
  complete: ({ acks }) => ({ kind: 'said', acks: [...acks, { promptId: 'booked', vars: {} }] }),
  onAnswers: ({ s }, answers) => {
    const f = factsOf(s);
    f.heard.push(s.slots.day!.value);
    const part = topOf(answers.partOfDay);
    if (part !== null) f.part = part;
  },
  onSummaryAnswer: ({ s }, answers) => {
    const f = factsOf(s);
    f.asked += 1;
    const part = topOf(answers.partOfDay);
    if (part !== null) {
      const at = TIMES.findIndex((t) => partOf(t) === part);
      if (at !== f.index) {
        f.index = at;
        return { moved: true, acks: [] };
      }
    }
    const move = topOf(answers.move);
    if (move === 'earlier') {
      if (f.index === 0) return { moved: false, acks: [EDGE_EARLIER] };
      f.index -= 1;
      return { moved: true, acks: [] };
    }
    if (move === 'later') {
      if (f.index === TIMES.length - 1) return { moved: false, acks: [EDGE_LATER] };
      f.index += 1;
      return { moved: true, acks: [] };
    }
    return null;
  },
  // "Anything later that day?" names the day, and asks to keep it.
  keepsSlot: (answers, slot) => slot === 'day' && topOf(answers.move) !== null,
};

const visits: App = {
  id: 'visits',
  intents: {
    agent: { criteria: 'Asks for a person', label: 'a person', kind: 'control' },
    repeat_prompt: { criteria: 'Asks to hear that again', label: 'repeat', kind: 'control' },
    visit: { criteria: 'Wants to book a visit', label: 'book a visit', kind: 'form' },
    cancel: { criteria: 'Wants to cancel a visit', label: 'cancel a visit', kind: 'form' },
    other: { criteria: 'Anything else', label: 'something else', kind: 'control' },
    none: { criteria: 'No request', label: 'nothing', kind: 'control' },
  },
  menu: [{ digit: '1', intent: 'visit' }, { digit: '2', intent: 'cancel' }],
  forms: {
    visit,
    // The same summary with none of the hooks: the engine's own path throughout.
    cancel: { slots: ['day'], summaryPromptId: 'confirm_cancel', complete: ({ acks }) => ({ kind: 'said', acks: [...acks, { promptId: 'cancelled', vars: {} }] }) },
  },
  slots: { day },
  tools: {},
  policy: { toolLevel: {}, purposeLevel: {}, rulesFor: {}, serviceFields: {}, confirmedFields: [], maxAttempts: 3, subjects: {} },
  facts: { initial: () => ({ part: null, index: 0, heard: [], asked: 0 }), clone: (f) => structuredClone(f) },
  systems: () => ({ sys: null, lookups: { ownerOf: () => null, scopeOf: () => [] } }),
  // A part of the day on the opener or anywhere in a visit; earlier or later only at its summary.
  questions: (s) => {
    const q: QuestionMap = {};
    if (s.form === null || s.form === 'visit') q.partOfDay = PART_OF_DAY;
    if (s.pendingConfirmation?.target === 'form' && s.pendingConfirmation.form === 'visit') q.move = MOVE;
    return q;
  },
  prompts: {
    manifest: {
      ...testkitApp.prompts.manifest,
      ask_day: { text: 'Which day works for you?', interruptible: true },
      ask_day_retry: { text: 'Sorry, which day?', interruptible: true },
      confirm_visit: { text: 'A visit on {day}. Is that right?', interruptible: true },
      confirm_cancel: { text: 'Cancel your visit on {day}. Is that right?', interruptible: true },
      edge_earlier: { text: "That's the earliest time that day.", interruptible: false },
      edge_later: { text: "That's the latest time that day.", interruptible: false },
      booked: { text: 'You are booked.', interruptible: false },
      cancelled: { text: 'Your visit is cancelled.', interruptible: false },
    },
    tags: {},
  },
  testing: { seed: { caller: () => ANONYMOUS, placeholders: { day: { value: 'tuesday', display: 'Tuesday' } } } },
};

registerApp(visits);

const tc: TurnContext = { nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...visits.systems(), codes: mockCodeVerifier } };

function answers(over: AnswerMap = {}): AnswerMap {
  return {
    addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
    rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05),
    frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }),
    intent: choice({ none: 0.9, other: 0.1 }),
    ...over,
  };
}

const ANSWERING = choice({ answering: 0.95, adding: 0.03, replacing: 0.02 });
const NO_CHANGE = choice({ day: 0.02, none: 0.98 });
const LATER = choice({ later: 0.9, earlier: 0.02, none: 0.08 });
const EARLIER = choice({ earlier: 0.9, later: 0.02, none: 0.08 });
const MORNING = choice({ morning: 0.9, afternoon: 0.02, none: 0.08 });
const AFTERNOON = choice({ afternoon: 0.9, morning: 0.02, none: 0.08 });

const say = (s: Session, text: string, over: AnswerMap = {}, final = true): TurnResult => resolve(s, speechEvent(text, final), answers(over), tc);
const started = (): Session => resolve(newSession('v', 0, VOICE_RELAY, ANONYMOUS, 'visits'), startEvent(), null, tc).session;
const inVisit = (): Session => say(started(), 'i want to book a visit', { intent: choice({ visit: 0.95, none: 0.05 }) }).session;
const BOOK_TUESDAY = { intent: choice({ visit: 0.95, none: 0.05 }) };
/** At the visit's summary, its day filled on the opener. */
const atSummary = (): TurnResult => say(started(), 'book a visit on tuesday', BOOK_TUESDAY);
/** At the summary, an answer that is neither a yes nor a clear no: the unanswered path. */
const unanswered = (r: TurnResult, text: string, over: AnswerMap): TurnResult =>
  say(r.session, text, { intentChange: ANSWERING, confirmsYes: noul(0.05), confirmsNo: noul(0.3), changeSlot: NO_CHANGE, ...over });
/** The same with a clear no: the rejected path. */
const declined = (r: TurnResult, text: string, over: AnswerMap): TurnResult =>
  say(r.session, text, { intentChange: ANSWERING, confirmsYes: noul(0.05), confirmsNo: noul(0.9), changeSlot: NO_CHANGE, ...over });
const indexAt = (r: TurnResult): number => factsOf(r.session).index;

describe('App.questions', () => {
  it('is a valid app', () => {
    expect(() => validateApp(visits)).not.toThrow();
  });

  it('asks its questions only where the app says, after the engine\'s and the slots\'', () => {
    const q = (s: Session) => Object.keys(buildQuestions(s, slotContext(s, 'hello', tc)));
    const opener = q(started());
    expect(opener).toContain('partOfDay');
    expect(opener).not.toContain('move');
    expect(opener.at(-1)).toBe('partOfDay');
    const form = q(inVisit());
    expect(form).toContain('partOfDay');
    expect(form).not.toContain('move');
    const summary = q(atSummary().session);
    expect(summary.slice(-2)).toEqual(['partOfDay', 'move']);
    expect(summary).toEqual(expect.arrayContaining(['confirmsYes', 'changeSlot', 'dayUnsure']));
    const cancel = q(say(started(), 'cancel my visit on tuesday', { intent: choice({ cancel: 0.95, none: 0.05 }) }).session);
    expect(cancel).not.toContain('partOfDay');
    expect(cancel).not.toContain('move');
  });

  it('adds nothing for an app without them', () => {
    expect(testkitApp.questions).toBeUndefined();
    const s = newSession('t', 0, VOICE_RELAY);
    const q = buildQuestions(s, slotContext(s, 'hello', tc));
    expect(Object.keys(q).filter((id) => id === 'partOfDay' || id === 'move')).toEqual([]);
  });

  it('refuses a question id the engine or a slot asks, even where the engine would not ask it', () => {
    const clash = (own: QuestionMap): App => ({ ...visits, id: `clash-${Object.keys(own)[0]}`, questions: () => own });
    for (const app of [clash({ confirmsYes: PART_OF_DAY }), clash({ manipulation: PART_OF_DAY }), clash({ dayUnsure: PART_OF_DAY })]) {
      registerApp(app);
      const s = newSession('c', 0, VOICE_RELAY, ANONYMOUS, app.id);
      expect(() => buildQuestions(s, slotContext(s, 'hello', tc))).toThrow(new RegExp(`app "${app.id}": its question "${Object.keys(app.questions!(s, slotContext(s, '', tc)))[0]}" is one the engine or a slot asks`));
    }
    expect(ENGINE_QUESTION_IDS).toEqual(expect.arrayContaining(['intent', 'confirmsYes', 'confirmsNo', 'intentChange', 'secondIntent', 'changeSlot', 'menuNumberSaid', 'manipulation']));
  });
});

describe('FormDef.onAnswers: where the form hears a turn', () => {
  it('hears the opener it is entered on, before the opener fills its slots', () => {
    const r = say(started(), 'book a visit on tuesday in the afternoon', { ...BOOK_TUESDAY, partOfDay: AFTERNOON });
    expect(r.session.form).toBe('visit');
    expect(r.session.slots.day!.value).toBe('tuesday');
    // Once, as it was entered (no form was open before), and before the day filled.
    expect(factsOf(r.session)).toMatchObject({ part: 'afternoon', heard: [null] });
  });

  it('keeps the opener\'s part of the day through an explicit intent check, and a yes that names one wins', () => {
    const opener = { intent: choice({ visit: 0.9, none: 0.1 }), intentTentative: noul(0.9), partOfDay: MORNING };
    const asked = say(started(), 'maybe book a visit in the morning', opener);
    expect(asked.decision).toMatchObject({ promptId: 'confirm_intent_explicit' });
    expect(factsOf(asked.session).heard).toEqual([]);
    const plain = say(asked.session, 'yes', { confirmsYes: noul(0.9), confirmsNo: noul(0.1) });
    expect(plain.session.form).toBe('visit');
    // The opener's answers, then the yes's own: twice, both on entry.
    expect(factsOf(plain.session)).toMatchObject({ part: 'morning', heard: [null, null] });
    const named = say(asked.session, 'yes, in the afternoon', { confirmsYes: noul(0.9), confirmsNo: noul(0.1), partOfDay: AFTERNOON });
    expect(named.session.form).toBe('visit');
    expect(factsOf(named.session).part).toBe('afternoon');
  });

  it('takes nothing from side speech, a held partial, or words that could not be made out', () => {
    const s = inVisit();
    expect(factsOf(s).heard).toEqual([null]);
    const aside = say(s, 'honey, the afternoon is no good', { addressedToSystem: noul(0.1), partOfDay: AFTERNOON });
    expect(aside.decision).toEqual({ kind: 'ignore' });
    const held = say(s, 'the after', { utteranceComplete: noul(0.2), partOfDay: AFTERNOON }, false);
    expect(held.decision).toEqual({ kind: 'hold' });
    const garbled = say(s, 'mm the aft', { intelligible: noul(0.1), partOfDay: AFTERNOON });
    expect(garbled.verdict?.kind).toBe('nomatch');
    for (const r of [aside, held, garbled]) expect(factsOf(r.session)).toMatchObject({ part: null, heard: [null] });
  });

  it('keeps a part of the day said mid-form, hearing the turn once and before it fills', () => {
    const r = say(inVisit(), 'tuesday, afternoons are best', { intentChange: ANSWERING, partOfDay: AFTERNOON });
    expect(r.session.slots.day!.value).toBe('tuesday');
    expect(factsOf(r.session)).toMatchObject({ part: 'afternoon', heard: [null, null] });
  });

  it('is not reached by silence, the keypad or an app\'s form without the hook', () => {
    const s = inVisit();
    const silent = resolve(s, silenceEvent(), null, tc);
    expect(factsOf(silent.session).heard).toEqual([null]);
    const cancel = say(started(), 'cancel my visit on tuesday in the morning', { intent: choice({ cancel: 0.95, none: 0.05 }), partOfDay: MORNING });
    expect(cancel.session.form).toBe('cancel');
    expect(factsOf(cancel.session)).toMatchObject({ part: null, heard: [] });
  });
});

describe('FormDef.onSummaryAnswer: moving what the summary offers', () => {
  it('moves later and earlier one step at a time, re-reading the summary re-armed (no answer to it)', () => {
    let r = unanswered(atSummary(), 'anything later', { move: LATER });
    expect(r.verdict?.kind).toBe('confirm_unanswered');
    expect(indexAt(r)).toBe(1);
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_visit', acks: [] });
    expect(r.session.pendingConfirmation).toMatchObject({ target: 'form', form: 'visit', attempts: 0 });
    r = unanswered(r, 'earlier please', { move: EARLIER });
    expect(indexAt(r)).toBe(0);
    expect(r.session.pendingConfirmation).toMatchObject({ attempts: 0 });
  });

  it('moves on a clear no as well, with no change question', () => {
    const r = declined(atSummary(), 'no, later', { move: LATER });
    expect(r.verdict?.kind).toBe('rejected');
    expect(indexAt(r)).toBe(1);
    expect(r.decision).toMatchObject({ promptId: 'confirm_visit' });
    expect(r.session.pendingConfirmation).toMatchObject({ target: 'form', attempts: 0 });
    expect(r.session.pendingConfirmation).not.toHaveProperty('askedChange');
  });

  it('says so at an edge and counts the turn on the summary ladder', () => {
    let r = unanswered(atSummary(), 'earlier', { move: EARLIER });
    expect(indexAt(r)).toBe(0);
    expect(r.decision).toMatchObject({ promptId: 'confirm_visit', acks: [EDGE_EARLIER] });
    expect(r.session.pendingConfirmation).toMatchObject({ target: 'form', attempts: 1 });
    r = unanswered(r, 'earlier', { move: EARLIER });
    expect(r.decision).toMatchObject({ promptId: 'confirm_dtmf' });
  });

  it('at an edge on a clear no, reads the summary again after the line rather than asking what to change, and counts it', () => {
    const r = declined(atSummary(), 'no, earlier', { move: EARLIER });
    expect(r.decision).toMatchObject({ promptId: 'confirm_visit', acks: [EDGE_EARLIER] });
    expect(r.session.pendingConfirmation).toMatchObject({ attempts: 1 });
    expect(r.session.pendingConfirmation).not.toHaveProperty('askedChange');
  });

  it('does not count an edge on a turn that added a request', () => {
    const r = unanswered(atSummary(), 'earlier, and can i also cancel one', {
      move: EARLIER, intentChange: choice({ adding: 0.9, answering: 0.05, replacing: 0.05 }), intent: choice({ cancel: 0.9, none: 0.1 }),
    });
    expect(r.verdict).toMatchObject({ kind: 'confirm_unanswered', queue: 'cancel' });
    expect(r.decision).toMatchObject({ promptId: 'confirm_visit', acks: [{ promptId: 'ack_queued' }, EDGE_EARLIER] });
    expect(r.session.pendingConfirmation).toMatchObject({ attempts: 0 });
  });

  it('moves to a part of the day named at the summary, which onAnswers has already kept', () => {
    const r = declined(atSummary(), 'no, the afternoon', { partOfDay: AFTERNOON });
    expect(factsOf(r.session).part).toBe('afternoon');
    expect(partOf(TIMES[indexAt(r)]!)).toBe('afternoon');
    expect(r.session.pendingConfirmation).toMatchObject({ attempts: 0 });
  });

  it('leaves the turn to the engine when the form does not move: a bare no asks what to change, no answer re-asks', () => {
    const no = declined(atSummary(), 'no', {});
    expect(factsOf(no.session).asked).toBe(1);
    expect(no.decision).toMatchObject({ promptId: 'ask_change' });
    const hmm = unanswered(atSummary(), 'hmm', {});
    expect(factsOf(hmm.session).asked).toBe(1);
    expect(hmm.decision).toMatchObject({ promptId: 'confirm_visit', acks: [] });
    expect(hmm.session.pendingConfirmation).toMatchObject({ attempts: 1 });
  });

  it('is not asked about a yes, or a correction that changed a slot', () => {
    const yes = say(atSummary().session, 'yes, later', { intentChange: ANSWERING, confirmsYes: noul(0.9), confirmsNo: noul(0.05), changeSlot: NO_CHANGE, move: LATER });
    expect(yes.decision).toMatchObject({ kind: 'prompt', promptId: 'anything_else' });
    expect(factsOf(yes.session).asked).toBe(0);
    const corrected = declined(atSummary(), 'no, thursday, later', { move: LATER });
    expect(corrected.session.slots.day!.value).toBe('thursday');
    expect(factsOf(corrected.session)).toMatchObject({ asked: 0, index: 0 });
    expect(corrected.decision).toMatchObject({ promptId: 'confirm_visit', vars: { day: 'Thursday' } });
  });

  it('leaves a summary without the hook on the engine\'s path', () => {
    const at = say(started(), 'cancel my visit on tuesday', { intent: choice({ cancel: 0.95, none: 0.05 }) });
    const r = unanswered(at, 'later', { move: LATER });
    expect(r.decision).toMatchObject({ promptId: 'confirm_cancel' });
    expect(r.session.pendingConfirmation).toMatchObject({ attempts: 1 });
  });
});

describe('FormDef.keepsSlot: a time move that names the day', () => {
  it('keeps the day and moves the time, the changeSlot row saying kept', () => {
    const r = unanswered(atSummary(), 'do you have anything later that day', { changeSlot: choice({ day: 0.9, none: 0.1 }), move: LATER });
    const row = r.rows.find((x) => x.gate === 'changeSlot');
    expect(row).toMatchObject({ outcome: 'kept', passed: false, decided: false });
    expect(r.verdict?.kind).toBe('confirm_unanswered');
    expect(r.session.slots.day!.value).toBe('tuesday');
    expect(indexAt(r)).toBe(1);
    expect(r.decision).toMatchObject({ promptId: 'confirm_visit' });
  });

  it('reopens the day when the form does not keep it, or has no hook', () => {
    const r = unanswered(atSummary(), 'the day is wrong', { changeSlot: choice({ day: 0.9, none: 0.1 }) });
    expect(r.verdict).toMatchObject({ kind: 'change_slot', slot: 'day' });
    expect(r.decision).toMatchObject({ promptId: 'ask_day' });
    const at = say(started(), 'cancel my visit on tuesday', { intent: choice({ cancel: 0.95, none: 0.05 }) });
    const c = unanswered(at, 'anything later that day', { changeSlot: choice({ day: 0.9, none: 0.1 }), move: LATER });
    expect(c.verdict).toMatchObject({ kind: 'change_slot', slot: 'day' });
  });
});

describe('CorpusEntry.labels', () => {
  const line = (e: object) => JSON.stringify(e);

  it('reads labels for non-engine questions, and refuses an engine question or a value that is not a label', () => {
    const [e] = parseCorpus(line({ id: 'v-1', text: 'tuesday afternoon', intent: 'visit', context: 'no_form', labels: { partOfDay: 'afternoon', dayUnsure: false } }), visits);
    expect(e!.labels).toEqual({ partOfDay: 'afternoon', dayUnsure: false });
    const bad = (labels: unknown) => () => parseCorpus(line({ id: 'v-2', text: 'tuesday', intent: 'visit', context: 'no_form', labels }), visits);
    expect(bad({ confirmsYes: true })).toThrow(/corpus v-2: labels names the engine's question confirmsYes; use the entry's own field or an answers override/);
    expect(bad({ intent: 'visit' })).toThrow(/engine's question intent/);
    expect(bad({ partOfDay: 3 })).toThrow(/corpus v-2: label for partOfDay must be a question's label or true or false/);
    expect(bad({ partOfDay: '' })).toThrow(/label for partOfDay/);
    expect(bad(['afternoon'])).toThrow(/corpus v-2: labels must be an object of question labels/);
  });

  /** The questions a session is asked on `text`, as the fixture stub receives them. */
  const request = (s: Session, text: string) => ({ state: buildTurnState(s, { text, isFinal: true, dtmf: null }, 0) as never, questions: buildQuestions(s, slotContext(s, text, tc)) });
  const corpus = parseCorpus([
    line({ id: 'v-open', text: 'book a visit on tuesday afternoon', intent: 'visit', context: 'no_form', labels: { partOfDay: 'afternoon', dayUnsure: true } }),
    line({ id: 'v-later', text: 'anything later', intent: 'none', context: 'confirm_visit', confirm: 'unanswered', labels: { move: 'later' } }),
    line({ id: 'v-bad', text: 'mornings please', intent: 'none', context: 'no_form', labels: { partOfDay: 'evening' } }),
    line({ id: 'v-type', text: 'not sure which day', intent: 'none', context: 'no_form', labels: { dayUnsure: 'yes' } }),
  ].join('\n'), visits);
  const stub = new FixtureStubClient(corpus, { sharpness: 0.9, fallback: new HeuristicStubClient(), app: visits });

  it('answers a choice with its label, a yes-or-no with 0.9 or 0.05, and leaves the rest to the generic answers', async () => {
    const s = started();
    const { answers: a } = await stub.ask(request(s, 'book a visit on tuesday afternoon'));
    expect(topOf(a.partOfDay)).toBe('afternoon');
    expect(noulValue(a, 'dayUnsure')).toBe(0.9);
    expect(topOf(a.intent)).toBe('visit');
    const quiet = parseCorpus(line({ id: 'v-q', text: 'book a visit', intent: 'visit', context: 'no_form', labels: { dayUnsure: false } }), visits);
    const { answers: b } = await new FixtureStubClient(quiet, { sharpness: 0.9, fallback: new HeuristicStubClient(), app: visits }).ask(request(s, 'book a visit'));
    expect(noulValue(b, 'dayUnsure')).toBe(0.05);
    expect(topOf(b.partOfDay)).toBeNull();
  });

  it('throws, naming the entry, on a label the question cannot give', async () => {
    const s = started();
    await expect(stub.ask(request(s, 'mornings please'))).rejects.toThrow(/corpus v-bad: label "evening" for partOfDay is not one the question offers \(morning, afternoon, none\)/);
    await expect(stub.ask(request(s, 'not sure which day'))).rejects.toThrow(/corpus v-type: label for dayUnsure must be true or false, not "yes"/);
  });

  it('feeds a seeded summary\'s turn: the label moves the offer', async () => {
    const entry = corpus.find((e) => e.id === 'v-later')!;
    const s = seedCorpusSession(newSession('v-later', 0, VOICE_RELAY, ANONYMOUS, 'visits'), entry, { thresholds: tc.thresholds, todayIso: tc.todayIso, tools: tc.tools });
    expect(s.pendingConfirmation).toMatchObject({ target: 'form', form: 'visit' });
    const { answers: a } = await stub.ask(request(s, entry.text));
    expect(topOf(a.move)).toBe('later');
    const r = resolve(s, speechEvent(entry.text), a, tc);
    expect(r.verdict?.kind).toBe('confirm_unanswered');
    expect(indexAt(r)).toBe(1);
    expect(r.decision).toMatchObject({ promptId: 'confirm_visit' });
  });
});
