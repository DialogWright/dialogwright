import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_CASSETTE_MISS, agentKey, cassetteAgent } from '../agent/cassette';
import { agentCassettePath, agentRequestOf, liveAgentClient, type AgentModelSpec } from '../agent/bakeoff';
import { NO_ACTION, type AgentAnswer, type AgentClient, type AgentContext, type AgentFailure, type AgentModelChoice, type AgentResult, type AgentRunner, type AgentValue } from '../agent/types';
import { gateOf } from '../core/app/lookup';
import type { App } from '../core/app/types';
import type { TurnRun } from '../run/turn';
import { foreignFigure } from '../render/checks';
import { lexiconOf } from '../core/extract/lexicon';
import { slotLocaleOf } from '../core/locale';
import { agentFigureSources, citedFigureSources } from '../render/agentLine';
import { isAnonymous } from '../gate/types';
import { inCi } from '../define/ci';
import { readBackPromptOf } from '../define/businessFiles';
import { recordedValue, recordingOf } from '../core/recording';

/**
 * Testing an app in agent mode (docs/designs/2026-11-08-agent-mode.md, "Testing"; plan Task 9): the
 * agent's answers a scripted call names, step by step, for the stub regression (no model); the agent
 * cassette a recorded regression replays and a recording appends to (recording and a live run refused in CI); and the properties a scripted call
 * and the adversarial suite's `agent` family hold a call to, over its turns, never its lines.
 */

// ---------------------------------------------------------------------------------------------
// The agent's answers a scripted call names
// ---------------------------------------------------------------------------------------------

/**
 * The agent's answer a scripted call's step names (ScenarioStep `agent`), for the stub regression: the
 * answer's own fields, each optional (no reply, no value, no action, nothing from the facts), or a failure
 * (`{ fail: "timeout" }`: a slow, malformed or failed model).
 */
export type ScriptedAgentAnswer =
  | { reply?: string; values?: AgentValue[]; action?: string; fromFacts?: boolean; fixedLine?: string; asks?: string; closes?: boolean }
  | { fail: AgentFailure; detail?: string };

/** A step's answers: one, or one per asking (the second when the turn asks again, shown a tool's result); every asking needs its own. */
export type ScriptedAgentStep = ScriptedAgentAnswer | readonly ScriptedAgentAnswer[];

/** An answer as the agent gives it, from what a step names. */
export function scriptedAnswer(a: ScriptedAgentAnswer): AgentAnswer | { fail: AgentFailure; detail?: string } {
  if ('fail' in a) return a;
  return {
    reply: a.reply ?? '',
    values: (a.values ?? []).map((v) => ({ field: v.field, value: v.value, words: v.words })),
    action: a.action ?? NO_ACTION,
    fromFacts: a.fromFacts ?? false,
    ...(a.fixedLine !== undefined ? { fixedLine: a.fixedLine } : {}),
    ...(a.asks !== undefined ? { asks: a.asks } : {}),
    ...(a.closes !== undefined ? { closes: a.closes } : {}),
  };
}

/** Whether `v` is a step's agent answers, as a scripted call's JSON holds them. */
export function isScriptedAgentStep(v: unknown): v is ScriptedAgentStep {
  const one = (a: unknown): boolean => {
    if (typeof a !== 'object' || a === null || Array.isArray(a)) return false;
    const x = a as Record<string, unknown>;
    if ('fail' in x) return x.fail === 'timeout' || x.fail === 'invalid' || x.fail === 'error';
    const values = x.values === undefined || (Array.isArray(x.values) && x.values.every((y) => typeof y === 'object' && y !== null && ['field', 'value', 'words'].every((k) => typeof (y as Record<string, unknown>)[k] === 'string')));
    return values && ['reply', 'action', 'fixedLine', 'asks'].every((k) => x[k] === undefined || typeof x[k] === 'string') && ['fromFacts', 'closes'].every((k) => x[k] === undefined || typeof x[k] === 'boolean');
  };
  return Array.isArray(v) ? v.length > 0 && v.every(one) : one(v);
}

/**
 * The fake agent a scripted call's steps answer (the stub regression): before each step the runner sets
 * that step's answers (`step`), and each asking of the turn takes the next, one answer per asking (a turn
 * that asks again, shown a tool's result, needs a second). An asking with none set (a step the agent is
 * asked on that names no answer) is noted (`unscripted`), and so is an asking past the answers the step
 * names (`short`: the step, the asking, and how many it names); each is answered as a model that
 * understood nothing, so the call fails on it rather than pass on an answer nobody wrote.
 */
export function stepAgent(): AgentClient & { step(index: number, answers: ScriptedAgentStep | undefined): void; readonly unscripted: number[]; readonly short: { step: number; asking: number; named: number }[] } {
  let index = -1;
  let answers: readonly ScriptedAgentAnswer[] | null = null;
  let asked = 0;
  const unscripted: number[] = [];
  const short: { step: number; asking: number; named: number }[] = [];
  return {
    model: 'scripted-agent',
    unscripted,
    short,
    step(i, a) {
      index = i;
      answers = a === undefined ? null : Array.isArray(a) ? (a as readonly ScriptedAgentAnswer[]) : [a as ScriptedAgentAnswer];
      asked = 0;
    },
    async answer(_ctx: AgentContext): Promise<AgentResult> {
      const nothing: AgentResult = { ok: true, answer: { reply: '', values: [], action: NO_ACTION, fromFacts: false }, ms: 0 };
      if (answers === null || answers.length === 0) {
        if (!unscripted.includes(index)) unscripted.push(index);
        return nothing;
      }
      if (asked >= answers.length) {
        short.push({ step: index, asking: asked + 1, named: answers.length });
        asked += 1;
        return nothing;
      }
      const out = scriptedAnswer(answers[asked]!);
      asked += 1;
      if ('fail' in out) return { ok: false, reason: out.fail, detail: out.detail ?? `scripted: ${out.fail}`, ms: 0 };
      return { ok: true, answer: out, ms: 0, raw: JSON.stringify(out) };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The agent a regression asks: the steps' answers, its cassette, or the model
// ---------------------------------------------------------------------------------------------

/** The model of an app's agent (style.yaml's `agent`) as the bake-off names it: its request and its cassette's name follow from it. */
export function agentSpecOf(model: AgentModelChoice): AgentModelSpec {
  if (model.provider === 'inception') return { entry: `inception:${model.model}`, provider: 'inception', model: model.model, effort: model.effort, realtime: true };
  return { entry: `openrouter:${model.model}`, provider: 'openrouter', model: model.model, ...(model.effort !== 'instant' ? { effort: model.effort } : {}), realtime: false };
}

/** Where an app's agent cassette is: `<recorded>/agent/<provider>__<model>[.settings].jsonl`. */
export function agentCassetteFile(recordedDir: string, model: AgentModelChoice): string {
  return agentCassettePath(join(recordedDir, 'agent'), agentSpecOf(model));
}

/** What a regression's run gets for the agent of an app in agent mode (harnessAgent). */
export interface HarnessAgent {
  /** The agent model's runner (its cassette, or the model); null on the stubs, which answer from the steps. */
  runner: AgentRunner | null;
  /** The stubs: each scripted call's steps name the agent's answers (ScenarioRunOptions.agentSteps). */
  steps: boolean;
  header: string[];
}

/** The budget a regression gives the agent: long, as a recording's is, so a slow answer is recorded, not cut off (a replay holds each to it all the same). */
export const HARNESS_AGENT_TIMEOUT_MS = 30_000;

/**
 * The agent a regression of `app` asks, by its client kind: on the stubs, the answers each scripted call's
 * steps name (no model); `recorded`, the app's agent cassette replayed (a turn it lacks is a miss, which
 * fails the call); `record`, the model asked with the author's own key and appended to the cassette (refused
 * in CI); `jev`, the model itself. Nothing for an app not in agent mode: its run is exactly as before.
 */
export function harnessAgent(kind: string, app: App, recordedDir: string, env: Readonly<Record<string, string | undefined>> = process.env): HarnessAgent {
  if (app.mode !== 'agent' || app.agent === undefined) return { runner: null, steps: false, header: [] };
  const model = app.agent.model;
  const spec = agentSpecOf(model);
  const label = `${model.model} on ${model.provider} at ${model.effort}`;
  if (kind === 'stub' || kind === 'heuristic') return { runner: null, steps: true, header: ['agent: the answers each scripted call\'s steps name (no model)'] };
  const timeoutMs = { voice: HARNESS_AGENT_TIMEOUT_MS, chat: HARNESS_AGENT_TIMEOUT_MS };
  const path = agentCassetteFile(recordedDir, model);
  if (kind === 'recorded') {
    const client = cassetteAgent(path, { request: agentRequestOf(spec), model: model.model, oneAnswer: true });
    client.preload();
    return { runner: { client, timeoutMs }, steps: false, header: [`agent: ${label}, replayed`, `agent cassette ${path}${existsSync(path) ? '' : ' (not found; every turn will miss until recorded)'}`] };
  }
  if (kind === 'record' && inCi(env)) throw new Error('recording the agent model is the author\'s step, with their own key: it is refused in CI (CI is set)');
  if (kind === 'jev' && inCi(env)) throw new Error('asking the agent model live is the author\'s step, with their own key: it is refused in CI (CI is set); a CI run replays the agent cassette (--client recorded)');
  const live = liveAgentClient(spec, { ...env });
  // One answer per request, as the decision model's cassette keeps (AgentCassetteOptions.oneAnswer): a call's
  // turns, replayed whole or alone, and the adversarial suite's variants of it hear what was recorded for them.
  if (kind === 'record') return { runner: { client: cassetteAgent(path, { record: live, oneAnswer: true }), timeoutMs }, steps: false, header: [`agent: ${label}, recorded`, `agent cassette ${path}`] };
  return { runner: { client: oneAnswerPerRequest(live), timeoutMs }, steps: false, header: [`agent: ${label}, live`] };
}

/**
 * A live agent model asked once per request in a run, as a regression's cassette answers (AgentCassetteOptions
 * .oneAnswer): a request asked again (an adversarial variant of a call, asking what its clean call asked)
 * hears the answer the first asking got, so a variant differs from its clean call by what was changed in
 * it, never by the model sampled twice.
 */
export function oneAnswerPerRequest(client: AgentClient): AgentClient {
  const answered = new Map<string, Promise<AgentResult>>();
  return {
    ...client,
    get model() {
      return client.model;
    },
    answer(ctx: AgentContext, timeoutMs: number): Promise<AgentResult> {
      let key: string;
      try {
        key = agentKey(ctx, client.request);
      } catch {
        return client.answer(ctx, timeoutMs);
      }
      const known = answered.get(key);
      if (known !== undefined) return known;
      const asked = client.answer(ctx, timeoutMs);
      answered.set(key, asked);
      return asked;
    },
  };
}

/** Whether a turn's agent answer (either asking) was a cassette's miss. */
export function agentCassetteMissed(run: Pick<TurnRun, 'record'>): boolean {
  const a = run.record.agent;
  return a !== undefined && (a.detail === AGENT_CASSETTE_MISS || a.again?.detail === AGENT_CASSETTE_MISS);
}

// ---------------------------------------------------------------------------------------------
// Properties over a call's turns
// ---------------------------------------------------------------------------------------------

/**
 * The properties a scripted call of an app in agent mode may hold (ScenarioExpectation), each checked over
 * the call's turns, never its lines:
 * - `values`: what the call's write carries, by field name: the params of the last write a form made (its
 *   first `then` tool, allowed by the gate), as the call is recorded (a value the records hide by its mask,
 *   "...0144"); with none, the values the form open at the end holds. Each is the value exactly, or `{ "has":
 *   [...] }`, words the value holds, each as written, in any case and any order (a text value is the model's
 *   own short version of the caller's words: "two copies" may be "two copies of it");
 * - `action`: a tool the gate allowed on the call (`"bookRoom"`), `"none"` for no form's write allowed, or
 *   `{ "not": "<tool>" }` for one never allowed;
 * - `said.notFigure`: no reply of the agent's that was said holds a figure that the facts, the values the
 *   line understood (with the words a digits or name value was cited from, and a text value's figures that
 *   are in its words too, as the agent line's check reads them) or the results it was shown do not (the
 *   caller's other words are no source: a figure the caller proposes is not the line's to state);
 * - `said.lines`: each line named (a prompt id: `booking_for_accounts`) was said on some turn, as the turn's
 *   own line or before it;
 * - `levelHeld`: nothing ran above the level the caller had once greeted (levelViolations: recognition is at
 *   the call's start only, so nothing a caller says raises it);
 * - `readBackSaid`: the turn before each write (or before the read-back's keypad rung) said its form's
 *   read-back, in its fixed words, with the values the write carries, and a call with no write said one;
 * - `nothingDoneBefore: "confirm"`: no write ran but on the turn whose words confirmed its form's read-back;
 * - `overLineSetAside`: how many turns heard over a line the caller could not interrupt were set aside as
 *   misses (TurnResult.setAside `speech-over-line`: nothing said, nothing counted, the line playing on), so a
 *   call can hold an echo of the line's own words to being no turn (the agent-mode design, call 54).
 * A property that fails names its turn (the greeting is turn 0).
 */
/** A value a property expects: exactly, or holding each of some words (AgentProperties.values). */
export type ExpectedValue = string | { has: readonly string[] };

export interface AgentProperties {
  values?: Record<string, ExpectedValue>;
  action?: string | { not: string };
  said?: { notFigure?: boolean; lines?: string[] };
  levelHeld?: boolean;
  readBackSaid?: boolean;
  nothingDoneBefore?: 'confirm';
  overLineSetAside?: number;
}

/** The property keys of a scripted call's expectation (AgentProperties). */
export const AGENT_PROPERTY_KEYS = ['values', 'action', 'said', 'levelHeld', 'readBackSaid', 'nothingDoneBefore', 'overLineSetAside'] as const;

/** Whether `v` holds only well-formed properties (a scripted call's JSON). */
export function validAgentProperties(v: Record<string, unknown>): boolean {
  const expected = (x: unknown): boolean => typeof x === 'string'
    || (typeof x === 'object' && x !== null && !Array.isArray(x) && Object.keys(x).length === 1 && Array.isArray((x as { has?: unknown }).has) && (x as { has: unknown[] }).has.length > 0 && (x as { has: unknown[] }).has.every((w) => typeof w === 'string' && w.trim() !== ''));
  const values = v.values === undefined || (typeof v.values === 'object' && v.values !== null && !Array.isArray(v.values) && Object.values(v.values).every(expected));
  const action = v.action === undefined || typeof v.action === 'string' || (typeof v.action === 'object' && v.action !== null && typeof (v.action as { not?: unknown }).not === 'string');
  const said = v.said === undefined || (typeof v.said === 'object' && v.said !== null && Object.entries(v.said).every(([k, x]) => (k === 'notFigure' && typeof x === 'boolean') || (k === 'lines' && Array.isArray(x) && x.length > 0 && x.every((l) => typeof l === 'string' && l !== ''))));
  return values && action && said && (v.levelHeld === undefined || typeof v.levelHeld === 'boolean') && (v.readBackSaid === undefined || typeof v.readBackSaid === 'boolean') && (v.nothingDoneBefore === undefined || v.nothingDoneBefore === 'confirm')
    && (v.overLineSetAside === undefined || (typeof v.overLineSetAside === 'number' && Number.isInteger(v.overLineSetAside) && v.overLineSetAside >= 0));
}

/** A form's write: the first tool of its `then`, by tool. */
function writesOf(app: App): Map<string, string> {
  return new Map(Object.entries(app.agent?.forms ?? {}).flatMap(([form, f]) => (f.then[0] !== undefined ? [[f.then[0], form] as [string, string]] : [])));
}

/** Every tool of a form's `then`, by tool: what the read-back's yes calls. */
function thenOf(app: App): Map<string, string> {
  return new Map(Object.entries(app.agent?.forms ?? {}).flatMap(([form, f]) => f.then.map((t) => [t, form] as [string, string])));
}

/** The calls the gate allowed on each turn, by turn. */
const allowed = (turns: readonly Pick<TurnRun, 'result'>[]): { turn: number; tool: string; params: Readonly<Record<string, string>> }[] =>
  turns.flatMap((r, turn) => r.result.gateEvents.filter((e) => e.decision.verdict === 'ALLOW').map((e) => ({ turn, tool: e.decision.call.tool, params: e.decision.call.params as Record<string, string> })));

/** The agent's replies said on each turn (an agent line said in its words, held to the facts first). */
function repliesSaid(turns: readonly Pick<TurnRun, 'record'>[]): { turn: number; said: string; judged: boolean; score?: number; refuseAt?: number }[] {
  return turns.flatMap((r, turn) => {
    const line = r.record.agent?.line;
    if (line === undefined || line.mode !== 'generated' || line.said === undefined) return [];
    return [{ turn, said: line.said, judged: line.judge !== undefined, ...(line.judge !== undefined ? { score: line.judge.score, refuseAt: line.judge.refuseAt } : {}) }];
  });
}

/**
 * Where a figure in a reply said on a turn may come from, as the agent line's own check reads it
 * (render/agentLine.ts agentFigureSources): what the line may say and its fixed lines, every value held
 * after the turn but a text value (as held, as shown, a date with how it is said), the sources the turn's
 * accepted values give (citedFigureSources: a digits or name value's words, a text value's figures in both
 * its value and its words), and the results of the tools the model was shown. Never the caller's other words.
 */
function figureSources(app: App, run: Pick<TurnRun, 'result' | 'record'>, today: string): string[] {
  const s = run.result.session;
  const accepted = (run.result.agent?.values ?? []).filter((v) => v.outcome === 'accepted');
  const seen = run.record.agent?.sent?.seen ?? [];
  return agentFigureSources(app, s, today, { cited: citedFigureSources(app, s, accepted), seen });
}

/** The reply said on a turn that holds a figure its sources do not ("no-figure"). */
export function figureViolations(app: App, turns: readonly Pick<TurnRun, 'result' | 'record'>[], today: string): string[] {
  // Read as the line's own check reads them: a number said in groups by the call's language's lexicon.
  return repliesSaid(turns).filter((r) => foreignFigure(r.said, figureSources(app, turns[r.turn]!, today), { groups: lexiconOf(slotLocaleOf(turns[r.turn]!.result.session)) }))
    .map((r) => `turn ${r.turn} said ${JSON.stringify(r.said)}, with a figure that the facts, the values understood and the results shown do not hold`);
}

/** The reply said on a turn that the drift judge did not pass: not judged, or judged at or above its cutoff ("no-promise"). */
export function unjudgedViolations(turns: readonly Pick<TurnRun, 'record'>[]): string[] {
  return repliesSaid(turns).filter((r) => !r.judged || r.score! >= r.refuseAt!)
    .map((r) => (r.judged ? `turn ${r.turn} said ${JSON.stringify(r.said)}, which the judge refused (${r.score} at ${r.refuseAt})` : `turn ${r.turn} said ${JSON.stringify(r.said)} without the judge passing it`));
}

/** A write (any tool of a form's `then`) that ran on a turn whose words did not confirm its form's read-back ("nothing done before the confirm"). */
export function unconfirmedViolations(app: App, turns: readonly Pick<TurnRun, 'result'>[]): string[] {
  const then = thenOf(app);
  return allowed(turns).filter((c) => then.has(c.tool)).flatMap((c) => {
    const form = then.get(c.tool)!;
    const before = c.turn > 0 ? turns[c.turn - 1]!.result.session.pendingConfirmation : null;
    const pending = before !== null && before.target === 'form' && before.form === form;
    const yes = turns[c.turn]!.result.verdict?.kind === 'confirmed';
    return pending && yes ? [] : [`turn ${c.turn} ran ${c.tool} ${pending ? 'on words that did not confirm' : 'with no read-back of'} the ${form}${pending ? '\'s read-back' : ' pending'}`];
  });
}

/**
 * A tool the gate allowed above the level the caller had once greeted ("no booking without level 1"): an
 * account is recognized at the call's start only, by the number calling (the design's call 15), so nothing
 * said later raises it; the greeting's own calls (the lookup, the recognition) are held to level 0.
 */
export function levelViolations(app: App, turns: readonly Pick<TurnRun, 'result'>[]): string[] {
  const actions = gateOf(app).source.actions;
  const p = turns[0]?.result.session.principal;
  const greeted = p === undefined || isAnonymous(p) ? 0 : p.level;
  return allowed(turns).flatMap((c) => {
    const need = actions[c.tool]?.level ?? 0;
    const had = c.turn === 0 ? 0 : greeted;
    return need > had ? [`turn ${c.turn} ran ${c.tool}, which needs level ${need}, with the caller at level ${had} ${c.turn === 0 ? 'at the call\'s start' : 'once greeted'}`] : [];
  });
}

/** Whether a value held is the one expected: exactly, or holding each word expected (in any case and order). */
function valueHolds(got: string | null | undefined, want: ExpectedValue): boolean {
  if (typeof want === 'string') return got === want;
  if (typeof got !== 'string') return false;
  const folded = got.toLowerCase();
  return want.has.every((w) => folded.includes(w.toLowerCase()));
}

/** What a scripted call's agent properties came to: one line per property that did not hold, each starting with its name. */
export function agentPropertyMismatches(app: App, expect: AgentProperties, turns: readonly Pick<TurnRun, 'result' | 'record'>[], today: string): string[] {
  const out: string[] = [];
  const calls = allowed(turns);
  const writes = writesOf(app);
  const written = calls.filter((c) => writes.has(c.tool));
  if (expect.values !== undefined) {
    const last = written.at(-1);
    const end = turns.at(-1)?.result.session;
    const formEnd = end?.form ?? null;
    const held = (field: string): string | null | undefined => {
      if (last !== undefined) return last.params[field];
      const f = formEnd !== null ? app.agent?.forms[formEnd]?.fields.find((x) => x.name === field) : undefined;
      return f === undefined ? undefined : end!.slots[f.slot]?.value;
    };
    for (const [field, want] of Object.entries(expect.values)) {
      const got = held(field);
      if (valueHolds(got, want)) continue;
      const wanted = typeof want === 'string' ? JSON.stringify(want) : `a value with ${want.has.map((w) => JSON.stringify(w)).join(', ')}`;
      out.push(`values: ${field}: expected ${wanted}, got ${got === undefined ? 'no such field' : JSON.stringify(got)}${last !== undefined ? ` in ${last.tool} on turn ${last.turn}` : ' (no write; in the form open at the end)'}`);
    }
  }
  if (expect.action !== undefined) {
    const a = expect.action;
    if (typeof a === 'string' && a === 'none') {
      for (const w of written) out.push(`action: expected no write, but turn ${w.turn} ran ${w.tool}`);
    } else if (typeof a === 'string') {
      if (!calls.some((c) => c.tool === a)) out.push(`action: expected ${a} to run, but the gate never allowed it`);
    } else {
      for (const c of calls.filter((x) => x.tool === a.not)) out.push(`action: expected ${a.not} never to run, but turn ${c.turn} ran it`);
    }
  }
  if (expect.said?.notFigure === true) for (const v of figureViolations(app, turns, today)) out.push(`said.notFigure: ${v}`);
  for (const line of expect.said?.lines ?? []) {
    const spoke = turns.some((r) => {
      const d = r.result.decision;
      return 'promptId' in d && (d.promptId === line || ('acks' in d && d.acks.some((a) => a.promptId === line)));
    });
    if (!spoke) out.push(`said.lines: no turn said ${line}`);
  }
  if (expect.levelHeld === true) for (const v of levelViolations(app, turns)) out.push(`levelHeld: ${v}`);
  if (expect.overLineSetAside !== undefined) {
    const setAside = turns.flatMap((r, turn) => (r.result.setAside === 'speech-over-line' ? [turn] : []));
    if (setAside.length !== expect.overLineSetAside) out.push(`overLineSetAside: expected ${expect.overLineSetAside} turn(s) heard over a line set aside, but ${setAside.length === 0 ? 'none was' : `turn(s) ${setAside.join(', ')} were`}`);
  }
  if (expect.readBackSaid === true) {
    const said = (turn: number, form: string): boolean => {
      const d = turns[turn]?.result.decision;
      return d !== undefined && d.kind === 'prompt' && d.promptId === readBackPromptOf(form as never);
    };
    // The keypad rung of the read-back ("press 1 for yes") may stand between it and the write.
    const keypad = (turn: number): boolean => {
      const d = turns[turn]?.result.decision;
      return d !== undefined && d.kind === 'prompt' && d.promptId === 'confirm_dtmf';
    };
    for (const w of written) {
      const form = writes.get(w.tool)!;
      let at = w.turn - 1;
      while (at > 0 && keypad(at)) at -= 1;
      if (!said(at, form)) {
        out.push(`readBackSaid: turn ${w.turn} ran ${w.tool}, but turn ${w.turn - 1} did not say the ${form}'s read-back`);
        continue;
      }
      // The values the read-back said (as held when it was said) are the ones the write carries: each as the
      // call is recorded (a value the records hide by its mask, an empty field as ""), one never recorded not compared.
      const heldThen = turns[at]!.result.session.slots;
      for (const f of app.agent?.forms[form]?.fields ?? []) {
        const then = recordedValue(recordingOf(app, f.name), heldThen[f.slot]?.value ?? '');
        if (then === null) continue;
        const sent = w.params[f.name] ?? '';
        if (then !== sent) out.push(`readBackSaid: turn ${w.turn} ran ${w.tool} with ${f.name} ${JSON.stringify(sent)}, but the read-back on turn ${at} said ${JSON.stringify(then)}`);
      }
    }
    if (written.length === 0 && !turns.some((_, i) => Object.keys(app.agent?.forms ?? {}).some((f) => said(i, f)))) out.push('readBackSaid: no turn said a read-back');
  }
  if (expect.nothingDoneBefore === 'confirm') for (const v of unconfirmedViolations(app, turns)) out.push(`nothingDoneBefore: ${v}`);
  return out;
}
