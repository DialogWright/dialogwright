import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { formatProblem } from '../../define/problems';
import { noul } from '../../testing/answers';
import { shadowSlot } from '../../testing/shadowSlot';
import { testSlotContext } from '../../testing/slots';
import { missingNoteSlot } from '../../testing/testkit/domain/slots/missingNote';
import { runSlotConformance } from '../conformance/run';
import { buildSlot, defineSlot, isSlotConfigError, slotTypeJsonSchema } from '../defineSlot';
import { textType } from './index';

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
      '(code)  note.type  "type" is "txt", which is not a slot type here; the types are "birthdate", "choice", "date", "digits", "name", "text"  ->  change it to "text"',
    ]);
    expect((buildSlot('note', { what: 'a note' }) as { problems: unknown[] }).problems.map((p) => formatProblem(p as never))).toEqual([
      '(code)  note  required key "type" is missing under note  ->  add "type:" with one of "birthdate", "choice", "date", "digits", "name", "text"',
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
  it('the README names every option', () => {
    const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
    const options = Object.keys((slotTypeJsonSchema(textType).properties ?? {}) as object).filter((k) => k !== 'type');
    expect(options.sort()).toEqual(['ids', 'instructions', 'keep', 'maxLength', 'redact', 'say', 'text', 'what']);
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
