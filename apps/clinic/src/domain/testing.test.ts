import { describe, expect, it } from 'vitest';
import {
  buildQuestions, buildTurnState, FixtureStubClient, HeuristicStubClient, parseCorpus, slotContext,
  type CorpusEntry, type Session,
} from 'dialogwright';
import { clinicApp } from '../index';
import { rescheduleAtSummary, started, tc, TODAY } from '../testing/turns';

const choiceOf = (a: unknown) => (a as { choice: string }).choice;
const noulOf = (a: unknown) => (a as { noul: number }).noul;

/** What the heuristic stub answers to `text`, to the questions the line asks of `s`. */
async function ask(text: string, s: Session = started()) {
  const state = buildTurnState(s, { text, isFinal: true, dtmf: null }, 0);
  const questions = buildQuestions(s, slotContext(s, text, tc));
  const res = await new HeuristicStubClient({ todayIso: TODAY }).ask({ state: state as never, questions });
  expect(Object.keys(res.answers).sort()).toEqual(Object.keys(questions).sort());
  return res.answers;
}

describe('the clinic heuristics (App.testing.heuristics)', () => {
  it('guesses the intent from the clinic\'s keywords, the control intents after them', async () => {
    const top = async (text: string) => {
      const p = (await ask(text)).intent as unknown as { probabilities: Record<string, number> };
      return Object.entries(p.probabilities).sort((a, b) => b[1] - a[1])[0]![0];
    };
    expect(await top('I need to reschedule my appointment')).toBe('reschedule');
    expect(await top('I want to book an appointment')).toBe('schedule_new');
    expect(await top('cancel my visit')).toBe('cancel');
    expect(await top('confirm my visit')).toBe('confirm_appointment');
    expect(await top('how much do I owe')).toBe('billing');
    expect(await top('let me talk to a person')).toBe('agent');
  });

  it('reads the provider, the day and a window said together', async () => {
    const a = await ask('I need to reschedule with dr chen next week');
    expect(choiceOf(a.provider)).toBe('chen');
    expect(choiceOf(a.dateMode)).toBe('window');
    expect(choiceOf(a.dateWindow)).toBe('next_week');
    // "Tuesday of next week" names a day; the week only says which Tuesday.
    const b = await ask('move it to tuesday of next week');
    expect(choiceOf(b.dateMode)).toBe('weekday');
    expect(choiceOf(b.dateWeekday)).toBe('tuesday');
    expect(choiceOf(b.dateWeekdayQualifier)).toBe('next');
  });

  it('names a hedge between two providers at the hedged strength, which does not fill the slot', async () => {
    const a = await ask('either dr chen or dr cheng');
    expect((a.provider as unknown as { probabilities: Record<string, number> }).probabilities.chen).toBeLessThan(0.5);
  });

  it('reads a name after a marker, or a bare two-word name, and never a doctor\'s or a reason for calling', async () => {
    for (const text of ["it's Morgan Ellis", 'Morgan Ellis', 'my name is Morgan Ellis, member 5550 7788']) {
      const a = await ask(text);
      expect(noulOf(a.nameGiven), text).toBeGreaterThan(0.8);
      expect(choiceOf(a.nameSpan), text).toBe('morgan ellis');
    }
    for (const text of ['this is regarding a scheduling issue', 'this is dr chen calling', 'five five five zero seven seven eight eight']) {
      const a = await ask(text);
      expect(noulOf(a.nameGiven), text).toBeLessThan(0.2);
      expect(choiceOf(a.nameSpan), text).toBe('none');
    }
  });

  it('reads a birthday, and a year alone as the answer to the year question', async () => {
    const a = await ask('June fourteenth nineteen seventy five');
    expect(noulOf(a.dobGiven)).toBeGreaterThan(0.8);
    expect([choiceOf(a.dobMonth), choiceOf(a.dobDay), choiceOf(a.dobYear)]).toEqual(['june', '14', 'nineteen seventy five']);
    const spelled = await ask('the fourteenth of June, 1975');
    expect([choiceOf(spelled.dobDay), choiceOf(spelled.dobYear)]).toEqual(['14', '1975']);
    expect(noulOf((await ask('nineteen seventy five')).dobGiven)).toBeGreaterThan(0.8);
    // A birthday is not an appointment day, and a member ID is not a birth year.
    expect(choiceOf(a.dateMode)).toBe('none');
    expect(noulOf((await ask('five five five zero seven seven eight eight')).dobGiven)).toBeLessThan(0.2);
  });

  it('picks the eight-digit span of a member ID, spoken in words, groups or digits', async () => {
    for (const text of ['my member id is five five five zero seven seven eight eight', "it's 5550 7788", '5 5 5 0 7 7 8 8']) {
      const a = await ask(text);
      expect(noulOf(a.containsMemberId), text).toBeGreaterThan(0.8);
      expect(noulOf(a.memberIdComplete), text).toBeGreaterThan(0.8);
      expect(choiceOf(a.memberIdSpan), text).not.toBe('none');
    }
    expect(noulOf((await ask('five five five zero')).memberIdComplete)).toBeLessThan(0.5);
  });

  it('reads a part of the day, a time preference and what to change at a summary', async () => {
    const summary = rescheduleAtSummary().session;
    const part = async (text: string) => choiceOf((await ask(text, summary)).timeOfDay);
    expect(await part('first thing in the morning')).toBe('morning');
    expect(await part('sometime around lunchtime works')).toBe('midday');
    expect(await part('late morning')).toBe('midday');
    expect(await part('afternoon please')).toBe('afternoon');
    expect(await part('good morning')).toBe('none');
    const move = async (text: string) => choiceOf((await ask(text, summary)).timePreference);
    expect(await move('earlier')).toBe('earlier');
    expect(await move('later please')).toBe('later');
    expect(await move("that time doesn't work")).toBe('different');
    expect(await move('what are your hours')).toBe('none');
    const change = async (text: string) => choiceOf((await ask(text, summary)).changeSlot);
    expect(await change('no, the doctor is wrong')).toBe('provider');
    expect(await change('the day')).toBe('date');
    expect(await change('Thursday')).toBe('none');
  });

  it('reads whether the caller has the provider\'s name', async () => {
    const s = rescheduleAtSummary().session;
    const status = async (text: string) => choiceOf((await ask(text, s)).providerNameStatus);
    expect(await status("I don't know")).toBe('no_name');
    expect(await status('yes I do')).toBe('has_name');
    expect(await status('Dr. Kim')).toBe('neither');
  });
});

describe('the clinic corpus labels (App.testing.checkCorpusSlots, labeled)', () => {
  const entry = (over: Partial<CorpusEntry> & { text: string }): string => JSON.stringify({ id: 'x-1', intent: 'none', context: 'reschedule', prompted: 'dob', ...over });
  const entries = (...lines: Array<Partial<CorpusEntry> & { text: string }>): string => lines.map((l, i) => entry({ id: `e-${i}`, ...l })).join('\n');

  it('accepts labels the questions can offer', () => {
    expect(() => parseCorpus(entry({ text: 'June fourteenth nineteen seventy five', slots: { dob: { month: 'june', day: '14', year: 'nineteen seventy five' } } }), clinicApp)).not.toThrow();
    expect(() => parseCorpus(entry({ text: 'five five five zero seven seven eight eight', context: 'billing', prompted: 'memberId', slots: { memberId: { span: 'five five five zero seven seven eight eight', value: '55507788' } } }), clinicApp)).not.toThrow();
  });

  it('refuses a label no question could pick, naming the entry', () => {
    const bad = (e: string, message: RegExp) => expect(() => parseCorpus(e, clinicApp)).toThrow(message);
    bad(entry({ text: 'June 14th', slots: { dob: { month: 'jun', day: '14' } } }), /x-1: dob month "jun"/);
    bad(entry({ text: 'June 14th', slots: { dob: { month: 'june' } } }), /dob needs a month and day together/);
    bad(entry({ text: 'June 14th 1975', slots: { dob: { month: 'june', day: '14', year: 'ninety' } } }), /dob year span "ninety"/);
    bad(entry({ text: 'Morgan Ellis', prompted: 'name', slots: { name: 'Sam Lee' } }), /name span "Sam Lee"/);
    bad(entry({ text: 'Dr. Kim', prompted: 'provider', slots: { provider: 'lee' } }), /provider "lee" is not on the roster/);
    bad(entry({ text: 'five five five zero', context: 'billing', prompted: 'memberId', slots: { memberId: { span: 'five five five zero', value: '55507788' } } }), /not the span's digits/);
    bad(entry({ text: 'Tuesday', prompted: 'date', slots: { date: { mode: 'someday' } } }), /date mode "someday"/);
  });

  it('answers a question from the entry\'s own label, falling back to what the slots say', async () => {
    const corpus = parseCorpus(entries(
      { text: 'in the afternoon, with dr kim, I think', context: 'no_form', intent: 'schedule_new', prompted: undefined, slots: { provider: 'kim' }, labels: { timeOfDay: 'afternoon', providerUnsure: true } },
      { text: 'no idea', context: 'cancel', prompted: 'provider', labels: { providerNameStatus: 'no_name' } },
      { text: 'Dr. Chen', context: 'cancel', prompted: 'provider', slots: { provider: 'chen' } },
    ), clinicApp);
    const client = new FixtureStubClient(corpus, { sharpness: 0.9, fallback: new HeuristicStubClient({ todayIso: TODAY }) });
    const answers = async (text: string) => {
      const s = started();
      const questions = buildQuestions(s, slotContext(s, text, tc));
      return (await client.ask({ state: buildTurnState(s, { text, isFinal: true, dtmf: null }, 0) as never, questions })).answers;
    };
    const first = await answers('in the afternoon, with dr kim, I think');
    expect(choiceOf(first.timeOfDay)).toBe('afternoon');
    expect(noulOf(first.providerUnsure)).toBeGreaterThan(0.8);
    expect(choiceOf(first.provider)).toBe('kim');
    const second = await answers('no idea');
    expect(choiceOf(second.providerNameStatus)).toBe('no_name');
    expect(noulOf(second.providerUnsure)).toBeLessThan(0.1);
    const third = await answers('Dr. Chen');
    expect(choiceOf(third.providerNameStatus)).toBe('neither');
    expect(choiceOf(third.timeOfDay)).toBe('none');
  });
});
