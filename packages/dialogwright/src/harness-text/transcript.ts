import type { CorpusEntry } from '../jev/corpus';
import type { Session } from '../core/session';
import type { GateEvent } from '../core/lifecycle';
import { WEB_VISITOR, spokenText, type Scenario, type ScenarioRun, type ScenarioStep, type TurnRun } from './runner';

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

/** The lines for one turn, indented under its step. */
function turnLines(run: TurnRun, indent: string): string[] {
  const d = run.result.decision;
  const s = run.result.session;
  const lines = [`${indent}-> ${decisionOf(run)}`];
  const acks = 'acks' in d ? d.acks.map((a) => a.promptId) : [];
  if (acks.length > 0) lines.push(`${indent}   acks   ${acks.join(', ')}`);
  const said = spokenText(run.result);
  if (said !== '') lines.push(`${indent}   says   ${JSON.stringify(said)}`);
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
 */
export function scenarioTranscript(scenario: Scenario, run: ScenarioRun): string[] {
  const out = [`scenario ${scenario.id}  (${channelOf(scenario)})`];
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
      out.push(...turnLines(t, '       '));
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
