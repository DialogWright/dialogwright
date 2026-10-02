import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { SlotOutcome } from '../../core/slots/types';
import { atLeast } from '../../core/thresholds';
import { isNoul, noulValue, type NoulAnswer } from '../../jev/types';
import { meetsThreshold } from '../parts/thresholds';
import { birthdateType } from '../birthdate/index';
import { choiceType } from '../choice/index';
import { digitsType } from '../digits/index';
import { textType } from '../text/index';
import type { BuiltSlotSpec, SlotExample, SlotType } from '../types';
import { CHECK_IDS, ConformanceError, slotConformanceChecks, type CheckId, type SlotConformanceOptions } from './checks';
import { runSlotConformance } from './run';

/**
 * The kit's own proof: a small, correct toy type passes every check, and each broken copy of it
 * fails exactly the check meant to catch its fault, with a message that says what is wrong.
 */

const options = z.strictObject({ minLength: z.number().int().min(1).default(3) });
type ToyOptions = z.output<typeof options>;

/** A correct toy: the caller's words as a value, at least minLength long, or four keys. */
function correctBuild(id: string, o: ToyOptions): BuiltSlotSpec {
  const said = `${id}Said`;
  const display = (value: string): string => value;
  return {
    id,
    spokenConfirm: 'summary',
    detect: true,
    questionIds: [said],
    prompts: [{ id: `ask_${id}_short`, why: 'the words are too short' }],
    questions: () => ({ [said]: { type: 'noul', instructions: 'Read asr.text. Does the caller say the word?' } }),
    fill(answers, ctx): SlotOutcome {
      const p = noulValue(answers, said);
      if (!meetsThreshold(ctx.thresholds, 'SLOT_DETECT', p)) return { kind: 'absent' };
      const value = ctx.text.trim();
      if (value.length < o.minLength) return { kind: 'invalid', reason: 'short', raw: value, retryPromptId: `ask_${id}_short` };
      return { kind: 'filled', value, display: display(value), confidence: p, confirm: 'none' };
    },
    dtmf: { length: 4, parse: (d) => (/^\d{4}$/.test(d) ? { value: d, display: display(d) } : null) },
    display,
  };
}

const EXAMPLES: SlotExample[] = [
  {
    name: 'word',
    slot: 'word',
    config: {},
    utterances: [
      { text: 'hello', answers: { wordSaid: { noul: 0.9 } }, expect: { kind: 'filled', value: 'hello' } },
      { text: 'ok', answers: { wordSaid: { noul: 0.9 } }, expect: { kind: 'invalid', reason: 'short', retryPromptId: 'ask_word_short' } },
      { text: 'never mind', answers: { wordSaid: { noul: 0.1 } }, expect: { kind: 'absent' } },
    ],
    keypad: [
      { digits: '5551', expect: { value: '5551' } },
      { digits: '55a1', expect: null },
    ],
  },
];

/** The toy, with `change` applied to what it builds (a broken copy), under its own name. */
function toy(name: string, change: (spec: BuiltSlotSpec, id: string, o: ToyOptions) => Partial<BuiltSlotSpec> = () => ({}), over: Partial<SlotType<ToyOptions>> = {}): SlotType<ToyOptions> {
  return {
    type: name,
    options,
    build(id, o) {
      const spec = correctBuild(id, o);
      return { ...spec, ...change(spec, id, o) };
    },
    examples: EXAMPLES,
    ...over,
  };
}

/** The checks a type fails, each with its message. */
function failures(type: SlotType<any>, opts: SlotConformanceOptions = {}): Map<CheckId, string> {
  const out = new Map<CheckId, string>();
  for (const check of slotConformanceChecks(type, opts)) {
    try {
      check.run();
    } catch (e) {
      expect(e).toBeInstanceOf(ConformanceError);
      out.set(check.id, `${out.get(check.id) ?? ''}${(e as Error).message}\n`);
    }
  }
  return out;
}

const failing = (type: SlotType<any>, opts?: SlotConformanceOptions): CheckId[] => [...failures(type, opts).keys()].sort();

describe('the correct toy, and the built-in types', () => {
  it('pass every check', () => {
    expect(failing(toy('toy'), { locales: ['en-US', 'es'] })).toEqual([]);
    expect(failing(textType, { locales: ['en-US', 'es'] })).toEqual([]);
    expect(failing(digitsType, { locales: ['en-US', 'es'] })).toEqual([]);
    expect(failing(choiceType, { locales: ['en-US', 'es'] })).toEqual([]);
    expect(failing(birthdateType, { locales: ['en-US', 'es'] })).toEqual([]);
  });
});

describe('each broken toy fails the check meant to catch it', () => {
  it('a display that disagrees with the fill: display', () => {
    const broken = toy('toy-display', (spec) => ({ display: (v: string) => `"${v}"`, dtmf: spec.dtmf }));
    const f = failures(broken);
    expect([...f.keys()]).toEqual(['display', 'keypad']);
    expect(f.get('display')).toContain('the fill of "hello" (no locale) carries the display "hello", but display("hello", undefined) is "\\"hello\\""');
  });

  it('a display that formats en-US apart from no locale: display', () => {
    const shout = (v: string, locale?: string) => (locale === 'en-US' ? v.toUpperCase() : v);
    const broken = toy('toy-en', (spec, id) => ({
      display: shout,
      fill: (a, ctx) => {
        const o = spec.fill(a, ctx);
        return o.kind === 'filled' ? { ...o, display: shout(o.value, ctx.locale) } : o;
      },
    }));
    const f = failures(broken);
    expect([...f.keys()]).toEqual(['display']);
    expect(f.get('display')).toContain('display("hello") is "hello" without a locale but "HELLO" in en-US');
  });

  it('a question id it does not declare: question-ids', () => {
    const broken = toy('toy-undeclared', (spec, id) => ({
      questions: (ctx) => ({ ...spec.questions(ctx), [`${id}Extra`]: { type: 'noul', instructions: 'Read asr.text. Anything else?' } }),
    }));
    const f = failures(broken);
    expect([...f.keys()]).toEqual(['question-ids']);
    expect(f.get('question-ids')).toContain('asks "wordExtra", which questionIds does not declare');
  });

  it('ids not derived from the slot id, so two slots would share them: question-ids', () => {
    const broken = toy('toy-shared', (spec) => ({ questionIds: ['said'], questions: (ctx) => ({ said: spec.questions(ctx).wordSaid ?? Object.values(spec.questions(ctx))[0]! }), fill: (a, ctx) => spec.fill({ wordSaid: a.said!, ...a }, ctx) }));
    const f = failures(broken, { examples: [{ ...EXAMPLES[0]!, utterances: EXAMPLES[0]!.utterances.map((u) => ({ ...u, answers: { said: u.answers!.wordSaid! } })) }] });
    expect([...f.keys()]).toEqual(['question-ids']);
    expect(f.get('question-ids')).toContain('a second slot of this type would ask the same question ids (said)');
  });

  it('ids that change from one build to the next: question-ids', () => {
    let n = 0;
    const broken = toy('toy-unstable', (spec) => {
      const id = `wordSaid${n++}`;
      return { questionIds: [id], questions: (ctx) => ({ [id]: Object.values(spec.questions(ctx))[0]! }), fill: (a, ctx) => spec.fill({ ...a, wordSaid: a[id]! }, ctx) };
    });
    expect(failures(broken).get('question-ids')).toContain('the same configuration declares other ids when built again');
  });

  it('a question id the engine asks: refused when it is built', () => {
    const broken = toy('toy-engine', (spec) => ({ questionIds: ['urgency'], questions: (ctx) => ({ urgency: Object.values(spec.questions(ctx))[0]! }) }));
    const f = failures(broken);
    expect(f.get('builds')).toContain('slot "word" declares the question id "urgency", which is one the engine asks');
  });

  it('a threshold written into the type and none read by name: thresholds', () => {
    const broken = toy('toy-literal', (spec, id, o) => ({
      fill: (a, ctx) => {
        const p = noulValue(a, `${id}Said`);
        if (!(p >= 0.6)) return { kind: 'absent' };
        const value = ctx.text.trim();
        if (value.length < o.minLength) return { kind: 'invalid', reason: 'short', raw: value, retryPromptId: `ask_${id}_short` };
        return { kind: 'filled', value, display: value, confidence: p, confirm: 'none' };
      },
    }));
    const f = failures(broken);
    expect([...f.keys()]).toEqual(['thresholds']);
    expect(f.get('thresholds')).toContain('fills without reading a threshold from ctx.thresholds');
  });

  it('a threshold written in beside the one read by name: thresholds, by scaling', () => {
    const broken = toy('toy-hidden', (spec, id) => ({
      fill: (a, ctx) => (atLeast(noulValue(a, `${id}Said`), 0.6) ? spec.fill(a, ctx) : { kind: 'absent' }),
    }));
    const f = failures(broken);
    expect([...f.keys()]).toEqual(['thresholds']);
    expect(f.get('thresholds')).toContain('utterance "hello" gives absent with every probability and threshold scaled by 0.5, but filled "hello" ("hello") as written');
  });

  it('a fill that throws on an answer of the wrong type: malformed', () => {
    const broken = toy('toy-throws', (spec, id) => ({
      fill: (a, ctx) => {
        const answer = a[`${id}Said`] as NoulAnswer | undefined;
        if (answer && answer.noul.toFixed(2) === 'x') return { kind: 'absent' };
        return spec.fill(a, ctx);
      },
    }));
    const f = failures(broken);
    expect([...f.keys()]).toEqual(['malformed']);
    expect(f.get('malformed')).toContain('fill on every answer a choice without its fields');
  });

  it('a fill that takes a missing answer as a yes: empty', () => {
    const broken = toy('toy-missing', (spec, id) => ({
      fill: (a, ctx) => spec.fill(a[`${id}Said`] ? a : { [`${id}Said`]: { type: 'noul', noul: 1 } }, ctx),
    }));
    const f = failures(broken);
    expect(f.get('empty')).toContain('no answers ("hello", unprompted, nothing on file) gave filled "hello" ("hello"), not absent');
  });

  it('a fill that hears a value in answers that say nothing: quiet', () => {
    const broken = toy('toy-quiet', (spec, id) => ({
      fill: (a, ctx) => {
        const answer = a[`${id}Said`];
        if (ctx.prompted && isNoul(answer) && answer.noul === 0 && ctx.text) return { kind: 'filled', value: ctx.text, display: ctx.text, confidence: 0, confirm: 'none' };
        return spec.fill(a, ctx);
      },
    }));
    const f = failures(broken);
    expect([...f.keys()]).toEqual(['quiet']);
    expect(f.get('quiet')).toContain('quiet answers ("hello", prompted, nothing on file) gave filled "hello" ("hello"): a slot that hears nothing must be absent or invalid');
  });

  it('an options schema that keeps unknown keys: unknown-keys', () => {
    const broken = toy('toy-loose', undefined, { options: z.object({ minLength: z.number().int().min(1).default(3) }) as unknown as typeof options });
    const f = failures(broken);
    expect([...f.keys()]).toEqual(['unknown-keys']);
    expect(f.get('unknown-keys')).toContain('the option "notAnOption" was accepted: an unknown key must be refused');
  });

  it('keys of any length taken as a value: keypad', () => {
    const broken = toy('toy-keys', () => ({ dtmf: { length: 4, parse: (d: string) => (/^\d+$/.test(d) ? { value: d, display: d } : null) } }));
    const f = failures(broken);
    expect([...f.keys()]).toEqual(['keypad']);
    expect(f.get('keypad')).toContain('the keys "55515" (5, not 4) gave "55515": keys of a wrong length must give none');
  });

  it('a retry line it does not declare: prompts', () => {
    const broken = toy('toy-prompt', () => ({ prompts: [] }));
    const f = failures(broken);
    expect([...f.keys()]).toEqual(['prompts']);
    expect(f.get('prompts')).toContain('the slot can lead to the line "ask_word_short" (the retryPromptId of utterance "ok"), which its prompts do not declare');
  });

  it('a disambiguation line declared without its variables: prompts', () => {
    const broken = toy('toy-pair', (spec, id) => ({
      prompts: [...spec.prompts, { id: `disambiguate_${id}`, why: 'two words are close' }],
      fill: (a, ctx) => (ctx.text === 'hello' && noulValue(a, `${id}Said`) > 0 ? { kind: 'disambiguate', a: { value: 'hello', display: 'hello' }, b: { value: 'hallo', display: 'hallo' } } : spec.fill(a, ctx)),
    }));
    const f = failures(broken, { examples: [{ ...EXAMPLES[0]!, utterances: [{ ...EXAMPLES[0]!.utterances[0]!, expect: { kind: 'disambiguate' } }, ...EXAMPLES[0]!.utterances.slice(1), { text: 'hello there', answers: { wordSaid: { noul: 0.9 } }, expect: { kind: 'filled' } }] }] });
    expect([...f.keys()]).toEqual(['prompts']);
    expect(f.get('prompts')).toContain('the line "disambiguate_word" is given a, b (the disambiguation of utterance "hello"), which its declared vars (none) leave out');
  });

  it('an utterance that gives another outcome than the example expects: utterances', () => {
    const wrong: SlotExample = { ...EXAMPLES[0]!, utterances: [{ text: 'hello', answers: { wordSaid: { noul: 0.9 } }, expect: { kind: 'filled', value: 'goodbye' } }] };
    const f = failures(toy('toy'), { examples: [wrong] });
    expect([...f.keys()]).toEqual(['utterances']);
    expect(f.get('utterances')).toContain('utterance "hello" gave filled "hello" ("hello"); expected value "goodbye"');
  });

  it('an example that answers a question the slot does not ask, and none that fills: utterances', () => {
    const wrong: SlotExample = { ...EXAMPLES[0]!, utterances: [{ text: 'hello', answers: { wordSays: { noul: 0.9 } }, expect: { kind: 'absent' } }] };
    const f = failures(toy('toy'), { examples: [wrong] });
    expect(f.get('utterances')).toContain('no utterance fills the slot');
    expect(f.get('utterances')).toContain('utterance "hello" answers "wordSays", which is not one of the slot\'s questions (wordSaid)');
  });

  it('a type with no examples fails', () => {
    expect(failing(toy('toy-none', undefined, { examples: [] }))).toEqual(['utterances']);
  });
});

describe('runSlotConformance', () => {
  it('registers a group per example and a test per check, with the runner it is given', () => {
    const names: string[] = [];
    const runs: (() => void)[] = [];
    runSlotConformance(toy('toy'), {
      describe: (name, fn) => {
        names.push(`describe ${name}`);
        fn();
      },
      it: (name, fn) => {
        names.push(`it ${name}`);
        runs.push(fn);
      },
    });
    expect(names[0]).toBe('describe slot type "toy" conforms');
    expect(names[1]).toBe('describe example "word"');
    expect(names.filter((n) => n.startsWith('it '))).toHaveLength(CHECK_IDS.length);
    expect(names).toContain('it thresholds: thresholds are read by name from ctx.thresholds, never written into the type');
    for (const run of runs) run();
  });
});
