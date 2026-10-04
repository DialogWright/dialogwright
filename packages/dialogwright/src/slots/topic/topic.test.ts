import { describe, expect, it } from 'vitest';
import type { SlotContext } from '../../core/slots/types';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { formatProblem } from '../../define/problems';
import type { AnswerMap, ChoiceQuestion, QuestionMap } from '../../jev/types';
import { kbCatalog, topicCatalog } from '../../kb/catalog';
import type { KnowledgeBase, Nomination, TopicCatalog } from '../../kb/types';
import { choice, noul } from '../../testing/answers';
import { fixedRetriever, keywordRetriever } from '../../testing/retrievers';
import { testSlotContext } from '../../testing/slots';
import { runSlotConformance } from '../conformance/run';
import { buildSlot, defineSlot } from '../defineSlot';
import { defineSlots } from '../defineSlots';
import { topicType } from './index';

/** The `topic` type: the conformance kit over its examples, then what the kit does not cover. */
runSlotConformance(topicType, { describe, it, locales: ['en-US', 'es'] });

const T = DEFAULT_THRESHOLDS;
const CATALOG: TopicCatalog = {
  topics: [
    { id: 'opening_hours', title: 'Opening hours', titles: { es: 'Horario de apertura' } },
    { id: 'returns', title: 'Returns and refunds' },
    { id: 'parking', title: 'Parking' },
    { id: 'late_fees', title: 'Late fees' },
    { id: 'lost_cards', title: 'Lost cards' },
  ],
};
const nom = (topic: string, score = 1): Nomination => ({ topic, title: CATALOG.topics.find((t) => t.id === topic)?.title ?? topic, score, via: 'keyword' });
const ctx = (text = '', over: Partial<SlotContext> = {}) => testSlotContext(text, over);
const criteriaOf = (q: QuestionMap, id: string) => (q[id] as ChoiceQuestion).criteria;

const subject = defineSlot('subject', { type: 'topic' }, undefined, { catalog: CATALOG });

describe('a topic slot built from the defaults', () => {
  it('reads nominations, asks one question (the slot\'s id followed by Topic) and leads to the disambiguation line', () => {
    expect(subject.nominates).toBe(true);
    expect(subject.spokenConfirm).toBe('summary');
    expect(subject.questionIds).toEqual(['subjectTopic']);
    expect(subject.prompts).toEqual([{ id: 'disambiguate_subject', why: 'the caller could mean either of two topics and is asked which', vars: ['a', 'b'] }]);
    expect(subject.thresholds).toEqual(['SLOT_CHOICE_FILL']);
  });

  it('asks nothing when nothing was nominated, or retrieval did not run', () => {
    expect(subject.questions(ctx('when do you open'))).toEqual({});
    expect(subject.questions(ctx('when do you open', { nominated: [] }))).toEqual({});
  });

  it('offers the nominated topics best first, each by its title in lower case, then none', () => {
    expect(subject.questions(ctx('parking and hours', { nominated: [nom('parking', 3), nom('opening_hours', 2)] }))).toEqual({
      subjectTopic: {
        type: 'choice',
        instructions: 'Read asr.text. Which of these topics does the caller ask about? Choose none when they ask about none of them, or ask nothing.',
        criteria: { parking: 'Asks about parking', opening_hours: 'Asks about opening hours', none: 'Asks about none of these' },
      },
    });
  });

  it('offers each topic once, never one called none, and at most the cap: the knowledge base\'s, else 8', () => {
    const many = Array.from({ length: 12 }, (_, i) => nom(`topic_${i}`, 12 - i));
    expect(Object.keys(criteriaOf(subject.questions(ctx('x', { nominated: many })), 'subjectTopic'))).toEqual([...many.slice(0, 8).map((n) => n.topic), 'none']);
    const twice = [nom('parking'), nom('none'), nom('parking'), nom('returns')];
    expect(Object.keys(criteriaOf(subject.questions(ctx('x', { nominated: twice })), 'subjectTopic'))).toEqual(['parking', 'returns', 'none']);
    const capped = defineSlot('subject', { type: 'topic' }, undefined, { catalog: { ...CATALOG, cap: 3 } });
    expect(Object.keys(criteriaOf(capped.questions(ctx('x', { nominated: many })), 'subjectTopic'))).toHaveLength(4);
    const own = defineSlot('subject', { type: 'topic', cap: 2 }, undefined, { catalog: { ...CATALOG, cap: 3 } });
    expect(Object.keys(criteriaOf(own.questions(ctx('x', { nominated: many })), 'subjectTopic'))).toEqual(['topic_0', 'topic_1', 'none']);
  });

  it('says a topic by its title in lower case, in the locale\'s title when the knowledge gives one, and the value itself for an unknown topic', () => {
    expect(subject.display('opening_hours')).toBe('opening hours');
    expect(subject.display('opening_hours', 'en-US')).toBe('opening hours');
    expect(subject.display('opening_hours', 'es')).toBe('horario de apertura');
    expect(subject.display('opening_hours', 'es-MX')).toBe('horario de apertura');
    expect(subject.display('parking', 'es')).toBe('parking');
    expect(subject.display('Not_Known')).toBe('not_known');
    expect(defineSlot('subject', { type: 'topic' }).display('parking')).toBe('parking');
  });
});

describe('the fill', () => {
  const nominated = [nom('returns', 2), nom('late_fees', 1)];
  const c = (over: Partial<SlotContext> = {}) => ctx('can i bring it back late', { nominated, ...over });
  const fill = (answers: AnswerMap, over: Partial<SlotContext> = {}) => subject.fill(answers, c(over));

  it('fills an offered topic the model is sure of, with its title, never acknowledged', () => {
    expect(fill({ subjectTopic: choice({ late_fees: 0.8, returns: 0.1, none: 0.1 }) })).toEqual({ kind: 'filled', value: 'late_fees', display: 'late fees', confidence: 0.8, confirm: 'none' });
  });

  it('asks which of two offered topics the model cannot tell apart (within KB_TOPIC_MARGIN), from SLOT_CHOICE_CONFIRM up', () => {
    expect(fill({ subjectTopic: choice({ returns: 0.5, late_fees: 0.42, none: 0.08 }) })).toEqual({
      kind: 'disambiguate', a: { value: 'returns', display: 'returns and refunds' }, b: { value: 'late_fees', display: 'late fees' },
    });
    // Exactly the margin apart is apart enough; below SLOT_CHOICE_CONFIRM nothing was chosen.
    expect(fill({ subjectTopic: choice({ returns: 0.6, late_fees: 0.3, none: 0.1 }) }, { thresholds: { ...T, KB_TOPIC_MARGIN: 0.3 } })).toMatchObject({ kind: 'filled', value: 'returns' });
    expect(fill({ subjectTopic: choice({ returns: 0.44, late_fees: 0.43, none: 0.13 }) })).toEqual({ kind: 'absent' });
    // A rival that is not a topic it may fill is no rival.
    expect(fill({ subjectTopic: choice({ returns: 0.5, parking: 0.45, none: 0.05 }) })).toEqual({ kind: 'absent' });
    expect(fill({ subjectTopic: choice({ returns: 0.6, parking: 0.4 }) })).toMatchObject({ kind: 'filled', value: 'returns' });
  });

  it('fills only an offered topic by default, any topic of the knowledge with accept: catalog, never none or a label no topic has', () => {
    const answers = { subjectTopic: choice({ parking: 0.9, none: 0.1 }) };
    expect(fill(answers)).toEqual({ kind: 'absent' });
    expect(fill(answers, { prompted: true })).toEqual({ kind: 'invalid', reason: 'no_topic', raw: '' });
    const any = defineSlot('subject', { type: 'topic', accept: 'catalog' }, undefined, { catalog: CATALOG });
    expect(any.fill(answers, c())).toMatchObject({ kind: 'filled', value: 'parking', display: 'parking' });
    expect(any.fill({ subjectTopic: choice({ dental_plan: 0.9, none: 0.1 }) }, c())).toEqual({ kind: 'absent' });
    expect(any.fill({ subjectTopic: choice({ none: 0.9, parking: 0.1 }) }, c())).toEqual({ kind: 'absent' });
    // A topic beyond the cap was not offered.
    const capped = defineSlot('subject', { type: 'topic', cap: 1 }, undefined, { catalog: CATALOG });
    expect(capped.fill({ subjectTopic: choice({ late_fees: 0.9, none: 0.1 }) }, c())).toEqual({ kind: 'absent' });
  });

  it('without disambiguate reads the model\'s pick alone, at its own probability or the confidence', () => {
    const pick = defineSlot('subject', { type: 'topic', disambiguate: false }, undefined, { catalog: CATALOG });
    expect(pick.prompts).toEqual([]);
    const tied: AnswerMap = { subjectTopic: { type: 'choice', choice: 'late_fees', probabilities: { returns: 0.6, late_fees: 0.6 }, confidence: 0.6 } };
    expect(pick.fill(tied, c())).toMatchObject({ kind: 'filled', value: 'late_fees', confidence: 0.6 });
    const unlisted: AnswerMap = { subjectTopic: { type: 'choice', choice: 'returns', probabilities: { none: 0.3 }, confidence: 0.7 } };
    expect(pick.fill(unlisted, c())).toMatchObject({ kind: 'filled', value: 'returns', confidence: 0.7 });
    expect(pick.fill({ subjectTopic: choice({ returns: 0.54, none: 0.46 }) }, c())).toEqual({ kind: 'absent' });
    expect(pick.fill({ subjectTopic: choice({ returns: 0.55, none: 0.45 }) }, c())).toMatchObject({ kind: 'filled' });
  });

  it('reads nothing but a choice answer to its own question; fillAt names the threshold', () => {
    expect(fill({})).toEqual({ kind: 'absent' });
    expect(fill({ subjectTopic: noul(0.9) }, { prompted: true })).toEqual({ kind: 'invalid', reason: 'no_topic', raw: '' });
    expect(fill({ subjectTopic: choice({ returns: 0.5, none: 0.5 }) })).toEqual({ kind: 'absent' });
    const lax = defineSlot('subject', { type: 'topic', fillAt: 'SLOT_CHOICE_CONFIRM', missReason: 'no_subject' }, undefined, { catalog: CATALOG });
    expect(lax.thresholds).toEqual(['SLOT_CHOICE_CONFIRM']);
    expect(lax.fill({ subjectTopic: choice({ returns: 0.5, none: 0.5 }) }, c())).toMatchObject({ kind: 'filled', value: 'returns' });
    expect(lax.fill({}, c({ prompted: true }))).toEqual({ kind: 'invalid', reason: 'no_subject', raw: '' });
  });

  it('fills nothing it was not offered when retrieval did not run (no nominations on the context)', () => {
    expect(subject.fill({ subjectTopic: choice({ returns: 0.9, none: 0.1 }) }, ctx('back'))).toEqual({ kind: 'absent' });
  });
});

describe('its options', () => {
  it('keep an existing slot\'s words and id: instructions, none, the criterion and ids.choice', () => {
    const kept = defineSlot('helpTopic', {
      type: 'topic',
      criterion: 'Is about {title} ({topic})',
      text: { instructions: 'Which one?', none: 'Neither' },
      ids: { choice: 'helpTopic' },
    });
    expect(kept.questionIds).toEqual(['helpTopic']);
    expect(kept.questions(ctx('x', { nominated: [nom('parking')] }))).toEqual({
      helpTopic: { type: 'choice', instructions: 'Which one?', criteria: { parking: 'Is about Parking (parking)', none: 'Neither' } },
    });
  });

  it('refuse a criterion with a name or a filter it does not have, and a cap out of range', () => {
    const bad = buildSlot('subject', { type: 'topic', criterion: 'About {name|upper}', cap: 0 });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.problems.map(formatProblem)).toEqual([
      '(code)  subject.cap  "cap" Too small: expected number to be >=1  ->  use a value of at least 1',
      '(code)  subject.criterion  {name|upper} is not one of its variables; it may use {title}, {topic}  ->  use {title} or {topic}, with or without a filter; the filters are lower',
      '(code)  subject.criterion  {name|upper} uses the filter "upper", which is not one of "lower"  ->  use {title} or {topic}, with or without a filter; the filters are lower',
    ]);
  });
});

describe('its topics, from the app\'s knowledge', () => {
  const KB: KnowledgeBase = {
    settings: { action: 'lookUp', applies: {}, localeFallback: 'none', maxAnswerChars: 400, retrieval: { cap: 3 } },
    defaultLocale: 'en-US',
    topics: {
      opening_hours: { id: 'opening_hours', title: 'Opening hours', keywords: ['open', 'hours'], asks: [], risk: 'low', locales: { es: { title: 'Horario', keywords: [], asks: [] } } },
      parking: { id: 'parking', title: 'Parking', keywords: ['park', 'car'], asks: [], risk: 'low', locales: { es: { keywords: [], asks: [] } } },
    },
    passages: {},
    sources: {},
  };

  it('are a knowledge base\'s, in order, with their titles by locale and its cap; or the code\'s own topics', () => {
    expect(kbCatalog(KB)).toEqual({ topics: [{ id: 'opening_hours', title: 'Opening hours', titles: { es: 'Horario' } }, { id: 'parking', title: 'Parking' }], cap: 3 });
    expect(topicCatalog({ kb: KB })).toEqual(kbCatalog(KB));
    const retriever = fixedRetriever({});
    expect(topicCatalog({ topics: CATALOG.topics, retriever })).toEqual({ topics: CATALOG.topics });
  });

  it('reach a slots.yaml\'s topic slot through defineSlots', () => {
    const slots = defineSlots({ subject: { type: 'topic' } }, {}, undefined, { knowledge: { kb: KB } });
    expect(slots.subject!.display('opening_hours', 'es')).toBe('horario');
    const many = [nom('opening_hours'), nom('parking'), nom('returns'), nom('late_fees')];
    expect(Object.keys(criteriaOf(slots.subject!.questions(ctx('x', { nominated: many })), 'subjectTopic'))).toEqual(['opening_hours', 'parking', 'returns', 'none']);
  });
});

describe('the test retrievers', () => {
  it('fixedRetriever nominates exactly what it is given for the words, and nothing for other words', async () => {
    const r = fixedRetriever({ 'where do i park': ['parking', 'opening_hours'], hours: [nom('opening_hours', 5)] });
    expect(r.nominate({ text: 'where do i park', locale: 'en-US', todayIso: '2026-09-18' })).toEqual([
      { topic: 'parking', title: 'parking', score: 1, via: 'app' },
      { topic: 'opening_hours', title: 'opening_hours', score: 0.9, via: 'app' },
    ]);
    expect(r.nominate({ text: 'hours', locale: 'en-US', todayIso: '2026-09-18' })).toEqual([nom('opening_hours', 5)]);
    expect(r.nominate({ text: 'Where do I park', locale: 'en-US', todayIso: '2026-09-18' })).toEqual([]);
    expect(r.calls).toEqual(['where do i park', 'hours', 'Where do I park']);
  });

  it('keywordRetriever nominates by whole keywords, best first, ties in listed order, at most its cap', () => {
    const r = keywordRetriever([
      { id: 'opening_hours', title: 'Opening hours', keywords: ['open', 'hours'] },
      { id: 'parking', title: 'Parking', keywords: ['park', 'car park'] },
      { id: 'late_fees', title: 'Late fees', keywords: ['late', 'fee'] },
    ], { cap: 2 });
    const said = (text: string) => r.nominate({ text, locale: 'en-US', todayIso: '2026-09-18' });
    expect(said('Is the CAR PARK open?')).toEqual([
      { topic: 'parking', title: 'Parking', score: 2, via: 'keyword' },
      { topic: 'opening_hours', title: 'Opening hours', score: 1, via: 'keyword' },
    ]);
    expect(said('open late')).toEqual([
      { topic: 'opening_hours', title: 'Opening hours', score: 1, via: 'keyword' },
      { topic: 'late_fees', title: 'Late fees', score: 1, via: 'keyword' },
    ]);
    expect(said('parked lately')).toEqual([]);
    expect(r.id).toBe('keywords');
  });
});
