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
import type { SlotContext } from '../../core/slots/types';
import { MAX_PICK_CANDIDATES, MAX_PICK_SPLITS, MIN_TAIL_WORDS, PICK_WORDS, pickCandidates, pickWordsFor, textType } from './index';

/** The `text` type: the conformance kit over its examples, then what the kit does not cover. */
runSlotConformance(textType, { describe, it, locales: ['en-US', 'es'] });

const note = defineSlot('note', { type: 'text', what: 'a note for the courier' });
const heard = (p: number) => ({ noteGiven: noul(p) });

describe('a text slot built from the defaults', () => {
  it('asks one yes-or-no question, named after the slot, in the default words (and declares the summary\'s, below)', () => {
    expect(note.questionIds).toEqual(['noteGiven', 'noteChanged']);
    expect(note.prompts).toEqual([]);
    expect(note.questions(testSlotContext('hello'))).toEqual({
      noteGiven: {
        type: 'noul',
        instructions: 'Read asr.text. Does the caller give a note for the courier? Only asking to give it, without saying it, is not.',
      },
    });
  });

  it('adds the instructions after the default question', () => {
    const slot = defineSlot('note', { type: 'text', what: 'a note for the courier', instructions: 'Count where to leave the parcel.' });
    expect(slot.questions(testSlotContext('')).noteGiven?.instructions).toBe(
      'Read asr.text. Does the caller give a note for the courier? Only asking to give it, without saying it, is not. Count where to leave the parcel.',
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
    expect(note.config).toEqual({ what: 'a note for the courier', maxLength: 500, say: 'your description', keep: 'first-unless-prompted', redact: 'length', numbers: 'words', case: 'as-said' });
    expect(Object.isFrozen(note.config)).toBe(true);
  });

  it('the other slots on the turn that gives its words while it is asked for (others, live findings item 27): the app decides; quiet by default for the whole answer, listen with pick', () => {
    // Takes the whole answer as its content: quiet by default, listen when the app says so.
    expect(note.quietsOthers).toBe(true);
    expect(defineSlot('note', { type: 'text', what: 'a note for the courier', others: 'quiet' }).quietsOthers).toBe(true);
    expect(defineSlot('note', { type: 'text', what: 'a note for the courier', others: 'listen' })).not.toHaveProperty('quietsOthers');
    // Picks part of a longer answer: listen by default, quiet when the app says so.
    const place = { type: 'text', what: 'the place', pick: { what: 'the street address' } } as const;
    expect(defineSlot('place', place)).not.toHaveProperty('quietsOthers');
    expect(defineSlot('place', { ...place, others: 'listen' })).not.toHaveProperty('quietsOthers');
    expect(defineSlot('place', { ...place, others: 'quiet' }).quietsOthers).toBe(true);
    const bad = buildSlot('note', { type: 'text', what: 'a note for the courier', others: 'sometimes' });
    expect(bad.ok).toBe(false);
  });

  it('the turn at its own question is its words, whole (commands, live findings item 29): ignore by default for the whole answer, listen with pick, the intents listed kept', () => {
    // Takes the whole answer as its content: the turn is the words, no request acted on.
    expect(note.dictation).toEqual({ listen: [] });
    expect(defineSlot('note', { type: 'text', what: 'a note for the courier', commands: 'ignore' }).dictation).toEqual({ listen: [] });
    expect(defineSlot('note', { type: 'text', what: 'a note for the courier', commands: 'listen' })).not.toHaveProperty('dictation');
    expect(defineSlot('note', { type: 'text', what: 'a note for the courier', commands: { listen: ['urgent', 'agent'] } }).dictation).toEqual({ listen: ['urgent', 'agent'] });
    // Picks part of a longer answer: read as any turn by default, as the app says otherwise.
    const place = { type: 'text', what: 'the place', pick: { what: 'the street address' } } as const;
    expect(defineSlot('place', place)).not.toHaveProperty('dictation');
    expect(defineSlot('place', { ...place, commands: 'ignore' }).dictation).toEqual({ listen: [] });
    for (const bad of ['sometimes', { listen: [] }, { listen: ['urgent', 'urgent'] }, { listen: ['not an id'] }]) {
      expect(buildSlot('note', { type: 'text', what: 'a note for the courier', commands: bad }).ok).toBe(false);
    }
  });

  it('told the turn is its words (SlotContext.dictated), fills with them whatever its question read; never past keep', () => {
    const dictated = (text: string, over: Partial<SlotContext> = {}): SlotContext => ({ ...testSlotContext(text), prompted: true, dictated: true, ...over });
    expect(note.fill(heard(0.05), dictated('  could you send me that updated spreadsheet  '))).toEqual({ kind: 'filled', value: 'could you send me that updated spreadsheet', display: 'your description', confidence: 0.05, confirm: 'none' });
    expect(note.fill({}, dictated('just say Alex called'))).toMatchObject({ kind: 'filled', value: 'just say Alex called' });
    // Empty words are no value (the engine sends no dictation without words).
    expect(note.fill(heard(0.05), dictated('   '))).toEqual({ kind: 'absent' });
    // keep: first keeps the value on file even then.
    const first = defineSlot('note', { type: 'text', what: 'a note for the courier', keep: 'first' });
    expect(first.fill(heard(0.05), dictated('another note', { current: 'by the gate' }))).toEqual({ kind: 'absent' });
    // Without it, the same answer is below the bar.
    expect(note.fill(heard(0.05), { ...testSlotContext('could you send me that updated spreadsheet'), prompted: true })).toEqual({ kind: 'absent' });
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
  it('redact: length-summarized masks the words by their length everywhere, the display and the console too, and marks them for a model to summarize', () => {
    const message = defineSlot('message', { type: 'text', what: 'a message', say: null, redact: 'length-summarized' });
    expect(message.redact).toBe('length');
    expect(message.statement).toBe(false);
    expect(message.summarized).toBe(true);
    const words = 'the logo files are ready for review';
    const record = { slots: { message: { value: words, display: words, confirmed: false, attempts: 0, window: null, helped: [] } } } as never;
    for (const mode of ['length', 'keep'] as const) {
      expect(JSON.stringify(redactRecordSlots(record, mode, { slots: { message } }))).not.toContain('logo files');
    }
    // A plain text slot is as it was: no mark, and a statement.
    const note = defineSlot('note', { type: 'text', what: 'a note' });
    expect(note.summarized).toBeUndefined();
    expect(note.statement).toBeUndefined();
  });

  it('say: null shows the words, and needs redact: none', () => {
    const plain = defineSlot('phrase', { type: 'text', what: 'a phrase', say: null, redact: 'none' });
    expect(plain.redact).toBeUndefined();
    expect(plain.fill({ phraseGiven: noul(0.9) }, testSlotContext('blue heron'))).toMatchObject({ value: 'blue heron', display: 'blue heron' });
    const refused = buildSlot('phrase', { type: 'text', what: 'a phrase', say: null });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.problems.map(formatProblem)).toEqual([
      '(code)  phrase.say  say is null, so the display is the caller\'s words, which redact: length keeps out of the trace  ->  give "say" a stand-in such as "your note", or set redact: none (or redact: length-summarized, for words a model summarizes though the records mask them)',
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
    expect(slot.questionIds).toEqual(['saysWhere', 'noteChanged']);
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
    expect(options.sort()).toEqual(['askedOf', 'attempts', 'case', 'commands', 'confirm', 'ids', 'instructions', 'keep', 'listen', 'maxLength', 'numbers', 'offer', 'offerAnswers', 'offerAt', 'onMaxAttempts', 'others', 'pick', 'redact', 'say', 'text', 'what']);
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

  it('offers the tail from each word, so the value is offered whatever leads in to it, in any language', () => {
    expect(pickCandidates('yeah my address is seventy six twenty five oak hollow lane', en)).toEqual([
      'yeah my address is seventy six twenty five oak hollow lane',
      'my address is seventy six twenty five oak hollow lane',
      'address is seventy six twenty five oak hollow lane',
      'is seventy six twenty five oak hollow lane',
      'seventy six twenty five oak hollow lane',
      'six twenty five oak hollow lane',
      'twenty five oak hollow lane',
      'five oak hollow lane',
      'oak hollow lane',
      'hollow lane',
    ]);
    expect(pickCandidates("it's 22 Alder Street", en)).toEqual(["it's 22 Alder Street", '22 Alder Street', 'Alder Street']);
    expect(pickCandidates('the address would be 9 Quarry Hill Road', en)).toEqual([
      'the address would be 9 Quarry Hill Road', 'address would be 9 Quarry Hill Road', 'would be 9 Quarry Hill Road', 'be 9 Quarry Hill Road',
      '9 Quarry Hill Road', 'Quarry Hill Road', 'Hill Road',
    ]);
    // No word list at all: the tails need none.
    expect(pickCandidates('oui alors c\'est le 22 rue Alder', pickWordsFor('fr'))).toContain('22 rue Alder');
  });

  it('offers the parts split there first, as before, then the tails, each clause\'s in the order said', () => {
    expect(pickCandidates(ALDER, en)).toEqual([
      'the power is out at 22 Alder Street', '22 Alder Street', 'nothing works', ALDER, '22 Alder Street and nothing works',
      'power is out at 22 Alder Street', 'is out at 22 Alder Street', 'out at 22 Alder Street', 'at 22 Alder Street', 'Alder Street',
      'power is out at 22 Alder Street and nothing works', 'is out at 22 Alder Street and nothing works', 'out at 22 Alder Street and nothing works',
      'at 22 Alder Street and nothing works', 'Alder Street and nothing works', 'Street and nothing works',
    ]);
  });

  it(`keeps the shortest tails under the cap of ${MAX_PICK_CANDIDATES}, so a long lead-in is what is dropped, never the value at the end`, () => {
    const said = 'yeah hi um okay well listen the thing is that my home address right now is 4410 Oak Hollow Lane';
    const got = pickCandidates(said, en);
    expect(got).toHaveLength(MAX_PICK_CANDIDATES);
    expect(got[0]).toBe(said);
    expect(got).toContain('4410 Oak Hollow Lane');
    expect(got[1]).toBe('well listen the thing is that my home address right now is 4410 Oak Hollow Lane');
    expect(got.at(-1)).toBe('Hollow Lane');
    for (const dropped of ['hi um okay well', 'um okay well', 'okay well']) expect(got).not.toContain(`${dropped} ${got[1]!.slice('well '.length)}`);
  });

  it('keeps a clause\'s tails before a join\'s, so a join never pushes the value out of the cap', () => {
    const got = pickCandidates('yeah my address is seventy six twenty five oak hollow lane and the power is out and nothing works', en);
    expect(got).toHaveLength(MAX_PICK_CANDIDATES);
    expect(got).toContain('seventy six twenty five oak hollow lane');
    expect(got.slice(MAX_PICK_SPLITS - 3)).toEqual([
      'my address is seventy six twenty five oak hollow lane', 'address is seventy six twenty five oak hollow lane', 'is seventy six twenty five oak hollow lane',
      'seventy six twenty five oak hollow lane', 'six twenty five oak hollow lane', 'twenty five oak hollow lane', 'five oak hollow lane', 'oak hollow lane', 'hollow lane',
      'power is out', 'is out',
    ]);
  });

  it('offers the tail after "for": a report made for an address', () => {
    expect(pickCandidates("yeah i'd like to report a outage for twelve oak hollow road", en).slice(0, 2)).toEqual([
      "yeah i'd like to report a outage for twelve oak hollow road",
      'twelve oak hollow road',
    ]);
    expect(pickCandidates('a delivery for the house on Elm', en).slice(0, 3)).toEqual(['a delivery for the house on Elm', 'the house on Elm', 'Elm']);
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
    expect(got.slice(0, 6)).toEqual([
      'the light is out for the street', 'the street', 'the heat is out for the lane', 'the lane', 'at 9 Quarry Hill', '9 Quarry Hill',
    ]);
  });

  it('then offers the parts that span one joining word, and their tails, after every part split there', () => {
    expect(pickCandidates(ALDER, en).slice(0, 5)).toEqual(['the power is out at 22 Alder Street', '22 Alder Street', 'nothing works', ALDER, '22 Alder Street and nothing works']);
    expect(pickCandidates('meet me at the corner of Elm and Third, by the bank', en).slice(0, 7)).toEqual([
      'meet me at the corner of Elm', 'the corner of Elm', 'Third', 'by the bank', 'the bank',
      'meet me at the corner of Elm and Third', 'the corner of Elm and Third',
    ]);
    // A one-word clause has no tail of two words; the join's tail from its second word is offered.
    expect(pickCandidates('Sandby Road and Anderson Lane', en)).toEqual(['Sandby Road', 'Anderson Lane', 'Sandby Road and Anderson Lane', 'Road and Anderson Lane']);
  });

  it('joins two clauses side by side only, never across punctuation', () => {
    expect(pickCandidates('Elm and Third and Main', en)).toEqual(['Elm', 'Third', 'Main', 'Elm and Third', 'Third and Main']);
    expect(pickCandidates('Elm, and Third', en)).toEqual(['Elm', 'Third']);
    expect(pickCandidates('Elm and and Third', en)).toEqual(['Elm', 'Third', 'Elm and and Third']);
  });

  it('a part spanning a joining word never pushes out a part split there, and the cap keeps the parts said first', () => {
    // The join past the splits' cap comes back among the tails (a join is its own tail from its first word).
    const split = 'one, two, three, four, five, six, seven and eight, nine';
    expect(pickCandidates(split, en)).toEqual(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'seven and eight']);
    const near = 'it is out, the lights, the heat, at the corner of Elm and Third';
    const got = pickCandidates(near, en);
    expect(got.slice(0, MAX_PICK_SPLITS).slice(-2)).toEqual(['at the corner of Elm and Third', 'the corner of Elm and Third']);
    expect(got.slice(MAX_PICK_SPLITS)).toEqual(['is out', 'corner of Elm', 'of Elm', 'corner of Elm and Third', 'of Elm and Third', 'Elm and Third']);
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
    expect(pickCandidates('Yes. It is 14 Birch Lane, by the school!', en)).toEqual(['Yes', 'It is 14 Birch Lane', 'by the school', 'the school', 'is 14 Birch Lane', '14 Birch Lane', 'Birch Lane']);
    // A tail starts after a space only, so "1,200" and "10:30" are never cut inside.
    expect(pickCandidates('1,200 Oak Road at 10:30', en)).toEqual(['1,200 Oak Road at 10:30', '10:30', 'Oak Road at 10:30', 'Road at 10:30', 'at 10:30']);
  });

  it(`offers one candidate for a single clause of ${MIN_TAIL_WORDS} words or fewer with no preposition: the words themselves`, () => {
    expect(MIN_TAIL_WORDS).toBe(2);
    expect(pickCandidates('Heron Row', en)).toEqual(['Heron Row']);
    expect(pickCandidates('200 Heron Row', en)).toEqual(['200 Heron Row', 'Heron Row']);
    expect(pickCandidates('   ', en)).toEqual([]);
  });

  it('empty clauses, a joining word alone, punctuation alone, a preposition alone, spacing at either end', () => {
    expect(pickCandidates('', en)).toEqual([]);
    expect(pickCandidates('and', en)).toEqual([]);
    expect(pickCandidates(', , ,', en)).toEqual([]);
    expect(pickCandidates('at', en)).toEqual(['at']);
    expect(pickCandidates('  at  ', en)).toEqual(['at']);
    expect(pickCandidates('  out at 22 Alder Street  ', en)).toEqual(['out at 22 Alder Street', '22 Alder Street', 'at 22 Alder Street', 'Alder Street']);
  });

  it('keeps a word with an apostrophe or a hyphen whole, so a joining word inside one splits nothing', () => {
    expect(pickCandidates("it's out at 4 O'Neil Street", en)).toEqual(["it's out at 4 O'Neil Street", "4 O'Neil Street", "out at 4 O'Neil Street", "at 4 O'Neil Street", "O'Neil Street"]);
    expect(pickCandidates('it’s out at 4 O’Neil Street', en)).toEqual(['it’s out at 4 O’Neil Street', '4 O’Neil Street', 'out at 4 O’Neil Street', 'at 4 O’Neil Street', 'O’Neil Street']);
    expect(pickCandidates('the rock-and-roll club on Smith-and-Wesson Road', en)).toEqual([
      'the rock-and-roll club on Smith-and-Wesson Road', 'Smith-and-Wesson Road', 'rock-and-roll club on Smith-and-Wesson Road', 'club on Smith-and-Wesson Road', 'on Smith-and-Wesson Road',
    ]);
    expect(pickCandidates('out at 22-24 Alder Street', en)).toEqual(['out at 22-24 Alder Street', '22-24 Alder Street', 'at 22-24 Alder Street', 'Alder Street']);
  });

  it('splits at any script\'s clause punctuation before a space, and at an ellipsis', () => {
    expect(pickCandidates('the power is out… at 22 Alder Street', en)).toEqual(['the power is out', 'at 22 Alder Street', '22 Alder Street', 'power is out', 'is out', 'Alder Street']);
    expect(pickCandidates('انقطعت الكهرباء، في شارع ألدر', pickWordsFor('ar'))).toEqual(['انقطعت الكهرباء', 'في شارع ألدر', 'شارع ألدر']);
    expect(pickCandidates('बिजली नहीं है। 22 एल्डर स्ट्रीट', pickWordsFor('hi'))).toEqual(['बिजली नहीं है', '22 एल्डर स्ट्रीट', 'नहीं है', 'एल्डर स्ट्रीट']);
    expect(pickCandidates('3.5 miles at 1,200 Oak Road', en)).toEqual(['3.5 miles at 1,200 Oak Road', '1,200 Oak Road', 'miles at 1,200 Oak Road', 'at 1,200 Oak Road', 'Oak Road']);
  });

  it('a very long utterance still gives at most the cap', () => {
    const long = 'the light is out at 22 Alder Street and '.repeat(20000) + 'it is 9 Quarry Hill';
    const got = pickCandidates(long, en);
    expect(got.slice(0, 7)).toEqual(['the light is out at 22 Alder Street', '22 Alder Street', 'it is 9 Quarry Hill', 'the light is out at 22 Alder Street and the light is out at 22 Alder Street', '22 Alder Street and the light is out at 22 Alder Street', 'the light is out at 22 Alder Street and it is 9 Quarry Hill', '22 Alder Street and it is 9 Quarry Hill']);
    // Then the shortest tails of the clauses, each once: nine are left under the cap.
    expect(got.slice(7)).toEqual([
      'light is out at 22 Alder Street', 'is out at 22 Alder Street', 'out at 22 Alder Street', 'at 22 Alder Street', 'Alder Street',
      'is 9 Quarry Hill', '9 Quarry Hill', 'Quarry Hill',
      'Street and it is 9 Quarry Hill',
    ]);
    expect(got).toHaveLength(MAX_PICK_CANDIDATES);
    const many = Array.from({ length: 5000 }, (_, i) => `part ${i}`).join(', ');
    expect(pickCandidates(many, en)).toEqual(Array.from({ length: MAX_PICK_CANDIDATES }, (_, i) => `part ${i}`));
  });

  it('matches whole words only, case aside, and drops a joining word at either end', () => {
    expect(pickCandidates('AND it is out ON Pine Street', en)).toEqual(['it is out ON Pine Street', 'Pine Street', 'is out ON Pine Street', 'out ON Pine Street', 'ON Pine Street']);
  });

  it('offers each tail of a clause, and each candidate once', () => {
    expect(pickCandidates('the house on the corner near Elm Park', en)).toEqual([
      'the house on the corner near Elm Park', 'the corner near Elm Park', 'Elm Park',
      'house on the corner near Elm Park', 'on the corner near Elm Park', 'corner near Elm Park', 'near Elm Park',
    ]);
    expect(pickCandidates('Elm Park and Elm Park', en)).toEqual(['Elm Park', 'Elm Park and Elm Park', 'Park and Elm Park']);
  });

  it(`offers at most ${MAX_PICK_SPLITS} parts split at punctuation, joining words and prepositions, the first in the order said`, () => {
    const many = 'one, two, three, four, five, six, seven, eight, nine, ten';
    expect(pickCandidates(many, en)).toEqual(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']);
  });

  it('reads Spanish words in Spanish, accents aside, keeping the words as said', () => {
    const es = pickWordsFor('es-MX');
    expect(pickCandidates('se fue la luz en la calle Alder 22 y nada funciona', es).slice(0, 3)).toEqual(['se fue la luz en la calle Alder 22', 'la calle Alder 22', 'nada funciona']);
    expect(pickCandidates('no hay luz, asi que llamo; está cerca de la plaza Mayor', es)).toEqual([
      'no hay luz', 'llamo', 'está cerca de la plaza Mayor', 'la plaza Mayor', 'hay luz', 'cerca de la plaza Mayor', 'de la plaza Mayor', 'plaza Mayor',
    ]);
  });

  it('English with no locale and in en-*; a language with no list splits at punctuation only, unless the slot gives its words', () => {
    expect(pickWordsFor(undefined)).toEqual(en);
    expect(pickWordsFor('en-GB')).toEqual(en);
    const fr = 'la panne est au 22 rue Alder et rien ne marche';
    // Not split at "et": the words are one clause, and its tails run to the end of the words.
    const whole = pickCandidates(fr, pickWordsFor('fr'));
    expect(whole[0]).toBe(fr);
    expect(whole).not.toContain('la panne est au 22 rue Alder');
    expect(whole).not.toContain('22 rue Alder');
    expect(whole).toContain('22 rue Alder et rien ne marche');
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
      instructions: 'Read asr.text. Which of these parts of the caller\'s words is the whole of the street address, with nothing else in it?',
      criteria: {
        a: 'the power is out at 22 Alder Street', b: '22 Alder Street', c: 'nothing works', d: ALDER, e: '22 Alder Street and nothing works',
        f: 'power is out at 22 Alder Street', g: 'is out at 22 Alder Street', h: 'out at 22 Alder Street', i: 'at 22 Alder Street', j: 'Alder Street',
        k: 'power is out at 22 Alder Street and nothing works', l: 'is out at 22 Alder Street and nothing works', m: 'out at 22 Alder Street and nothing works',
        n: 'at 22 Alder Street and nothing works', o: 'Alder Street and nothing works', p: 'Street and nothing works',
        none: 'None of these is the street address',
      },
    });
  });

  it('asks only the given question for a single candidate, and none for a value it would keep', () => {
    expect(Object.keys(place.questions(testSlotContext('Heron Row')))).toEqual(['placeGiven']);
    expect(Object.keys(place.questions(testSlotContext('200 Heron Row')))).toEqual(['placeGiven', 'placePick']);
    expect(Object.keys(place.questions(testSlotContext(ALDER, { current: '14 Birch Lane' })))).toEqual(['placeGiven']);
    expect(Object.keys(place.questions(testSlotContext(ALDER, { current: '14 Birch Lane', prompted: true })))).toEqual(['placeGiven', 'placePick']);
  });

  it('fills with the picked span, verbatim', () => {
    const o = place.fill({ ...given(0.9), placePick: choice({ b: 0.88, a: 0.07, c: 0.01, none: 0.04 }) }, testSlotContext(ALDER));
    expect(o).toEqual({ kind: 'filled', value: '22 Alder Street', display: '22 Alder Street', confidence: 0.9, confirm: 'none' });
  });

  it('keeps the whole words on none, below SLOT_DETECT, a letter not offered, or no answer', () => {
    const t = DEFAULT_THRESHOLDS.SLOT_DETECT;
    for (const pick of [choice({ none: 0.9, b: 0.1 }), choice({ b: t - 0.01, none: t - 0.02, a: 0.03 }), choice({ q: 0.9, none: 0.1 }), undefined]) {
      expect(place.fill({ ...given(0.9), ...(pick ? { placePick: pick } : {}) }, testSlotContext(ALDER))).toMatchObject({ kind: 'filled', value: ALDER });
    }
    const short = "it's 22 Alder Street";
    expect(place.fill({ ...given(0.9), placePick: choice({ g: 0.9, none: 0.1 }) }, testSlotContext(short))).toMatchObject({ kind: 'filled', value: short });
    expect(place.fill({ ...given(0.9), placePick: choice({ b: t, none: 1 - t }) }, testSlotContext(ALDER))).toMatchObject({ value: '22 Alder Street' });
  });

  it('fills with a tail from a word: the address after a lead-in no word list names', () => {
    const said = 'yeah my address is seventy six twenty five oak hollow lane';
    const q = place.questions(testSlotContext(said)).placePick as { criteria: Record<string, string> };
    expect(q.criteria.e).toBe('seventy six twenty five oak hollow lane');
    expect(place.fill({ ...given(0.9), placePick: choice({ e: 0.86, h: 0.06, none: 0.08 }) }, testSlotContext(said))).toMatchObject({ value: 'seventy six twenty five oak hollow lane' });
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

describe('numbers and case: the value written by code, the words read back', () => {
  const SAID = 'yeah my address is seventy six twenty five oak hollow lane';
  const place = defineSlot('place', { type: 'text', what: 'where', say: null, redact: 'none', numbers: 'digits', case: 'title', pick: { what: 'the street address' } });
  const given = (p: number) => ({ placeGiven: noul(p) });
  const picked = { ...given(0.9), placePick: choice({ e: 0.86, h: 0.06, none: 0.08 }) };

  it('writes the part picked as digits and title case, and keeps the words as said for the read-back', () => {
    expect(place.fill(picked, testSlotContext(SAID))).toEqual({
      kind: 'filled', value: '7625 Oak Hollow Lane', display: 'seventy six twenty five oak hollow lane', confidence: 0.9, confirm: 'none',
    });
  });

  it('asks the model the same questions: the candidates are the words as said, and code writes the one chosen', () => {
    const plain = defineSlot('place', { type: 'text', what: 'where', say: null, redact: 'none', pick: { what: 'the street address' } });
    expect(place.questions(testSlotContext(SAID))).toEqual(plain.questions(testSlotContext(SAID)));
    expect(place.questionIds).toEqual(plain.questionIds);
  });

  it('writes the whole words when they are kept: no pick, none picked, or one candidate', () => {
    const whole = defineSlot('place', { type: 'text', what: 'where', say: null, redact: 'none', numbers: 'digits' });
    expect(whole.fill(given(0.9), testSlotContext('one zero two four six aspen glade lane'))).toMatchObject({ value: '10246 aspen glade lane', display: 'one zero two four six aspen glade lane' });
    expect(place.fill({ ...given(0.9), placePick: choice({ none: 0.9, e: 0.1 }) }, testSlotContext(SAID))).toMatchObject({
      value: 'Yeah My Address Is 7625 Oak Hollow Lane', display: SAID,
    });
  });

  it('is shown as said only where the display is the words and the value is written from them', () => {
    expect(place.displayFrom).toBe('said');
    expect(defineSlot('place', { type: 'text', what: 'where', say: null, redact: 'none', case: 'title' }).displayFrom).toBe('said');
    expect(defineSlot('place', { type: 'text', what: 'where', say: null, redact: 'none' }).displayFrom).toBeUndefined();
    // With a stand-in, the display is the stand-in as ever, display(value) gives it, and the value is written.
    const standIn = defineSlot('place', { type: 'text', what: 'where', numbers: 'digits' });
    expect(standIn.displayFrom).toBeUndefined();
    expect(standIn.fill(given(0.9), testSlotContext('twenty two alder street'))).toMatchObject({ value: '22 alder street', display: 'your description' });
  });

  it('leaves the words as said in a language with no rules', () => {
    expect(place.fill(given(0.9), testSlotContext('calle Alder veintidós', { locale: 'es' }))).toMatchObject({ value: 'calle Alder veintidós', display: 'calle Alder veintidós' });
  });

  it('cuts the words to maxLength before writing them, so the value is never longer', () => {
    const short = defineSlot('place', { type: 'text', what: 'where', say: null, redact: 'none', numbers: 'digits', maxLength: 27 });
    expect(short.fill(given(0.9), testSlotContext('seventy six twenty five oak hollow lane'))).toMatchObject({ value: '7625 oak', display: 'seventy six twenty five oak' });
  });

  it('defaults to the words as said, and refuses another value', () => {
    expect(defineSlot('place', { type: 'text', what: 'where' }).config).toMatchObject({ numbers: 'words', case: 'as-said' });
    const r = buildSlot('place', { type: 'text', what: 'where', numbers: 'numerals' });
    expect(!r.ok && r.problems.map(formatProblem)).toEqual([expect.stringContaining('place.numbers')]);
  });
});

describe('at a form\'s summary: a yes with new or changed words (the `changed` question, live findings item 28)', () => {
  const MESSAGE = 'the logo files are ready for review';
  const atSummary = (text: string, over: Partial<SlotContext> = {}): SlotContext => ({ ...testSlotContext(text), current: MESSAGE, prompted: false, summary: true, ...over });
  // The words said by the stand-in (the type's default), so the question says they were not read back
  // (Harbor findings item 2; the maintainer's decision, 2026-10-16).
  const CHANGED = 'Read asr.text and node.promptJustPlayed. The caller was read back a summary of their request and asked to confirm it; a note for the courier was not read back, only named ("your description"). Besides agreeing, disagreeing or correcting another detail of the summary, does the caller add to or change a note for the courier? Agreeing alone (yes, that\'s right, sounds good, thanks) is no.';

  it('is asked only at the read-back of a form\'s summary that holds the slot, once it has words, and never with pick', () => {
    expect(note.questions(atSummary('yes'))).toEqual({ noteGiven: expect.anything(), noteChanged: { type: 'noul', instructions: CHANGED } });
    // Not at the summary, nor at it before the slot has words, nor where its words are not kept (a correction hides them).
    expect(Object.keys(note.questions(atSummary('yes', { summary: undefined })))).toEqual(['noteGiven']);
    expect(Object.keys(note.questions(atSummary('yes', { current: null })))).toEqual(['noteGiven']);
    const picked = defineSlot('place', { type: 'text', what: 'the place', pick: { what: 'the street address' } });
    expect(picked.questionIds).toEqual(['placeGiven', 'placePick']);
    expect(Object.keys(picked.questions({ ...atSummary('yes'), current: '22 Alder Street' }))).toEqual(['placeGiven']);
    // Its words and id, as the app's; a slot whose question is its own words names its words plainly.
    const own = defineSlot('note', { type: 'text', text: { given: 'Read asr.text. Is there a note?', changed: 'Does the caller change the note?' }, ids: { changed: 'noteEdited' } });
    expect(own.questions(atSummary('yes'))).toMatchObject({ noteEdited: { type: 'noul', instructions: 'Does the caller change the note?' } });
    // Said whole (say: null), the question says the words were read back as said.
    const whole = defineSlot('note', { type: 'text', what: 'a note for the courier', say: null, redact: 'none' });
    expect(whole.questions(atSummary('yes')).noteChanged?.instructions).toBe('Read asr.text and node.promptJustPlayed. The caller was read back a summary of their request and asked to confirm it, with a note for the courier read back as they said it. Besides agreeing, disagreeing or correcting another detail of the summary, does the caller add to or change a note for the courier? Agreeing alone (yes, that\'s right, sounds good, thanks) is no.');
    const plain = defineSlot('note', { type: 'text', text: { given: 'Read asr.text. Is there a note?' } });
    expect(plain.questions(atSummary('yes')).noteChanged?.instructions).toContain('add to or change the words they gave?');
  });

  it('at SUMMARY_WORDS_CHANGED or more the turn\'s words are added after the words on file, exactly as said; under it they are kept', () => {
    const said = "yes but tell her it's moved to Thursday";
    expect(note.fill({ noteGiven: noul(0.9), noteChanged: noul(0.9) }, atSummary(said))).toMatchObject({ kind: 'filled', value: `${MESSAGE}. ${said}` });
    // Words on file that already end a sentence are followed by a space alone.
    expect(note.fill({ noteGiven: noul(0.9), noteChanged: noul(0.9) }, atSummary(said, { current: `${MESSAGE}.` }))).toMatchObject({ value: `${MESSAGE}. ${said}` });
    // Cut to maxLength as any of the slot's values is: the accepted words first, then as much of the addition as fits.
    const short = defineSlot('note', { type: 'text', what: 'a note for the courier', maxLength: 50 });
    expect(short.fill({ noteGiven: noul(0.9), noteChanged: noul(0.9) }, atSummary(said))).toMatchObject({ value: `${MESSAGE}. ${said}`.slice(0, 50) });
    // The display of a slot shown as said is the same words.
    const shown = defineSlot('note', { type: 'text', what: 'a note for the courier', say: null, redact: 'none' });
    expect(shown.fill({ noteGiven: noul(0.9), noteChanged: noul(0.9) }, atSummary(said))).toMatchObject({ value: `${MESSAGE}. ${said}`, display: `${MESSAGE}. ${said}` });
    expect(note.fill({ noteGiven: noul(0.6), noteChanged: noul(0.1) }, atSummary('yes'))).toEqual({ kind: 'absent' });
    // At the summary the changed question alone decides (recording 5, 2026-10-14: "yes, actually make it Friday
    // not Thursday" read changed 0.92 and given only 0.25, since a correction alone does not read as a message,
    // and the change was lost): the given question's bar is for words given anywhere else.
    expect(note.fill({ noteGiven: noul(0.25), noteChanged: noul(0.92) }, atSummary(said))).toMatchObject({ kind: 'filled', value: `${MESSAGE}. ${said}` });
    // Away from a summary the question is never asked, and keep holds whatever an answer to it says.
    expect(note.fill({ noteGiven: noul(0.9), noteChanged: noul(0.9) }, atSummary(said, { summary: undefined }))).toEqual({ kind: 'absent' });
  });

  it('refuses its words or id on a slot with pick, which is never asked it', () => {
    const r = buildSlot('place', { type: 'text', what: 'the place', pick: { what: 'the street address' }, text: { changed: 'x?' }, ids: { changed: 'placeEdited' } });
    expect(!r.ok && r.problems.map((p) => `${p.path}: ${p.message}`)).toEqual([
      'place.text.changed: text.changed is not used with "pick": a slot that picks part of the words is not asked whether a yes to the summary changes them',
      'place.ids.changed: ids.changed is not used with "pick": a slot that picks part of the words is not asked whether a yes to the summary changes them',
    ]);
  });
});
