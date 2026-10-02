import { describe, expect, it } from 'vitest';
import { LineCounter, parseDocument } from 'yaml';
import { z } from 'zod';
import { formatProblem } from '../define/problems';
import { testSlotContext } from '../testing/slots';
import { noul } from '../testing/answers';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { buildSlot, defineSlot } from './defineSlot';
import { questionParts, textParts } from './parts/text';
import { checkTemplate, placeholdersOf, renderTemplate, TemplateError } from './parts/template';
import { meetsThreshold } from './parts/thresholds';
import { parseSlotExamples } from './parts/examples';
import { BUILT_IN_SLOT_TYPES, registerSlotType } from './registry';
import { defineSlotType } from './slotType';
import { birthdateType } from './birthdate/index';
import { choiceType } from './choice/index';
import { dateType } from './date/index';
import { digitsType } from './digits/index';
import { nameType } from './name/index';
import { textType } from './text/index';
import type { SlotType } from './types';

/** The library's skeleton: templates, parts, the registry, defineSlot's problems, examples. */

describe('templates', () => {
  it('fill {name} placeholders and keep any other brace', () => {
    expect(renderTemplate('Does the caller give {what}? {what}, {x y} and {}.', { what: 'a note' })).toBe('Does the caller give a note? a note, {x y} and {}.');
    expect(placeholdersOf('{a} {b} {a}')).toEqual(['a', 'b']);
  });

  it('refuse a placeholder the template is not given', () => {
    expect(() => renderTemplate('Give {what} by {when}.', { what: 'a note' }, 'the note')).toThrow(TemplateError);
    expect(() => checkTemplate('Give {what} by {when}.', ['what'], 'the note')).toThrow('the note uses {when}, which is not one of its variables; it may use {what}');
  });

  it('a type whose default names a variable it never gives fails when it is defined', () => {
    expect(() => textParts('demo', { ask: { template: 'Give {thing}.', vars: ['what'], about: 'the ask' } })).toThrow(
      'the "demo" type\'s default text for "ask" uses {thing}, which is not one of its variables; it may use {what}',
    );
  });
});

describe('text parts and question ids', () => {
  const parts = textParts('demo', { ask: { template: 'Give {what}.', vars: ['what'], about: 'the ask' } });
  const ids = questionParts({ ask: 'whether it is given', span: 'which span it is' });

  it('a literal replaces the default word for word; otherwise the template is filled', () => {
    expect(parts.render('ask', undefined, { what: 'a note' })).toBe('Give a note.');
    expect(parts.render('ask', { ask: 'Is there {a note}?' }, { what: 'a note' })).toBe('Is there {a note}?');
  });

  it('an id is the slot and the part unless the option names it', () => {
    expect(ids.id('note', 'ask', undefined)).toBe('noteAsk');
    expect(ids.id('note', 'span', { ask: 'x' })).toBe('noteSpan');
    expect(ids.id('note', 'span', { span: 'legacySpan' })).toBe('legacySpan');
  });

  it('the option schemas refuse a part the type does not have', () => {
    expect(parts.schema.safeParse({ ask: 'x' }).success).toBe(true);
    expect(parts.schema.safeParse({ nope: 'x' }).success).toBe(false);
    expect(ids.schema.safeParse({ span: 'not an id' }).success).toBe(false);
  });
});

describe('thresholds by name', () => {
  it('meets a named threshold with floating-point slack, and never one that is not there', () => {
    expect(meetsThreshold(DEFAULT_THRESHOLDS, 'SLOT_DETECT', 0.6)).toBe(true);
    expect(meetsThreshold(DEFAULT_THRESHOLDS, 'SLOT_DETECT', 0.59)).toBe(false);
    expect(meetsThreshold({ ...DEFAULT_THRESHOLDS, OWN: 0.4 }, 'OWN', 0.1 + 0.3)).toBe(true);
    expect(meetsThreshold(DEFAULT_THRESHOLDS, 'NOT_THERE', 1)).toBe(false);
  });
});

describe('the registry', () => {
  const echo = defineSlotType({
    type: 'echo',
    options: z.strictObject({}),
    build: (id) => ({ id, spokenConfirm: 'summary', questionIds: [], prompts: [], questions: () => ({}), fill: () => ({ kind: 'absent' }), display: (v) => v }),
    examples: [],
  });

  it('holds the built-in types, frozen', () => {
    expect(Object.keys(BUILT_IN_SLOT_TYPES)).toEqual(['birthdate', 'choice', 'date', 'digits', 'name', 'text']);
    expect(BUILT_IN_SLOT_TYPES.text).toBe(textType);
    expect(BUILT_IN_SLOT_TYPES.choice).toBe(choiceType);
    expect(BUILT_IN_SLOT_TYPES.birthdate).toBe(birthdateType);
    expect(BUILT_IN_SLOT_TYPES.date).toBe(dateType);
    expect(BUILT_IN_SLOT_TYPES.digits).toBe(digitsType);
    expect(BUILT_IN_SLOT_TYPES.name).toBe(nameType);
    expect(Object.isFrozen(BUILT_IN_SLOT_TYPES)).toBe(true);
  });

  it('adds an app\'s type to a new map, leaving the built-in one as it was, and refuses a name taken', () => {
    const types = registerSlotType(echo);
    expect(Object.keys(types)).toEqual(['birthdate', 'choice', 'date', 'digits', 'name', 'text', 'echo']);
    expect(Object.keys(BUILT_IN_SLOT_TYPES)).toEqual(['birthdate', 'choice', 'date', 'digits', 'name', 'text']);
    expect(defineSlot('ping', { type: 'echo' }, types).type).toBe('echo');
    expect(() => defineSlot('ping', { type: 'echo' })).toThrow('"type" is "echo", which is not a slot type here; the types are "birthdate", "choice", "date", "digits", "name", "text"');
    expect(() => registerSlotType(echo, types)).toThrow('a slot type named "echo" is already registered');
  });

  it('defineSlotType refuses a bad name and options that keep unknown keys', () => {
    expect(() => defineSlotType({ ...echo, type: 'Echo' })).toThrow('the slot type name "Echo" must be lower-case letters');
    expect(() => defineSlotType({ ...echo, options: z.object({}) })).toThrow('the "echo" type\'s options must refuse unknown keys: build them with z.strictObject');
  });

  it('defineSlotType keeps a lazy examples getter lazy', () => {
    let reads = 0;
    const lazy: SlotType<Record<string, never>> = {
      ...echo,
      get examples() {
        reads += 1;
        return [];
      },
    };
    expect(defineSlotType(lazy)).toBe(lazy);
    expect(reads).toBe(0);
  });
});

describe('buildSlot from a YAML file', () => {
  it('points each problem at its line and column', () => {
    const text = ['note:', '  type: text', '  what: a note', '  maxLenght: 40', 'other:', '  type: txt', ''].join('\n');
    const lines = new LineCounter();
    const doc = parseDocument(text, { lineCounter: lines });
    const note = buildSlot('note', doc.toJS().note, { source: { file: 'slots.yaml', doc, lines, at: ['note'] } });
    const other = buildSlot('other', doc.toJS().other, { source: { file: 'slots.yaml', doc, lines, at: ['other'] } });
    expect(!note.ok && note.problems.map(formatProblem)).toEqual(['slots.yaml:4:3  note.maxLenght  unknown key "maxLenght" under note  ->  rename "maxLenght" to "maxLength"']);
    expect(!other.ok && other.problems.map(formatProblem)).toEqual(['slots.yaml:6:9  other.type  "type" is "txt", which is not a slot type here; the types are "birthdate", "choice", "date", "digits", "name", "text"  ->  change it to "text"']);
  });

  it('refuses a slot id that is not an id, and a configuration that is not a map', () => {
    expect((buildSlot('my note', { type: 'text', what: 'a note' }) as { problems: { message: string }[] }).problems[0]!.message).toContain('the slot id "my note" is not valid');
    expect((buildSlot('note', 'text') as { problems: { message: string }[] }).problems[0]!.message).toBe('the slot "note" must be a map with a "type" and that type\'s options');
  });

  it('a built slot runs like a hand-written one', () => {
    const slot = defineSlot('note', { type: 'text', what: 'a note' });
    expect(slot.fill({ noteGiven: noul(0.9) }, testSlotContext('by the gate'))).toMatchObject({ kind: 'filled', value: 'by the gate' });
  });
});

describe('examples.yaml', () => {
  it('parses, and refuses an unknown key or a repeated name with the file named', () => {
    const one = 'name: a\n  slot: a\n  config: {}\n  utterances:\n    - { text: hi, expect: { kind: absent } }';
    expect(parseSlotExamples(`- ${one}`)).toHaveLength(1);
    expect(() => parseSlotExamples(`- ${one}\n- ${one}`, 'x.yaml')).toThrow('x.yaml: two examples are named "a"');
    expect(() => parseSlotExamples(`- ${one}\n  extra: 1`, 'x.yaml')).toThrow('x.yaml: 0');
  });
});
