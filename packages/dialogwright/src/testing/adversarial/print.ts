import { sayText } from '../../channel/actions';
import type { AdversarialReport, CaseResult } from './run';
import { FAMILIES } from './types';

/** The report's lines for a regression run: a failure's properties first, then the counts, the cases not yet recorded, and the notes. */
export function formatAdversarialReport(report: AdversarialReport, opts: { notes?: boolean } = {}): string[] {
  const lines: string[] = [];
  const by = (status: CaseResult['status']): CaseResult[] => report.results.filter((r) => r.status === status);
  for (const r of by('fail')) {
    lines.push(`FAIL adversarial ${r.case.id}: ${r.case.about}`);
    for (const v of r.violations) lines.push(`  ${v}`);
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
  if (opts.notes === true) {
    for (const r of by('not-run')) lines.push(`  not run: ${r.case.id}: ${r.note ?? ''}`);
    for (const n of report.notes) lines.push(`  note: ${n}`);
  }
  return lines;
}

/** One case turn by turn: each call's turns (what the caller did, what was said, what the gate decided), then its properties' verdict. */
export function adversarialTranscript(r: CaseResult): string[] {
  const c = r.case;
  const lines = [`adversarial ${c.id}`, `  ${c.about}`, `  family ${c.family}, perception ${c.perception}, language ${c.language}`, `  properties: ${c.properties.join(', ')}${c.allowed.length > 0 ? `; allowed outcomes: ${c.allowed.join(', ')}` : ''}`];
  if (c.line) lines.push(`  line: ${JSON.stringify({ ...c.line, tags: undefined })}`);
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
    }
    if (call.threw) lines.push(`    the next turn threw: ${call.threw}`);
    lines.push(`    outcome: ${call.outcome}`);
  }
  lines.push('', `  ${r.status}${r.note ? `: ${r.note}` : ''}`);
  for (const v of r.violations) lines.push(`    ${v}`);
  return lines;
}
