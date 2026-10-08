import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { candidateWordSpans } from '../../core/spans';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { formatProblem } from '../../define/problems';
import { choice, noul } from '../../testing/answers';
import { testSlotContext } from '../../testing/slots';
import { runSlotConformance } from '../conformance/run';
import { buildSlot, defineSlot, slotTypeJsonSchema } from '../defineSlot';
import { nameType } from './index';
import { titleCase } from './display';

/** The `name` type: the conformance kit over its examples, then what the kit does not cover. */
runSlotConformance(nameType, { describe, it, locales: ['en-US', 'es'] });

const T = DEFAULT_THRESHOLDS;
const name = defineSlot('name', { type: 'name' });
const spanKeys = (slot: typeof name, text: string, id = 'nameSpan') => Object.keys((slot.questions(testSlotContext(text))[id] as { criteria: Record<string, string | null> }).criteria);
const heard = (span: string, p = 0.9, given = 0.95) => ({ nameGiven: noul(given), nameSpan: choice({ [span]: p, none: 1 - p }) });

describe('a name slot built from the defaults', () => {
  it('asks two questions, named after the slot, in the default words', () => {
    expect(name.questionIds).toEqual(['nameGiven', 'nameSpan']);
    expect(name.prompts).toEqual([]);
    const q = name.questions(testSlotContext('my name is Morgan Ellis'));
    expect(Object.keys(q)).toEqual(['nameGiven', 'nameSpan']);
    expect(q.nameGiven).toEqual({
      type: 'noul',
      instructions: 'Read asr.text. Does the caller state their own name, first name alone or first and last?',
      criteria: {
        true: "The caller gives their own name, as in my name is Anna Petrov, this is Sam, or Priya Raghunathan, including a correction to their own name just read back to them, as in no, it's Sam Lee",
        false: "No personal name, or a name that is not the caller's, such as the name of someone they are talking about",
      },
    });
    expect(q.nameSpan).toEqual({
      type: 'choice',
      instructions:
        "Read asr.text. Which of these spans is the caller's own full name as they say it, first and last when both are given? Do not include words such as my name is or this is, and do not choose anyone else's name. When `slots.name` is already set and the caller gives a different name for themselves, as in no, it's Sam Lee, choose that span. A single word can be the whole name, as in Prince. Choose none if no span is the caller's name.",
      criteria: {
        ...Object.fromEntries(candidateWordSpans('my name is Morgan Ellis').map((s) => [s, null])),
        none: "No span of asr.text is the caller's name, as when the caller only agrees, refuses, or names something other than themselves",
      },
    });
  });

  it('names the slot it belongs to in the span question', () => {
    const caller = defineSlot('caller', { type: 'name' });
    expect(caller.questions(testSlotContext('x')).callerSpan).toMatchObject({ instructions: expect.stringContaining('When `slots.caller` is already set') });
  });

  it('offers every word span of what the caller said, then none', () => {
    expect(spanKeys(name, 'my name is Morgan Ellis')).toEqual([...candidateWordSpans('my name is Morgan Ellis'), 'none']);
    expect(spanKeys(name, 'my name is Morgan Ellis')).toEqual(['morgan', 'morgan ellis', 'ellis', 'none']);
  });

  it('never lets a literal "none" word span collide with the sentinel', () => {
    expect(candidateWordSpans('none of your business')).toContain('none');
    const criteria = (name.questions(testSlotContext('none of your business')).nameSpan as { criteria: Record<string, string | null> }).criteria;
    expect(Object.keys(criteria).filter((k) => k === 'none')).toHaveLength(1);
    expect(criteria.none).toMatch(/caller/);
  });

  it('is detected, read back in the summary, kept as it is, handed over as its display, with no keypad', () => {
    expect(name).toMatchObject({ spokenConfirm: 'summary', detect: true });
    expect(name.redact).toBeUndefined();
    expect(name.handoff).toBeUndefined();
    expect(name.dtmf).toBeUndefined();
    expect(name.valueKind).toBeUndefined();
  });

  it('carries its type and its parsed options, defaults applied', () => {
    expect(name.type).toBe('name');
    expect(name.config).toEqual({ exclude: [], redact: 'none', handoff: 'display' });
    expect(Object.isFrozen(name.config)).toBe(true);
  });
});

describe('fill', () => {
  const said = 'my name is Morgan Ellis';

  it('fills the span, title-cased for display, with the span\'s own probability, silently', () => {
    expect(name.fill(heard('morgan ellis', 0.8), testSlotContext(said))).toEqual({
      kind: 'filled', value: 'morgan ellis', display: 'Morgan Ellis', confidence: 0.8, confirm: 'none',
    });
  });

  it('takes the confidence of the choice when the answer carries no probability for it', () => {
    const answer = { type: 'choice' as const, choice: 'morgan ellis', probabilities: {}, confidence: 0.7 };
    expect(name.fill({ nameGiven: noul(0.9), nameSpan: answer }, testSlotContext(said))).toMatchObject({ kind: 'filled', confidence: 0.7 });
  });

  it('accepts a single word', () => {
    expect(name.fill(heard('cher'), testSlotContext("it's Cher"))).toMatchObject({ kind: 'filled', value: 'cher', display: 'Cher' });
  });

  it('is absent below SLOT_DETECT and not below the threshold, reading it from the context', () => {
    const ctx = testSlotContext(said);
    expect(name.fill(heard('morgan ellis', 0.9, 0.2), ctx).kind).toBe('absent');
    expect(name.fill(heard('morgan ellis', 0.9, T.SLOT_DETECT - 0.01), ctx).kind).toBe('absent');
    expect(name.fill(heard('morgan ellis', 0.9, T.SLOT_DETECT), ctx).kind).toBe('filled');
    const strict = testSlotContext(said, { thresholds: { ...T, SLOT_DETECT: 0.99 } });
    expect(name.fill(heard('morgan ellis', 0.9, 0.95), strict).kind).toBe('absent');
    expect(name.fill({}, ctx).kind).toBe('absent');
  });

  it('is invalid, "no_span", when it is stated but none is chosen', () => {
    expect(name.fill({ nameGiven: noul(0.9), nameSpan: choice({ none: 0.9, x: 0.1 }) }, testSlotContext('x'))).toEqual({ kind: 'invalid', reason: 'no_span', raw: '' });
    expect(name.fill({ nameGiven: noul(0.9) }, testSlotContext('x'))).toEqual({ kind: 'invalid', reason: 'no_span', raw: '' });
  });

  it('collapses the whitespace of the span it fills', () => {
    const odd = { type: 'choice' as const, choice: ' morgan  ellis ', probabilities: { ' morgan  ellis ': 0.9 }, confidence: 0.9 };
    expect(name.fill({ nameGiven: noul(0.9), nameSpan: odd }, testSlotContext(said))).toMatchObject({ kind: 'filled', value: 'morgan ellis' });
  });

  it('refuses a span the question never offered, with the span as raw', () => {
    expect(name.fill(heard('ellis morgan'), testSlotContext(said))).toEqual({ kind: 'invalid', reason: 'no_span', raw: 'ellis morgan' });
    expect(name.fill(heard('someone else'), testSlotContext(said))).toMatchObject({ kind: 'invalid', reason: 'no_span' });
  });
});

describe('exclude', () => {
  const doctors = defineSlot('name', { type: 'name', exclude: ['dr', 'Doctor', 'chen', 'cheng'] });

  it('withholds every span holding an excluded word, in any case', () => {
    expect(candidateWordSpans('not Chen, Cheng')).toEqual(['not', 'not chen', 'not chen cheng', 'chen', 'chen cheng', 'cheng']);
    expect(spanKeys(doctors, 'not Chen, Cheng')).toEqual(['not', 'none']);
    const keys = spanKeys(doctors, 'this is Morgan Ellis, seeing Dr. Chen');
    expect(keys).toContain('morgan ellis');
    expect(keys.filter((k) => k.split(' ').some((w) => ['dr', 'doctor', 'chen'].includes(w)))).toEqual([]);
  });

  it('leaves a caller whose name holds none of them untouched', () => {
    const text = 'my name is Dana Whitfield';
    expect(spanKeys(doctors, text)).toEqual([...candidateWordSpans(text), 'none']);
  });

  it('matches whole words, not parts of one', () => {
    expect(spanKeys(doctors, 'this is Chenoweth Drummond')).toEqual(['chenoweth', 'chenoweth drummond', 'drummond', 'none']);
  });

  it('refuses a span answered anyway, as one built against other words can be', () => {
    expect(doctors.fill(heard('chen cheng', 0.8), testSlotContext('not Chen, Cheng'))).toEqual({ kind: 'invalid', reason: 'no_span', raw: 'chen cheng' });
    expect(doctors.fill(heard('dr chen', 0.8), testSlotContext('seeing Dr. Chen'))).toMatchObject({ kind: 'invalid', reason: 'no_span' });
    expect(name.fill(heard('dr chen', 0.8), testSlotContext('seeing Dr. Chen'))).toMatchObject({ kind: 'filled', value: 'dr chen' });
  });

  it('keeps the list as written in the configuration', () => {
    expect(doctors.config).toMatchObject({ exclude: ['dr', 'Doctor', 'chen', 'cheng'] });
  });

  it('takes a word of letters and digits and nothing else', () => {
    for (const bad of ['dr.', 'dr chen', '', "o'neil", 'chên']) {
      const r = buildSlot('name', { type: 'name', exclude: [bad] });
      expect(r.ok, bad).toBe(false);
      expect(!r.ok && r.problems.map((p) => p.path), bad).toEqual(['name.exclude[0]']);
    }
    const r = buildSlot('name', { type: 'name', exclude: ['dr.'] });
    expect(!r.ok && r.problems.map(formatProblem)).toEqual([
      '(code)  name.exclude[0]  "dr." must be a single word of letters and digits, as a span\'s words are  ->  write one word per entry, without spaces or punctuation ("dr", not "Dr." or "dr smith"); list each word of a longer name on its own',
    ]);
  });
});

describe('redact and handoff', () => {
  it('mask hides the name wherever it leaves the turn; verified hands over only whether the caller was verified', () => {
    const slot = defineSlot('name', { type: 'name', redact: 'mask', handoff: 'verified' });
    expect(slot).toMatchObject({ redact: 'mask', handoff: 'verified' });
    expect(slot.fill(heard('morgan ellis'), testSlotContext('morgan ellis'))).toMatchObject({ display: 'Morgan Ellis' });
  });

  it('refuses a rule it does not have', () => {
    const r = buildSlot('name', { type: 'name', redact: 'last4', handoff: 'last4' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems.map((p) => p.path).sort()).toEqual(['name.handoff', 'name.redact']);
  });
});

describe('the words and the ids', () => {
  it('text replaces any part word for word, and ids renames a question', () => {
    const slot = defineSlot('contact', {
      type: 'name',
      text: { given: 'Q1', givenTrue: 'yes', givenFalse: 'no', span: 'Q2', spanNone: 'nothing' },
      ids: { given: 'saysName', span: 'whichName' },
    });
    expect(slot.questionIds).toEqual(['saysName', 'whichName']);
    const q = slot.questions(testSlotContext('morgan'));
    expect(q.saysName).toEqual({ type: 'noul', instructions: 'Q1', criteria: { true: 'yes', false: 'no' } });
    expect(q.whichName).toEqual({ type: 'choice', instructions: 'Q2', criteria: { morgan: null, none: 'nothing' } });
    expect(slot.fill({ saysName: noul(0.9), whichName: choice({ morgan: 0.9, none: 0.1 }) }, testSlotContext('morgan'))).toMatchObject({ kind: 'filled', value: 'morgan' });
  });

  it('refuses an unknown part, an id the engine asks, and question text with a line break', () => {
    expect(buildSlot('name', { type: 'name', text: { family: 'x' } }).ok).toBe(false);
    const engine = buildSlot('name', { type: 'name', ids: { given: 'urgency' } });
    expect(!engine.ok && engine.problems.map((p) => p.path)).toEqual(['name.ids.given']);
    const lines = buildSlot('name', { type: 'name', text: { span: 'one\ntwo' } });
    expect(!lines.ok && lines.problems.map((p) => p.path)).toEqual(['name.text.span']);
  });
});

describe('display', () => {
  it('title-cases each run of letters, the same in every locale for now', () => {
    expect(titleCase('mary kate o neil')).toBe('Mary Kate O Neil');
    expect(titleCase('MORGAN ellis')).toBe('Morgan Ellis');
    expect(name.display('morgan ellis')).toBe('Morgan Ellis');
    expect(name.display('morgan ellis', 'es')).toBe('Morgan Ellis');
  });
});

describe('the docs', () => {
  it('the docs page names every option and every text part', () => {
    const readme = readFileSync(new URL('../../../../../docs/slots/name.md', import.meta.url), 'utf8');
    const options = Object.keys((slotTypeJsonSchema(nameType).properties ?? {}) as object).filter((k) => k !== 'type');
    expect(options.sort()).toEqual(['confirm', 'exclude', 'handoff', 'ids', 'listen', 'offer', 'offerAnswers', 'offerAt', 'redact', 'text']);
    for (const option of options) expect(readme, option).toContain(`\`${option}\``);
    for (const part of ['given', 'givenTrue', 'givenFalse', 'span', 'spanNone']) expect(readme, part).toContain(`\`text.${part}\``);
  });
});

describe('a name slot in Spanish (es, es-*)', () => {
  const name = defineSlot('name', { type: 'name', exclude: ['munoz'] });
  const plain = defineSlot('name', { type: 'name' });

  it('title-cases Unicode letters and keeps the particles inside a name in lower case', () => {
    expect(titleCase('maría josé muñoz de la cruz', 'es')).toBe('María José Muñoz de la Cruz');
    expect(titleCase('íñigo del valle y ortega', 'es-MX')).toBe('Íñigo del Valle y Ortega');
    expect(titleCase('de la fuente', 'es')).toBe('De la Fuente');
    // English, and no locale, as always
    expect(titleCase('maría josé muñoz de la cruz')).toBe('MaríA José MuñOz De La Cruz');
    expect(titleCase('mary kate o neil', 'en-US')).toBe('Mary Kate O Neil');
  });

  it('offers a compound surname as one span and fills it as said', () => {
    const said = 'me llamo María José Muñoz de la Cruz';
    const ctx = testSlotContext(said, { locale: 'es' });
    const span = plain.questions(ctx).nameSpan!;
    expect(span.type === 'choice' && Object.keys(span.criteria)).toContain('maría josé muñoz de la cruz');
    expect(plain.fill({ nameGiven: noul(0.95), nameSpan: choice({ 'maría josé muñoz de la cruz': 0.9, none: 0.1 }) }, ctx)).toEqual({
      kind: 'filled', value: 'maría josé muñoz de la cruz', display: 'María José Muñoz de la Cruz', confidence: 0.9, confirm: 'none',
    });
  });

  it('compares excluded words without accents in Spanish', () => {
    const ctx = testSlotContext('soy Ana Muñoz', { locale: 'es' });
    const span = name.questions(ctx).nameSpan!;
    expect(span.type === 'choice' && Object.keys(span.criteria)).toEqual(['ana', 'none']);
  });
});
