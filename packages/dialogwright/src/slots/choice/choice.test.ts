import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { SlotOutcome, SlotSpec } from '../../core/slots/types';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { isChoice } from '../../jev/types';
import { formatProblem } from '../../define/problems';
import { choice } from '../../testing/answers';
import { shadowSlot } from '../../testing/shadowSlot';
import { testSlotContext } from '../../testing/slots';
import { DAY_PART_DISPLAY } from '../../testing/testkit/domain/slots/deliveryPart';
import { deliveryPartSlot } from '../../testing/testkit/domain/slots/deliveryPart';
import { quietAnswers } from '../conformance/turns';
import { runSlotConformance } from '../conformance/run';
import { buildSlot, defineSlot, slotTypeJsonSchema } from '../defineSlot';
import { choiceType } from './index';

/** The `choice` type: the conformance kit over its examples, then what the kit does not cover. */
runSlotConformance(choiceType, { describe, it, locales: ['en-US', 'es'] });

const T = DEFAULT_THRESHOLDS;
const ctx = (text = '') => testSlotContext(text);
const speed = defineSlot('speed', {
  type: 'choice',
  keypad: true,
  options: { standard: { say: 'standard delivery' }, express: 'express delivery', next_day: { say: 'next-day delivery', means: 'Delivery on the next day, whatever it is called' } },
});

describe('a choice slot built from the defaults', () => {
  it('asks one question, named after the slot, with a criterion for each option in order and one for none', () => {
    expect(speed.questionIds).toEqual(['speed']);
    const q = speed.questions(ctx('express'));
    expect(Object.keys(q)).toEqual(['speed']);
    expect(q.speed).toEqual({
      type: 'choice',
      instructions: 'Read asr.text. Which of these does the caller name?',
      criteria: {
        standard: 'The caller names standard delivery',
        express: 'The caller names express delivery',
        next_day: 'Delivery on the next day, whatever it is called',
        none: 'Names none of these',
      },
    });
    expect(Object.keys((q.speed as { criteria: object }).criteria)).toEqual(['standard', 'express', 'next_day', 'none']);
  });

  it('gives a fresh question each call, so nothing a turn does to it reaches the next', () => {
    const first = speed.questions(ctx());
    (first.speed as { criteria: Record<string, string> }).criteria.standard = 'changed';
    expect((speed.questions(ctx()).speed as { criteria: Record<string, string> }).criteria.standard).toBe('The caller names standard delivery');
  });

  it('is summarized, not detected, not masked, and declares its keypad line', () => {
    expect(speed).toMatchObject({ spokenConfirm: 'summary' });
    expect(speed.detect).toBeUndefined();
    expect(speed.redact).toBeUndefined();
    expect(speed.handoff).toBeUndefined();
    expect(speed.prompts).toEqual([{ id: 'ask_speed_dtmf', why: 'it asks for the option on the keypad after spoken answers missed' }]);
    expect(defineSlot('speed', { type: 'choice', options: { a: 'A' } }).prompts).toEqual([]);
  });

  it('carries its type and its parsed options, defaults applied and every option with its display', () => {
    expect(speed.type).toBe('choice');
    expect(speed.config).toEqual({
      options: { standard: { say: 'standard delivery' }, express: { say: 'express delivery' }, next_day: { say: 'next-day delivery', means: 'Delivery on the next day, whatever it is called' } },
      means: 'The caller names {say}',
      none: 'Names none of these',
      instructions: 'Read asr.text. Which of these does the caller name?',
      keypad: true,
      fillAt: 'SLOT_CHOICE_FILL',
      confirm: 'summary',
    });
    expect(Object.keys((speed.config as { options: object }).options)).toEqual(['standard', 'express', 'next_day']);
    expect(Object.isFrozen(speed.config)).toBe(true);
  });
});

describe('fill', () => {
  it('fills the option the model chose, with its display, when the model is sure', () => {
    expect(speed.fill({ speed: choice({ express: 0.9, none: 0.1 }) }, ctx())).toEqual({ kind: 'filled', value: 'express', display: 'express delivery', confidence: 0.9, confirm: 'none' });
  });

  it('is absent for none, for a label that is no option, for a choice below the threshold and for no answer', () => {
    expect(speed.fill({ speed: choice({ none: 0.9, express: 0.1 }) }, ctx())).toEqual({ kind: 'absent' });
    expect(speed.fill({ speed: choice({ overnight: 0.9, none: 0.1 }) }, ctx())).toEqual({ kind: 'absent' });
    expect(speed.fill({ speed: choice({ express: 0.5, none: 0.5 }) }, ctx())).toEqual({ kind: 'absent' });
    expect(speed.fill({}, ctx())).toEqual({ kind: 'absent' });
  });

  it('does not take a label the object inherits, such as constructor', () => {
    expect(speed.fill({ speed: choice({ constructor: 0.95, none: 0.05 }) }, ctx())).toEqual({ kind: 'absent' });
    expect(speed.display('toString')).toBe('toString');
  });

  it('reads SLOT_CHOICE_FILL from the context, at the threshold and not below it', () => {
    expect(speed.fill({ speed: choice({ express: T.SLOT_CHOICE_FILL, none: 1 - T.SLOT_CHOICE_FILL }) }, ctx()).kind).toBe('filled');
    expect(speed.fill({ speed: choice({ express: T.SLOT_CHOICE_FILL - 0.01, none: 0.4 }) }, ctx()).kind).toBe('absent');
    expect(speed.fill({ speed: choice({ express: 0.9, none: 0.1 }) }, testSlotContext('', { thresholds: { ...T, SLOT_CHOICE_FILL: 0.95 } })).kind).toBe('absent');
  });

  it('fillAt names the threshold to read instead', () => {
    const loose = defineSlot('speed', { type: 'choice', options: { a: 'A', b: 'B' }, fillAt: 'SLOT_CHOICE_CONFIRM' });
    const between = (T.SLOT_CHOICE_FILL + T.SLOT_CHOICE_CONFIRM) / 2;
    expect(loose.fill({ speed: choice({ a: between, b: 1 - between }) }, ctx())).toMatchObject({ kind: 'filled', value: 'a' });
    expect(speed.fill({ speed: choice({ express: between, none: 1 - between }) }, ctx()).kind).toBe('absent');
    expect(loose.fill({ speed: { type: 'choice', choice: 'a', probabilities: { a: T.SLOT_CHOICE_CONFIRM - 0.01, b: 0.3, none: 0.26 }, confidence: T.SLOT_CHOICE_CONFIRM - 0.01 } }, ctx()).kind).toBe('absent');
    const bad = buildSlot('speed', { type: 'choice', options: { a: 'A' }, fillAt: 'SLOT_DETECT' });
    expect(!bad.ok && bad.problems.map((p) => p.path)).toEqual(['speed.fillAt']);
  });

  it('a choice with no probabilities falls back to its confidence, and a malformed one is absent', () => {
    expect(speed.fill({ speed: { type: 'choice', choice: 'express', probabilities: {}, confidence: 0.9 } }, ctx())).toMatchObject({ kind: 'filled', confidence: 0.9 });
    expect(speed.fill({ speed: { type: 'choice', choice: 'express', confidence: 0.9 } as never }, ctx())).toMatchObject({ kind: 'filled', confidence: 0.9 });
    expect(speed.fill({ speed: { type: 'choice' } as never }, ctx())).toEqual({ kind: 'absent' });
  });

  it('a quiet model never fills it', () => {
    expect(speed.fill(quietAnswers(speed.questions(ctx())), ctx())).toEqual({ kind: 'absent' });
  });
});

describe('the keypad', () => {
  it('chooses by position: 1 is the first option, in the order written', () => {
    expect(speed.dtmf?.length).toBe(1);
    expect(speed.dtmf!.parse('1', ctx())).toEqual({ value: 'standard', display: 'standard delivery' });
    expect(speed.dtmf!.parse('2', ctx())).toEqual({ value: 'express', display: 'express delivery' });
    expect(speed.dtmf!.parse('3', ctx())).toEqual({ value: 'next_day', display: 'next-day delivery' });
  });

  it('gives none for a digit past the options, for 0, and for anything but one digit', () => {
    for (const keys of ['4', '9', '0', '', '12', 'a', '#', '*', '01', '1.0', ' 1']) expect(speed.dtmf!.parse(keys, ctx()), JSON.stringify(keys)).toBeNull();
  });

  it('is off unless asked for, and the keypad has nine digits', () => {
    expect(defineSlot('speed', { type: 'choice', options: { a: 'A' } }).dtmf).toBeUndefined();
    const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`o${i + 1}`, `Option ${i + 1}`]));
    expect(defineSlot('nine', { type: 'choice', options: nine, keypad: true }).dtmf!.parse('9', ctx())).toEqual({ value: 'o9', display: 'Option 9' });
    const ten = buildSlot('ten', { type: 'choice', options: { ...nine, o10: 'Option 10' }, keypad: true });
    expect(!ten.ok && ten.problems.map(formatProblem)).toEqual(['(code)  ten.keypad  keypad is true, but the slot has 10 options and the keypad has the digits 1 to 9  ->  set keypad: false, or keep 9 options or fewer']);
    expect(buildSlot('ten', { type: 'choice', options: { ...nine, o10: 'Option 10' } }).ok).toBe(true);
  });
});

describe('the words', () => {
  it('instructions, none and means (a template over {say} and {key}) replace the defaults word for word', () => {
    const slot = defineSlot('colour', {
      type: 'choice',
      instructions: 'Which colour of case?',
      none: 'No colour',
      means: 'The {key} case, said as {say}',
      options: { black: 'black', forest: { say: 'forest green' }, white: { say: 'white', means: 'White, {say} or cream' } },
    });
    expect(slot.questions(ctx()).colour).toEqual({
      type: 'choice',
      instructions: 'Which colour of case?',
      criteria: { black: 'The {key} case, said as {say}'.replace('{key}', 'black').replace('{say}', 'black'), forest: 'The forest case, said as forest green', white: 'White, {say} or cream', none: 'No colour' },
    });
  });

  it('an option\'s own means is a literal: braces in it are kept as written', () => {
    const slot = defineSlot('s', { type: 'choice', options: { a: { say: 'A', means: 'Says {a}' } } });
    expect((slot.questions(ctx()).s as { criteria: Record<string, string> }).criteria.a).toBe('Says {a}');
  });

  it('ids.choice keeps the id a question was recorded with', () => {
    const slot = defineSlot('colour', { type: 'choice', options: { a: 'A' }, ids: { choice: 'caseColour' } });
    expect(slot.questionIds).toEqual(['caseColour']);
    expect(Object.keys(slot.questions(ctx()))).toEqual(['caseColour']);
    expect(slot.fill({ caseColour: choice({ a: 0.9, none: 0.1 }) }, ctx()).kind).toBe('filled');
  });

  it('refuses an id the engine asks', () => {
    const r = buildSlot('colour', { type: 'choice', options: { a: 'A' }, ids: { choice: 'intent' } });
    expect(!r.ok && r.problems.map((p) => p.path)).toEqual(['colour.ids.choice']);
  });
});

describe('the options', () => {
  const problems = (config: Record<string, unknown>) => {
    const r = buildSlot('s', { type: 'choice', ...config });
    return r.ok ? [] : r.problems.map(formatProblem);
  };

  it('need at least one', () => {
    expect(problems({ options: {} })).toEqual(['(code)  s.options  a choice slot needs at least one option  ->  add an option, such as "standard: Standard delivery"']);
    expect(problems({})).toHaveLength(1);
  });

  it('cannot be called none, and are named as an id, which also keeps their order', () => {
    expect(problems({ options: { none: 'None' } })).toEqual([
      '(code)  s.options.none  "none" is the label the model chooses when the caller names no option, so an option cannot be called that  ->  rename the option; set the criterion of "none" with the `none` option',
    ]);
    expect(problems({ options: { 'next day': 'Next day' } })).toEqual([
      '(code)  s.options["next day"]  the option key "next day" is not valid: it must start with a letter and use only letters, digits and underscores  ->  rename it using only letters, digits and underscores, starting with a letter (for example "next_day")',
    ]);
    // a key like "1" would be sorted ahead of the others by JavaScript, losing the order written
    expect(problems({ options: { b: 'B', '1': 'One' } })).toHaveLength(1);
  });

  it('take a say, and a means only as an option of its own; an unknown key under an option is refused', () => {
    expect(problems({ options: { a: { say: 'A', mean: 'x' } } })).toHaveLength(1);
    expect(problems({ options: { a: { means: 'x' } } })).toHaveLength(1);
    expect(problems({ options: { a: '' } })).toHaveLength(1);
    expect(problems({ options: { a: 'two\nlines' } })).toHaveLength(1);
  });

  it('means may use {say} and {key} only', () => {
    expect(problems({ options: { a: 'A' }, means: 'The caller names {name}' })).toEqual([
      '(code)  s.means  means uses {name}, which is not one of its variables  ->  use {say} (what the option says) and {key} (its key), or write the criterion on the option itself',
    ]);
    expect(problems({ options: { a: 'A' }, means: 'Says {say} ({key})' })).toEqual([]);
  });

  it('a shorthand option and its long form are the same option', () => {
    const short = defineSlot('s', { type: 'choice', options: { a: 'Apple' } });
    const long = defineSlot('s', { type: 'choice', options: { a: { say: 'Apple' } } });
    expect(short.config).toEqual(long.config);
    expect(short.questions(ctx())).toEqual(long.questions(ctx()));
  });
});

describe('display', () => {
  it('says an option as it says, and a value that is no option as it is', () => {
    expect(speed.display('next_day')).toBe('next-day delivery');
    expect(speed.display('overnight')).toBe('overnight');
    expect(speed.display('next_day', 'es')).toBe('next-day delivery');
  });
});

describe('the testkit\'s delivery part, written as configuration', () => {
  // Proof that the options reach a hand-written slot exactly, through the same shadow harness the
  // migration uses: its own words, the ids it was recorded with, its keypad.
  const library = defineSlot('deliveryPart', {
    type: 'choice',
    instructions: 'Read asr.text alone. Which part of the day do these words name for a delivery?',
    none: 'Names no part of the day',
    keypad: true,
    options: {
      morning: { say: DAY_PART_DISPLAY.morning, means: 'The morning, before noon' },
      afternoon: { say: DAY_PART_DISPLAY.afternoon, means: 'The afternoon, from noon until about five' },
      evening: { say: DAY_PART_DISPLAY.evening, means: 'The evening, after about five' },
    },
  });
  const shadow = shadowSlot(deliveryPartSlot, library);

  it('asks the same question and fills the same way on every branch', () => {
    shadow.questions(ctx(''));
    shadow.questions(ctx('in the morning'));
    for (const label of ['morning', 'afternoon', 'evening', 'none', 'night']) {
      for (const p of [0.05, 0.3, 0.44, 0.5, 0.56, 0.7, 0.9, 1]) {
        shadow.fill({ deliveryPart: choice({ [label]: p, ...(label === 'none' ? {} : { none: 1 - p }) }) }, ctx('x'));
        shadow.fill({ deliveryPart: { type: 'choice', choice: label, probabilities: {}, confidence: p } }, ctx('x'));
      }
    }
    shadow.fill({}, ctx());
    shadow.fill({ deliveryPart: { type: 'noul', noul: 0.9 } } as never, ctx());
    for (const keys of ['1', '2', '3', '4', '0', '', '9']) shadow.dtmf!.parse(keys, ctx());
    for (const value of ['morning', 'evening', 'dawn']) shadow.display(value);
  });
});

describe('the library fixture\'s book and branch, written as configuration', () => {
  // They were hand-written (a choiceSlot over a table) before they were choice slots; this is that
  // slot, as it was, shadowed by the same options with the old words.
  const options = { river_atlas: 'The River Atlas', quiet_orchard: 'A Quiet Orchard' };
  const legacy: SlotSpec = {
    id: 'book',
    spokenConfirm: 'summary',
    questionIds: ['book'],
    prompts: [],
    questions: () => ({
      book: {
        type: 'choice',
        instructions: 'Read asr.text. Which book in the catalog does the caller name?',
        criteria: { ...Object.fromEntries(Object.entries(options).map(([key, name]) => [key, `The caller names ${name}`])), none: 'Names none of these' },
      },
    }),
    fill(answers, c): SlotOutcome {
      const a = answers.book;
      if (!isChoice(a) || !Object.hasOwn(options, a.choice)) return { kind: 'absent' };
      const p = a.probabilities[a.choice] ?? a.confidence;
      if (p < c.thresholds.SLOT_CHOICE_FILL) return { kind: 'absent' };
      return { kind: 'filled', value: a.choice, display: options[a.choice as keyof typeof options], confidence: p, confirm: 'none' };
    },
    display: (value) => options[value as keyof typeof options] ?? value,
  };
  const library = defineSlot('book', { type: 'choice', instructions: 'Read asr.text. Which book in the catalog does the caller name?', options });
  const shadow = shadowSlot(legacy, library);

  it('asks the same question and fills the same way, probabilities away from the threshold', () => {
    // (the old slot compared with < and the type with atLeast: they differ only within 1e-9 of the threshold)
    shadow.questions(ctx('the atlas'));
    for (const label of ['river_atlas', 'quiet_orchard', 'none', 'other']) {
      for (const p of [0.1, 0.44, 0.5, 0.56, 0.95]) shadow.fill({ book: choice({ [label]: p, ...(label === 'none' ? {} : { none: 1 - p }) }) }, ctx('x'));
    }
    shadow.fill({}, ctx());
    expect(shadow.dtmf).toBeUndefined();
  });
});

describe('the docs', () => {
  it('the README names every option', () => {
    const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
    const options = Object.keys((slotTypeJsonSchema(choiceType).properties ?? {}) as object).filter((k) => k !== 'type');
    expect(options.sort()).toEqual(['confirm', 'fillAt', 'ids', 'instructions', 'keypad', 'means', 'none', 'options']);
    for (const option of options) expect(readme, option).toContain(`\`${option}\``);
  });
});
