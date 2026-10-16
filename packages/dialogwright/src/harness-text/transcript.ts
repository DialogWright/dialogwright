import type { CorpusEntry } from '../jev/corpus';
import type { Session } from '../core/session';
import type { GateEvent } from '../core/lifecycle';
import type { Transfer } from '../channel/actions';
import { redactSent } from '../trace/redact';
import { appOf } from '../core/app/registry';
import { WEB_VISITOR, spokenText, type Scenario, type ScenarioRun, type ScenarioStep, type TurnRun } from './runner';
import { rankProbabilities, type Answer, type Question } from '../jev/types';
import type { GateRow } from '../core/gates';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../core/thresholds';

/**
 * A readable account of one scripted call or one corpus line, turn by turn, for `regress --scenario
 * <id>` and `regress --corpus <id>`: what the caller said or keyed, what the agent said (the prompt
 * id, its acknowledgements and the words), the form, the caller's level and the slots after the turn,
 * and every gate decision the turn made (the tool, the verdict, the reason and the rule that decided).
 * It reads the turns the regression ran; it runs nothing of its own.
 */

/** The step as the scenario file writes it. */
export function describeStep(step: ScenarioStep): string {
  if ('say' in step) return `say ${JSON.stringify(step.say)}${step.fail === true ? ' (the model fails)' : ''}${step.partial === true ? ' (partial)' : ''}`;
  if ('dtmf' in step) return `keys ${step.dtmf}`;
  if ('silence' in step) return 'silence';
  if ('signIn' in step) return `signs in as ${step.signIn}`;
  return 'the next service is down';
}

/** Where the call is: a phone call, a subject's chat, or a delegate's signed-in chat. */
function channelOf(scenario: Scenario): string {
  if (scenario.as === undefined) return 'a phone call, anonymous';
  if (scenario.as === WEB_VISITOR) return 'a web chat, anonymous until a sign-in';
  return `a chat signed in as ${scenario.as}`;
}

/** The slots that hold a value, as `id=value`; "none" when no slot does. */
function slotsOf(session: Session): string {
  const filled = Object.entries(session.slots).filter(([, slot]) => slot.value !== null).map(([id, slot]) => `${id}=${slot.value}`);
  return filled.length > 0 ? filled.join(', ') : 'none';
}

/** One gate decision: the tool, its purpose, the verdict and why. */
export function describeGate(event: GateEvent): string {
  const d = event.decision;
  const purpose = d.call.purpose === undefined ? '' : ` (purpose ${d.call.purpose})`;
  const why = d.verdict === 'STEP_UP' ? ` to level ${d.needLevel ?? '?'}` : d.reason !== undefined ? ` reason=${d.reason}` : '';
  const failed = d.rules.find((r) => !r.pass);
  const rule = failed ? `; ${failed.id} ${failed.description}: ${failed.compared}` : '';
  return `${d.call.tool}${purpose} ${d.verdict}${why}${rule}`;
}

/** What the turn decided: the prompt, a handoff and its reason, the end of the call, or nothing said. */
function decisionOf(run: TurnRun): string {
  const d = run.result.decision;
  switch (d.kind) {
    case 'prompt':
      return `prompt ${d.promptId}`;
    case 'handoff':
      return `handoff ${d.reason} (${d.promptId})`;
    case 'complete':
      return `complete ${d.promptId}`;
    case 'replay':
      return 'replay';
    default:
      return d.kind;
  }
}

/** A transfer in one line: its target, the rule taken (or the default), and its headers and chat data as recorded. */
function transferLine(run: TurnRun, t: Transfer): string {
  const app = appOf(run.result.session);
  const d = run.result.decision;
  const rule = d.kind === 'handoff' && d.transfer !== undefined ? (d.transfer.rule === null ? 'the default' : `rule ${d.transfer.rule + 1}`) : '';
  const pairs = (part: 'headers' | 'chat', values: Readonly<Record<string, string>> | undefined): string =>
    Object.entries((redactSent(app, part, values ?? {}, 'length') as Record<string, string>)).map(([k, v]) => `${k}=${v}`).join(', ');
  const headers = pairs('headers', t.headers);
  const data = pairs('chat', t.data);
  return [`${t.target}${rule !== '' ? ` (${rule})` : ''}`, ...(headers !== '' ? [`headers ${headers}`] : []), ...(data !== '' ? [`data ${data}`] : [])].join('   ');
}

/** The lines for one turn, indented under its step. */
function turnLines(run: TurnRun, indent: string): string[] {
  const d = run.result.decision;
  const s = run.result.session;
  const lines = [`${indent}-> ${decisionOf(run)}`];
  const acks = 'acks' in d ? d.acks.map((a) => a.promptId) : [];
  if (acks.length > 0) lines.push(`${indent}   acks   ${acks.join(', ')}`);
  const said = spokenText(run.result);
  if (said !== '') lines.push(`${indent}   says   ${JSON.stringify(said)}`);
  // An app that generates lines: each such line's mode, and for one said generated or fallen back, its fixed line.
  for (const l of run.record.render?.lines ?? []) {
    const how = l.mode === 'generated' ? 'generated' : l.unchanged === true ? 'fixed, said unchanged (the wording was the words themselves)' : l.fallback !== undefined ? `fixed, fell back (${l.fallback})` : `fixed (${l.skipped ?? 'not tried'})`;
    lines.push(`${indent}   line   ${l.promptId}: ${how}${l.mode === 'generated' ? `; fixed ${JSON.stringify(l.fixed)}` : ''}${l.refused !== undefined ? `; refused ${JSON.stringify(l.refused)}` : ''}`);
  }
  // A knowledge answer whose wording ran past its line's budget: the hold line said before it.
  const hold = run.record.render?.hold;
  if (hold !== undefined) lines.push(`${indent}   hold   ${hold.promptId ?? 'the engine\'s words'}, before the answer still being worded`);
  // An app with transfer: where the handoff goes, the rule taken, and what goes with it, each value as a record keeps it.
  const transfer = run.result.actions.find((a) => a.type === 'transfer');
  if (transfer?.type === 'transfer' && transfer.target !== undefined) lines.push(`${indent}   transfer ${transferLine(run, transfer)}`);
  // An app with routes: each route taken, its point, its rule and what followed, and the subjects it read.
  for (const r of run.result.routes ?? []) {
    lines.push(`${indent}   route  ${r.point}${r.form !== undefined ? ` ${r.form}` : ''}: ${r.rule === 'else' ? 'else' : `rule ${r.rule}`} -> ${r.outcome}${r.subjects.length > 0 ? `   read ${r.subjects.join(', ')}` : ''}`);
  }
  lines.push(`${indent}   form   ${s.form ?? '-'}   level ${s.principal.level}   slots ${slotsOf(s)}`);
  for (const event of run.result.gateEvents) lines.push(`${indent}   gate   ${describeGate(event)}`);
  return lines;
}

/** A turn the step made that the caller would notice: one that said something, or the step's last. */
function worthShowing(run: TurnRun, last: boolean): boolean {
  return last || run.result.decision.kind !== 'ignore' || run.result.gateEvents.length > 0;
}

/** A turn a service's answer made rather than the caller (the scenario runner answers it next). */
function serviceTurn(run: TurnRun): string | null {
  const event = run.record.event;
  return event.type === 'service.result' ? `the service "${event.service}" answers${event.result === null ? ' (down)' : ''}` : null;
}

/**
 * A scripted call, step by step, then what it expected and whether it got it. Keypad steps run one
 * turn per key; only the keys that did something (said a line, asked the gate) and the last are shown.
 * With `detail`, each turn shown is followed by what the model answered and the questions and their
 * bars (turnDetailLines).
 */
export function scenarioTranscript(scenario: Scenario, run: ScenarioRun, detail: TurnDetail = {}): string[] {
  const out = [`scenario ${scenario.id}  (${channelOf(scenario)})`];
  const seen = new Map<string, string>();
  const byStep = new Map<number, TurnRun[]>();
  run.runs.forEach((r, i) => {
    const step = run.stepOf[i] ?? -1;
    byStep.set(step, [...(byStep.get(step) ?? []), r]);
  });
  for (const [index, step] of [[-1, null] as const, ...scenario.steps.map((s, i) => [i, s] as const)]) {
    const turns = byStep.get(index) ?? [];
    out.push(step === null ? '  start' : `  ${index + 1}. ${describeStep(step)}`);
    if (step !== null && turns.length === 0) {
      out.push('       (no turn: the call had ended, or the step only sets up the next one)');
      continue;
    }
    const keys = turns.filter((t) => t.record.event.type === 'user.key').length;
    const shown = turns.filter((t, i) => worthShowing(t, i === turns.length - 1));
    if (keys > 1 && shown.length < turns.length) out.push(`       (${keys} keys, one turn each; ${turns.length - shown.length} said nothing and are not shown)`);
    for (const t of shown) {
      const service = serviceTurn(t);
      if (service) out.push(`       ${service}`);
      out.push(...turnLines(t, '       '), ...turnDetailLines(t, '          ', detail, seen));
    }
  }
  const expect = Object.entries(scenario.expect).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
  out.push(`  expect ${expect}`);
  out.push(run.pass ? '  pass' : `  FAIL ${run.mismatches.join('; ')}`);
  return out;
}

/** Where a corpus line is said, as the seed set it up. */
function seededAt(entry: CorpusEntry, setup: TurnRun): string {
  const s = setup.result.session;
  if (entry.context === 'no_form') return entry.as === undefined ? 'the opening of a phone call' : `the opening of a chat signed in as ${entry.as}`;
  return `${entry.context}, answering ${s.lastPromptId ?? 'nothing'}${entry.prompted ? ` (prompted ${entry.prompted})` : ''}`;
}

/** A corpus line: the seeded state it is said in, then the one turn it makes. */
export function corpusTranscript(entry: CorpusEntry, run: { run: TurnRun; setup: TurnRun }): string[] {
  const seeded = run.setup.result.session;
  const labels = entry.labels && Object.keys(entry.labels).length > 0 ? `   labels ${JSON.stringify(entry.labels)}` : '';
  return [
    `corpus ${entry.id}  (intent ${entry.intent}${labels})`,
    `  seeded  ${seededAt(entry, run.setup)}`,
    `          form ${seeded.form ?? '-'}   level ${seeded.principal.level}   slots ${slotsOf(seeded)}`,
    `  1. ${entry.as === undefined ? 'say' : `types (as ${entry.as})`} ${JSON.stringify(entry.text)}`,
    ...turnLines(run.run, '       '),
  ];
}

/** A choice's labels below this are counted, not listed, in a line's model answers. */
const SHOWN_FROM = 0.01;

const p2 = (n: number): string => n.toFixed(2);

/** One answer as a cell: a yes-or-no question's reading, a choice's labels ranked with their probabilities, a score's levels in order. */
function answerCell(q: Question | undefined, a: Answer): string {
  if (a.type === 'noul') return `noul    ${p2(a.noul)}`;
  if (a.type === 'score') {
    const levels = q?.type === 'score' ? q.levels.map((l) => l.label) : Object.keys(a.probabilities);
    return `score   ${levels.map((l) => `${l} ${p2(a.probabilities[l] ?? 0)}`).join('  ')}   (level ${a.score.toFixed(2)})`;
  }
  const ranked = rankProbabilities(a.probabilities);
  const shown = ranked.filter((r) => r.p >= SHOWN_FROM);
  const rest = ranked.length - shown.length;
  return `choice  ${shown.map((r) => `${r.label} ${p2(r.p)}`).join('  ')}${rest > 0 ? `  (+${rest} under ${SHOWN_FROM})` : ''}`;
}

/**
 * What the model answered on one turn, every question of its request with its probabilities (an
 * intent's choice and its rivals, each yes-or-no reading, each slot's questions), then the injection
 * screen's reading; for `regress --corpus <id>` against a model or its cassette, to see why a line
 * read as it did. A turn the model did not answer (a cassette miss, a timeout) says so; a turn that
 * asked nothing (the greeting) says nothing.
 */
export function modelAnswerLines(run: TurnRun, indent = '  '): string[] {
  if (run.questions === null) return [];
  const source = run.record.source;
  if (run.response === null) return [`${indent}model answers: none (${run.error?.message ?? 'no response'})`];
  const answers = run.response.answers;
  const ids = [...new Set([...Object.keys(run.questions), ...Object.keys(answers)])].filter((id) => answers[id] !== undefined);
  const width = Math.max(...ids.map((id) => id.length), 4);
  const lines = [`${indent}model answers (${source})`];
  for (const id of ids) lines.push(`${indent}   ${id.padEnd(width)}  ${answerCell(run.questions[id], answers[id]!)}`);
  const screen = run.record.screen;
  if (screen) {
    const how = screen.inline ? 'in the same request' : 'asked on its own';
    const reading = screen.error !== null ? `none (${screen.error})` : `${screen.value === null ? '-' : p2(screen.value)}${screen.fired ? ', fired' : ''}`;
    lines.push(`${indent}   ${'screen'.padEnd(width)}  ${reading}   (${how})`);
  }
  // The turn's second request on the same words (TraceRecord.followUp), when it made one.
  const followUp = run.followUp;
  if (followUp !== null) {
    if (followUp.response === null) lines.push(`${indent}follow-up (${followUp.followUp.reason}): none (${followUp.error?.message ?? 'no response'})`);
    else {
      lines.push(`${indent}follow-up (${followUp.followUp.reason}, ${followUp.response.source})`);
      for (const [id, a] of Object.entries(followUp.response.answers)) if (followUp.questions[id] !== undefined) lines.push(`${indent}   ${id.padEnd(width)}  ${answerCell(followUp.questions[id], a)}`);
    }
  }
  return lines;
}

/**
 * What a transcript adds under each turn (`regress --scenario`, `--corpus` and `--adversarial`):
 * `answers`, the model's answers to every question (modelAnswerLines), shown against a model or its
 * cassette; `questions` (`--questions`), each question's text and the bar each reading was held to
 * (questionLines), with the run's `thresholds`, by which a bar is named.
 */
export interface TurnDetail {
  readonly answers?: boolean;
  readonly questions?: boolean;
  readonly thresholds?: Thresholds;
}

/** The lines `detail` asks for under one turn; `seen` keeps the questions already written out in this transcript. */
export function turnDetailLines(run: TurnRun, indent: string, detail: TurnDetail, seen: Map<string, string> = new Map()): string[] {
  return [
    ...(detail.answers === true ? modelAnswerLines(run, indent) : []),
    ...(detail.questions === true ? questionLines(run, indent, detail.thresholds ?? DEFAULT_THRESHOLDS, seen) : []),
  ];
}

/**
 * The thresholds a gate row's bar may be, by the row's gate (core/gates.ts and core/turn.ts): the
 * one whose value in the run is the row's bar names it. A row whose gate is not here, or whose bar
 * is none of its names' values (an app's own threshold), is shown with its number alone.
 */
const BAR_NAMES: Readonly<Record<string, readonly string[]>> = {
  addressedToSystem: ['GATE_ADDRESSED'],
  intelligible: ['GATE_INTELLIGIBLE'],
  utteranceComplete: ['GATE_COMPLETE'],
  wantsHuman: ['GATE_WANTS_HUMAN'],
  frustration: ['GATE_FRUSTRATION_HIGH'],
  confirmation: ['CONFIRM_YES', 'CONFIRM_NO'],
  menuNumber: ['MENU_NUMBER'],
  intentTentative: ['INTENT_TENTATIVE'],
  intentChange: ['INTENT_CHANGE'],
  changeSlot: ['SLOT_CHANGE'],
  secondIntent: ['INTENT_SECOND'],
  intent: ['INTENT_EXPLICIT', 'INTENT_SWITCH'],
  intentMargin: ['GATE_INTENT_MARGIN'],
  screen: ['SCREEN_FIRE'],
};

/** The name of a row's bar: its gate's threshold whose value the bar is (`A/B` when two are equal), or '' when none is. */
export function barName(row: GateRow, thresholds: Thresholds): string {
  if (row.threshold === null) return '';
  const gate = row.gate.replace(/^opening:/, '');
  // A slot's row: SLOT_DETECT for a detected slot, SLOT_CHOICE_CONFIRM for a picked one (core/turn.ts slotThreshold).
  // A priority intent's: PRIORITY_INTENT, or the threshold of the app's own the intent names.
  const names = gate.startsWith('slot:') ? ['SLOT_DETECT', 'SLOT_CHOICE_CONFIRM']
    : gate === 'priorityIntent' ? ['PRIORITY_INTENT', ...Object.keys(thresholds).filter((n) => !Object.hasOwn(DEFAULT_THRESHOLDS, n))]
      : BAR_NAMES[gate] ?? [];
  return names.filter((n) => thresholds[n] === row.threshold).join('/');
}

/** A question's text: its instructions, then a choice's options, a score's levels, or a yes-or-no's two readings, each on its own line. */
function questionText(q: Question, indent: string): string[] {
  const lines: string[] = [];
  if (q.type === 'choice') {
    const described = Object.entries(q.criteria).filter(([, d]) => d !== null);
    const bare = Object.entries(q.criteria).filter(([, d]) => d === null).map(([label]) => label);
    for (const [label, d] of described) lines.push(`${indent}${label}: ${d}`);
    if (bare.length > 0) lines.push(`${indent}${described.length > 0 ? 'and ' : ''}${bare.join(', ')}`);
  } else if (q.type === 'score') {
    for (const l of q.levels) lines.push(`${indent}${l.label}: ${l.description}`);
  } else {
    if (q.criteria?.true !== undefined) lines.push(`${indent}yes: ${q.criteria.true}`);
    if (q.criteria?.false !== undefined) lines.push(`${indent}no: ${q.criteria.false}`);
  }
  return lines;
}

/**
 * `--questions`: under a turn, every question its request asked (and its second request's, when it
 * made one), each with its text as the model was sent it, those already written out in this
 * transcript with the same text named on one line (`as above: ...`); then the turn's gates, each
 * reading with the bar it was held to and that bar's name in core/thresholds.ts (what `--threshold
 * NAME=value` moves), whether it passed, what it led to, and `<==` on the one that decided the turn.
 */
export function questionLines(run: TurnRun, indent: string, thresholds: Thresholds, seen: Map<string, string> = new Map()): string[] {
  const lines: string[] = [];
  const asked: Array<[string, Question]> = [...Object.entries(run.questions ?? {}), ...Object.entries(run.followUp?.questions ?? {})];
  if (asked.length > 0) {
    lines.push(`${indent}questions`);
    const same: string[] = [];
    for (const [id, q] of asked) {
      const key = JSON.stringify(q);
      if (seen.get(id) === key) {
        same.push(id);
        continue;
      }
      seen.set(id, key);
      lines.push(`${indent}   ${id}  ${q.instructions}`, ...questionText(q, `${indent}      `));
    }
    if (same.length > 0) lines.push(`${indent}   as above: ${same.join(', ')}`);
  }
  const rows = run.record.gates;
  if (rows.length > 0) {
    const width = Math.max(...rows.map((r) => r.gate.length), 4);
    const names = rows.map((r) => barName(r, thresholds));
    const nameWidth = Math.max(...names.map((n) => n.length), 0);
    lines.push(`${indent}gates  (each reading, the bar it was held to, and what it led to; <== decided the turn)`);
    rows.forEach((r, i) => {
      const value = r.value === null ? '   -' : p2(r.value).padStart(4);
      const bar = r.threshold === null ? `bar    -${' '.repeat(nameWidth + 1)}` : `bar ${p2(r.threshold).padStart(4)} ${names[i]!.padEnd(nameWidth)}`;
      const result = r.threshold === null ? 'info' : r.passed ? 'pass' : 'FAIL';
      lines.push(`${indent}   ${r.gate.padEnd(width)}  ${value}  ${bar}  ${result}  ${r.outcome}${r.decided ? '  <==' : ''}`);
    });
  }
  return lines;
}
