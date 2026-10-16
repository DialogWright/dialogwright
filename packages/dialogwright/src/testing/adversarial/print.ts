import { sayText } from '../../channel/actions';
import type { AdversarialReport, CaseResult } from './run';
import { FAMILIES } from './types';
import { turnDetailLines, type TurnDetail } from '../../harness-text/transcript';

/** The report's lines for a regression run: a failure's properties first, then the counts, the cases not yet recorded, the cases not run and why, and (with `notes`) the run's other notes. */
export function formatAdversarialReport(report: AdversarialReport, opts: { notes?: boolean } = {}): string[] {
  const lines: string[] = [];
  const by = (status: CaseResult['status']): CaseResult[] => report.results.filter((r) => r.status === status);
  for (const r of by('fail')) {
    lines.push(`FAIL adversarial ${r.case.id}: ${r.case.about}`);
    for (const v of r.violations) lines.push(`  ${v}`);
  }
  // Under a model: what it read otherwise than a correct model would, which fails nothing.
  for (const r of report.results.filter((x) => (x.readings?.length ?? 0) > 0)) {
    lines.push(`model reading, adversarial ${r.case.id}: ${r.case.about}`);
    for (const v of r.readings!) lines.push(`  ${v}`);
  }
  // The plain hostile words a free-text field let through, said in their own place in a fixed line:
  // the residual risk the guide names, listed so it is seen, failing nothing.
  for (const r of report.results.filter((x) => (x.accepted?.length ?? 0) > 0)) {
    lines.push(`said in its place, adversarial ${r.case.id}:`);
    for (const a of r.accepted!) lines.push(`  ${a}`);
  }
  const count = (status: CaseResult['status']): number => by(status).length;
  const families = FAMILIES.map((f) => {
    const of = report.results.filter((r) => r.case.family === f);
    return of.length === 0 ? null : `${f} ${of.filter((r) => r.status === 'hold').length}/${of.filter((r) => r.status !== 'not-run' && r.status !== 'not-recorded').length}`;
  }).filter((x): x is string => x !== null);
  lines.push(`adversarial ${count('hold')}/${report.results.length - count('not-run') - count('not-recorded')} cases hold${count('fail') > 0 ? `, ${count('fail')} fail` : ''}${count('not-recorded') > 0 ? `, ${count('not-recorded')} not yet recorded` : ''}${count('not-run') > 0 ? `, ${count('not-run')} not run` : ''}  (${families.join(', ')})`);
  const unrecorded = by('not-recorded');
  if (unrecorded.length > 0) {
    lines.push(`  not yet recorded (they are recorded with the app's next --client record): ${unrecorded.map((r) => r.case.id).join(', ')}`);
  }
  // A case the suite meant to generate and could not set up (its line refused by the corpus's checks,
  // its state not seeded): always shown, since it is a case the run did not try.
  for (const n of report.notes.filter((x) => x.includes(': not generated: '))) lines.push(`  ${n}`);
  // A case the run did not try, and why: always shown, one line per reason.
  lines.push(...notRunLines(by('not-run')));
  if (opts.notes === true) {
    for (const n of report.notes.filter((x) => !x.includes(': not generated: '))) lines.push(`  note: ${n}`);
  }
  return lines;
}

/**
 * The cases not run, one line per reason in the order first met: a reason one case has, with its id
 * (`not run: <id>: <reason>`); a reason several share, counted, with their ids
 * (`not run, 18 cases: <reason>: <id>, <id>, ...`).
 */
function notRunLines(results: readonly CaseResult[]): string[] {
  const byNote = new Map<string, string[]>();
  for (const r of results) {
    const note = r.note ?? 'no reason given';
    byNote.set(note, [...(byNote.get(note) ?? []), r.case.id]);
  }
  return [...byNote].map(([note, ids]) => (ids.length === 1 ? `  not run: ${ids[0]}: ${note}` : `  not run, ${ids.length} cases: ${note}: ${ids.join(', ')}`));
}

/**
 * One case turn by turn: each call's turns (what the caller did, what was said, what the gate
 * decided, and what `detail` asks for: the model's answers, the questions and their bars), then its
 * properties' verdict.
 */
export function adversarialTranscript(r: CaseResult, detail: TurnDetail = {}): string[] {
  const c = r.case;
  const lines = [`adversarial ${c.id}`, `  ${c.about}`, `  family ${c.family}, perception ${c.perception}, language ${c.language}`, `  properties: ${c.properties.join(', ')}${c.allowed.length > 0 ? `; allowed outcomes: ${c.allowed.join(', ')}` : ''}`];
  if (c.line) lines.push(`  line: ${JSON.stringify({ ...c.line, tags: undefined })}`);
  const seen = new Map<string, string>();
  for (const call of r.calls) {
    lines.push('', `  call ${call.label}`);
    for (const [i, t] of call.turns.entries()) {
      const e = t.record.event;
      const heard = e.type === 'user.speech' || e.type === 'user.text' ? `caller: ${e.text}` : e.type === 'user.key' ? `caller keys: ${e.digit}` : e.type === 'session.start' ? 'call starts' : e.type;
      lines.push(`    ${i}. ${heard}`);
      const said = sayText(t.result.actions);
      if (said) lines.push(`       agent: ${said}`);
      for (const g of t.result.gateEvents) lines.push(`       gate: ${g.decision.call.tool} ${g.decision.verdict}${g.decision.reason ? ` (${g.decision.reason})` : ''}${g.summary ? `: ${g.summary}` : ''}`);
      if (t.result.quarantined) lines.push('       screen: quarantined');
      lines.push(`       ${t.result.decision.kind}, level ${t.result.session.principal.level}`);
      lines.push(...turnDetailLines(t, '       ', detail, seen));
    }
    if (call.threw) lines.push(`    the next turn threw: ${call.threw}`);
    lines.push(`    outcome: ${call.outcome}`);
  }
  lines.push('', `  ${r.status}${r.note ? `: ${r.note}` : ''}`);
  for (const v of r.violations) lines.push(`    ${v}`);
  for (const v of r.readings ?? []) lines.push(`    model reading: ${v}`);
  for (const a of r.accepted ?? []) lines.push(`    said in its place: ${a}`);
  return lines;
}
