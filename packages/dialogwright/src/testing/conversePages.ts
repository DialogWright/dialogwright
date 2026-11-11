import type { ConverseApp } from '../converse/app';
import type { ActionSpec, AgentBusiness } from '../converse/business/schema';
import { END_CALL } from '../converse/business/schema';
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

/** A rule as agent.yaml wrote it, in words. */
function ruleWords(rule: Rule): string {
  switch (rule.rule) {
    case 'oneOf': return `${rule.field} must be one of ${rule.values.join(', ')}${rule.reason === undefined ? '' : ` (refused as ${rule.reason})`}`;
    case 'noneOf': return `${rule.field} must not be ${rule.values.join(', ')}${rule.reason === undefined ? '' : ` (refused as ${rule.reason})`}`;
    case 'fields': return `only ${rule.fields.join(', ')} may be sent`;
    case 'confirmed': return `the caller's yes to a read-back of ${rule.fields.join(', ') || 'no values'}`;
    case 'dateInRange': return `${rule.field} must be a day within the range the rule names`;
    case 'limit': return `${rule.field} must be within the limit the rule names`;
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
    case 'dateInRange': return `dateInRange(${rule.field})`;
    case 'limit': return `limit(${rule.field})`;
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

/** The values a listed param is tried with: the first listed, and another value. */
const OTHER = 'another value';

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
    '#   a param     for a param a oneOf or noneOf rule lists: the first value listed, and another value',
    '# verdicts: ALLOW; BLOCK <reason>; STEP_UP to <level>; NEEDS_HUMAN <reason>',
  ];
  for (const [name, spec] of Object.entries(app.business.actions)) {
    const action: PolicyAction = policy.source.actions[name]!;
    out.push('', `${name} · level ${action.level} · ${action.rules.map(ruleHeader).join(', ') || 'no rules'}`);
    const base = Object.fromEntries(Object.entries(spec.params).map(([p, s]) => [p, sampleValue(s)]));
    // The params a listed rule names: each tried with a listed value and another.
    const listed = new Map<string, string[]>();
    for (const r of action.rules) if (r.rule === 'oneOf' || r.rule === 'noneOf') listed.set(r.field, [...new Set([...(listed.get(r.field) ?? []), r.values[0]!])]);
    let variants: Record<string, string>[] = [{}];
    for (const [field, values] of listed) variants = variants.flatMap((v) => [...values, OTHER].map((value) => ({ ...v, [field]: value })));
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

/** The rules of an action as agent.yaml wrote them (the gate adds `confirmed` for a change, shown apart). */
function writtenRules(spec: ActionSpec): Rule[] {
  return (spec.rules ?? []).map((entry) => readRule(entry as RuleEntryYaml));
}

/** The policy card for a converse app, as Markdown. */
export function conversePolicyCardText(app: ConverseApp): string {
  const b = app.business;
  const followOns = followOnsOf(b);
  const parentsOf = (name: string): string[] => Object.entries(b.actions).filter(([, a]) => a.then?.includes(name)).map(([n]) => n);
  const lines: string[] = [
    `# Policy card: ${b.business.name}`,
    '',
    '*Generated from `agent.yaml`\'s actions by `pnpm policy:card`: do not edit it by hand. Change the file, write the card again, and review the diff. A test fails when this page and the file disagree.*',
    '',
    '## How the gate decides',
    '',
    '- A model leads the conversation, but it acts only through the actions below, and every action goes through the gate. Each decision, allowed or refused, is written to the audit.',
    '- Anything not listed under Actions is refused.',
    '- Every action is open to a caller nobody has proven (level 0): this app has no identity. The number a caller calls from may recognise a dealership account; it is never proof of who is speaking.',
    '- The rules of an action run in the order shown, and the first one that fails decides.',
    '- Every change is read back in the business\'s fixed words with exactly the values it will run with, and runs only once the caller has said yes to that read-back (the gate\'s `confirmed` rule, over all of the change\'s params, runs last). A lookup is never confirmed. The follow-on actions of a change run after that yes with no read-back of their own, each through the gate with the same values.',
    `- ${code(END_CALL)} is the runtime's own action, offered to the model on every call: it says the closing line and ends the call, and changes nothing.`,
    '',
    '## What a model is sent and what is recorded',
    '',
    '- The conversation is sent to the agent model: the caller\'s words, its own replies and the fixed lines said. Identity factors are never sent (this app has none).',
    '- The results of the actions the model calls are sent to it, each held to its action\'s check in a closed form.',
    '- A value an action\'s `audit` hides (`mask`, `length` or `secret`) is masked, once understood, in what the model is sent.',
    '- The caller\'s number is given to the model by its last four digits, so it can say them; the whole number goes only to the actions\' code.',
    '- The audit, the trace and the console record each action\'s params as its `audit` says, by default hidden (`•`): see each action\'s table below.',
    '',
    '## Actions',
    '',
    '| Action | Kind | Offered to the model | Rules | Follow-on actions |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const [name, spec] of Object.entries(b.actions)) {
    const rules = writtenRules(spec).map(ruleHeader);
    const all = spec.kind === 'change' ? [...rules, `confirmed(${confirmedFields(spec).join(', ')})`] : rules;
    lines.push(`| ${code(name)} | ${spec.kind} | ${followOns.has(name) ? `no: follows ${andList(parentsOf(name).map(code))}` : 'yes'} | ${cell(all.map(code).join(', ') || 'none')} | ${spec.then?.map(code).join(', ') ?? 'none'} |`);
  }
  for (const [name, spec] of Object.entries(b.actions)) {
    lines.push('', `### ${code(name)}: ${spec.kind === 'change' ? 'a change' : 'a lookup'}`, '', cell(spec.about.trim().replace(/\s+/g, ' ')), '');
    if (followOns.has(name)) lines.push(`Never offered to the model: it runs after the caller's yes to ${andList(parentsOf(name).map(code))}, with the values read back there.`, '');
    if (spec.kind === 'change') lines.push(`Read back before it runs, in these words: "${spec.readBack?.en ?? ''}"`, '');
    const written = writtenRules(spec);
    lines.push('Rules, in the order they run:', '');
    written.forEach((r) => lines.push(`- ${ruleWords(r)}`));
    if (spec.kind === 'change') lines.push(`- ${ruleWords({ rule: 'confirmed', fields: confirmedFields(spec) })}`);
    if (written.length === 0 && spec.kind === 'lookup') lines.push('- none: a lookup reads and returns a result; it is open to every caller');
    if (spec.then !== undefined && spec.then.length > 0) lines.push('', `After the caller's yes it is followed by ${andList(spec.then.map(code))}, each through the gate.`);
    const params = Object.entries(spec.params);
    if (params.length > 0) {
      lines.push('', '| Param | Type | Recorded |', '| --- | --- | --- |');
      for (const [p, s] of params) lines.push(`| ${code(p)} | ${s.type}${s.type === 'slot' ? ` from ${code(s.from ?? '')}` : s.type === 'choice' ? ` (${(s.options ?? []).join(', ')})` : ''} | ${recordedWords(spec, p)} |`);
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
  return `${lines.join('\n')}\n`;
}
