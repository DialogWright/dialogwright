import { ENGINE_QUESTION_IDS } from '../../core/questionIds';
import type { SlotContext, SlotOutcome, SlotPartial } from '../../core/slots/types';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { canonicalJson } from '../../jev/cassette';
import { isChoice, isNoul, isScore, type AnswerMap, type QuestionMap } from '../../jev/types';
import { buildSlot, defineSlot, SlotConfigError, slotTypeJsonSchema } from '../defineSlot';
import { BUILT_IN_SLOT_TYPES } from '../registry';
import { refusesUnknownKeys } from '../slotType';
import type { TopicCatalog } from '../../kb/types';
import type { ExampleContext, LibrarySlotSpec, SlotExample, SlotType, SlotTypes, SlotUtterance } from '../types';
import {
  answersOf, describeOutcome, essence, kitContext, MALFORMED_ANSWERS, MALFORMED_KEYS, outcomeProblem, quietAnswers,
  KIT_TODAY, recordingThresholds, scaleAnswers, scaleThresholds,
} from './turns';

/**
 * The conformance kit: what any slot type, built in or contributed, must do to run in the engine.
 * Each check runs over every example configuration of the type (its examples.yaml) and throws,
 * with every problem it found, when the type fails it. runSlotConformance (./run.ts) registers them
 * as tests; slotConformanceChecks returns them for any other runner.
 */

/** The checks, by id. */
export const CHECK_IDS = [
  'builds', 'unknown-keys', 'question-ids', 'empty', 'quiet', 'malformed', 'thresholds', 'threshold-names', 'boundary', 'display', 'keypad',
  'prompts', 'prompt-vars', 'values', 'utterances',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/** What each check proves, in a sentence (a test's name, and the README's table). */
export const CHECK_ABOUT: Readonly<Record<CheckId, string>> = {
  builds: 'the configuration builds a slot that declares its question ids and its lines',
  'unknown-keys': 'an option the type does not have is refused, with a problem that names it',
  'question-ids': 'questions() asks only the ids the slot declares, none of them the engine\'s, the same ids for the same configuration, other ids for another slot, and the same questions whatever its wording by locale',
  empty: 'no answers at all give absent when the slot was not asked for, and absent or invalid (never a value) when it was',
  quiet: 'answers that hear nothing for the slot give absent or invalid, never a value',
  malformed: 'answers of the wrong type, missing or out of range, and keys that are no value, never make it throw',
  thresholds: 'thresholds are read by name from ctx.thresholds, never written into the type',
  'threshold-names': 'every threshold a fill reads is the engine\'s or one the slot declares, and every one it declares is read',
  boundary: 'a probability exactly at a threshold meets it (atLeast), as one just above does',
  display: 'display(value, locale) is the display every fill, keypad value and candidate carries, in every locale (a fill of a slot shown as said, SlotSpec.displayFrom, carries the words instead), and the example pins one in each',
  keypad: 'keys of the right length give the value the example expects, and keys of a wrong length give none',
  prompts: 'every line an outcome can lead to is in the slot\'s prompts, with the variables it is given',
  'prompt-vars': 'every line the slot declares uses only variables the engine gives it, and an acknowledged value has its ack line declared',
  values: 'a date-valued slot gives ISO dates, and every confidence is a number from 0 to 1',
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
  /** Locales to format values in, beyond each utterance's own (default: en-US and es). */
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
/** The locales the kit checks when it is given none. */
export const KIT_LOCALES: readonly string[] = ['en-US', 'es'];
/**
 * Days the kit also tries each slot on, beyond KIT_TODAY (a Friday): a Sunday, the last two days of
 * February in a leap year, and the last day of a year, so a question asked only on some days is seen.
 */
export const KIT_TODAYS: readonly string[] = ['2026-09-20', '2028-02-28', '2028-02-29', '2026-12-31'];
/**
 * A pending partial no type makes, for the question-ids check of a type whose examples make none,
 * so a question asked only while a partial is pending is seen. A questions() that throws on it is
 * skipped: the engine only ever gives a slot its own partials.
 */
const KIT_WINDOW: SlotPartial = { kind: 'kit', month: 2, day: 29 };
/** How far below a probability the boundary check sets a threshold. */
const NUDGE = 1e-6;
/** The probabilities and thresholds are multiplied by each of these for the thresholds check. */
const SCALES = [0.5, 0.2];
/** Above any probability or margin: a threshold raised to this can never be met. */
const UNREACHABLE = 2;

/** Every check of `type`, over each of its examples. */
export function slotConformanceChecks(type: SlotType<any, any>, options: SlotConformanceOptions = {}): ConformanceCheck[] {
  const types: SlotTypes = { ...(options.types ?? BUILT_IN_SLOT_TYPES), [type.type]: type };
  const locales = options.locales ?? KIT_LOCALES;
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
  type: SlotType<any, any>;
  types: SlotTypes;
  locales: readonly string[];
  example: SlotExample;
  fail(problem: string): void;
}

const configOf = (r: Run, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: r.type.type, ...r.example.config, ...extra });
/** The example's slot, with its wording by locale when it gives any. */
const build = (r: Run, slot = r.example.slot): LibrarySlotSpec => {
  const catalog = catalogOf(r.example);
  if (r.example.wording === undefined) return defineSlot(slot, configOf(r), r.types, catalog ? { catalog } : {});
  const built = buildSlot(slot, configOf(r), { types: r.types, wording: r.example.wording, ...(catalog ? { catalog } : {}) });
  if (!built.ok) throw new SlotConfigError(slot, built.problems);
  return built.spec;
};
/** The app's knowledge topics an example's slot is built with (SlotExample.topics), if it gives any. */
const catalogOf = (example: SlotExample): TopicCatalog | undefined => (example.topics !== undefined ? { topics: example.topics } : undefined);
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
  `${JSON.stringify(ctx.text)}, ${ctx.prompted ? 'prompted' : 'unprompted'}, ${ctx.current === null ? 'nothing on file' : 'a value on file'}${ctx.window ? `, partial ${canonicalJson(ctx.window)}` : ''}${ctx.locale ? `, ${ctx.locale}` : ''}${ctx.todayIso !== KIT_TODAY ? `, today ${ctx.todayIso}` : ''}`;

/**
 * The contexts the kit tries a slot in: no words and each utterance's, asked or not, with and
 * without a value on file, with and without each pending partial, in each locale and on each of
 * KIT_TODAYS, and each utterance's own.
 */
function contextsOf(r: Run, windows: readonly SlotPartial[] = []): SlotContext[] {
  // Each utterance's words with the records it was said over and the topics nominated for them (an
  // app's lists, and what retrieval nominates for the words, stay the same whether or not the slot
  // was asked for), and the empty words with none.
  const turns: { text: string; lists: ExampleContext }[] = [
    { text: '', lists: {} },
    ...r.example.utterances.map((u) => ({
      text: u.text,
      lists: {
        ...(u.context?.records !== undefined ? { records: u.context.records } : {}),
        ...(u.context?.sources !== undefined ? { sources: u.context.sources } : {}),
        ...(u.context?.nominated !== undefined ? { nominated: u.context.nominated } : {}),
      },
    })),
  ];
  const states: ExampleContext[] = [];
  for (const window of [null, ...windows]) for (const current of [null, ON_FILE]) for (const prompted of [false, true]) states.push({ prompted, current, window });
  const out: SlotContext[] = [];
  for (const locale of [undefined, ...r.locales]) {
    for (const { text, lists } of turns) for (const state of states) out.push(kitContext(text, { ...lists, ...state }, locale));
  }
  for (const todayIso of KIT_TODAYS) {
    for (const { text, lists } of turns) for (const state of states) out.push(kitContext(text, { ...lists, ...state, todayIso }));
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

/**
 * What the slot gives in each context the kit tries: each utterance's answers where its words are
 * said, and quiet answers everywhere. Throws and outcomes that are not outcomes are reported.
 */
function observedOutcomes(r: Run, spec: LibrarySlotSpec): { o: SlotOutcome; ctx: SlotContext; what: string }[] {
  const out: { o: SlotOutcome; ctx: SlotContext; what: string }[] = [];
  for (const ctx of contextsOf(r, windowsOf(r, spec))) {
    const u = r.example.utterances.find((x) => x.text === ctx.text);
    if (u) {
      const o = fillOf(r, spec, answersOf(u.answers), ctx, `utterance ${said(u)} (${where(ctx)})`);
      if (o) out.push({ o, ctx, what: `utterance ${said(u)}` });
    }
    const qs = attempt(r, `questions(${where(ctx)})`, () => spec.questions(ctx));
    if (qs) {
      const o = fillOf(r, spec, quietAnswers(qs), ctx, `quiet answers (${where(ctx)})`);
      if (o) out.push({ o, ctx, what: `quiet answers (${where(ctx)})` });
    }
  }
  return out;
}

/** Whether `value` is a calendar day written YYYY-MM-DD. */
function isIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/**
 * The numbers the model gave in `answers` that a fill may compare to a threshold: each yes-or-no,
 * each label's (or level's) probability and confidence, and the gaps between a choice's labels.
 */
function numbersOf(answers: AnswerMap): number[] {
  const out = new Set<number>();
  for (const a of Object.values(answers)) {
    if (isNoul(a)) out.add(a.noul);
    else if (isChoice(a) || isScore(a)) {
      const ps = Object.values(a.probabilities).sort((x, y) => y - x);
      for (const p of ps) out.add(p);
      out.add(a.confidence);
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) out.add(ps[i]! - ps[j]!);
    }
  }
  return [...out].filter((p) => Number.isFinite(p) && p > NUDGE && p <= 1);
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
    // A locale's wording changes what the slot says, never what the model is asked.
    const plain = r.example.wording === undefined ? undefined : attempt(r, 'defineSlot without the wording', () => defineSlot(r.example.slot, configOf(r), r.types, catalogOf(r.example) ? { catalog: catalogOf(r.example)! } : {}));
    // A type whose examples make no partial is tried with one it never made, so a question asked
    // only while a partial is pending is seen; a questions() that throws on that one is skipped.
    const windows = windowsOf(r, spec);
    const synthetic = windows.length === 0;
    for (const ctx of contextsOf(r, synthetic ? [KIT_WINDOW] : windows)) {
      let qs: QuestionMap | undefined;
      if (synthetic && ctx.window !== null) {
        try {
          qs = spec.questions(ctx);
        } catch {
          continue;
        }
      } else qs = attempt(r, `questions(${where(ctx)})`, () => spec.questions(ctx));
      if (!qs) continue;
      const unworded = plain ? attempt(r, `questions(${where(ctx)}), without the wording`, () => plain.questions(ctx)) : undefined;
      if (unworded && canonicalJson(unworded) !== canonicalJson(qs)) r.fail(`questions(${where(ctx)}) differ with the slot's wording: a locale's wording may change what the slot says, never what the model is asked`);
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
      // Asked, a slot with nothing to ask (no list to offer) or nothing answered may read the turn as
      // a miss (invalid, so the retry ladder moves on); never as a value, a pair or a partial.
      const o = fillOf(r, spec, {}, ctx, `no answers (${where(ctx)})`);
      if (!o || o.kind === 'absent') continue;
      if (!ctx.prompted) r.fail(`no answers (${where(ctx)}) gave ${describeOutcome(o)}, not absent: a slot not asked for that hears nothing is absent`);
      else if (o.kind !== 'invalid') r.fail(`no answers (${where(ctx)}) gave ${describeOutcome(o)}: a slot asked for that hears nothing is absent or invalid`);
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

  'threshold-names'(r) {
    const spec = attempt(r, 'defineSlot', () => build(r));
    if (!spec) return;
    const declared = spec.thresholds ?? [];
    const reads = new Set<string>();
    for (const u of r.example.utterances) {
      for (const locale of [u.context?.locale, ...r.locales.filter((l) => l !== u.context?.locale)]) {
        const ctx = kitContext(u.text, u.context, locale);
        fillOf(r, spec, answersOf(u.answers), { ...ctx, thresholds: recordingThresholds(ctx.thresholds, reads) }, `utterance ${said(u)}`);
      }
    }
    for (const name of reads) {
      if (!Object.hasOwn(DEFAULT_THRESHOLDS, name) && !declared.includes(name)) {
        r.fail(`a fill reads the threshold "${name}", which is not one of the engine's (DEFAULT_THRESHOLDS) and not one the slot declares (thresholds: ${declared.join(', ') || 'none'}): declare it, so an app that lacks it is told when it is defined`);
      }
    }
    for (const name of declared) {
      if (!reads.has(name)) r.fail(`the slot declares the threshold "${name}", but no utterance of the example makes a fill read it: compare against the threshold the slot declares, and give an utterance that reaches that comparison`);
    }
  },

  boundary(r) {
    const spec = attempt(r, 'defineSlot', () => build(r));
    if (!spec) return;
    for (const u of r.example.utterances) {
      const answers = answersOf(u.answers);
      const ctx = kitContext(u.text, u.context);
      const reads = new Set<string>();
      if (!fillOf(r, spec, answers, { ...ctx, thresholds: recordingThresholds(ctx.thresholds, reads) }, `utterance ${said(u)}`)) continue;
      const numbers = numbersOf(answers);
      for (const name of reads) {
        if (typeof (ctx.thresholds as Readonly<Record<string, unknown>>)[name] !== 'number') continue;
        for (const p of numbers) {
          const at = fillOf(r, spec, answers, { ...ctx, thresholds: { ...ctx.thresholds, [name]: p } }, `utterance ${said(u)} with ${name} at ${p}`);
          const below = fillOf(r, spec, answers, { ...ctx, thresholds: { ...ctx.thresholds, [name]: p - NUDGE } }, `utterance ${said(u)} with ${name} just below ${p}`);
          if (at && below && essence(at) !== essence(below)) {
            r.fail(`utterance ${said(u)} gives ${describeOutcome(at)} with ${name} exactly ${p} (a number the model gave), but ${describeOutcome(below)} with ${name} just below it: a number that equals its threshold meets it, so compare with meetsThreshold or atLeast, never with >`);
            break;
          }
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
        // A slot shown as said (SlotSpec.displayFrom) carries the words, which display(value) cannot give back.
        if (o?.kind === 'filled' && spec.displayFrom !== 'said') agree(o.value, o.display, locale, `the fill of ${said(u)} (${locale ?? 'no locale'})`);
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
    // A display wrong the same way every time agrees with itself, so the example pins what the
    // caller hears in each locale the kit checks: expect.display in the utterance's own locale (none
    // formats as en-US), expect.displays by locale, or a keypad value's display.
    const pinned = new Set<string>();
    for (const u of r.example.utterances) {
      if (u.expect.display !== undefined) pinned.add(u.context?.locale ?? 'en-US');
      for (const [locale, shown] of Object.entries(u.expect.displays ?? {})) {
        pinned.add(locale);
        const o = fillOf(r, spec, answersOf(u.answers), kitContext(u.text, u.context, locale), `utterance ${said(u)} (${locale})`);
        if (o && o.kind !== 'filled') r.fail(`utterance ${said(u)} pins a display in ${locale}, but there it gives ${describeOutcome(o)}`);
        else if (o && o.display !== shown) r.fail(`utterance ${said(u)} displays as ${JSON.stringify(o.display)} in ${locale}, not ${JSON.stringify(shown)} as the example pins`);
      }
    }
    for (const k of r.example.keypad ?? []) if (k.expect?.display !== undefined) pinned.add(k.locale ?? 'en-US');
    for (const locale of r.locales) {
      if (!pinned.has(locale)) r.fail(`the example pins no display in ${locale}: give a filled utterance \`displays: { ${locale}: ... }\` (or a display on an utterance said in ${locale}), what the caller hears there, so a display that is wrong the same way every time is caught`);
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
      const c = attempt(r, `dtmf.parse(${JSON.stringify(k.digits)}${k.locale ? `, ${k.locale}` : ''})`, () => spec.dtmf!.parse(k.digits, k.locale === undefined ? ctx : kitContext('', {}, k.locale)));
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
      const shown = attempt(r, `display(${JSON.stringify(c.value)}${k.locale ? `, ${k.locale}` : ''})`, () => spec.display(c.value, k.locale));
      if (shown !== undefined && shown !== c.display) r.fail(`the keys ${JSON.stringify(k.digits)} carry the display ${JSON.stringify(c.display)}, but display(${JSON.stringify(c.value)}) is ${JSON.stringify(shown)}`);
    }
    const sample = valid.find((k) => k.locale === undefined)?.digits ?? valid[0]?.digits ?? '5'.repeat(Math.max(1, length));
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
    for (const { o, ctx, what } of observedOutcomes(r, spec)) {
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

  'prompt-vars'(r) {
    const spec = attempt(r, 'defineSlot', () => build(r));
    if (!spec) return;
    const id = spec.id;
    const observed = observedOutcomes(r, spec);
    // The variables the engine gives each line a slot can lead to (core/fia.ts, core/turn.ts,
    // core/decision.ts): an ack and a read-back get the slot's display under its id, a
    // disambiguation its two candidates, the partial prompt its partialVars (and so does ask_<slot>
    // when there is no partialPromptId); the keypad ask, the retry, a retryPromptId and a help line
    // get none.
    const partialKeys = new Set<string>();
    for (const { o, ctx } of observed) {
      if (o.kind !== 'window') continue;
      const vars = attempt(r, `partialVars(${canonicalJson(o.window)})`, () => spec.partialVars?.(o.window, ctx.locale) ?? {});
      for (const k of Object.keys(vars ?? {})) partialKeys.add(k);
    }
    const retries = new Set(observed.flatMap(({ o }) => (o.kind === 'invalid' && o.retryPromptId ? [o.retryPromptId] : [])));
    const helps = new Set(observed.flatMap(({ o }) => (o.kind === 'help' ? [o.promptId] : [])));
    const given = (line: string): { vars: string[]; as: string } => {
      const roles: { vars: readonly string[]; as: string }[] = [];
      if (line === `ack_${id}`) roles.push({ vars: [id], as: 'an ack, given the display as {' + id + '}' });
      if (line === `confirm_${id}`) roles.push({ vars: [id], as: 'a read-back, given the display as {' + id + '}' });
      if (line === `disambiguate_${id}`) roles.push({ vars: ['a', 'b'], as: 'a disambiguation, given {a} and {b}' });
      if (line === spec.partialPromptId) roles.push({ vars: [...partialKeys], as: 'the partial prompt, given partialVars' });
      if (line === `ask_${id}`) roles.push(spec.partialPromptId === undefined ? { vars: [...partialKeys], as: 'the ask, given partialVars while a partial is pending' } : { vars: [], as: 'the ask' });
      if (line === `ask_${id}_dtmf`) roles.push({ vars: [], as: 'the keypad ask' });
      if (line === `ask_${id}_retry`) roles.push({ vars: [], as: 'the retry' });
      if (retries.has(line)) roles.push({ vars: [], as: 'a retryPromptId' });
      if (helps.has(line)) roles.push({ vars: [], as: 'a help line' });
      if (roles.length === 0) return { vars: [], as: 'a line the engine says with no variables' };
      return { vars: roles.slice(1).reduce((acc, role) => acc.filter((v) => role.vars.includes(v)), [...roles[0]!.vars]), as: roles.map((role) => role.as).join(' and ') };
    };
    for (const p of spec.prompts ?? []) {
      const { vars, as } = given(p.id);
      const extra = (p.vars ?? []).filter((v) => !vars.includes(v));
      if (extra.length > 0) {
        r.fail(`the line "${p.id}" declares ${extra.map((v) => `{${v}}`).join(', ')}, which the engine never gives it (it is ${as}; it gets ${vars.map((v) => `{${v}}`).join(', ') || 'no variables'}): a line written with ${extra.length === 1 ? 'it' : 'them'} would pass check and fail when it is said`);
      }
    }
    if (spec.spokenConfirm === 'by-confidence' && !(spec.prompts ?? []).some((p) => p.id === `ack_${id}`)) {
      const acked = observed.find(({ o }) => o.kind === 'filled' && o.confirm === 'implicit');
      if (acked) r.fail(`${acked.what} fills with confirm "implicit", and the slot's spokenConfirm is "by-confidence", so the engine says "ack_${id}" with {${id}}: declare it in prompts with vars [${id}]`);
    }
  },

  values(r) {
    const spec = attempt(r, 'defineSlot', () => build(r));
    if (!spec) return;
    const date = spec.valueKind === 'date';
    const dateProblem = (value: string, what: string): void => {
      if (date && !isIsoDate(value)) r.fail(`${what} gave the value ${JSON.stringify(value)}, but the slot's valueKind is "date": its values must be ISO dates (YYYY-MM-DD), which the engine compares day by day`);
    };
    const confidenceProblem = (c: number, what: string): void => {
      if (!(c >= 0 && c <= 1)) r.fail(`${what} gave a confidence of ${c}: a confidence is a probability, from 0 to 1`);
    };
    for (const { o, what } of observedOutcomes(r, spec)) {
      if (o.kind === 'filled') {
        dateProblem(o.value, what);
        confidenceProblem(o.confidence, what);
      }
      if (o.kind === 'window') confidenceProblem(o.confidence, what);
      if (o.kind === 'disambiguate') {
        dateProblem(o.a.value, `the first candidate of ${what}`);
        dateProblem(o.b.value, `the second candidate of ${what}`);
      }
    }
    if (spec.dtmf) {
      for (const k of r.example.keypad ?? []) {
        const c = attempt(r, `dtmf.parse(${JSON.stringify(k.digits)})`, () => spec.dtmf!.parse(k.digits, kitContext('', {}, k.locale)));
        if (c) dateProblem(c.value, `the keys ${JSON.stringify(k.digits)}`);
      }
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
      const wrong = Object.entries(u.expect).filter(([k, v]) => k !== 'displays' && got[k] !== v);
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
