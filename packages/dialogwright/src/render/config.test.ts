import { describe, expect, it } from 'vitest';
import type { FormsYaml, PromptYaml } from '../define/schema/index';
import { formLineIds, generatedWordingOf, generatedWordingProblems, generatedWordingWarnings, identifierVarsFrom, KB_ANSWER_LINE_VAR, summarizedVarsFrom } from './config';
import { KB_ANSWER_VAR } from '../kb/answer';
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

  it('the message fixture generates its form\'s questions, frames its read-back with the summary a span generated from the message, and prescribes two', () => {
    const g = messageApp.generated!;
    expect(Object.keys(g.lines)).toEqual(['confirm_take_message', 'ask_recipient', 'ask_recipient_retry', 'ask_caller', 'ask_caller_retry', 'ask_phone', 'ask_phone_retry', 'ask_message', 'ask_message_retry']);
    expect(g.lines.confirm_take_message).toMatchObject({ spans: { summary: { from: 'message', words: 25 } }, situations: ['first-ask'], by: 'prompt', summarizesConfirmed: true });
    expect(g.lines.confirm_take_message!.from).toBeUndefined();
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

  it('a knowledge base\'s answer line is never generated: refused on the line, left fixed by its form', () => {
    expect(problems({ kb_answer: line('{answer}', { mode: 'generative', goal: 'Say it.' }) })).toEqual([
      'prompts.yaml prompts.kb_answer.mode: the line "kb_answer" says a knowledge base\'s answer ({answer}), which is an approved passage said word for word, never generated',
    ]);
    expect(KB_ANSWER_LINE_VAR).toBe(KB_ANSWER_VAR);
    const g = generatedWordingOf({ prompts: { ask_x: line('X?'), confirm_x: line('So {answer}?') }, forms: { f: form(['x'], { wording: 'generative', summaryPromptId: null }) }, style: null, localePrompts: {} })!;
    expect(Object.keys(g.lines)).toEqual(['ask_x']);
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

describe('a generated read-back that summarizes a confirmed value (review fixes)', () => {
  const prompts = {
    ask_note: line('Your note?'),
    confirm_f: line('So: {note}. Right?', { mode: 'generative', goal: 'Read it back.', from: ['note'] }),
  };
  const forms = { f: form(['note'], { summaryPromptId: 'confirm_f', calls: ['save'] }) };
  it('needs summarizesConfirmed when a confirmed rule of an action its form calls holds the value', () => {
    expect(generatedWordingProblems({ prompts, forms, localePrompts: {}, identifierVars: new Set(), confirmed: { save: ['note'] } }).map((p) => p.message)).toEqual([
      'the line "confirm_f" may summarize {note}, which a confirmed rule holds the caller to confirming exactly, so the caller would confirm a value they heard summarized',
    ]);
    const accepted = { ...prompts, confirm_f: { ...prompts.confirm_f, summarizesConfirmed: true as const } };
    expect(generatedWordingProblems({ prompts: accepted, forms, localePrompts: {}, identifierVars: new Set(), confirmed: { save: ['note'] } })).toEqual([]);
    expect(generatedWordingProblems({ prompts: accepted, forms, localePrompts: {}, identifierVars: new Set(), confirmed: { save: [] } }).map((p) => p.path.join('.'))).toEqual(['prompts.confirm_f.summarizesConfirmed']);
  });
});

describe('a framed line: a fixed line with generated spans (generate)', () => {
  const FRAME = '{caller} called and left this message: {summary}. Shall I pass it on?';
  const framed = (more: Partial<PromptYaml> = {}): PromptYaml => line(FRAME, { generate: { summary: { from: 'message', goal: 'Summarize the message in one sentence.' } }, ...more });
  const forms = { f: form(['caller', 'message'], { summaryPromptId: 'confirm_f', calls: ['save'] }) };
  const problems = (prompts: Record<string, PromptYaml>, localePrompts: Record<string, Record<string, PromptYaml>> = {}, confirmed: Record<string, string[]> = {}) =>
    generatedWordingProblems({ prompts, forms, localePrompts, identifierVars: new Set(['accountId']), slots: ['caller', 'message', 'accountId'], confirmed }).map((p) => `${p.file} ${p.path.join('.')}: ${p.message}`);

  it('is a generated line whose spans alone are generated, each with its goal, its content and its word budget', () => {
    const g = generatedWordingOf({ prompts: { confirm_f: framed({ when: { situations: ['first-ask'] }, summarizesConfirmed: true }) }, forms, style: null, localePrompts: { es: { confirm_f: line('{caller} dejó este mensaje: {summary}. ¿Lo paso?', { generate: { summary: { goal: 'Resumir el mensaje.' } } }) } } })!;
    expect(g.lines.confirm_f).toEqual({
      goal: 'Said as written, but for its generated spans.',
      situations: ['first-ask'],
      by: 'prompt',
      summarizesConfirmed: true,
      spans: { summary: { from: 'message', goal: 'Summarize the message in one sentence.', words: 25 } },
    });
    expect(g.localeGoals).toEqual({});
    expect(g.localeSpanGoals).toEqual({ es: { confirm_f: { summary: 'Resumir el mensaje.' } } });
    // Its form's switch does not make it a line generated whole.
    const switched = generatedWordingOf({ prompts: { confirm_f: framed() }, forms: { f: form(['caller', 'message'], { summaryPromptId: 'confirm_f', wording: 'generative' }) }, style: null, localePrompts: {} })!;
    expect(switched.lines.confirm_f!.spans).toBeDefined();
    expect(switched.lines.confirm_f!.by).toBe('prompt');
  });

  it('an app with no framed line has no span goals: its App is as it was', () => {
    const g = generatedWordingOf({ prompts: { a: line('Hi.', { mode: 'generative', goal: 'Greet.' }) }, forms: {}, style: null, localePrompts: {} })!;
    expect(Object.keys(g)).toEqual(['lines', 'prescribed', 'style', 'localeGoals']);
  });

  it('check holds it: a framed line is fine as written, and summarizesConfirmed counts its span\'s content', () => {
    expect(problems({ confirm_f: framed() })).toEqual([]);
    expect(problems({ confirm_f: framed() }, {}, { save: ['message'] })).toEqual([
      'prompts.yaml prompts.confirm_f.generate: the line "confirm_f" may summarize {message}, which a confirmed rule holds the caller to confirming exactly, so the caller would confirm a value they heard summarized',
    ]);
    expect(problems({ confirm_f: framed({ summarizesConfirmed: true }) }, {}, { save: ['message'] })).toEqual([]);
  });

  it('check refuses it prescribed, with a mode, a goal or a from of the whole line', () => {
    expect(problems({ a: framed({ prescribed: true }) })).toEqual(['prompts.yaml prompts.a.generate: the line "a" is prescribed (prescribed: true), so it is always said word for word and no span of it is generated']);
    expect(problems({ a: framed({ mode: 'generative', goal: 'Read it back.', from: ['message'] }) })).toEqual([
      'prompts.yaml prompts.a.mode: the line "a" is framed (generate): only its spans are generated and every other word is fixed, so "mode: generative" does not apply',
      'prompts.yaml prompts.a.goal: the line "a" is framed (generate): each span has its own goal, so a goal of the whole line does nothing',
      'prompts.yaml prompts.a.from: the line "a" is framed (generate): each span names the content it is worded from in its own "from"',
    ]);
    expect(problems({ a: framed({ mode: 'fixed' }) })).toEqual(['prompts.yaml prompts.a.mode: the line "a" is framed (generate): only its spans are generated and every other word is fixed, so "mode: fixed" does not apply']);
  });

  it('check refuses a span its text does not say, a span named for a slot, and content that is no slot, another span or an identifier', () => {
    const g = (generate: NonNullable<PromptYaml['generate']>, text = FRAME) => problems({ a: line(text, { generate }) });
    expect(g({ gist: { from: 'message', goal: 'Sum it up.' } })).toEqual(['prompts.yaml prompts.a.generate.gist: the line "a" has no {gist}, so the span "gist" would never be said']);
    expect(g({ caller: { from: 'message', goal: 'Sum it up.' } })).toEqual(['prompts.yaml prompts.a.generate.caller: {caller} is a slot, the value the call collected, so it cannot also be a span the model words']);
    expect(g({ summary: { goal: 'Sum it up.' } })).toEqual(['prompts.yaml prompts.a.generate.summary: the span "summary" of the line "a" names no content to be worded from, so it would have nothing to summarize and nothing to say when it is not generated']);
    expect(g({ summary: { from: 'note', goal: 'Sum it up.' } })).toEqual(['prompts.yaml prompts.a.generate.summary.from: the span "summary" is worded from "note", which is not a slot, so there is no content for it']);
    expect(g({ summary: { from: 'gist', goal: 'Sum it up.' }, gist: { from: 'message', goal: 'Sum it up.' } }, '{summary} and {gist}')).toEqual(['prompts.yaml prompts.a.generate.summary.from: the span "summary" is worded from {gist}, another span of the line, which is worded, never collected']);
    expect(g({ summary: { from: 'accountId', goal: 'Sum it up.' } })).toEqual(['prompts.yaml prompts.a.generate.summary.from: the span "summary" is worded from {accountId}, which holds an identifier (an identity factor, or a slot hidden whole in the records); a model is never sent an identifier']);
  });

  it('a frame may name an identifier: it is never sent to a model', () => {
    expect(problems({ a: line('For account {accountId}: {summary}.', { generate: { summary: { from: 'message', goal: 'Sum it up.' } } }) })).toEqual([]);
  });

  it('in a locale: its text says every span, a span gives only its goal, and only a span prompts.yaml frames', () => {
    expect(problems({ confirm_f: framed(), b: line('Bye.') }, {
      es: {
        confirm_f: line('{caller} llamó. ¿Lo paso?', { goal: 'Leer.', generate: { summary: { from: 'message', goal: 'Resumir.', words: 10 }, gist: { goal: 'Resumir.' } } }),
        b: line('Adiós.', { generate: { x: { goal: 'Algo.' } } }),
      },
    })).toEqual([
      'locale/es/prompts.yaml prompts.confirm_f.goal: the line "confirm_f" is framed in prompts.yaml (generate): only its spans are generated, so a goal of the whole line does nothing',
      'locale/es/prompts.yaml prompts.confirm_f.text: the line "confirm_f" is framed in prompts.yaml with a generated span {summary}, which this locale\'s text does not say, so the content it gives would never be heard in this locale',
      'locale/es/prompts.yaml prompts.confirm_f.generate.summary.from: a span\'s "from" is read from prompts.yaml, for every locale; a locale gives a span only its goal',
      'locale/es/prompts.yaml prompts.confirm_f.generate.summary.words: a span\'s "words" is read from prompts.yaml, for every locale; a locale gives a span only its goal',
      'locale/es/prompts.yaml prompts.confirm_f.generate.gist: prompts.yaml frames no span {gist} in the line "confirm_f" (it frames {summary}), so this one does nothing',
      'locale/es/prompts.yaml prompts.b.generate.x: the line "b" is not framed in prompts.yaml, so a span here does nothing',
    ]);
  });

  it('check warns, never refuses, of a line generated whole from what the caller said, pointing to the framed form', () => {
    const whole = line('Your message: {message}. Shall I pass it on?', { mode: 'generative', goal: 'Read it back.', from: ['message'] });
    expect(generatedWordingWarnings({ prompts: { confirm_f: whole, ask_x: line('X?', { mode: 'generative', goal: 'Ask.' }), c2: framed() }, forms, localePrompts: {} }).map((w) => `${w.path.join('.')}: ${w.message}  ->  ${w.fix}`)).toEqual([
      'prompts.confirm_f.from: the line "confirm_f" is generated whole from what the caller said ({message}): whether the line says it as the caller\'s words, not the agent\'s own, rests on the checks and on a model\'s judgement  ->  frame it instead: keep the line fixed, saying whose words they are, with a generated span for the summary ("{caller} left this message: {summary}", and generate: { summary: { from: message, goal: ... } }); or keep it, as the app\'s choice',
    ]);
    expect(problems({ confirm_f: whole })).toEqual([]);
  });
});

describe('a framed line (review fixes)', () => {
  const FRAME = '{caller} called and left this message: {summary}. Shall I pass it on?';
  const span = (from: string): PromptYaml => line(FRAME, { generate: { summary: { from, goal: 'Summarize it.' } } });
  const forms = { f: form(['caller', 'message', 'phone'], { summaryPromptId: 'confirm_f' }) };
  it('check refuses a span worded from a slot its line\'s form does not ask: the line is never given it', () => {
    const problems = (prompts: Record<string, PromptYaml>) => generatedWordingProblems({ prompts, forms, localePrompts: {}, identifierVars: new Set(), slots: ['caller', 'message', 'phone', 'other'] }).map((p) => `${p.path.join('.')}: ${p.message}`);
    expect(problems({ confirm_f: span('other') })).toEqual(['prompts.confirm_f.generate.summary.from: the span "summary" is worded from "other", which the form "f" does not ask, so the line is never given it']);
    expect(problems({ confirm_f: span('message') })).toEqual([]);
    // A line of no form: any slot.
    expect(problems({ somewhere: span('other') })).toEqual([]);
  });
  it('check warns, never refuses, of a span worded from a slot the records mask: its value goes to the model whole', () => {
    const warnings = generatedWordingWarnings({ prompts: { confirm_f: span('phone'), c2: span('message') }, forms, localePrompts: {}, redacted: { phone: 'last4' } });
    expect(warnings.map((w) => `${w.path.join('.')}: ${w.message}`)).toEqual([
      'prompts.confirm_f.generate.summary.from: the span "summary" is worded from {phone}, which the records keep by its last four (redact: last4), and a model is sent it whole to word the span',
    ]);
    expect(generatedWordingProblems({ prompts: { confirm_f: span('phone') }, forms, localePrompts: {}, identifierVars: new Set(), slots: ['caller', 'message', 'phone'] })).toEqual([]);
  });
});

describe('acknowledge: false (live findings, item 18)', () => {
  it('a line\'s own wins over its form\'s; absent everywhere, the line is as it was', () => {
    const g = generatedWordingOf({
      prompts: {
        thanks: line('Thanks.', { mode: 'generative', goal: 'Thank them.', acknowledge: false }),
        ask_a: line('What is a?'),
        ask_a_retry: line('Sorry, a?', { acknowledge: true }),
        ask_b: line('What is b?'),
      },
      forms: { f: form(['a'], { wording: 'generative', acknowledge: false }), g: form(['b'], { wording: 'generative' }) },
      style: null,
      localePrompts: {},
    })!;
    expect(g.lines.thanks).toMatchObject({ acknowledge: false });
    expect(g.lines.ask_a).toMatchObject({ acknowledge: false });
    expect(Object.hasOwn(g.lines.ask_a_retry!, 'acknowledge')).toBe(false);
    expect(Object.hasOwn(g.lines.ask_b!, 'acknowledge')).toBe(false);
  });

  it('check refuses it where it does nothing: a line not generated, a framed line, a form that generates nothing, a locale', () => {
    const problems = generatedWordingProblems({
      prompts: {
        fixed: line('Fixed.', { acknowledge: false }),
        confirm_note: line('You said: {summary}. Right?', { generate: { summary: { from: 'note', goal: 'Sum it up.' } }, acknowledge: false }),
        ask_note: line('Your note?'),
      },
      forms: { f: form(['note'], { acknowledge: false }) },
      localePrompts: { es: { ask_note: line('¿Su nota?', { acknowledge: false }) } },
      identifierVars: new Set(),
      slots: ['note'],
    }).map((p) => `${p.file} ${p.path.join('.')}: ${p.message}`);
    expect(problems).toEqual([
      'prompts.yaml prompts.fixed.acknowledge: the line "fixed" is not generated (no mode: generative, and no form that generates its lines), so its "acknowledge" does nothing',
      'prompts.yaml prompts.confirm_note.acknowledge: the line "confirm_note" is framed (generate): only its spans are generated, and a span never acknowledges the caller, so "acknowledge" does nothing',
      'forms.yaml forms.f.acknowledge: the form "f" does not generate its lines (no wording: generative), so its "acknowledge" does nothing',
      'locale/es/prompts.yaml prompts.ask_note.acknowledge: "acknowledge" is read from prompts.yaml, for every locale; a locale gives a generated line only its goal',
    ]);
  });

  it('check warns of a form\'s acknowledge that no line takes: each line generated by its own mode or saying its own', () => {
    const warn = (prompts: Record<string, PromptYaml>) => generatedWordingWarnings({ prompts, forms: { f: form(['a'], { wording: 'generative', acknowledge: false }) }, localePrompts: {} }).map((w) => `${w.path.join('.')}: ${w.message}`);
    expect(warn({ ask_a: line('What is a?', { mode: 'generative', goal: 'Ask a.' }) })).toEqual(['forms.f.acknowledge: the form "f" says acknowledge: false, but no line takes it: each line it generates is generated by its own mode: generative or says its own "acknowledge"']);
    expect(warn({ ask_a: line('What is a?', { acknowledge: true }) })).toHaveLength(1);
    expect(warn({ ask_a: line('What is a?'), ask_a_retry: line('Sorry, a?', { acknowledge: true }) })).toEqual([]);
  });
});

describe('a framed line with a frame for the exact words (exactText; the secretary demo, live findings, item 20)', () => {
  const SHORT = '{caller} called and said, in short, {summary}. Shall I pass it on?';
  const EXACT = '{caller} called and said: {summary}. Shall I pass it on?';
  const framed = (more: Partial<PromptYaml> = {}): PromptYaml => line(SHORT, { generate: { summary: { from: 'message', goal: 'Summarize it.' } }, ...more });
  const forms = { f: form(['caller', 'message'], { summaryPromptId: 'confirm_f' }) };
  const problems = (prompts: Record<string, PromptYaml>, localePrompts: Record<string, Record<string, PromptYaml>> = {}) =>
    generatedWordingProblems({ prompts, forms, localePrompts, identifierVars: new Set(), slots: ['caller', 'message'] }).map((p) => `${p.file} ${p.path.join('.')}: ${p.message}`);

  it('check holds it: on a framed line, naming the same variables as its text', () => {
    expect(problems({ confirm_f: framed({ exactText: EXACT }) })).toEqual([]);
    expect(problems({ confirm_f: framed({ exactText: '{caller} called and said: {message}. Shall I pass it on?' }) })).toEqual([
      'prompts.yaml prompts.confirm_f.exactText: the line "confirm_f"\'s frame for the exact words (exactText) names {caller}, {message}, not the variables of its text ({caller}, {summary}), so the two would not say the same values',
    ]);
  });

  it('check refuses it on a line that is not framed, and on a prescribed one', () => {
    expect(problems({ a: line('Bye, {caller}.', { exactText: 'Bye.' }) })).toEqual([
      'prompts.yaml prompts.a.exactText: the line "a" is not framed (no generate), so it has no span that is said word for word, and "exactText" (a framed line\'s frame for its exact words) does not apply to it',
    ]);
    expect(problems({ a: framed({ exactText: EXACT, prescribed: true }) })).toEqual([
      'prompts.yaml prompts.a.exactText: the line "a" is not framed (no generate, and it is prescribed), so it has no span that is said word for word, and "exactText" (a framed line\'s frame for its exact words) does not apply to it',
      'prompts.yaml prompts.a.generate: the line "a" is prescribed (prescribed: true), so it is always said word for word and no span of it is generated',
    ]);
  });

  it('a locale mirrors it: its own where prompts.yaml has one, with its text\'s variables, and none where prompts.yaml has none', () => {
    const es = (more: Partial<PromptYaml> = {}): PromptYaml => line('{caller} llamó y dijo, en resumen, {summary}. ¿Lo paso?', more);
    expect(problems({ confirm_f: framed({ exactText: EXACT }) }, { es: { confirm_f: es({ exactText: '{caller} llamó y dijo: {summary}. ¿Lo paso?' }) } })).toEqual([]);
    expect(problems({ confirm_f: framed({ exactText: EXACT }) }, { es: { confirm_f: es() } })).toEqual([
      'locale/es/prompts.yaml prompts.confirm_f: prompts.yaml gives the line "confirm_f" a frame of its own for the exact words (exactText), and this locale gives none, so its text would be said with the exact words too',
    ]);
    expect(problems({ confirm_f: framed({ exactText: EXACT }) }, { es: { confirm_f: es({ exactText: 'Llamó y dijo: {summary}.' }) } })).toEqual([
      'locale/es/prompts.yaml prompts.confirm_f.exactText: the line "confirm_f"\'s frame for the exact words names {summary}, not the variables of this locale\'s text ({caller}, {summary}), so the two would not say the same values',
    ]);
    expect(problems({ confirm_f: framed() }, { es: { confirm_f: es({ exactText: '{caller} llamó y dijo: {summary}. ¿Lo paso?' }) } })).toEqual([
      'locale/es/prompts.yaml prompts.confirm_f.exactText: prompts.yaml gives the line "confirm_f" no frame of its own for the exact words (exactText), so a locale\'s own does not apply: a locale mirrors prompts.yaml',
    ]);
    expect(problems({ b: line('Bye.') }, { es: { b: line('Adiós.', { exactText: 'Adiós.' }) } })).toEqual([
      'locale/es/prompts.yaml prompts.b.exactText: the line "b" is not framed in prompts.yaml, so a frame for its exact words does nothing',
    ]);
  });
});

describe('a slot masked in the records that a model summarizes (redact: length-summarized; live findings, item 20)', () => {
  const FRAME = '{caller} called and left this message: {summary}. Shall I pass it on?';
  const forms = { f: form(['caller', 'message'], { summaryPromptId: 'confirm_f' }) };
  const problems = (prompts: Record<string, PromptYaml>, factors: string[] = []) =>
    generatedWordingProblems({ prompts, forms, localePrompts: {}, identifierVars: new Set(['message', ...factors]), slots: ['caller', 'message'], summarized: ['message'], factors }).map((p) => `${p.file} ${p.path.join('.')}: ${p.message}`);

  it('lets a framed span, or a line generated from it, be worded from it; a line naming it as an item stays refused', () => {
    expect(problems({ confirm_f: line(FRAME, { generate: { summary: { from: 'message', goal: 'Sum it up.' } } }) })).toEqual([]);
    expect(problems({ confirm_f: line('Your message: {message}. Shall I pass it on?', { mode: 'generative', goal: 'Read it back.', from: ['message'] }) })).toEqual([]);
    expect(problems({ confirm_f: line(FRAME, { generate: { summary: { from: 'message', goal: 'Sum it up.' } } }), other: line('You said {message}.', { mode: 'generative', goal: 'Say it.' }) })).toEqual([
      'prompts.yaml prompts.other.mode: the line "other" is generated, but it names {message}, which holds an identifier (an identity factor, or a slot hidden whole in the records); a generated line is never sent an identifier',
    ]);
    // A form's switch leaves a line that names it as an item fixed.
    const g = generatedWordingOf({ prompts: { confirm_f: line('So {caller}, and {message}?') }, forms: { f: form(['caller', 'message'], { summaryPromptId: 'confirm_f', wording: 'generative' }) }, style: null, localePrompts: {}, identifierVars: new Set(['message']), summarized: new Set(['message']) });
    expect(g).toBeUndefined();
  });

  it('check refuses it on a slot no generated line summarizes, and on an identity factor', () => {
    expect(problems({ ask: line('What is the message?') })).toEqual([
      'slots.yaml message.redact: the slot "message" says "redact: length-summarized", but no generated line summarizes it (no framed span and no line generated from it), so nothing would be sent to a model and the setting only names an exception it does not use',
    ]);
    expect(problems({ confirm_f: line(FRAME, { generate: { summary: { from: 'message', goal: 'Sum it up.' } } }) }, ['message'])).toEqual([
      'slots.yaml message.redact: the slot "message" is an identity factor, and "redact: length-summarized" would send it whole to a model; an identity factor is never sent to one',
      'prompts.yaml prompts.confirm_f.generate.summary.from: the span "summary" is worded from {message}, which holds an identifier (an identity factor, or a slot hidden whole in the records); a model is never sent an identifier',
    ]);
    expect(summarizedVarsFrom({ message: { summarized: true }, dob: { summarized: true }, note: {} }, ['dob'])).toEqual(new Set(['message']));
  });
});
