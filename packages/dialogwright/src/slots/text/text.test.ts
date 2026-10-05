import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { formatProblem } from '../../define/problems';
import { choice, noul } from '../../testing/answers';
import { shadowSlot } from '../../testing/shadowSlot';
import { testSlotContext } from '../../testing/slots';
import { missingNoteSlot } from '../../testing/testkit/oracles/missingNote';
import { runSlotConformance } from '../conformance/run';
import { buildSlot, defineSlot, isSlotConfigError, slotTypeJsonSchema } from '../defineSlot';
import { redactCall } from '../../core/recording';
import { emptySlot } from '../../core/session';
import { redactRecordSlots } from '../../trace/redact';
import type { TraceRecord } from '../../trace/types';
import { MAX_PICK_CANDIDATES, PICK_WORDS, pickCandidates, pickWordsFor, textType } from './index';

/** The `text` type: the conformance kit over its examples, then what the kit does not cover. */
runSlotConformance(textType, { describe, it, locales: ['en-US', 'es'] });

const note = defineSlot('note', { type: 'text', what: 'a note for the courier' });
const heard = (p: number) => ({ noteGiven: noul(p) });

describe('a text slot built from the defaults', () => {
  it('asks one yes-or-no question, named after the slot, in the default words', () => {
    expect(note.questionIds).toEqual(['noteGiven']);
    expect(note.prompts).toEqual([]);
    expect(note.questions(testSlotContext('hello'))).toEqual({
      noteGiven: {
        type: 'noul',
        instructions: 'Read asr.text. Does the caller give a note for the courier? A request alone is not a note for the courier.',
      },
    });
  });

  it('adds the instructions after the default question', () => {
    const slot = defineSlot('note', { type: 'text', what: 'a note for the courier', instructions: 'Count where to leave the parcel.' });
    expect(slot.questions(testSlotContext('')).noteGiven?.instructions).toBe(
      'Read asr.text. Does the caller give a note for the courier? A request alone is not a note for the courier. Count where to leave the parcel.',
    );
  });

  it('is said in the summary only, detected, redacted by length, with no keypad', () => {
    expect(note.spokenConfirm).toBe('summary');
    expect(note.detect).toBe(true);
    expect(note.redact).toBe('length');
    expect(note.dtmf).toBeUndefined();
    expect(note.handoff).toBeUndefined();
  });

  it('carries its type and its parsed options, defaults applied', () => {
    expect(note.type).toBe('text');
    expect(note.config).toEqual({ what: 'a note for the courier', maxLength: 500, say: 'your description', keep: 'first-unless-prompted', redact: 'length' });
    expect(Object.isFrozen(note.config)).toBe(true);
  });

  it('fills with the words, trimmed, at SLOT_DETECT and not below it', () => {
    const t = DEFAULT_THRESHOLDS.SLOT_DETECT;
    expect(note.fill(heard(t), testSlotContext('  by the gate  '))).toEqual({ kind: 'filled', value: 'by the gate', display: 'your description', confidence: t, confirm: 'none' });
    expect(note.fill(heard(t - 0.01), testSlotContext('by the gate'))).toEqual({ kind: 'absent' });
  });

  it('reads SLOT_DETECT from the context, so an override moves it', () => {
    const ctx = testSlotContext('by the gate', { thresholds: { ...DEFAULT_THRESHOLDS, SLOT_DETECT: 0.95 } });
    expect(note.fill(heard(0.9), ctx).kind).toBe('absent');
  });
});

describe('keep', () => {
  const onFile = { current: 'by the gate' };
  it('first-unless-prompted: an aside keeps the value on file, a re-ask replaces it', () => {
    expect(note.fill(heard(0.9), testSlotContext('and ring twice', onFile)).kind).toBe('absent');
    expect(note.fill(heard(0.9), testSlotContext('ring twice', { ...onFile, prompted: true }))).toMatchObject({ kind: 'filled', value: 'ring twice' });
  });

  it('first: the value on file is never replaced, even when asked for again', () => {
    const first = defineSlot('note', { type: 'text', what: 'a note for the courier', keep: 'first' });
    expect(first.fill(heard(0.9), testSlotContext('ring twice', { ...onFile, prompted: true })).kind).toBe('absent');
    expect(first.fill(heard(0.9), testSlotContext('ring twice', { prompted: true })).kind).toBe('filled');
  });
});

describe('the options', () => {
  it('say: null shows the words, and needs redact: none', () => {
    const plain = defineSlot('phrase', { type: 'text', what: 'a phrase', say: null, redact: 'none' });
    expect(plain.redact).toBeUndefined();
    expect(plain.fill({ phraseGiven: noul(0.9) }, testSlotContext('blue heron'))).toMatchObject({ value: 'blue heron', display: 'blue heron' });
    const refused = buildSlot('phrase', { type: 'text', what: 'a phrase', say: null });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.problems.map(formatProblem)).toEqual([
      '(code)  phrase.say  say is null, so the display is the caller\'s words, which redact: length keeps out of the trace  ->  give "say" a stand-in such as "your note", or set redact: none',
    ]);
  });

  it('needs "what" or text.given, and refuses "what" beside text.given', () => {
    const none = buildSlot('note', { type: 'text' });
    expect(!none.ok && none.problems.map(formatProblem)).toEqual([
      '(code)  note  a text slot needs "what" (what the caller gives, which the default question names) or text.given (the question in its own words)  ->  add "what:" with a noun phrase, such as "a note for the courier"',
    ]);
    const both = buildSlot('note', { type: 'text', what: 'a note', text: { given: 'Read asr.text. Is there a note?' } });
    expect(!both.ok && both.problems.map((p) => `${p.path}: ${p.message}`)).toEqual(['note.what: "what" is not used, since text.given replaces the whole question']);
  });

  it('text.given replaces the question word for word, and ids.given renames it', () => {
    const given = 'Read asr.text. Does the caller say where to leave it? A request alone is not.';
    const slot = defineSlot('note', { type: 'text', text: { given }, ids: { given: 'saysWhere' } });
    expect(slot.questionIds).toEqual(['saysWhere']);
    expect(slot.questions(testSlotContext(''))).toEqual({ saysWhere: { type: 'noul', instructions: given } });
  });

  it('refuses question text with a line break, as a YAML block scalar would give', () => {
    const r = buildSlot('note', { type: 'text', text: { given: 'Read asr.text. Is there a note?\n' } });
    expect(!r.ok && r.problems.map(formatProblem)).toEqual([
      '(code)  note.text.given  "Read asr.text. Is there a note?\\n" must be one line of text, without line breaks or control characters  ->  write it on one line, in quotes; a block scalar (| or >) ends the text with a line break the model would be sent',
    ]);
  });

  it('refuses an id the engine asks', () => {
    const r = buildSlot('note', { type: 'text', what: 'a note', ids: { given: 'urgency' } });
    expect(!r.ok && r.problems.map(formatProblem)).toEqual([
      '(code)  note.ids.given  slot "note" declares the question id "urgency", which is one the engine asks, so its answers would be read as the engine\'s  ->  give the "given" question another id',
    ]);
  });

  it('maxLength cuts the words', () => {
    const short = defineSlot('note', { type: 'text', what: 'a note', maxLength: 5 });
    expect(short.fill(heard(0.9), testSlotContext('by the gate'))).toMatchObject({ value: 'by th' });
  });
});

describe('defineSlot problems', () => {
  it('names an unknown option and suggests the one meant', () => {
    try {
      defineSlot('note', { type: 'text', what: 'a note', maxLenght: 40 });
      expect.unreachable();
    } catch (e) {
      expect(isSlotConfigError(e)).toBe(true);
      expect((e as { problems: unknown[] }).problems.map((p) => formatProblem(p as never))).toEqual(['(code)  note.maxLenght  unknown key "maxLenght" under note  ->  rename "maxLenght" to "maxLength"']);
      expect((e as Error).message).toBe('the slot "note" is not valid (1 problem):\n  (code)  note.maxLenght  unknown key "maxLenght" under note  ->  rename "maxLenght" to "maxLength"');
    }
  });

  it('names an unknown type and the one meant, and a missing one', () => {
    expect((buildSlot('note', { type: 'txt' }) as { problems: unknown[] }).problems.map((p) => formatProblem(p as never))).toEqual([
      '(code)  note.type  "type" is "txt", which is not a slot type here; the types are "birthdate", "choice", "date", "digits", "name", "record", "text", "topic"  ->  change it to "text"',
    ]);
    expect((buildSlot('note', { what: 'a note' }) as { problems: unknown[] }).problems.map((p) => formatProblem(p as never))).toEqual([
      '(code)  note  required key "type" is missing under note  ->  add "type:" with one of "birthdate", "choice", "date", "digits", "name", "record", "text", "topic"',
    ]);
  });

  it('a value of the wrong kind, and a bad option value', () => {
    const r = buildSlot('note', { type: 'text', what: 'a note', maxLength: '40', keep: 'frist' });
    expect(!r.ok && r.problems.map(formatProblem)).toEqual([
      '(code)  note.maxLength  "maxLength" must be a number, but is text ("40")  ->  write a number without quotes',
      '(code)  note.keep  "keep" is "frist", which is not allowed here; it must be one of "first", "first-unless-prompted"  ->  change it to "first"',
    ]);
  });
});

describe('the docs', () => {
  it('the docs page names every option', () => {
    const readme = readFileSync(new URL('../../../../../docs/slots/text.md', import.meta.url), 'utf8');
    const options = Object.keys((slotTypeJsonSchema(textType).properties ?? {}) as object).filter((k) => k !== 'type');
    expect(options.sort()).toEqual(['ids', 'instructions', 'keep', 'listen', 'maxLength', 'pick', 'redact', 'say', 'text', 'what']);
    for (const option of options) expect(readme, option).toContain(`\`${option}\``);
  });
});

describe('the testkit\'s note, written as configuration', () => {
  // Not a migration (the testkit keeps its slot): proof that the type's options reach a
  // hand-written text slot exactly, through the same shadow harness the migration will use.
  const library = defineSlot('missingNote', {
    type: 'text',
    text: { given: 'Read asr.text. Does the caller describe the missing parcel: what was in it, what it looked like, or where it should have been left? A request alone is not a description.' },
    ids: { given: 'describesParcel' },
  });
  const shadow = shadowSlot(missingNoteSlot, library);

  it('asks the same question and fills the same way on every branch', () => {
    for (const text of ['', 'a blue box with a lamp in it', '   ']) {
      for (const over of [{}, { prompted: true }, { current: 'a box' }, { current: 'a box', prompted: true }]) {
        const ctx = testSlotContext(text, over);
        shadow.questions(ctx);
        for (const p of [0, 0.59, 0.6, 0.95]) shadow.fill({ describesParcel: noul(p) }, ctx);
        shadow.fill({}, ctx);
      }
    }
    expect(shadow.display('x')).toBe('your description');
  });
});

describe('a text slot in Spanish: its stand-in by locale', () => {
  const config = { type: 'text', what: 'a note for the courier', say: 'your note' };

  it('says the locale\'s stand-in there and the option\'s elsewhere; the words are kept as said', () => {
    const built = buildSlot('note', config, { wording: { es: { say: 'su nota' } } });
    if (!built.ok) throw new Error(built.problems.map(formatProblem).join('\n'));
    const note = built.spec;
    expect(note.fill({ noteGiven: noul(0.9) }, testSlotContext('déjelo con el vecino', { locale: 'es' }))).toMatchObject({ kind: 'filled', value: 'déjelo con el vecino', display: 'su nota' });
    expect(note.display('x', 'en-US')).toBe('your note');
    expect(note.display('x')).toBe('your note');
    expect(note.questions(testSlotContext('x', { locale: 'es' }))).toEqual(defineSlot('note', config).questions(testSlotContext('x', { locale: 'es' })));
  });

  it('takes no stand-in for a slot whose display is the words', () => {
    const bad = buildSlot('note', { ...config, say: null, redact: 'none' }, { wording: { es: { say: 'su nota' } } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems.map(formatProblem)).toEqual([expect.stringContaining('locale/es/slots.yaml  note.say  unknown key "say"')]);
  });
});

describe('pick: the candidates code proposes', () => {
  const en = PICK_WORDS.en!;
  const ALDER = 'the power is out at 22 Alder Street and nothing works';

  it('splits at a joining word and offers a clause\'s tail after a preposition, each verbatim', () => {
    expect(pickCandidates(ALDER, en).slice(0, 3)).toEqual(['the power is out at 22 Alder Street', '22 Alder Street', 'nothing works']);
  });

  it('offers the tail after "for": a report made for an address', () => {
    expect(pickCandidates("yeah i'd like to report a outage for twelve oak hollow road", en)).toEqual([
      "yeah i'd like to report a outage for twelve oak hollow road",
      'twelve oak hollow road',
    ]);
    expect(pickCandidates('a delivery for the house on Elm', en)).toEqual(['a delivery for the house on Elm', 'the house on Elm', 'Elm']);
  });

  it('a "for" tail comes in the order said, so it never moves a clause or an earlier tail out of the cap', () => {
    const said = 'the power is out at 22 Alder Street for the whole block and nothing works';
    expect(pickCandidates(said, en).slice(0, 4)).toEqual([
      'the power is out at 22 Alder Street for the whole block',
      '22 Alder Street for the whole block',
      'the whole block',
      'nothing works',
    ]);
    const got = pickCandidates('the light is out for the street, the heat is out for the lane, at 9 Quarry Hill', en);
    expect(got).toEqual([
      'the light is out for the street', 'the street', 'the heat is out for the lane', 'the lane', 'at 9 Quarry Hill', '9 Quarry Hill',
    ]);
  });

  it('then offers the parts that span one joining word, and their tails, after every part split there', () => {
    expect(pickCandidates(ALDER, en)).toEqual(['the power is out at 22 Alder Street', '22 Alder Street', 'nothing works', ALDER, '22 Alder Street and nothing works']);
    expect(pickCandidates('meet me at the corner of Elm and Third, by the bank', en)).toEqual([
      'meet me at the corner of Elm', 'the corner of Elm', 'Third', 'by the bank', 'the bank',
      'meet me at the corner of Elm and Third', 'the corner of Elm and Third',
    ]);
    expect(pickCandidates('Sandby Road and Anderson Lane', en)).toEqual(['Sandby Road', 'Anderson Lane', 'Sandby Road and Anderson Lane']);
  });

  it('joins two clauses side by side only, never across punctuation', () => {
    expect(pickCandidates('Elm and Third and Main', en)).toEqual(['Elm', 'Third', 'Main', 'Elm and Third', 'Third and Main']);
    expect(pickCandidates('Elm, and Third', en)).toEqual(['Elm', 'Third']);
    expect(pickCandidates('Elm and and Third', en)).toEqual(['Elm', 'Third', 'Elm and and Third']);
  });

  it('a part spanning a joining word never pushes out a part split there, and the cap keeps the parts said first', () => {
    const split = 'one, two, three, four, five, six, seven and eight, nine';
    expect(pickCandidates(split, en)).toEqual(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']);
    const near = 'it is out, the lights, the heat, at the corner of Elm and Third';
    const got = pickCandidates(near, en);
    expect(got).toHaveLength(MAX_PICK_CANDIDATES);
    expect(got.slice(-2)).toEqual(['at the corner of Elm and Third', 'the corner of Elm and Third']);
  });

  it('every candidate is a slice of the words as said, offered once', () => {
    const said = [
      ALDER, 'meet me at the corner of Elm and Third, by the bank', 'Elm Park and Elm Park and Elm Park', '  at the mill and  by  the bridge  ',
      "it's out at 4 O’Neil Street and at 4 O'Neil Street", 'se fue la luz en la calle Alder 22 y nada funciona',
    ];
    for (const text of said) {
      const got = pickCandidates(text, pickWordsFor(text.startsWith('se ') ? 'es' : 'en'));
      expect(new Set(got).size, text).toBe(got.length);
      for (const c of got) expect(text, c).toContain(c);
      for (const c of got) expect(c, c).toBe(c.trim());
    }
  });

  it('splits at punctuation, but not inside a number or a time', () => {
    expect(pickCandidates('Yes. It is 14 Birch Lane, by the school!', en)).toEqual(['Yes', 'It is 14 Birch Lane', 'by the school', 'the school']);
    expect(pickCandidates('1,200 Oak Road at 10:30', en)).toEqual(['1,200 Oak Road at 10:30', '10:30']);
  });

  it('offers one candidate for a single clause with no preposition: the words themselves', () => {
    expect(pickCandidates('200 Heron Row', en)).toEqual(['200 Heron Row']);
    expect(pickCandidates('   ', en)).toEqual([]);
  });

  it('empty clauses, a joining word alone, punctuation alone, a preposition alone, spacing at either end', () => {
    expect(pickCandidates('', en)).toEqual([]);
    expect(pickCandidates('and', en)).toEqual([]);
    expect(pickCandidates(', , ,', en)).toEqual([]);
    expect(pickCandidates('at', en)).toEqual(['at']);
    expect(pickCandidates('  at  ', en)).toEqual(['at']);
    expect(pickCandidates('  out at 22 Alder Street  ', en)).toEqual(['out at 22 Alder Street', '22 Alder Street']);
  });

  it('keeps a word with an apostrophe or a hyphen whole, so a joining word inside one splits nothing', () => {
    expect(pickCandidates("it's out at 4 O'Neil Street", en)).toEqual(["it's out at 4 O'Neil Street", "4 O'Neil Street"]);
    expect(pickCandidates('it’s out at 4 O’Neil Street', en)).toEqual(['it’s out at 4 O’Neil Street', '4 O’Neil Street']);
    expect(pickCandidates('the rock-and-roll club on Smith-and-Wesson Road', en)).toEqual(['the rock-and-roll club on Smith-and-Wesson Road', 'Smith-and-Wesson Road']);
    expect(pickCandidates('out at 22-24 Alder Street', en)).toEqual(['out at 22-24 Alder Street', '22-24 Alder Street']);
  });

  it('splits at any script\'s clause punctuation before a space, and at an ellipsis', () => {
    expect(pickCandidates('the power is out… at 22 Alder Street', en)).toEqual(['the power is out', 'at 22 Alder Street', '22 Alder Street']);
    expect(pickCandidates('انقطعت الكهرباء، في شارع ألدر', pickWordsFor('ar'))).toEqual(['انقطعت الكهرباء', 'في شارع ألدر']);
    expect(pickCandidates('बिजली नहीं है। 22 एल्डर स्ट्रीट', pickWordsFor('hi'))).toEqual(['बिजली नहीं है', '22 एल्डर स्ट्रीट']);
    expect(pickCandidates('3.5 miles at 1,200 Oak Road', en)).toEqual(['3.5 miles at 1,200 Oak Road', '1,200 Oak Road']);
  });

  it('a very long utterance still gives at most the cap', () => {
    const long = 'the light is out at 22 Alder Street and '.repeat(20000) + 'it is 9 Quarry Hill';
    expect(pickCandidates(long, en)).toEqual(['the light is out at 22 Alder Street', '22 Alder Street', 'it is 9 Quarry Hill', 'the light is out at 22 Alder Street and the light is out at 22 Alder Street', '22 Alder Street and the light is out at 22 Alder Street', 'the light is out at 22 Alder Street and it is 9 Quarry Hill', '22 Alder Street and it is 9 Quarry Hill']);
    const many = Array.from({ length: 5000 }, (_, i) => `part ${i}`).join(', ');
    expect(pickCandidates(many, en)).toHaveLength(MAX_PICK_CANDIDATES);
  });

  it('matches whole words only, case aside, and drops a joining word at either end', () => {
    expect(pickCandidates('AND it is out ON Pine Street', en)).toEqual(['it is out ON Pine Street', 'Pine Street']);
  });

  it('offers each tail of a clause, and each candidate once', () => {
    expect(pickCandidates('the house on the corner near Elm Park', en)).toEqual(['the house on the corner near Elm Park', 'the corner near Elm Park', 'Elm Park']);
    expect(pickCandidates('Elm Park and Elm Park', en)).toEqual(['Elm Park', 'Elm Park and Elm Park']);
  });

  it(`offers at most ${MAX_PICK_CANDIDATES}, the first in the order said`, () => {
    const many = 'one, two, three, four, five, six, seven, eight, nine, ten';
    expect(pickCandidates(many, en)).toEqual(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']);
  });

  it('reads Spanish words in Spanish, accents aside, keeping the words as said', () => {
    const es = pickWordsFor('es-MX');
    expect(pickCandidates('se fue la luz en la calle Alder 22 y nada funciona', es).slice(0, 3)).toEqual(['se fue la luz en la calle Alder 22', 'la calle Alder 22', 'nada funciona']);
    expect(pickCandidates('no hay luz, asi que llamo; está cerca de la plaza Mayor', es)).toEqual(['no hay luz', 'llamo', 'está cerca de la plaza Mayor', 'la plaza Mayor']);
  });

  it('English with no locale and in en-*; a language with no list splits at punctuation only, unless the slot gives its words', () => {
    expect(pickWordsFor(undefined)).toEqual(en);
    expect(pickWordsFor('en-GB')).toEqual(en);
    const fr = 'la panne est au 22 rue Alder et rien ne marche';
    expect(pickCandidates(fr, pickWordsFor('fr'))).toEqual([fr]);
    const own = { fr: { joiners: ['et', 'parce que'], prepositions: ['au', 'près de'] } };
    expect(pickCandidates(fr, pickWordsFor('fr-CA', own)).slice(0, 3)).toEqual(['la panne est au 22 rue Alder', '22 rue Alder', 'rien ne marche']);
    expect(pickWordsFor('en-US', { en: { joiners: ['and'] } })).toEqual({ joiners: ['and'], prepositions: en.prepositions });
  });

  it('a list the region\'s words leave out is the language\'s own, then the built-in one', () => {
    const own = { fr: { joiners: ['et'], prepositions: ['au'] }, 'fr-CA': { joiners: ['et', 'puis'] } };
    expect(pickWordsFor('fr-CA', own)).toEqual({ joiners: ['et', 'puis'], prepositions: ['au'] });
    expect(pickWordsFor('fr', own)).toEqual({ joiners: ['et'], prepositions: ['au'] });
    expect(pickWordsFor('es-MX', { 'es-MX': { joiners: ['y'] } })).toEqual({ joiners: ['y'], prepositions: PICK_WORDS.es!.prepositions });
  });
});

describe('pick: the question and the value', () => {
  const ALDER = 'the power is out at 22 Alder Street and nothing works';
  const place = defineSlot('place', { type: 'text', what: 'where the problem is', say: null, redact: 'none', pick: { what: 'the street address' } });
  const given = (p: number) => ({ placeGiven: noul(p) });

  it('declares the pick question, named after the slot', () => {
    expect(place.questionIds).toEqual(['placeGiven', 'placePick']);
    expect(place.config).toMatchObject({ pick: { what: 'the street address' } });
  });

  it('asks which candidate is the value, by letter, with none of these', () => {
    expect(place.questions(testSlotContext(ALDER)).placePick).toEqual({
      type: 'choice',
      instructions: 'Read asr.text. Which of these parts of the caller\'s words is the street address, with nothing else in it?',
      criteria: {
        a: 'the power is out at 22 Alder Street', b: '22 Alder Street', c: 'nothing works', d: ALDER, e: '22 Alder Street and nothing works',
        none: 'None of these is the street address',
      },
    });
  });

  it('asks only the given question for a single candidate, and none for a value it would keep', () => {
    expect(Object.keys(place.questions(testSlotContext('200 Heron Row')))).toEqual(['placeGiven']);
    expect(Object.keys(place.questions(testSlotContext(ALDER, { current: '14 Birch Lane' })))).toEqual(['placeGiven']);
    expect(Object.keys(place.questions(testSlotContext(ALDER, { current: '14 Birch Lane', prompted: true })))).toEqual(['placeGiven', 'placePick']);
  });

  it('fills with the picked span, verbatim', () => {
    const o = place.fill({ ...given(0.9), placePick: choice({ b: 0.88, a: 0.07, c: 0.01, none: 0.04 }) }, testSlotContext(ALDER));
    expect(o).toEqual({ kind: 'filled', value: '22 Alder Street', display: '22 Alder Street', confidence: 0.9, confirm: 'none' });
  });

  it('keeps the whole words on none, below SLOT_DETECT, a letter not offered, or no answer', () => {
    const t = DEFAULT_THRESHOLDS.SLOT_DETECT;
    for (const pick of [choice({ none: 0.9, b: 0.1 }), choice({ b: t - 0.01, none: t - 0.02, a: 0.03 }), choice({ g: 0.9, none: 0.1 }), undefined]) {
      expect(place.fill({ ...given(0.9), ...(pick ? { placePick: pick } : {}) }, testSlotContext(ALDER))).toMatchObject({ kind: 'filled', value: ALDER });
    }
    expect(place.fill({ ...given(0.9), placePick: choice({ b: t, none: 1 - t }) }, testSlotContext(ALDER))).toMatchObject({ value: '22 Alder Street' });
  });

  it('fills with a part that spans a joining word, so "the corner of Elm and Third" is one value', () => {
    const said = 'meet me at the corner of Elm and Third, by the bank';
    const q = place.questions(testSlotContext(said)).placePick as { criteria: Record<string, string> };
    expect(q.criteria.g).toBe('the corner of Elm and Third');
    expect(place.fill({ ...given(0.9), placePick: choice({ g: 0.9, none: 0.1 }) }, testSlotContext(said))).toMatchObject({ value: 'the corner of Elm and Third' });
  });

  it('a picked value of a slot redacted by length leaves the turn as its length, in the trace and in a tool\'s params', () => {
    const redacted = defineSlot('place', { type: 'text', what: 'where', pick: { what: 'the street address' } });
    const out = redacted.fill({ ...given(0.9), placePick: choice({ b: 0.9, none: 0.1 }) }, testSlotContext(ALDER));
    expect(out).toMatchObject({ value: '22 Alder Street', display: 'your description' });
    const app = { slots: { place: redacted }, policy: { audit: {} } };
    expect(redactCall(app, { tool: 'report', params: { place: '22 Alder Street' } }).params).toEqual({ place: '<15 chars>' });
    const record = { slots: { place: { ...emptySlot(), value: '22 Alder Street', display: 'your description' } }, turnState: { slots: {}, pendingConfirmation: null }, decision: null, actions: [], pendingConfirmation: null } as unknown as TraceRecord;
    expect(redactRecordSlots(record, 'length', app).slots.place).toMatchObject({ value: '<15 chars>', display: 'your description' });
  });

  it('is absent when the words are not given, whatever the pick says', () => {
    expect(place.fill({ ...given(0.1), placePick: choice({ b: 0.95, none: 0.05 }) }, testSlotContext(ALDER))).toEqual({ kind: 'absent' });
  });

  it('cuts the picked span to maxLength', () => {
    const short = defineSlot('place', { type: 'text', what: 'where', maxLength: 6, pick: { what: 'the street address' } });
    expect(short.fill({ ...given(0.9), placePick: choice({ b: 0.9, none: 0.1 }) }, testSlotContext(ALDER))).toMatchObject({ value: '22 Ald', display: 'your description' });
  });

  it('text.pick, text.pickNone and ids.pick replace the wording and the id', () => {
    const own = defineSlot('place', {
      type: 'text', what: 'where', pick: { what: 'the address' },
      text: { pick: 'Read asr.text. Which is the address?', pickNone: 'No address' }, ids: { pick: 'whichAddress' },
    });
    expect(own.questionIds).toEqual(['placeGiven', 'whichAddress']);
    expect(own.questions(testSlotContext(ALDER)).whichAddress).toMatchObject({ instructions: 'Read asr.text. Which is the address?', criteria: { none: 'No address' } });
  });

  it('reads the locale\'s words, and the slot\'s own for another language', () => {
    const es = place.questions(testSlotContext('se fue la luz en la calle Alder 22 y nada funciona', { locale: 'es' })).placePick;
    expect(es).toMatchObject({ criteria: { a: 'se fue la luz en la calle Alder 22', b: 'la calle Alder 22', c: 'nada funciona', d: 'se fue la luz en la calle Alder 22 y nada funciona' } });
    const fr = defineSlot('place', { type: 'text', what: 'where', pick: { what: 'the address', words: { fr: { joiners: ['et'], prepositions: ['au'] } } } });
    expect(fr.questions(testSlotContext('la panne est au 22 rue Alder et rien ne marche', { locale: 'fr' })).placePick).toMatchObject({
      criteria: { a: 'la panne est au 22 rue Alder', b: '22 rue Alder', c: 'rien ne marche' },
    });
  });

  it('refuses pick wording or an id without pick, a pick without what, and a word list with no words', () => {
    const problems = (config: Record<string, unknown>) => {
      const r = buildSlot('place', { type: 'text', what: 'where', ...config });
      return r.ok ? [] : r.problems.map(formatProblem);
    };
    expect(problems({ text: { pick: 'Which?' } })).toEqual([
      '(code)  place.text.pick  text.pick is not used without "pick"  ->  add "pick: { what: ... }", or delete text.pick',
    ]);
    expect(problems({ ids: { pick: 'whichAddress' } })).toEqual([
      '(code)  place.ids.pick  ids.pick is not used without "pick"  ->  add "pick: { what: ... }", or delete ids.pick',
    ]);
    expect(problems({ pick: {} })).toEqual([expect.stringContaining('place.pick.what  required key "what" is missing')]);
    expect(problems({ pick: { what: 'the address', words: { fr: { joiners: [] } } } })).toEqual([expect.stringContaining('place.pick.words.fr.joiners')]);
    expect(problems({ pick: { what: 'the address', words: { French: { joiners: ['et'] } } } })).toEqual([expect.stringContaining('place.pick.words.French')]);
  });
});
