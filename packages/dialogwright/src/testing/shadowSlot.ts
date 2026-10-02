import { isDeepStrictEqual } from 'node:util';
import { canonicalJson } from '../jev/cassette';
import type { AnswerMap } from '../jev/types';
import type { App, SlotId } from '../core/app/types';
import type { SlotCandidate, SlotContext, SlotOutcome, SlotPartial, SlotSpec } from '../core/slots/types';

/**
 * Test support: the shadow harness. A slot rewritten (a library type in place of a hand-written
 * spec) has to behave exactly as the slot it replaces, including on branches no recorded call
 * reaches. `shadowSlot(legacy, candidate)` returns a spec that is the legacy one to the engine (every
 * result it returns is the legacy result), and that on every call also runs the candidate and
 * compares the two:
 * - `questions(ctx)` as the cassette keys them (jev/cassette.ts canonicalJson);
 * - `fill(answers, ctx)` outcomes, deep and strict (an absent field and one set to undefined differ);
 * - `dtmf.parse(digits, ctx)` results;
 * - `partialVars(window, locale)` on every window a fill returns (in the context's locale), and
 *   wherever the engine asks;
 * - `display(value, locale)` on every value a fill or a keypad parse yields (in the context's
 *   locale), and wherever it is asked;
 * - the declared fields, once, when the shadow is made: id, spokenConfirm, redact, handoff, detect,
 *   valueKind, partialPromptId, whether there is a keypad and its length, whether there is a
 *   partialVars. Not the declarations a hand-written spec need not make (questionIds, prompts): the
 *   shadow carries the legacy spec's, and the candidate's are the conformance kit's to prove.
 * A method that throws is compared by its message. On a difference the harness throws a
 * ShadowMismatchError naming the slot, the method, the inputs and both results; in `report` mode it
 * records the difference in a ShadowReport instead and carries on with the legacy result.
 *
 * Its use: porting a slot you wrote by hand onto a library type. Keep the hand-written slot in the
 * app, build the library slot from the options you mean to use, and run the library slot beside it
 * (`shadowSlot` in a test over a grid of answers; `withShadowSlots(app, [librarySlot])` over a whole
 * regression or replay). When nothing differs on the grids and on every recorded call, the library
 * slot can replace the hand-written one; freeze the old file as a test-only oracle for the grid
 * tests, as the testkit and the clinic did (docs/authoring-an-app.md, "Porting a slot to a library type").
 *
 * A regression launcher can turn it on for a whole run with `shadowFromEnv(app, candidates)`: with
 * DIALOGWRIGHT_SHADOW unset the app is returned as it is, so a run without the flag is the run it
 * always was. Kept out of the package's root entry: import it from `dialogwright/testing`.
 */

export type ShadowMode = 'throw' | 'report';

/** What was compared: a declared field (at construction) or a method call. */
export type ShadowMethod = 'static' | 'questions' | 'fill' | 'dtmf.parse' | 'partialVars' | 'display';

export interface ShadowMismatch {
  slot: SlotId;
  method: ShadowMethod;
  /** What the method was given, summarized for a person. */
  inputs: string;
  /** Where the results differ, one line per path. */
  differences: string[];
  legacy: unknown;
  candidate: unknown;
}

export interface ShadowReport {
  readonly mismatches: ShadowMismatch[];
  /** Comparisons made, by `<slot>.<method>`: a shadow that was never exercised proves nothing. */
  readonly calls: Record<string, number>;
}

export interface ShadowOptions {
  /** throw (default): a ShadowMismatchError on the first difference; report: collect into `report`. */
  mode?: ShadowMode;
  /** Where mismatches are collected (required in report mode) and comparisons are counted. */
  report?: ShadowReport;
}

export class ShadowMismatchError extends Error {
  constructor(readonly mismatch: ShadowMismatch) {
    super(formatShadowMismatch(mismatch));
    this.name = 'ShadowMismatchError';
  }
}

export function createShadowReport(): ShadowReport {
  return { mismatches: [], calls: {} };
}

/** The legacy spec to the engine, the candidate compared beside it on every call. */
export function shadowSlot(legacy: SlotSpec, candidate: SlotSpec, options: ShadowOptions = {}): SlotSpec {
  const mode = options.mode ?? 'throw';
  const report = options.report;
  if (mode === 'report' && !report) throw new Error('shadowSlot: report mode needs a report (createShadowReport())');
  const slot = legacy.id;

  function count(method: ShadowMethod): void {
    if (report) report.calls[`${slot}.${method}`] = (report.calls[`${slot}.${method}`] ?? 0) + 1;
  }

  function mismatch(method: ShadowMethod, inputs: string, a: unknown, b: unknown): void {
    const found: ShadowMismatch = { slot, method, inputs, differences: differences(a, b), legacy: a, candidate: b };
    report?.mismatches.push(found);
    if (mode === 'throw') throw new ShadowMismatchError(found);
  }

  /** Runs both sides; compares them with `same`; returns (or rethrows) the legacy side. */
  function compare<T>(method: ShadowMethod, inputs: () => string, runLegacy: () => T, runCandidate: () => T, same: (a: T, b: T) => boolean): T {
    count(method);
    const a = attempt(runLegacy);
    const b = attempt(runCandidate);
    const equal = 'threw' in a || 'threw' in b
      ? 'threw' in a && 'threw' in b && a.threw === b.threw
      : same(a.value, b.value);
    if (!equal) mismatch(method, inputs(), shown(a), shown(b));
    if ('threw' in a) throw a.error;
    return a.value;
  }

  const deep = <T>(a: T, b: T) => isDeepStrictEqual(a, b);

  function compareDisplay(value: string, locale: string | undefined): string {
    return compare('display', () => `value ${json(value)}${localeSummary(locale)}`, () => legacy.display(value, locale), () => candidate.display(value, locale), deep);
  }

  function comparePartialVars(window: SlotPartial, locale: string | undefined): Record<string, string> | undefined {
    return compare(
      'partialVars',
      () => `window ${json(window)}${localeSummary(locale)}`,
      () => legacy.partialVars?.(window, locale),
      () => candidate.partialVars?.(window, locale),
      deep,
    );
  }

  /** The displays and partial variables a fill's outcome leads to, compared too, in the context's locale. */
  function followOutcome(outcome: SlotOutcome, locale: string | undefined): void {
    if (outcome.kind === 'filled') compareDisplay(outcome.value, locale);
    if (outcome.kind === 'disambiguate') {
      compareDisplay(outcome.a.value, locale);
      compareDisplay(outcome.b.value, locale);
    }
    if (outcome.kind === 'window') comparePartialVars(outcome.window, locale);
  }

  // The declared fields, once.
  count('static');
  const declared = staticFields(legacy);
  const declaredCandidate = staticFields(candidate);
  if (!isDeepStrictEqual(declared, declaredCandidate)) mismatch('static', 'the declared fields', declared, declaredCandidate);

  const spec: SlotSpec = {
    ...pick(legacy),
    questions(ctx) {
      return compare('questions', () => contextSummary(ctx), () => legacy.questions(ctx), () => candidate.questions(ctx), (a, b) => canonicalJson(a) === canonicalJson(b));
    },
    fill(answers, ctx) {
      const outcome = compare(
        'fill',
        () => `${contextSummary(ctx)} · answers ${json(answersFor(answers, ctx, legacy, candidate))}`,
        () => legacy.fill(answers, ctx),
        () => candidate.fill(answers, ctx),
        deep,
      );
      followOutcome(outcome, ctx.locale);
      return outcome;
    },
    display(value, locale) {
      return compareDisplay(value, locale);
    },
  };
  const legacyDtmf = legacy.dtmf;
  if (legacyDtmf) {
    spec.dtmf = {
      length: legacyDtmf.length,
      parse(digits, ctx): SlotCandidate | null {
        const parsed = compare(
          'dtmf.parse',
          () => `digits ${json(digits)} · ${contextSummary(ctx)}`,
          () => legacyDtmf.parse(digits, ctx),
          () => {
            if (!candidate.dtmf) throw new Error('the candidate has no keypad');
            return candidate.dtmf.parse(digits, ctx);
          },
          deep,
        );
        if (parsed !== null) compareDisplay(parsed.value, ctx.locale);
        return parsed;
      },
    };
  }
  if (legacy.partialVars) spec.partialVars = (window, locale) => comparePartialVars(window, locale)!;
  return spec;
}

/**
 * The app with each candidate shadowing the app's slot of the same id (shadowSlot), in the app's
 * own slot order. With no candidates the app itself is returned, untouched.
 */
export function withShadowSlots(app: App, candidates: readonly SlotSpec[], options: ShadowOptions = {}): App {
  if (candidates.length === 0) return app;
  const byId = new Map<SlotId, SlotSpec>();
  for (const c of candidates) {
    if (!Object.hasOwn(app.slots, c.id)) throw new Error(`shadow: app "${app.id}" has no slot "${c.id}" to shadow`);
    if (byId.has(c.id)) throw new Error(`shadow: slot "${c.id}" is shadowed twice`);
    byId.set(c.id, c);
  }
  const slots = Object.fromEntries(
    Object.entries(app.slots).map(([id, spec]) => [id, byId.has(id) ? shadowSlot(spec, byId.get(id)!, options) : spec]),
  ) as Record<SlotId, SlotSpec>;
  return { ...app, slots };
}

/** The environment flag that turns shadowing on in a regression launcher. */
export const SHADOW_ENV = 'DIALOGWRIGHT_SHADOW';

/** DIALOGWRIGHT_SHADOW: unset, empty or 0 is off; 1 or throw stops at the first difference; report collects them. */
export function shadowModeOf(env: NodeJS.ProcessEnv = process.env): ShadowMode | null {
  const v = env[SHADOW_ENV];
  if (v === undefined || v === '' || v === '0') return null;
  if (v === '1' || v === 'throw') return 'throw';
  if (v === 'report') return 'report';
  throw new Error(`${SHADOW_ENV} must be 1, throw or report (got "${v}")`);
}

/**
 * For a regression launcher: the app, shadowed by `candidates` when DIALOGWRIGHT_SHADOW is on, and
 * the app itself, untouched, when it is off. When on, a summary goes to stderr as the process exits
 * (stdout, the run's diff, is left as it is), and a mismatch fails the run: in throw mode the first
 * one ends it, in report mode all are listed and the exit code is set.
 */
export function shadowFromEnv(app: App, candidates: readonly SlotSpec[], env: NodeJS.ProcessEnv = process.env): App {
  const mode = shadowModeOf(env);
  if (mode === null) return app;
  const report = createShadowReport();
  const shadowed = withShadowSlots(app, candidates, { mode, report });
  process.once('exit', () => {
    console.error(formatShadowReport(report, candidates.map((c) => c.id)));
    if (report.mismatches.length > 0) process.exitCode = 1;
  });
  return shadowed;
}

/** A report as lines for a person: what was shadowed, how often each method was compared, every mismatch. */
export function formatShadowReport(report: ShadowReport, slots: readonly SlotId[]): string {
  const lines = [`shadow  ${slots.length === 0 ? 'no slots' : slots.join(', ')}  ${report.mismatches.length} mismatch${report.mismatches.length === 1 ? '' : 'es'}`];
  for (const key of Object.keys(report.calls).sort()) lines.push(`  ${key} ${report.calls[key]}`);
  for (const m of report.mismatches) lines.push(formatShadowMismatch(m));
  return lines.join('\n');
}

export function formatShadowMismatch(m: ShadowMismatch): string {
  return [
    `shadow slot "${m.slot}": ${m.method} differs`,
    `  inputs: ${m.inputs}`,
    ...m.differences.map((d) => `  ${d}`),
    `  legacy:    ${json(m.legacy)}`,
    `  candidate: ${json(m.candidate)}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------

type Attempt<T> = { value: T } | { threw: string; error: unknown };

function attempt<T>(run: () => T): Attempt<T> {
  try {
    return { value: run() };
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error), error };
  }
}

function shown<T>(a: Attempt<T>): unknown {
  return 'threw' in a ? { threw: a.threw } : a.value;
}

/** The fields a slot declares rather than computes. */
function staticFields(spec: SlotSpec): Record<string, unknown> {
  return {
    id: spec.id,
    spokenConfirm: spec.spokenConfirm,
    redact: spec.redact,
    handoff: spec.handoff,
    detect: spec.detect,
    valueKind: spec.valueKind,
    partialPromptId: spec.partialPromptId,
    dtmf: spec.dtmf ? { length: spec.dtmf.length } : undefined,
    partialVars: typeof spec.partialVars === 'function',
  };
}

/** The legacy spec's declared fields, as it has them (an absent one stays absent). */
function pick(spec: SlotSpec): Pick<SlotSpec, 'id' | 'spokenConfirm'> & Partial<SlotSpec> {
  const out: Pick<SlotSpec, 'id' | 'spokenConfirm'> & Partial<SlotSpec> = { id: spec.id, spokenConfirm: spec.spokenConfirm };
  if (spec.redact !== undefined) out.redact = spec.redact;
  if (spec.handoff !== undefined) out.handoff = spec.handoff;
  if (spec.detect !== undefined) out.detect = spec.detect;
  if (spec.valueKind !== undefined) out.valueKind = spec.valueKind;
  if (spec.partialPromptId !== undefined) out.partialPromptId = spec.partialPromptId;
  if (spec.questionIds !== undefined) out.questionIds = spec.questionIds;
  if (spec.prompts !== undefined) out.prompts = spec.prompts;
  return out;
}

const MAX_SHOWN = 600;

function json(value: unknown): string {
  const s = value === undefined ? 'undefined' : JSON.stringify(value);
  return s.length > MAX_SHOWN ? `${s.slice(0, MAX_SHOWN)}… (${s.length} chars)` : s;
}

function contextSummary(ctx: SlotContext): string {
  const parts = [`text ${json(ctx.text)}`];
  if (ctx.prompted) parts.push('prompted');
  if (ctx.current !== null) parts.push(`current ${json(ctx.current)}`);
  if (ctx.window !== null) parts.push(`window ${json(ctx.window)}`);
  if (ctx.records.length > 0) parts.push(`${ctx.records.length} records`);
  if (ctx.locale !== undefined) parts.push(`locale ${ctx.locale}`);
  return parts.join(' · ');
}

const localeSummary = (locale: string | undefined): string => (locale === undefined ? '' : ` · locale ${locale}`);

/** The answers to the questions either side asks, which is all a fill can read of its own. */
function answersFor(answers: AnswerMap, ctx: SlotContext, legacy: SlotSpec, candidate: SlotSpec): AnswerMap {
  const ids = new Set<string>();
  for (const spec of [legacy, candidate]) {
    try {
      for (const id of Object.keys(spec.questions(ctx))) ids.add(id);
    } catch {
      /* summary only */
    }
  }
  return Object.fromEntries(Object.entries(answers).filter(([id]) => ids.has(id)));
}

/** Where two values differ, path by path (at most a dozen lines). */
function differences(a: unknown, b: unknown): string[] {
  const out: string[] = [];
  walk(a, b, '', out);
  return out.length > 12 ? [...out.slice(0, 12), `… ${out.length - 12} more`] : out;
}

function walk(a: unknown, b: unknown, path: string, out: string[]): void {
  if (isDeepStrictEqual(a, b)) return;
  const at = path === '' ? '(the whole value)' : path;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`at ${at}: legacy has ${a.length} items, candidate ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) walk(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  if (isRecord(a) && isRecord(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const p = `${path}.${k}`;
      if (!Object.hasOwn(b, k)) out.push(`at ${p}: legacy ${json(a[k])}, candidate has no ${k}`);
      else if (!Object.hasOwn(a, k)) out.push(`at ${p}: legacy has no ${k}, candidate ${json(b[k])}`);
      else walk(a[k], b[k], p, out);
    }
    return;
  }
  out.push(`at ${at}: legacy ${json(a)}, candidate ${json(b)}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
