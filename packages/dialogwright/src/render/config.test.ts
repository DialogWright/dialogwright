import { describe, expect, it } from 'vitest';
import type { FormsYaml, PromptYaml } from '../define/schema/index';
import { formLineIds, generatedWordingOf, generatedWordingProblems, identifierVarsFrom } from './config';
import { messageApp } from '../testing/message/app';

/**
 * Which lines an app generates (App.generated), and what `pnpm check` holds generated wording to: the
 * app decides, line by line or form by form; a prescribed line is never generated; a generated line
 * names no identifier; a locale gives a line only its goal.
 */

const line = (text: string, more: Partial<PromptYaml> = {}): PromptYaml => ({ text, interruptible: true, ...more });
const form = (slots: string[], more: Partial<FormsYaml['forms'][string]> = {}): FormsYaml['forms'][string] => ({ slots, summaryPromptId: `confirm_${slots[0]}_form`, ...more }) as FormsYaml['forms'][string];

describe('generatedWordingOf', () => {
  it('is undefined for an app that generates nothing and prescribes nothing: its App is as it was', () => {
    expect(generatedWordingOf({ prompts: { hi: line('Hi.') }, forms: { f: form(['a']) }, style: null, localePrompts: {} })).toBeUndefined();
  });

  it('a line by its own mode, the lines of a form by its switch but for one that says fixed, is prescribed, or names an identifier', () => {
    const g = generatedWordingOf({
      prompts: {
        greeting: line('Hello.', { prescribed: true }),
        thanks: line('Thanks.', { mode: 'generative', goal: 'Thank them.', when: { situations: ['frustrated'], channels: ['voice'] } }),
        ask_a: line('What is a?'),
        ask_a_retry: line('Sorry, a?'),
        ask_a_dtmf: line('Key in a.', { mode: 'fixed' }),
        confirm_a: line('{a}, right?', { prescribed: true }),
        ask_id: line('Your id?'),
        confirm_id: line('Is it {id}?'),
        confirm_a_form: line('So {a} and {id}?'),
        other: line('Other.'),
      },
      forms: { f: form(['a', 'id'], { wording: 'generative' }) },
      style: { words: { voice: 30 } },
      localePrompts: { es: { thanks: line('Gracias.', { goal: 'Darles las gracias.' }), ask_a: line('¿Qué es a?', { goal: 'Preguntar a.' }) } },
      identifierVars: new Set(['id']),
    })!;
    expect(Object.keys(g.lines)).toEqual(['thanks', 'ask_a', 'ask_a_retry', 'ask_id']);
    expect(g.lines.thanks).toEqual({ goal: 'Thank them.', situations: ['frustrated'], channels: ['voice'], by: 'prompt' });
    expect(g.lines.ask_a).toEqual({ goal: 'Say what the fixed line says, in words that fit this moment.', by: { form: 'f' } });
    expect(g.prescribed).toEqual(['confirm_a', 'greeting']);
    expect(g.style).toEqual({ persona: 'a calm, plain-spoken agent', words: { voice: 30, chat: 40 }, avoid: [] });
    expect(g.localeGoals).toEqual({ es: { thanks: 'Darles las gracias.', ask_a: 'Preguntar a.' } });
  });

  it('a form\'s lines: its slots\' questions and read-backs with their variants, and its summary', () => {
    expect(formLineIds(['ask_a', 'ask_a_retry2', 'ask_ab', 'confirm_a', 'confirm_a_x', 'sum', 'ask_b'], ['a'], 'sum')).toEqual(['ask_a', 'ask_a_retry2', 'confirm_a', 'confirm_a_x', 'sum']);
  });

  it('an identifier is an identity factor, or a slot hidden whole in the records; one recorded by its last four is a data item', () => {
    expect([...identifierVarsFrom({ a: { redact: 'last4' }, b: { redact: 'mask' }, c: { redact: 'length' }, d: {} }, ['dob'])].sort()).toEqual(['b', 'c', 'dob']);
  });

  it('the message fixture generates its form\'s lines and its read-back from the message, and prescribes two', () => {
    const g = messageApp.generated!;
    expect(Object.keys(g.lines)).toEqual(['confirm_take_message', 'ask_recipient', 'ask_recipient_retry', 'ask_caller', 'ask_caller_retry', 'ask_phone', 'ask_phone_retry', 'ask_message', 'ask_message_retry']);
    expect(g.lines.confirm_take_message).toMatchObject({ from: ['message'], situations: ['first-ask'], by: 'prompt' });
    expect(g.prescribed).toEqual(['greeting', 'message_taken']);
  });
});

describe('generatedWordingProblems', () => {
  const problems = (prompts: Record<string, PromptYaml>, forms: FormsYaml['forms'] = {}, localePrompts: Record<string, Record<string, PromptYaml>> = {}) =>
    generatedWordingProblems({ prompts, forms, localePrompts, identifierVars: new Set(['accountId']) }).map((p) => `${p.file} ${p.path.join('.')}: ${p.message}`);

  it('refuses mode: generative on a prescribed line', () => {
    expect(problems({ legal: line('Calls are recorded.', { prescribed: true, mode: 'generative', goal: 'Say it.' }) })).toEqual([
      'prompts.yaml prompts.legal.mode: the line "legal" is prescribed (prescribed: true), so it is always said word for word and never generated',
    ]);
  });

  it('a generated line needs a goal, names no identifier, and generates from its own variables', () => {
    expect(problems({
      a: line('Hi.', { mode: 'generative' }),
      b: line('Is it {accountId}?', { mode: 'generative', goal: 'Check.' }),
      c: line('Your note: {note}.', { mode: 'generative', goal: 'Read it.', from: ['message'] }),
    })).toEqual([
      'prompts.yaml prompts.a: the line "a" is generated (mode: generative) but has no goal, so the model would not know what the line is for',
      'prompts.yaml prompts.b.mode: the line "b" is generated, but it names {accountId}, which holds an identifier (an identity factor, or a slot hidden whole in the records); a generated line is never sent an identifier',
      'prompts.yaml prompts.c.from.0: the line "c" has no {message}, so it cannot be generated from it',
    ]);
  });

  it('a goal, when or from on a line that is not generated does nothing', () => {
    expect(problems({ a: line('Hi.', { goal: 'Greet.' }) })).toEqual(['prompts.yaml prompts.a.goal: the line "a" is not generated (no mode: generative, and no form that generates its lines), so its "goal" does nothing']);
    expect(problems({ ask_x: line('X?', { goal: 'Ask x.' }) }, { f: form(['x'], { wording: 'generative' }) })).toEqual([]);
  });

  it('a form whose switch generates nothing, and a locale that sets more than a goal or a goal for a fixed line', () => {
    expect(problems({ ask_x: line('X?', { mode: 'fixed' }) }, { f: form(['x'], { wording: 'generative' }) })).toEqual([
      'forms.yaml forms.f.wording: the form "f" says wording: generative, but none of its lines is generated (each is mode: fixed, prescribed, names an identifier, or is not in prompts.yaml)',
    ]);
    expect(problems({ a: line('Hi.', { mode: 'generative', goal: 'Greet.' }), b: line('Bye.') }, {}, { es: { a: line('Hola.', { mode: 'generative', goal: 'Saludar.' }), b: line('Adiós.', { goal: 'Despedirse.' }) } })).toEqual([
      'locale/es/prompts.yaml prompts.a.mode: "mode" is read from prompts.yaml, for every locale; a locale gives a generated line only its goal',
      'locale/es/prompts.yaml prompts.b.goal: the line "b" is not generated in prompts.yaml, so its goal here does nothing',
    ]);
  });
});
