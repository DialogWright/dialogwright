import type { ConverseApp } from '../converse/app';
import type { ActionSpec, AgentBusiness } from '../converse/business/schema';
import { END_CALL, TEXT_MAX } from '../converse/business/schema';
import { hasJourneys } from '../converse/journeys';
import { confirmedFields, CALLER, NO_LOOKUPS, policyOf } from '../converse/policy';
import { readRule } from '../define/ruleEntry';
import type { RuleEntryYaml } from '../define/schema/policy';
import type { PolicyAction, Rule } from '../gate/compiled';
import { confirmationHash } from '../gate/lines';
import type { GateFacts } from '../gate/types';
import { andList, cell, code, mermaidLabel, nodeId } from './generatedPage';
import { verdictText } from './policyMatrix';

/**
 * Test support: the pages written from a converse app's agent.yaml (docs/designs/2026-11-11-agent-runtime.md,
 * "Per-app obligations"): the policy matrix, the policy card and the app map, as a scripted app's pages are
 * (policyMatrix.ts, policyCard.ts, appMap.ts) and read from the same gate: each action's rules as agent.yaml
 * writes them, with `confirmed` over all of a change's params last (converse/policy.ts policyOf). The
 * commands `pnpm policy:matrix`, `pnpm policy:card` and `pnpm app:diagram` write them; the app's tests
 * (expectPolicyMatrix, expectPolicyCard, expectAppMap) compare them with what the app generates today.
 */

/** The day the gate is asked on: a fixed one, so the matrix does not move with the clock. */
const MATRIX_TODAY = '2026-11-11';

const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - s.length));

/** The actions run after another's yes (agent.yaml's `then`), never offered to the model. */
function followOnsOf(b: AgentBusiness): Set<string> {
  return new Set(Object.values(b.actions).flatMap((a) => a.then ?? []));
}

/** A bound as it is written: today (plus days), a date, a number, or a lookup's value. */
function boundText(b: { kind: string; days?: number; date?: string; value?: string; ref?: { lookup: string; param: string; field?: string } }): string {
  switch (b.kind) {
    case 'today': return b.days === undefined ? 'today' : `today ${b.days > 0 ? '+' : '-'} ${Math.abs(b.days)} days`;
    case 'date': return b.date ?? '';
    case 'number': return b.value ?? '';
    default: return `${b.ref!.lookup}(${b.ref!.param})${b.ref!.field === undefined ? '' : `.${b.ref!.field}`}`;
  }
}

/** A range rule's bounds, in words: "not before 2026-12-01, not after today + 30 days". */
function boundsText(rule: Rule): string {
  if (rule.rule === 'dateInRange') {
    return [rule.notBefore ? `not before ${boundText(rule.notBefore)}` : '', rule.notAfter ? `not after ${boundText(rule.notAfter)}` : '', rule.within ? `within ${boundText({ kind: 'lookup', ref: rule.within })}` : ''].filter((x) => x !== '').join(', ');
  }
  if (rule.rule === 'limit') return [rule.min ? `at least ${boundText(rule.min)}` : '', rule.max ? `at most ${boundText(rule.max)}` : ''].filter((x) => x !== '').join(', ');
  return '';
}

/** A rule as agent.yaml wrote it, in words. */
function ruleWords(rule: Rule): string {
  switch (rule.rule) {
    case 'oneOf': return `${rule.field} must be one of ${rule.values.join(', ')}${rule.reason === undefined ? '' : ` (refused as ${rule.reason})`}`;
    case 'noneOf': return `${rule.field} must not be ${rule.values.join(', ')}${rule.reason === undefined ? '' : ` (refused as ${rule.reason})`}`;
    case 'fields': return `only ${rule.fields.join(', ')} may be sent`;
    case 'confirmed': return `the caller's yes to a read-back of ${rule.fields.join(', ') || 'no values'}`;
    case 'dateInRange': return `${rule.field} must be a day ${boundsText(rule) || 'in range'}`;
    case 'limit': return `${rule.field} must be a number ${boundsText(rule) || 'within its limit'}`;
    case 'callerNumber': return `${rule.field} must be the number calling${rule.else === 'confirmed' ? ', or one the caller confirmed' : ''}${rule.withheld === 'refuse' ? ' (refused where the caller withheld it)' : ''}`;
    case 'scope': return rule.subject === null ? 'scope (no subject)' : `${rule.subject.param} must be a subject the caller may act for`;
    default: return rule.rule;
  }
}

/** A rule as the matrix header writes it. */
function ruleHeader(rule: Rule): string {
  switch (rule.rule) {
    case 'confirmed': return `confirmed(${rule.fields.join(', ')})`;
    case 'fields': return `fields(${rule.fields.join(', ')})`;
    case 'oneOf': return `oneOf(${rule.field}: ${rule.values.join(', ')})`;
    case 'noneOf': return `noneOf(${rule.field}: ${rule.values.join(', ')})`;
    case 'dateInRange': return `dateInRange(${rule.field}: ${boundsText(rule)})`;
    case 'limit': return `limit(${rule.field}: ${boundsText(rule)})`;
    case 'callerNumber': return `callerNumber(${rule.field}${rule.else === 'confirmed' ? ', else confirmed' : ''}${rule.withheld === 'refuse' ? ', withheld refused' : ''})`;
    case 'scope': return rule.subject === null ? 'scope(no subject)' : `scope(${rule.subject.param})`;
    case 'custom': return `custom ${rule.id}`;
    default: return rule.rule;
  }
}

/** A value of a param of each type, for a call the matrix makes: the gate reads values by its rules, never by type. */
function sampleValue(spec: ActionSpec['params'][string]): string {
  switch (spec.type) {
    case 'date': return '2026-12-01';
    case 'phone': return '+15555550142';
    case 'number': return '1';
    case 'slot': return 'slot-1';
    case 'choice': return spec.options?.[0] ?? 'option';
    default: return 'sample';
  }
}

/** The value a listed param is tried with besides the ones listed. */
const OTHER = 'another value';

/** A day (YYYY-MM-DD) some days from another. */
function daysFrom(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------------------------

/** policy.matrix's text for a converse app: every action's verdict, with and without the caller's yes, and for the values its rules list. */
export function conversePolicyMatrixText(app: ConverseApp): string {
  const policy = policyOf(app.business);
  const out: string[] = [
    `# policy.matrix: what the gate of "${app.id}" decides, for every action.`,
    '# Written by `pnpm policy:matrix` from agent.yaml\'s actions (their rules as written, and, for a change,',
    '# `confirmed` over all its params last); a test fails when it differs. Never edit it by hand: a difference',
    '# here is a change in what the agent may do, to be reviewed as the policy is.',
    '#',
    '# Every call is made by a caller nobody has proven (level 0): agent.yaml has no identity. Under each',
    '# action (its level and its rules in the order they run), one line per kind of call, where a|b means',
    '# either value.',
    '# what a call carries',
    '#   confirmed   none; match (the caller said yes to a read-back of exactly these values); mismatch',
    '#   a param     for a param a rule lists or bounds: every value listed, the value at each bound and one beyond it (a bound a lookup gives is not tried), and another value',
    '# verdicts: ALLOW; BLOCK <reason>; STEP_UP to <level>; NEEDS_HUMAN <reason>',
  ];
  for (const [name, spec] of Object.entries(app.business.actions)) {
    const action: PolicyAction = policy.source.actions[name]!;
    out.push('', `${name} · level ${action.level} · ${action.rules.map(ruleHeader).join(', ') || 'no rules'}`);
    const base = Object.fromEntries(Object.entries(spec.params).map(([p, s]) => [p, sampleValue(s)]));
    // The params a rule bounds or lists: each tried with every value listed, at and beyond each bound, and another value.
    const tried = new Map<string, string[]>();
    const add = (field: string, ...values: string[]): void => void tried.set(field, [...new Set([...(tried.get(field) ?? []), ...values])]);
    for (const r of action.rules) {
      if (r.rule === 'oneOf' || r.rule === 'noneOf') add(r.field, ...r.values, OTHER);
      else if (r.rule === 'dateInRange') {
        for (const [bound, step] of [[r.notBefore, -1], [r.notAfter, 1]] as const) {
          const day = bound?.kind === 'today' ? daysFrom(MATRIX_TODAY, bound.days ?? 0) : bound?.kind === 'date' ? bound.date : undefined;
          if (day !== undefined) add(r.field, day, daysFrom(day, step));
        }
      } else if (r.rule === 'limit') {
        for (const [bound, step] of [[r.min, -1], [r.max, 1]] as const) {
          const n = bound?.kind === 'number' ? Number(bound.value) : NaN;
          if (Number.isFinite(n)) add(r.field, String(n), String(n + step));
        }
      }
    }
    let variants: Record<string, string>[] = [{}];
    for (const [field, values] of tried) variants = variants.flatMap((v) => values.map((value) => ({ ...v, [field]: value })));
    const confirmations = spec.kind === 'change' ? (['none', 'match', 'mismatch'] as const) : (['none'] as const);
    const lines: { cond: string; verdict: string }[] = [];
    for (const variant of variants) {
      const params = { ...base, ...Object.fromEntries(Object.entries(variant).map(([k, v]) => [k, v === OTHER ? 'x-other' : v])) };
      const byVerdict = new Map<string, string[]>();
      for (const c of confirmations) {
        const confirmedHash = c === 'none' ? null : c === 'match' ? confirmationHash(params, confirmedFields(spec)) : confirmationHash({}, confirmedFields(spec));
        const facts: GateFacts = { attempts: 0, confirmedHash, todayIso: MATRIX_TODAY };
        const text = verdictText(policy.evaluate({ tool: name, params }, CALLER, facts, NO_LOOKUPS));
        byVerdict.set(text, [...(byVerdict.get(text) ?? []), c]);
      }
      const named = Object.entries(variant).map(([k, v]) => `${k} ${v}`).join(', ');
      for (const [verdict, cs] of byVerdict) {
        const conf = spec.kind === 'change' ? (byVerdict.size === 1 ? '' : `confirmed ${cs.join('|')}`) : '';
        lines.push({ cond: [named, conf].filter((s) => s !== '').join(', ') || 'any call', verdict });
      }
    }
    const width = Math.max(...lines.map((l) => l.cond.length)) + 2;
    lines.forEach((l, i) => out.push(`  ${pad(i === 0 ? 'every caller' : '', 14)}${lines.length === 1 ? l.verdict : `${pad(l.cond, width)}${l.verdict}`}`));
  }
  const unlisted = policy.evaluate({ tool: '(unlisted)', params: {} }, CALLER, { attempts: 0, confirmedHash: null, todayIso: MATRIX_TODAY }, NO_LOOKUPS);
  out.push('', '(unlisted) · an action agent.yaml does not list', `  ${pad('every caller', 14)}${verdictText(unlisted)}`);
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------------------------

const RECORDED: Record<string, string> = {
  keep: 'as it is',
  last4: 'by its last four',
  mask: 'hidden (`•`)',
  length: 'by its length only',
  secret: 'never recorded',
};

function recordedWords(spec: ActionSpec, param: string): string {
  return RECORDED[spec.audit?.[param] ?? 'mask']!;
}

/** A param's type as the card shows it: a slot with its lookup, a choice with its options, a text with its bound. */
function typeWords(s: ActionSpec['params'][string]): string {
  if (s.type === 'slot') return `slot from ${code(s.from ?? '')}`;
  if (s.type === 'choice') return `choice (${(s.options ?? []).join(', ')})`;
  if (s.type === 'text') return `text (one line, at most ${s.max ?? TEXT_MAX} characters)`;
  return s.type;
}

/** The rules of an action as agent.yaml wrote them (the gate adds `confirmed` for a change, shown apart). */
function writtenRules(spec: ActionSpec): Rule[] {
  return (spec.rules ?? []).map((entry) => readRule(entry as RuleEntryYaml));
}

/** What the card says of the check after speaking (agent.yaml `checks.claims`, docs/designs/2026-11-11-claims-check.md): what the decision model is sent for it, and what follows. */
function checkWords(b: ConverseApp['business']): string {
  const c = b.checks.claims;
  if (c.mode === 'off') return 'The check after speaking is off (agent.yaml `checks.claims.mode: off`): the decision model is sent no reply of the agent model.';
  const then = c.mode === 'correct'
    ? `a reply read as contradicted or as saying something was done that was not, at ${c.correctAt} or over, goes back to the agent model with a note marked as the line's own check (never as the caller's words: any words of the caller's that imitate the note's mark are rewritten before the agent model is sent them), and its correction is said after the reply (a correction that fails says nothing more); a gap (a commitment the business information does not address) at ${c.gapAt} or over is recorded`
    : `its readings are recorded (a reading of contradicted or not done at ${c.correctAt} or over, a gap at ${c.gapAt} or over), and nothing more is said`;
  return `For the check after speaking (agent.yaml \`checks.claims.mode: ${c.mode}\`), it is also sent the business information, the business's day, the call's actions so far with the agent model's arguments and what each returned (as the agent model was sent them), and each reply of the agent model as it was said, once said: ${then}. The trace keeps each reply's readings.`;
}

/** What the card says the decision model is sent to route each caller turn among the journeys (converse/journeys.ts routeState and routeQuestions). */
function routingWords(): string {
  return '- For routing among the journeys, the decision model is also sent each caller turn\'s words, the line\'s last reply before them (the read-back waiting for its answer, where one is), and the trigger (`when`) of each journey open to the caller (the journey in progress and one set aside among them); in a finished journey\'s after phase, also the finished journey\'s goal. A turn whose yes runs its read-back is not routed.';
}

/** Where an action is offered, in words: the root and the journeys that name it. */
function offeredIn(b: AgentBusiness, name: string): string {
  const places = [...((b.root?.actions ?? []).includes(name) ? ['at the root'] : []), ...Object.entries(b.journeys ?? {}).filter(([, j]) => j.actions.includes(name)).map(([id]) => code(id))];
  return places.join(', ') || 'none';
}

/** Who a journey is open to and what starts it, in words. */
function journeyAudience(j: NonNullable<AgentBusiness['journeys']>[string]): string {
  const open = j.for === undefined ? 'Open to every caller.' : j.for.account === 'recognised' ? 'Open only where the number calling is on an account.' : 'Open only where the number calling is on no account.';
  return j.start === undefined ? open : `${open} Starts the call there.`;
}

/** The card's Journeys section: the root, then each journey's trigger, audience and actions. */
function journeyCardLines(b: AgentBusiness): string[] {
  const lines = [
    '## Journeys',
    '',
    '- Each caller turn, the decision model reads which journey (task) the caller wants now. The agent model is offered only the actions of the journey it is in (or the root\'s), and an action of another journey is refused as not offered, audited and not counted as a refusal of the action.',
    `- The root offers ${(b.root?.actions ?? []).length > 0 ? andList((b.root?.actions ?? []).map(code)) : 'no actions'}${b.root?.instructions === undefined ? '' : ' and has its own instructions'}.`,
    '',
  ];
  for (const [id, j] of Object.entries(b.journeys ?? {})) {
    lines.push(`### ${code(id)}`, '', `- Trigger: ${cell(j.when)}`, `- ${journeyAudience(j)}`, `- Actions: ${j.actions.length > 0 ? andList(j.actions.map(code)) : 'none'}`);
    if (j.completes !== undefined) lines.push(`- Done when ${andList(j.completes.map(code))} runs on the caller's yes.`);
    lines.push('');
  }
  return lines;
}

/** The policy card for a converse app, as Markdown. */
export function conversePolicyCardText(app: ConverseApp): string {
  const b = app.business;
  const followOns = followOnsOf(b);
  const parentsOf = (name: string): string[] => Object.entries(b.actions).filter(([, a]) => a.then?.includes(name)).map(([n]) => n);
  const levels = [...new Set(Object.values(policyOf(b).source.actions).map((a) => a.level))];
  const accounts = (b.sources.accounts ?? []).length > 0;
  const identityLine = levels.length === 1 && levels[0] === 0
    ? `Every action is open to a caller nobody has proven (level 0): this app has no identity.${accounts ? ' The number a caller calls from may recognise a known account; it is never proof of who is speaking.' : ''}`
    : `The actions are at levels ${levels.join(', ')}; the runtime asks for every call as a caller nobody has proven (level 0).`;
  const lines: string[] = [
    `# Policy card: ${b.business.name}`,
    '',
    '*Generated from `agent.yaml`\'s actions by `pnpm policy:card`: do not edit it by hand. Change the file, write the card again, and review the diff. A test fails when this page and the file disagree.*',
    '',
    '## How the gate decides',
    '',
    '- A model leads the conversation, but it acts only through the actions below, and every action goes through the gate. Each decision, allowed or refused, is written to the audit.',
    '- Anything not listed under Actions is refused.',
    `- ${identityLine}`,
    '- The rules of an action run in the order shown, and the first one that fails decides.',
    '- Every change is read back in the business\'s fixed words with exactly the values it will run with. The caller\'s answer is read as a yes or a no by the decision model (not the agent model), and the change runs only on a clear yes (the gate\'s `confirmed` rule, over all of the change\'s params, runs last). A lookup is never confirmed.',
    '- One confirmation at a time: a call made while a read-back waits for its answer is not run, and is no refusal of its action (it counts toward no limit below).',
    '- Anything but a clear yes runs nothing: the agent model is told that nothing was changed and what the caller said.',
    '- A follow-on action runs only after its parent ran on the caller\'s yes, with the values read back there, through the gate with its own confirmation hash; it has no read-back of its own.',
    `- After ${b.limits.refusalsPerAction} refusals of the same action on a call (\`limits.refusalsPerAction\`), the agent model is told to offer the caller a person rather than try again.`,
    `- ${code(END_CALL)} is the runtime's own action, offered to the model on every call: it says the closing line and ends the call, and changes nothing.`,
    '',
    '## What a model is sent and what is recorded',
    '',
    '- The agent model is sent, in full: the caller\'s words, its own replies, the fixed lines said, the arguments of its own action calls, each read-back as it was said (the caller\'s own values among it), and what each action returned, as the action returned it. Nothing checks an action\'s result: there is no closed-form check on a converse action\'s reply, so an action returns only what the model may see. This app has no identity factors to withhold.',
    `- The decision model (not the agent model) is sent each read-back as it was said, the caller's own words in answer to it and the business's day (today's date, in words), to read a yes or a no. ${checkWords(b)}`,
    ...(hasJourneys(b) ? [routingWords()] : []),
    '- The caller\'s number reaches the agent model only by its last four digits, so it can say them; the whole number goes only to the actions\' code (a phone param the model writes as `caller` is resolved by the runtime).',
    '- Only the reason the gate refused a call is scrubbed before the agent model is told it: any value of a param that is recorded hidden is replaced by its recorded form. The reason a call\'s values were not valid for their types, and the words an action failed with, go to the agent model as written.',
    '- The trace and the audit record each action\'s params as its `audit` says, hidden (`•`) where it says nothing (see each action\'s table below). Only the audit records an action\'s result, as the model is sent it, with the values of hidden params replaced and cut to 600 characters; the trace records whether it ran (and the words it failed with, those values replaced), not what it returned.',
    '- The caller\'s own words, typed or spoken, are kept as they said them in the trace and the frame log, as in the scripted mode.',
    '',
    ...(hasJourneys(b) ? journeyCardLines(b) : []),
    '## Actions',
    '',
    hasJourneys(b) ? '| Action | Kind | Offered to the model | Journeys | Rules | Follow-on actions |' : '| Action | Kind | Offered to the model | Rules | Follow-on actions |',
    hasJourneys(b) ? '| --- | --- | --- | --- | --- | --- |' : '| --- | --- | --- | --- | --- |',
  ];
  for (const [name, spec] of Object.entries(b.actions)) {
    const rules = writtenRules(spec).map(ruleHeader);
    const all = spec.kind === 'change' ? [...rules, `confirmed(${confirmedFields(spec).join(', ')})`] : rules;
    lines.push(`| ${code(name)} | ${spec.kind} | ${followOns.has(name) ? `no: follows ${andList(parentsOf(name).map(code))}` : hasJourneys(b) && offeredIn(b, name) === 'none' ? 'no: named by no journey' : 'yes'} | ${hasJourneys(b) ? `${followOns.has(name) ? 'none' : offeredIn(b, name)} | ` : ''}${cell(all.map(code).join(', ') || 'none')} | ${spec.then?.map(code).join(', ') ?? 'none'} |`);
  }
  for (const [name, spec] of Object.entries(b.actions)) {
    lines.push('', `### ${code(name)}: ${spec.kind === 'change' ? 'a change' : 'a lookup'}`, '', cell(spec.about.trim().replace(/\s+/g, ' ')), '');
    if (followOns.has(name)) lines.push(`Never offered to the model, and it has no read-back of its own: it runs after the caller's yes to ${andList(parentsOf(name).map(code))}, whose confirmation stands in for it, with the values read back there.`, '');
    if (spec.kind === 'change' && !followOns.has(name)) {
      const frame = spec.readBack?.en ?? '';
      lines.push(`Read back before it runs, in these words: "${frame}"${/\[[^[\]]*\]/.test(frame) ? ' (a part in square brackets is said only when its value is given)' : ''}`, '');
    }
    const written = writtenRules(spec);
    lines.push('Rules, in the order they run:', '');
    written.forEach((r) => lines.push(`- ${ruleWords(r)}`));
    if (spec.kind === 'change') lines.push(followOns.has(name) ? `- the caller's yes to the read-back of ${andList(parentsOf(name).map(code))} (its values for ${confirmedFields(spec).join(', ') || 'no values'} are the ones read back there)` : `- ${ruleWords({ rule: 'confirmed', fields: confirmedFields(spec) })}`);
    if (written.length === 0 && spec.kind === 'lookup') lines.push('- none: a lookup reads and returns a result; it is open to every caller');
    if (spec.then !== undefined && spec.then.length > 0) lines.push('', `After the caller's yes it is followed by ${andList(spec.then.map(code))}, each through the gate.`);
    const params = Object.entries(spec.params);
    if (params.length > 0) {
      lines.push('', '| Param | Type | Recorded |', '| --- | --- | --- |');
      for (const [p, s] of params) lines.push(`| ${code(p)} | ${typeWords(s)} | ${recordedWords(spec, p)} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------------------------

/** The app map for a converse app, as Markdown: its actions, what follows what, where a value must come from, and its sources. */
export function converseAppMapText(app: ConverseApp): string {
  const b = app.business;
  const followOns = followOnsOf(b);
  const names = Object.keys(b.actions);
  const lines: string[] = [
    `# App map: ${b.business.name}`,
    '',
    '*Generated from the app\'s `agent.yaml` by `pnpm app:diagram`: do not edit it by hand. A test fails when this page and the file disagree.*',
    '',
    '**This is the structure of the app, not a script for a call.** A model holds the conversation and chooses which action to call; the map shows what each action takes, what runs after a confirmed change, and where a value must come from.',
    '',
    '## What the agent can do',
    '',
    '| Action | Kind | Takes | Value from |',
    '| --- | --- | --- | --- |',
  ];
  for (const [name, spec] of Object.entries(b.actions)) {
    const takes = Object.keys(spec.params).map(code).join(', ') || 'nothing';
    const from = [...new Set(Object.values(spec.params).filter((p) => p.type === 'slot').map((p) => p.from ?? ''))].map(code).join(', ') || 'the caller';
    lines.push(`| ${code(name)} | ${spec.kind}${followOns.has(name) ? ', a follow-on' : ''} | ${cell(takes)} | ${from} |`);
  }
  lines.push('', '## Actions, follow-ons and sources', '', '```mermaid', 'flowchart LR');
  const calendar = b.sources.calendar;
  const accounts = b.sources.accounts;
  if (calendar !== undefined || (accounts !== undefined && accounts.length > 0)) {
    lines.push('  subgraph sources["Sources"]');
    if (calendar !== undefined) lines.push(`    src_calendar[${mermaidLabel('calendar', `${calendar.kind}: ${calendar.days.length} days`, `windows: ${calendar.windows.map((w) => w.name).join(', ') || 'none'}`)}]`);
    if (accounts !== undefined && accounts.length > 0) lines.push(`    src_accounts[${mermaidLabel('accounts', `${accounts.length} recognised by the number calling`)}]`);
    lines.push('  end');
  }
  for (const [name, spec] of Object.entries(b.actions)) {
    const shape = spec.kind === 'lookup' ? ['[', ']'] : ['[[', ']]'];
    lines.push(`  ${nodeId('a', name)}${shape[0]}${mermaidLabel(name, spec.kind === 'lookup' ? 'lookup' : followOns.has(name) ? 'change (follow-on)' : 'change: read back, then yes')}${shape[1]}`);
  }
  lines.push(`  ${nodeId('a', END_CALL)}(${mermaidLabel(END_CALL, 'closing line, ends the call')})`);
  for (const [name, spec] of Object.entries(b.actions)) {
    for (const [p, s] of Object.entries(spec.params)) if (s.type === 'slot' && s.from !== undefined && names.includes(s.from)) lines.push(`  ${nodeId('a', s.from)} -->|${mermaidLabel(p).slice(1, -1)}| ${nodeId('a', name)}`);
    for (const t of spec.then ?? []) lines.push(`  ${nodeId('a', name)} ==>|"then, after the yes"| ${nodeId('a', t)}`);
  }
  lines.push('```', '', 'A thin arrow is a value the lookup returned: the param must be one of its results on this call. A thick arrow is a follow-on action, run after the caller\'s yes with the values read back.');
  if (hasJourneys(b)) {
    lines.push('', '## Journeys', '', 'Each caller turn, the decision model reads which journey the caller wants; the agent model is offered only that journey\'s actions (or the root\'s).', '', '```mermaid', 'flowchart LR', '  root(["Root"])', '  subgraph journeys["Journeys"]');
    for (const [id, j] of Object.entries(b.journeys ?? {})) lines.push(`    ${nodeId('j', id)}[${mermaidLabel(id, j.when)}]`);
    lines.push('  end');
    const used = new Set<string>([...(b.root?.actions ?? []), ...Object.values(b.journeys ?? {}).flatMap((j) => j.actions)]);
    for (const n of [...used]) for (const t of b.actions[n]?.then ?? []) used.add(t);
    for (const n of names.filter((x) => used.has(x))) lines.push(`  ${nodeId('a', n)}${b.actions[n]!.kind === 'lookup' ? '[' : '[['}${mermaidLabel(n)}${b.actions[n]!.kind === 'lookup' ? ']' : ']]'}`);
    for (const id of Object.keys(b.journeys ?? {})) lines.push(`  root --> ${nodeId('j', id)}`);
    for (const n of b.root?.actions ?? []) lines.push(`  root --> ${nodeId('a', n)}`);
    for (const [id, j] of Object.entries(b.journeys ?? {})) for (const n of j.actions) lines.push(`  ${nodeId('j', id)} --> ${nodeId('a', n)}`);
    for (const n of names.filter((x) => used.has(x))) for (const t of b.actions[n]!.then ?? []) lines.push(`  ${nodeId('a', n)} ==>|"then, after the yes"| ${nodeId('a', t)}`);
    lines.push('```');
  }
  return `${lines.join('\n')}\n`;
}
