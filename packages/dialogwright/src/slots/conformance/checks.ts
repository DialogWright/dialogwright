import { ENGINE_QUESTION_IDS } from '../../core/questionIds';
import type { SlotContext, SlotOutcome, SlotPartial } from '../../core/slots/types';
import { canonicalJson } from '../../jev/cassette';
import type { AnswerMap, QuestionMap } from '../../jev/types';
import { buildSlot, defineSlot, slotTypeJsonSchema } from '../defineSlot';
import { BUILT_IN_SLOT_TYPES } from '../registry';
import { refusesUnknownKeys } from '../slotType';
import type { ExampleContext, LibrarySlotSpec, SlotExample, SlotType, SlotTypes, SlotUtterance } from '../types';
import {
  answersOf, describeOutcome, essence, kitContext, MALFORMED_ANSWERS, MALFORMED_KEYS, outcomeProblem, quietAnswers,
  recordingThresholds, scaleAnswers, scaleThresholds,
} from './turns';

/**
 * The conformance kit: what any slot type, built in or contributed, must do to run in the engine.
 * Each check runs over every example configuration of the type (its examples.yaml) and throws,
 * with every problem it found, when the type fails it. runSlotConformance (./run.ts) registers them
 * as tests; slotConformanceChecks returns them for any other runner.
 */

/** The checks, by id. */
export const CHECK_IDS = [
  'builds', 'unknown-keys', 'question-ids', 'empty', 'quiet', 'malformed', 'thresholds', 'display', 'keypad', 'prompts', 'utterances',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/** What each check proves, in a sentence (a test's name, and the README's table). */
export const CHECK_ABOUT: Readonly<Record<CheckId, string>> = {
  builds: 'the configuration builds a slot that declares its question ids and its lines',
  'unknown-keys': 'an option the type does not have is refused, with a problem that names it',
  'question-ids': 'questions() asks only the ids the slot declares, none of them the engine\'s, the same ids for the same configuration, and other ids for another slot',
  empty: 'no answers at all give absent',
  quiet: 'answers that hear nothing for the slot give absent or invalid, never a value',
  malformed: 'answers of the wrong type, missing or out of range, and keys that are no value, never make it throw',
  thresholds: 'thresholds are read by name from ctx.thresholds, never written into the type',
  display: 'display(value, locale) is the display every fill, keypad value and candidate carries, in every locale',
  keypad: 'keys of the right length give the value the example expects, and keys of a wrong length give none',
  prompts: 'every line an outcome can lead to is in the slot\'s prompts, with the variables it is given',
  utterances: 'each example utterance gives the outcome it expects',
};

export interface ConformanceCheck {
  id: CheckId;
  /** The example the check runs over. */
  example: string;
  /** What it proves. */
  name: string;
  /** Throws, listing every problem, when the type fails the check. */
  run(): void;
}

export interface SlotConformanceOptions {
  /** Locales to format values in, beyond each utterance's own (default: en-US). */
  locales?: readonly string[];
  /** The types the examples are built with; the type under test is added. Default: the built-in ones. */
  types?: SlotTypes;
  /** The examples to run. Default: the type's own. */
  examples?: readonly SlotExample[];
}

/** A failed check: every problem found, one per line. */
export class ConformanceError extends Error {
  readonly problems: readonly string[];

  constructor(type: string, check: CheckId, example: string, problems: readonly string[]) {
    const shown = problems.slice(0, 12);
    const more = problems.length > shown.length ? `\n  ... and ${problems.length - shown.length} more` : '';
    super(`slot type "${type}", check "${check}", example "${example}": ${problems.length} problem${problems.length === 1 ? '' : 's'}\n${shown.map((p) => `  - ${p}`).join('\n')}${more}`);
    this.name = 'ConformanceError';
    this.problems = problems;
  }
}

/** A value already on file, for the contexts that have one. */
const ON_FILE = 'a value on file';
/** The probabilities and thresholds are multiplied by each of these for the thresholds check. */
const SCALES = [0.5, 0.2];
/** Above any probability or margin: a threshold raised to this can never be met. */
const UNREACHABLE = 2;

/** Every check of `type`, over each of its examples. */
export function slotConformanceChecks(type: SlotType<any>, options: SlotConformanceOptions = {}): ConformanceCheck[] {
  const types: SlotTypes = { ...(options.types ?? BUILT_IN_SLOT_TYPES), [type.type]: type };
  const locales = options.locales ?? ['en-US'];
  const examples = options.examples ?? type.examples;
  if (examples.length === 0) {
    return [{ id: 'utterances', example: '(none)', name: CHECK_ABOUT.utterances, run: () => { throw new ConformanceError(type.type, 'utterances', '(none)', ['the type has no examples: give at least one in its examples.yaml']); } }];
  }
  return examples.flatMap((example) =>
    CHECK_IDS.map((id) => ({
      id,
      example: example.name,
      name: CHECK_ABOUT[id],
      run: () => {
        const problems: string[] = [];
        RUNS[id]({ type, types, locales, example, fail: (p) => problems.push(p) });
        if (problems.length > 0) throw new ConformanceError(type.type, id, example.name, problems);
      },
    })),
  );
}

interface Run {
  type: SlotType<any>;
  types: SlotTypes;
  locales: readonly string[];
  example: SlotExample;
  fail(problem: string): void;
}

const configOf = (r: Run, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: r.type.type, ...r.example.config, ...extra });
const build = (r: Run, slot = r.example.slot): LibrarySlotSpec => defineSlot(slot, configOf(r), r.types);
const said = (u: SlotUtterance): string => JSON.stringify(u.text);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `fn`'s result, or undefined with a problem when it throws. */
function attempt<T>(r: Run, what: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    r.fail(`${what} threw: ${message(e)}`);
    return undefined;
  }
}

/** A fill, checked to be an outcome; undefined (with a problem) when it throws or is not one. */
function fillOf(r: Run, spec: LibrarySlotSpec, answers: AnswerMap, ctx: SlotContext, what: string): SlotOutcome | undefined {
  const outcome = attempt(r, `fill on ${what}`, () => spec.fill(answers, ctx));
  if (outcome === undefined) return undefined;
  const wrong = outcomeProblem(outcome);
  if (wrong) {
    r.fail(`${wrong} (${what})`);
    return undefined;
  }
  return outcome;
}

const where = (ctx: SlotContext): string =>
  `${JSON.stringify(ctx.text)}, ${ctx.prompted ? 'prompted' : 'unprompted'}, ${ctx.current === null ? 'nothing on file' : 'a value on file'}${ctx.window ? `, partial ${canonicalJson(ctx.window)}` : ''}${ctx.locale ? `, ${ctx.locale}` : ''}`;

/** The contexts the kit tries a slot in: no words and each utterance's, asked or not, with and without a value on file, in each locale, and each utterance's own. */
function contextsOf(r: Run, windows: readonly SlotPartial[] = []): SlotContext[] {
  const texts = ['', ...r.example.utterances.map((u) => u.text)];
  const out: SlotContext[] = [];
  for (const locale of [undefined, ...r.locales]) {
    for (const text of texts) {
      for (const over of [{}, { prompted: true }, { prompted: true, current: ON_FILE }, { current: ON_FILE }] as ExampleContext[]) out.push(kitContext(text, over, locale));
      for (const window of windows) out.push(kitContext(text, { prompted: true, window }, locale));
    }
  }
  for (const u of r.example.utterances) out.push(kitContext(u.text, u.context));
  return out;
}

/** The partial values the utterances give, for contexts with one pending. */
function windowsOf(r: Run, spec: LibrarySlotSpec): SlotPartial[] {
  const out: SlotPartial[] = [];
  for (const u of r.example.utterances) {
    if (u.context?.window) out.push(u.context.window);
    try {
      const o = spec.fill(answersOf(u.answers), kitContext(u.text, u.context));
      if (o?.kind === 'window') out.push(o.window);
    } catch {
      // the utterances check reports it
    }
  }
  return out;
}

const RUNS: Readonly<Record<CheckId, (r: Run) => void>> = {
  builds(r) {
    const spec = attempt(r, 'defineSlot', () => build(r));
    if (!spec) return;
    if (spec.id !== r.example.slot) r.fail(`the slot's id is "${spec.id}", not "${r.example.slot}"`);
    if (spec.type !== r.type.type) r.fail(`the slot's type is "${spec.type}", not "${r.type.type}"`);
    if (!Array.isArray(spec.questionIds)) r.fail('the slot declares no questionIds');
    if (!Array.isArray(spec.prompts)) r.fail('the slot declares no prompts (an empty list when it says nothing beyond its ask and retry)');
    const seen = new Set<string>();
    for (const p of spec.prompts ?? []) {
      if (!p.id || !p.why) r.fail(`a declared prompt needs an id and a why: ${JSON.stringify(p)}`);
      if (seen.has(p.id)) r.fail(`the prompt "${p.id}" is declared twice`);
      seen.add(p.id);
    }
  },

  'unknown-keys'(r) {
    if (!refusesUnknownKeys(r.type)) r.fail('the options schema accepts a key it does not know: build it with z.strictObject');
    const tries: { path: string; config: Record<string, unknown> }[] = [{ path: 'notAnOption', config: configOf(r, { notAnOption: true }) }];
    const properties = (slotTypeJsonSchema(r.type).properties ?? {}) as Record<string, unknown>;
    for (const group of ['text', 'ids']) {
      if (!Object.hasOwn(properties, group)) continue;
      const given = r.example.config[group];
      tries.push({ path: `${group}.notAPart`, config: configOf(r, { [group]: { ...(typeof given === 'object' && given !== null ? given : {}), notAPart: 'x' } }) });
    }
    for (const t of tries) {
      const key = t.path.split('.').pop()!;
      const result = attempt(r, `defineSlot with "${t.path}"`, () => buildSlot(r.example.slot, t.config, { types: r.types }));
      if (!result) continue;
      if (result.ok) {
        r.fail(`the option "${t.path}" was accepted: an unknown key must be refused`);
        continue;
      }
      const path = `${r.example.slot}.${t.path}`;
      const named = result.problems.find((p) => p.path === path && p.message.includes(`unknown key "${key}"`));
      if (!named) r.fail(`"${t.path}" was refused, but no problem points at ${path} as an unknown key: ${result.problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`);
      else if (!named.fix) r.fail(`the problem for "${t.path}" has no fix`);
    }
  },

  'question-ids'(r) {
    const spec = attempt(r, 'defineSlot', () => build(r));
    if (!spec) return;
    const declared = spec.questionIds ?? [];
    if (new Set(declared).size !== declared.length) r.fail(`questionIds lists an id twice: ${declared.join(', ')}`);
    for (const id of declared) if (ENGINE_QUESTION_IDS.includes(id)) r.fail(`the question id "${id}" is one the engine asks`);
    const again = attempt(r, 'defineSlot, a second time', () => build(r));
    if (again && canonicalJson(again.questionIds) !== canonicalJson(declared)) {
      r.fail(`the same configuration declares other ids when built again: ${declared.join(', ')}, then ${again.questionIds?.join(', ')}`);
    }
    if (!Object.hasOwn(r.example.config, 'ids')) {
      const other = attempt(r, 'defineSlot under another slot id', () => build(r, `${r.example.slot}Other`));
      const shared = (other?.questionIds ?? []).filter((id) => declared.includes(id));
      if (shared.length > 0) r.fail(`a second slot of this type would ask the same question ids (${shared.join(', ')}): derive each id from the slot's id`);
    }
    for (const ctx of contextsOf(r, windowsOf(r, spec))) {
      const qs = attempt(r, `questions(${where(ctx)})`, () => spec.questions(ctx));
      if (!qs) continue;
      for (const id of Object.keys(qs)) if (!declared.includes(id)) r.fail(`questions(${where(ctx)}) asks "${id}", which questionIds does not declare`);
      for (const problem of questionProblems(qs)) r.fail(`questions(${where(ctx)}): ${problem}`);
      const twice = attempt(r, `questions(${where(ctx)}), again`, () => spec.questions(ctx));
      const rebuilt = again ? attempt(r, `questions(${where(ctx)}), rebuilt`, () => again.questions(ctx)) : undefined;
      if (twice && canonicalJson(twice) !== canonicalJson(qs)) r.fail(`questions(${where(ctx)}) differ from one call to the next`);
      if (rebuilt && canonicalJson(rebuilt) !== canonicalJson(qs)) r.fail(`questions(${where(ctx)}) differ when the same configuration is built again`);
    }
  },

  empty(r) {
    const spec = attempt(r, 'defineSlot', () => build(r));
    if (!spec) return;
    for (const ctx of contextsOf(r, windowsOf(r, spec))) {
      const o = fillOf(r, spec, {}, ctx, `no answers (${where(ctx)})`);
      if (o && o.kind !== 'absent') r.fail(`no answers (${where(ctx)}) gave ${describeOutcome(o)}, not absent`);
    }
  },

  quiet(r) {
    const spec = attempt(r, 'defineSlot', () => build(r));
    if (!spec) return;
    for (const ctx of contextsOf(r, windowsOf(r, spec))) {
      const qs = attempt(r, `questions(${where(ctx)})`, () => spec.questions(ctx));
      if (!qs) continue;
      const o = fillOf(r, spec, quietAnswers(qs), ctx, `quiet answers (${where(ctx)})`);
      if (o && o.kind !== 'absent' && o.kind !== 'invalid') r.fail(`quiet answers (${where(ctx)}) gave ${describeOutcome(o)}: a slot that hears nothing must be absent or invalid`);
    }
  },

  malformed(r) {
    const spec = attempt(r, 'defineSlot', () => build(r));
    if (!spec) return;
    for (const u of r.example.utterances) {
      const ctx = kitContext(u.text, u.context);
      const qs = attempt(r, `questions(${where(ctx)})`, () => spec.questions(ctx));
      if (!qs) continue;
      const good = answersOf(u.answers);
      for (const bad of MALFORMED_ANSWERS) {
        const all = Object.fromEntries(Object.keys(qs).map((id) => [id, bad.answer])) as unknown as AnswerMap;
        fillOf(r, spec, all, ctx, `every answer ${bad.name} (${where(ctx)})`);
        for (const id of Object.keys(qs)) {
          fillOf(r, spec, { ...good, [id]: bad.answer } as unknown as AnswerMap, ctx, `"${id}" answered with ${bad.name} (${where(ctx)})`);
          const { [id]: _missing, ...rest } = good;
          fillOf(r, spec, rest, ctx, `"${id}" unanswered (${where(ctx)})`);
        }
      }
    }
    if (spec.dtmf) {
      for (const keys of MALFORMED_KEYS) attempt(r, `dtmf.parse(${JSON.stringify(keys)})`, () => spec.dtmf!.parse(keys, kitContext('')));
    }
  },

  thresholds(r) {
    const spec = attempt(r, 'defineSlot', () => build(r));
    if (!spec) return;
    for (const u of r.example.utterances) {
      const answers = answersOf(u.answers);
      const ctx = kitContext(u.text, u.context);
      const base = fillOf(r, spec, answers, ctx, `utterance ${said(u)}`);
      if (!base) continue;
      if (base.kind === 'filled') {
        const reads = new Set<string>();
        fillOf(r, spec, answers, { ...ctx, thresholds: recordingThresholds(ctx.thresholds, reads) }, `utterance ${said(u)}`);
        if (reads.size === 0) r.fail(`utterance ${said(u)} fills without reading a threshold from ctx.thresholds: compare the model's numbers to thresholds by name`);
        else {
          const raised = { ...ctx.thresholds, ...Object.fromEntries([...reads].map((name) => [name, UNREACHABLE])) };
          const o = fillOf(r, spec, answers, { ...ctx, thresholds: raised }, `utterance ${said(u)} with ${[...reads].join(', ')} at ${UNREACHABLE}`);
          if (o?.kind === 'filled') r.fail(`utterance ${said(u)} still fills with every threshold it reads (${[...reads].join(', ')}) out of reach: it decides by a number written in the type`);
        }
      }
      for (const k of SCALES) {
        const o = fillOf(r, spec, scaleAnswers(answers, k), { ...ctx, thresholds: scaleThresholds(ctx.thresholds, k) }, `utterance ${said(u)} scaled by ${k}`);
        if (o && essence(o) !== essence(base)) {
          r.fail(`utterance ${said(u)} gives ${describeOutcome(o)} with every probability and threshold scaled by ${k}, but ${describeOutcome(base)} as written: it compares against a number written in the type, not ctx.thresholds by name`);
        }
      }
    }
  },

  display(r) {
    const spec = attempt(r, 'defineSlot', () => build(r));
    if (!spec) return;
    const agree = (value: string, shown: string, locale: string | undefined, what: string): void => {
      const formatted = attempt(r, `display(${JSON.stringify(value)}, ${locale ?? 'no locale'})`, () => spec.display(value, locale));
      if (formatted !== undefined && formatted !== shown) r.fail(`${what} carries the display ${JSON.stringify(shown)}, but display(${JSON.stringify(value)}, ${JSON.stringify(locale)}) is ${JSON.stringify(formatted)}`);
    };
    for (const u of r.example.utterances) {
      const locales = [u.context?.locale, ...r.locales.filter((l) => l !== u.context?.locale)];
      for (const locale of locales) {
        const ctx = kitContext(u.text, u.context, locale);
        const o = fillOf(r, spec, answersOf(u.answers), ctx, `utterance ${said(u)} (${locale ?? 'no locale'})`);
        if (o?.kind === 'filled') agree(o.value, o.display, locale, `the fill of ${said(u)} (${locale ?? 'no locale'})`);
        if (o?.kind === 'disambiguate') {
          agree(o.a.value, o.a.display, locale, `the first candidate for ${said(u)}`);
          agree(o.b.value, o.b.display, locale, `the second candidate for ${said(u)}`);
        }
        if (o?.kind === 'filled' && (locale === undefined || locale === 'en-US')) {
          const plain = attempt(r, 'display without a locale', () => spec.display(o.value));
          const en = attempt(r, 'display in en-US', () => spec.display(o.value, 'en-US'));
          if (plain !== en) r.fail(`display(${JSON.stringify(o.value)}) is ${JSON.stringify(plain)} without a locale but ${JSON.stringify(en)} in en-US: en-US must format as no locale does`);
        }
      }
    }
    if (spec.dtmf) {
      for (const k of r.example.keypad ?? []) {
        for (const locale of [undefined, ...r.locales]) {
          const c = attempt(r, `dtmf.parse(${JSON.stringify(k.digits)})`, () => spec.dtmf!.parse(k.digits, kitContext('', {}, locale)));
          if (c) agree(c.value, c.display, locale, `the keys ${JSON.stringify(k.digits)}`);
        }
      }
    }
  },

  keypad(r) {
    const spec = attempt(r, 'defineSlot', () => build(r));
    if (!spec) return;
    const keys = r.example.keypad ?? [];
    if (!spec.dtmf) {
      if (keys.length > 0) r.fail('the example gives keypad keys, but the slot has no keypad rung (dtmf)');
      return;
    }
    const { length } = spec.dtmf;
    if (!Number.isInteger(length) || length < 1) r.fail(`dtmf.length is ${length}: it must be a whole number of keys, at least 1`);
    const valid = keys.filter((k) => k.expect !== null);
    if (valid.length === 0) r.fail('the slot has a keypad rung, but the example gives no keys that make a value: add one under keypad');
    const ctx = kitContext('');
    for (const k of keys) {
      const c = attempt(r, `dtmf.parse(${JSON.stringify(k.digits)})`, () => spec.dtmf!.parse(k.digits, ctx));
      if (c === undefined) continue;
      if (k.expect === null) {
        if (c !== null) r.fail(`the keys ${JSON.stringify(k.digits)} gave ${JSON.stringify(c.value)}, but the example expects none`);
        continue;
      }
      if (c === null) {
        r.fail(`the keys ${JSON.stringify(k.digits)} gave nothing, but the example expects ${JSON.stringify(k.expect.value)}`);
        continue;
      }
      if (k.digits.length !== length) r.fail(`the example's keys ${JSON.stringify(k.digits)} make a value but are not ${length} long, so the engine never collects them`);
      if (c.value !== k.expect.value) r.fail(`the keys ${JSON.stringify(k.digits)} gave ${JSON.stringify(c.value)}, not ${JSON.stringify(k.expect.value)}`);
      if (k.expect.display !== undefined && c.display !== k.expect.display) r.fail(`the keys ${JSON.stringify(k.digits)} display as ${JSON.stringify(c.display)}, not ${JSON.stringify(k.expect.display)}`);
      const shown = attempt(r, `display(${JSON.stringify(c.value)})`, () => spec.display(c.value));
      if (shown !== undefined && shown !== c.display) r.fail(`the keys ${JSON.stringify(k.digits)} carry the display ${JSON.stringify(c.display)}, but display(${JSON.stringify(c.value)}) is ${JSON.stringify(shown)}`);
    }
    const sample = valid[0]?.digits ?? '5'.repeat(Math.max(1, length));
    for (const wrong of [`${sample}5`, sample.slice(0, -1), '5'.repeat(length + 1), length > 1 ? '5'.repeat(length - 1) : '']) {
      if (wrong.length === length) continue;
      const c = attempt(r, `dtmf.parse(${JSON.stringify(wrong)})`, () => spec.dtmf!.parse(wrong, ctx));
      if (c) r.fail(`the keys ${JSON.stringify(wrong)} (${wrong.length}, not ${length}) gave ${JSON.stringify(c.value)}: keys of a wrong length must give none`);
    }
  },

  prompts(r) {
    const spec = attempt(r, 'defineSlot', () => build(r));
    if (!spec) return;
    const declared = new Map((spec.prompts ?? []).map((p) => [p.id, p.vars ?? []]));
    const needs = new Map<string, { vars: Set<string>; why: string }>();
    const need = (id: string, vars: readonly string[], why: string): void => {
      const n = needs.get(id) ?? { vars: new Set<string>(), why };
      for (const v of vars) n.vars.add(v);
      needs.set(id, n);
    };
    const observe = (o: SlotOutcome | undefined, ctx: SlotContext, what: string): void => {
      if (!o) return;
      if (o.kind === 'invalid' && o.retryPromptId) need(o.retryPromptId, [], `the retryPromptId of ${what}`);
      if (o.kind === 'help') need(o.promptId, [], `the help prompt of ${what}`);
      if (o.kind === 'disambiguate') need(`disambiguate_${spec.id}`, ['a', 'b'], `the disambiguation of ${what}`);
      if (o.kind === 'window' && spec.partialPromptId) {
        const vars = attempt(r, `partialVars(${canonicalJson(o.window)})`, () => spec.partialVars?.(o.window, ctx.locale) ?? {});
        if (vars) {
          for (const [k, v] of Object.entries(vars)) if (typeof v !== 'string') r.fail(`partialVars(${canonicalJson(o.window)}) gives ${k} as ${JSON.stringify(v)}, not text`);
          need(spec.partialPromptId, Object.keys(vars), `the partial value of ${what}`);
        }
      }
    };
    for (const ctx of contextsOf(r, windowsOf(r, spec))) {
      const u = r.example.utterances.find((x) => x.text === ctx.text);
      if (u) observe(fillOf(r, spec, answersOf(u.answers), ctx, `utterance ${said(u)} (${where(ctx)})`), ctx, `utterance ${said(u)}`);
      const qs = attempt(r, `questions(${where(ctx)})`, () => spec.questions(ctx));
      if (qs) observe(fillOf(r, spec, quietAnswers(qs), ctx, `quiet answers (${where(ctx)})`), ctx, `quiet answers (${where(ctx)})`);
    }
    for (const [id, { vars, why }] of needs) {
      const has = declared.get(id);
      if (has === undefined) {
        r.fail(`the slot can lead to the line "${id}" (${why}), which its prompts do not declare`);
        continue;
      }
      const missing = [...vars].filter((v) => !has.includes(v));
      if (missing.length > 0) r.fail(`the line "${id}" is given ${missing.join(', ')} (${why}), which its declared vars (${has.join(', ') || 'none'}) leave out`);
    }
  },

  utterances(r) {
    const spec = attempt(r, 'defineSlot', () => build(r));
    if (!spec) return;
    const ids = spec.questionIds ?? [];
    if (!r.example.utterances.some((u) => u.expect.kind === 'filled')) r.fail('no utterance fills the slot: give at least one, so the thresholds and the display can be checked');
    for (const u of r.example.utterances) {
      for (const id of Object.keys(u.answers ?? {})) if (!ids.includes(id)) r.fail(`utterance ${said(u)} answers "${id}", which is not one of the slot's questions (${ids.join(', ')})`);
      const o = fillOf(r, spec, answersOf(u.answers), kitContext(u.text, u.context), `utterance ${said(u)}`);
      if (!o) continue;
      const got = o as unknown as Record<string, unknown>;
      const wrong = Object.entries(u.expect).filter(([k, v]) => got[k] !== v);
      if (wrong.length > 0) r.fail(`utterance ${said(u)} gave ${describeOutcome(o)}; expected ${wrong.map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(', ')}`);
    }
  },
};

/** What is wrong with the questions a slot asks: an unknown type, no instructions, a choice with no labels. */
function questionProblems(qs: QuestionMap): string[] {
  const out: string[] = [];
  for (const [id, q] of Object.entries(qs)) {
    if (!q || !['noul', 'choice', 'score'].includes(q.type)) out.push(`"${id}" is not a noul, choice or score question`);
    else if (typeof q.instructions !== 'string' || q.instructions.trim() === '') out.push(`"${id}" has no instructions`);
    else if (q.type === 'choice' && Object.keys(q.criteria ?? {}).length === 0) out.push(`"${id}" is a choice with no labels`);
    else if (q.type === 'score' && (q.levels ?? []).length === 0) out.push(`"${id}" is a score with no levels`);
  }
  return out;
}
