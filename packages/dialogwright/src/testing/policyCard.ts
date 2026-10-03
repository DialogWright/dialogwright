import { dirname, relative } from 'node:path';
import { gateOf, identityOf, topLevelOf } from '../core/app/lookup';
import type { App, AuditMask, RoleAccess, ToolName } from '../core/app/types';
import { recordingOf } from '../core/recording';
import { refText, todayText, type DateBound, type LookupRef, type NumberBound } from '../gate/bounded';
import { identityToolsOf, type PolicyAction, type PolicySource, type Rule } from '../gate/compiled';
import { isDefinedRule } from '../gate/defineRule';
import { DEFAULT_ROLE_PERSON_REASON } from '../gate/lines';
import type { Level } from '../gate/types';
import {
  andList, capitalize, cell, code, configHashOf, expectGeneratedPage, formWords, humanize, levelName, lowerFirst, mermaidLabel, nodeId, paramNoun, slotNoun, writeGeneratedPage,
} from './generatedPage';

/**
 * Test support: the policy card, a one-page plain-English account of what an app's agent may do,
 * written from the compiled app (the gate's named rules, gateOf; the identity configuration; what
 * the policy withholds from a party acting for subjects, PolicyTables.redact; what is recorded of
 * each value an action is sent, the slots' redact and PolicyTables.audit) and kept as POLICY.md beside policy.yaml, so compliance reads a page and not a file of rules. A page,
 * and two Mermaid diagrams GitHub renders: the identity ladder, and the actions grouped by level
 * with their rules and what each role gets.
 *
 * It says only what the gate does: the card is a golden. `policyCardText(app, dir)` writes it (dir is
 * the app's folder, for the files' config hashes); `expectPolicyCard(app, file)` fails a test on any
 * difference with a line diff and the command that writes it; `dialogwright policy:card [dir...]`
 * (pnpm policy:card) writes it, deliberately, never in CI. A change to a policy, an identity or a
 * custom rule's description is a diff of this page a reviewer reads (and the files' CODEOWNERS own).
 */

/** The file name of the card, beside policy.yaml. */
export const POLICY_CARD_FILE = 'POLICY.md';

const article = (word: string): string => (/^[aeiou]/i.test(word) ? 'an' : 'a');

/** An action in words: its `say`, else its tool id. */
function actionLabel(source: PolicySource, tool: ToolName): string {
  return source.actions[tool]?.say ?? tool;
}

/** A date or number bound in words. */
function boundText(bound: DateBound | NumberBound): string {
  switch (bound.kind) {
    case 'today': return todayText(bound);
    case 'date': return bound.date;
    case 'number': return bound.value;
    case 'lookup': return `what ${code(refText(bound.ref))} gives`;
  }
}

/**
 * A dateInRange bound in words, with what it holds the date to: "on or after 2026-01-31", "on or
 * before today", and for a number of days from today "no later than 30 days from today" (notAfter
 * today+30) or "no earlier than 7 days before today" (notBefore today-7).
 */
function dateBoundWords(which: 'notBefore' | 'notAfter', bound: DateBound): string {
  const days = bound.kind === 'today' ? bound.days ?? 0 : 0;
  if (days === 0) return `${which === 'notBefore' ? 'on or after' : 'on or before'} ${boundText(bound)}`;
  const n = Math.abs(days);
  return `${which === 'notBefore' ? 'no earlier than' : 'no later than'} ${n} day${n === 1 ? '' : 's'} ${days > 0 ? 'from' : 'before'} today`;
}

const refWords = (ref: LookupRef): string => code(refText(ref));

/** The verdict a failed range rule gives, in words. */
function failure(verdict: 'BLOCK' | 'NEEDS_HUMAN' | undefined): string {
  return verdict === 'NEEDS_HUMAN' ? 'goes to a person' : 'is refused';
}

/** What a role rule gives each role, in words, ending with the role it leaves out. */
function roleLine(rule: Extract<Rule, { rule: 'role' }>, subjectKind: string): string {
  const parts = Object.entries(rule.access).map(([role, access]) => {
    const who = `${article(humanize(role))} ${humanize(role)}'s request`;
    if (access === 'allow') return `${who} goes ahead`;
    if (access === 'refuse') return `${who} is refused`;
    return `${who} goes to a person (${rule.reason ?? DEFAULT_ROLE_PERSON_REASON})`;
  });
  const rest = 'any other role, or none, is refused';
  const own = subjectKind === '' ? '' : `; ${article(subjectKind)} ${subjectKind} acting for themselves is not held to this rule`;
  return `by role: ${parts.join('; ')}; ${rest}${own}`;
}

/** One rule of an action in plain English, with its parameters. */
function ruleText(app: App, source: PolicySource, action: PolicyAction, rule: Rule): string {
  const subjectKind = identityOf(app).subjectKind;
  switch (rule.rule) {
    case 'identity':
      return action.level === 0 ? 'any caller may ask, verified or not' : `the caller must be at '${levelName(app, action.level)}' or above`;
    case 'attempts':
      return `the identity check has not already failed ${source.maxAttempts} times (after that a person takes the call)`;
    case 'scope': {
      if (rule.subject === null) return 'the action names no subject to check, so it is refused';
      const noun = paramNoun(app, rule.subject.param);
      const same = subjectKind === '' ? 'one the caller may see' : "the caller's own, or one they act for";
      return rule.subject.via === 'record'
        ? `the ${noun} must belong to ${subjectKind === '' ? 'someone the caller may see' : 'the caller, or to someone they act for'}`
        : `the ${noun} must be ${same}`;
    }
    case 'role': return roleLine(rule, subjectKind);
    case 'confirmed': return `the caller must confirm exactly these values at the read-back, and nothing else is sent: ${andList(rule.fields.map((f) => paramNoun(app, f)))}`;
    case 'fields': return `only these fields are sent: ${rule.fields.length === 0 ? 'none' : rule.fields.map(code).join(', ')}`;
    case 'dateInRange': {
      const bounds = [
        ...(rule.notBefore ? [dateBoundWords('notBefore', rule.notBefore)] : []),
        ...(rule.notAfter ? [dateBoundWords('notAfter', rule.notAfter)] : []),
        ...(rule.within ? [`inside the window ${refWords(rule.within)} gives`] : []),
      ];
      const outcomes = [
        ...(rule.notBefore || rule.notAfter ? [`a date out of bounds ${failure(rule.verdicts?.outOfRange)}`] : []),
        ...(rule.within ? [`one outside the window ${failure(rule.verdicts?.outsideWindow)}`] : []),
      ];
      return `the ${paramNoun(app, rule.field)} must be ${andList(bounds)} (${outcomes.join('; ')}; anything that is not a date is refused)`;
    }
    case 'limit': {
      const bounds = [...(rule.min ? [`at least ${boundText(rule.min)}`] : []), ...(rule.max ? [`at most ${boundText(rule.max)}`] : [])];
      return `the ${paramNoun(app, rule.field)} must be ${andList(bounds)} (a number outside it ${failure(rule.verdicts?.outOfRange)}; anything that is not a number is refused)`;
    }
    case 'custom': {
      const defined = source.customRules?.[rule.id];
      const what = isDefinedRule(defined) ? lowerFirst(defined.description) : `the app's own rule (no description given)`;
      return `${what} (custom rule ${code(rule.id)})`;
    }
  }
}

/** A rule by its name, as a diagram says it: `scope`, `custom R8`, `limit amount`. */
export function ruleName(rule: Rule): string {
  return rule.rule === 'custom' ? `custom ${rule.id}` : rule.rule === 'dateInRange' || rule.rule === 'limit' ? `${rule.rule} ${rule.field}` : rule.rule;
}

/** The levels the ladder has, from 0 to its top. */
function ladderLevels(app: App): Level[] {
  return app.identity === undefined ? [0] : ([0, 1, ...(topLevelOf(identityOf(app)) === 2 ? [2] : [])] as Level[]);
}

/** What a role gets in each action that has a role rule, by role. */
function roleOutcomes(source: PolicySource): { roles: string[]; byRole: Map<string, Record<RoleAccess, ToolName[]>> } {
  const byRole = new Map<string, Record<RoleAccess, ToolName[]>>();
  const roles: string[] = [];
  const entry = (role: string): Record<RoleAccess, ToolName[]> => {
    let e = byRole.get(role);
    if (!e) {
      byRole.set(role, (e = { allow: [], person: [], refuse: [] }));
      roles.push(role);
    }
    return e;
  };
  for (const [tool, action] of Object.entries(source.actions)) {
    for (const rule of action.rules) {
      if (rule.rule !== 'role') continue;
      for (const [role, access] of Object.entries(rule.access)) entry(role)[access].push(tool);
    }
  }
  return { roles, byRole };
}

/** The roles a party who acts for subjects may have: the identity file's, then any a role rule names that it does not. */
function rolesOf(app: App, source: PolicySource): string[] {
  const declared = [...(identityOf(app).delegateRoles ?? [])];
  const named = roleOutcomes(source).roles.filter((r) => !declared.includes(r));
  return [...declared, ...named];
}

function roleLabel(role: string): string {
  return humanize(role) === role ? role : `${humanize(role)} (${code(role)})`;
}

// ---------------------------------------------------------------------------------------------
// The sections
// ---------------------------------------------------------------------------------------------

function header(app: App, dir: string): string[] {
  const out = [
    `# Policy card: ${app.brand?.name ?? app.id}`,
    '',
    '*Generated from `policy.yaml` and `identity.yaml` by `pnpm policy:card`: do not edit it by hand. Change the files, write the card again, and review the diff. A test fails when this page and the files disagree.*',
    '',
    '| File | Config hash |',
    '| --- | --- |',
  ];
  const policy = configHashOf(app, dir, 'policy.yaml');
  const identity = configHashOf(app, dir, 'identity.yaml');
  out.push(`| \`policy.yaml\` | ${policy === null ? 'none' : code(policy)} |`);
  out.push(`| \`identity.yaml\` | ${identity === null ? 'none: this app verifies no one' : code(identity)} |`);
  out.push('', 'The hash is a SHA-256 of the file\'s content (comments and layout do not change it); every call\'s audit record carries the hashes it ran under.');
  return out;
}

function defaults(app: App, source: PolicySource): string[] {
  const identity = identityOf(app);
  const out = ['## Defaults', '', '- Anything not listed under Actions is refused.', '- The rules of an action run in the order shown, and the first one that fails decides.'];
  out.push('- Identifiers in decision lines appear by their last four characters (`...1234`), never in full.');
  if (app.identity) {
    const checks = `the ${slotsInWords(app, identity.factorSlots)}${identity.codeTool ? ', and the one-time code' : ''}`;
    out.push(`- A caller has ${source.maxAttempts} tries at each identity check (${checks}). After that a person takes the call.`);
  }
  const recorded = Object.entries(app.slots).flatMap(([id, spec]) => (spec.redact ? [{ id, how: spec.redact }] : []));
  if (recorded.length > 0) {
    const how = { last4: 'by its last four', mask: 'hidden (a year is kept)', length: 'by its length' } as const;
    const parts = recorded.map(({ id, how: h }) => `${slotNoun(app, id)} ${how[h]}`);
    out.push(`- In traces and the audit a caller's values are recorded as they are said, except: ${parts.join('; ')}.`);
  }
  return out;
}

function slotsInWords(app: App, slots: readonly string[]): string {
  return andList(slots.map((s) => slotNoun(app, s)));
}

function identitySection(app: App, source: PolicySource): string[] {
  const out = ['## Identity', ''];
  const identity = identityOf(app);
  if (!app.identity) {
    out.push('This app verifies no one. Every caller stays anonymous (level 0), so every action is at level 0.', '', '```mermaid', 'flowchart LR', `  L0(${mermaidLabel('Level 0', 'anonymous', 'no one is verified')})`, '```');
    return out;
  }
  const top = topLevelOf(identity);
  const factors = slotsInWords(app, identity.factorSlots);
  const verify = `${actionLabel(source, identity.verifyTool)} (${code(identity.verifyTool)})`;
  out.push('| Level | Name | What the caller gives | Checked by |', '| --- | --- | --- | --- |');
  out.push(`| 0 | ${levelName(app, 0)} | nothing | |`);
  out.push(`| 1 | ${cell(levelName(app, 1))} | their ${factors} | ${cell(verify)} |`);
  if (top === 2) {
    const send = `${actionLabel(source, identity.sendCodeTool!)} (${code(identity.sendCodeTool!)})`;
    const check = `${actionLabel(source, identity.codeTool!)} (${code(identity.codeTool!)})`;
    out.push(`| 2 | ${cell(levelName(app, 2))} | level 1, and a ${identity.codeLength ?? 6}-digit one-time code sent to the contact on file | ${cell(send)}; ${cell(check)} |`);
  }
  out.push('');
  out.push(`- Each level includes the one below it. A ${identity.subjectKind} below an action's level is asked for what the next level needs; any other caller is refused.`);
  out.push(`- The identity checks (${identityToolsOf(identity).map((t) => `${actionLabel(source, t)}, ${code(t)}`).join('; ')}) are for ${identity.subjectKind}s only: a caller not yet verified may use them, and any other party (one who acts for ${identity.subjectKind}s, or anyone else) is refused them before their rules run.`);
  if (top === 2) out.push('- The one-time code is keyed on the keypad: it is masked, never traced and never held as a slot.');
  out.push(identity.signInLevel === undefined
    ? '- The app takes no portal sign-in: every caller proves who they are on the call, and a caller on a channel that signs callers in (a web chat) whose request needs identity goes to a person.'
    : `- A sign-in through a portal proves level ${identity.signInLevel} ('${levelName(app, identity.signInLevel)}'), so a signed-in caller starts there.`);
  const purposes = Object.entries(source.purposes).filter(([, level]) => level > 0);
  if (purposes.length > 0) {
    out.push('', 'Some tasks need a higher level before any action is called, even where the action itself needs less:', '');
    for (const [purpose, level] of purposes) out.push(`- ${formWords(app, purpose)} (${code(purpose)}) needs '${levelName(app, level)}'.`);
  }
  out.push('', '```mermaid', ...ladderDiagram(app, source), '```');
  return out;
}

/** The identity ladder as a Mermaid flowchart: levels, what steps a caller up, and the sign-in. */
function ladderDiagram(app: App, source: PolicySource): string[] {
  const identity = identityOf(app);
  const top = topLevelOf(identity);
  const out = ['flowchart LR'];
  for (const level of ladderLevels(app)) out.push(`  L${level}(${mermaidLabel(`Level ${level}`, levelName(app, level))})`);
  out.push(`  L0 -->|${mermaidLabel(`gives ${slotsInWords(app, identity.factorSlots)}`, `checked by: ${actionLabel(source, identity.verifyTool)}`)}| L1`);
  if (top === 2) {
    out.push(`  L1 -->|${mermaidLabel(`gives a ${identity.codeLength ?? 6}-digit one-time code`, `sent by: ${actionLabel(source, identity.sendCodeTool!)}`, `checked by: ${actionLabel(source, identity.codeTool!)}`)}| L2`);
  }
  if (identity.signInLevel !== undefined) {
    out.push(`  SI([${mermaidLabel('Portal sign-in')}]) -.->|${mermaidLabel(`proves level ${identity.signInLevel}`)}| L${identity.signInLevel}`);
  }
  return out;
}

function principalsSection(app: App, source: PolicySource): string[] {
  const out = ['## Who is served and who acts for them', ''];
  if (!app.identity) {
    out.push('No one is verified, so the app has no subjects and no one acts for them.');
    return out;
  }
  const identity = identityOf(app);
  out.push(`- **${identity.subjectKind}**: the people the app serves. They are verified up the ladder above and may see only their own records.`);
  if (identity.delegateKind === undefined) {
    out.push('- No party acts for them on this app.');
    return out;
  }
  const roles = rolesOf(app, source);
  out.push(`- **${identity.delegateKind}**: acts for ${identity.subjectKind}s, signed in through a portal. They may see the records of the ${identity.subjectKind}s they act for${roles.length > 0 ? `, with a role: ${roles.map(roleLabel).join(', ')}` : ''}.`);
  const { byRole } = roleOutcomes(source);
  if (byRole.size === 0) {
    out.push('', 'No action is governed by role: the role rule is not used.');
    return out;
  }
  const list = (tools: readonly ToolName[]): string => (tools.length === 0 ? 'none' : tools.map((t) => cell(actionLabel(source, t))).join('<br/>'));
  out.push('', 'What each role may do, in the actions that have a role rule (a role a rule does not list is refused, and so is a party with no role):', '');
  out.push('| Role | Goes ahead | Goes to a person | Refused |', '| --- | --- | --- | --- |');
  for (const role of roles) {
    const e = byRole.get(role) ?? { allow: [], person: [], refuse: [] };
    const named = new Set([...e.allow, ...e.person, ...e.refuse]);
    const unlisted = [...byRole.values()].flatMap((r) => [...r.allow, ...r.person, ...r.refuse]).filter((t, i, all) => all.indexOf(t) === i && !named.has(t));
    out.push(`| ${roleLabel(role)} | ${list(e.allow)} | ${list(e.person)} | ${list([...e.refuse, ...unlisted])} |`);
  }
  return out;
}

/**
 * What a party who acts for subjects does not see of what an action returns (policy.yaml `redact:`),
 * by kind and by role; none for an app that withholds nothing, so its card has no such section.
 */
function redactionSection(app: App, source: PolicySource): string[] {
  const rows = Object.entries(app.policy.redact ?? {});
  if (rows.length === 0) return [];
  const subjectKind = identityOf(app).subjectKind;
  const out = ['## What is withheld', ''];
  out.push(`A party who acts for ${subjectKind}s does not see every field of what some actions return: right after the action runs, the engine sets these fields to nothing wherever the result holds them, at any depth, before a line, the session, the trace, the console or the audit reads it. The record of the call says which fields were withheld, and where the action's summary repeats what one held, that is masked. What the action itself does with the whole record as it runs (a side effect it queues, what it writes to the session) and an error it raises are not covered: the action's code keeps those to what the caller may see. A row for a role replaces its kind's for that action. ${capitalize(article(subjectKind))} ${subjectKind} acting for themselves sees the whole of their own record.`);
  out.push('', '| Who | Action | Fields withheld |', '| --- | --- | --- |');
  for (const [who, byTool] of rows) {
    const dot = who.indexOf('.');
    const label = dot < 0 ? `${who}, any role` : `${who.slice(0, dot)}, as ${roleLabel(who.slice(dot + 1))}`;
    for (const [tool, fields] of Object.entries(byTool)) {
      const action = source.actions[tool]?.say;
      const named = action === undefined ? code(tool) : `${cell(capitalize(action))} (${code(tool)})`;
      out.push(`| ${cell(label)} | ${named} | ${fields.length === 0 ? 'none' : fields.map(code).join(', ')} |`);
    }
  }
  return out;
}

/** How a value is recorded, in words (core/recording.ts). */
const RECORDED: Readonly<Record<AuditMask, string>> = {
  last4: 'by its last four characters',
  mask: 'hidden',
  length: 'by its length only',
  secret: 'never',
  keep: 'as it is',
};

/**
 * What is recorded of each value an action is sent (the tools' params, ToolDef.params): as its slot's
 * redact setting or policy.yaml's `audit:` says. None for an app whose tools list no params and whose
 * policy declares nothing, so its card has no such section.
 */
function recordingSection(app: App, source: PolicySource): string[] {
  const tools = Object.keys(source.actions);
  const listed = (tool: string): readonly string[] | undefined => (Object.hasOwn(app.tools, tool) ? app.tools[tool]!.params : undefined);
  if (app.policy.audit === undefined && !tools.some((tool) => listed(tool) !== undefined)) return [];
  const out = ['## What is recorded', ''];
  out.push('What the record of a call keeps of each value the action is sent: the gate\'s decision, the trace, the console and the audit. A value is recorded as its slot says or as policy.yaml\'s `audit` declares, and `check` refuses one that neither covers. Where a rule\'s line, the action\'s summary or its own audit rows repeat a value that is hidden, shortened or never recorded, it is masked there too.');
  out.push('', '| Action | Value | Recorded |', '| --- | --- | --- |');
  for (const tool of tools) {
    const action = source.actions[tool]?.say;
    const named = action === undefined ? code(tool) : `${cell(capitalize(action))} (${code(tool)})`;
    const params = listed(tool);
    if (params === undefined) out.push(`| ${named} | not listed (the tool lists no params) | |`);
    else if (params.length === 0) out.push(`| ${named} | nothing | |`);
    else for (const param of params) out.push(`| ${named} | ${cell(paramNoun(app, param))} (${code(param)}) | ${RECORDED[recordingOf(app, param)]} |`);
  }
  return out;
}

function actionsSection(app: App, source: PolicySource): string[] {
  const identityTools = identityToolsOf(identityOf(app));
  const subjectKind = identityOf(app).subjectKind;
  const out = ['## Actions', '', 'One row per action the agent may take. Anything else is refused.', ''];
  out.push('| Action | Level | The gate checks, in order |', '| --- | --- | --- |');
  for (const [tool, action] of Object.entries(source.actions)) {
    const label = action.say === undefined ? code(tool) : `**${cell(capitalize(action.say))}**<br/>${code(tool)}`;
    // The identity tools' own check runs first (gate/compiled.ts subjectOnlyDecision), written in no file.
    const subjectOnly = app.identity !== undefined && identityTools.includes(tool) ? [`only ${article(subjectKind)} ${subjectKind}, or a caller not yet verified, may use it (any other party is refused)`] : [];
    const said = [...subjectOnly, ...action.rules.map((r) => ruleText(app, source, action, r))];
    const rules = said.length === 0 ? 'nothing: no rule runs' : said.map((r, i) => `${i + 1}. ${cell(r)}`).join('<br/>');
    out.push(`| ${label} | ${action.level} ${cell(levelName(app, action.level))} | ${rules} |`);
  }
  return out;
}

/** The actions grouped by level, each with the rules it runs and the roles' outcomes, as a Mermaid flowchart. */
function policyDiagram(app: App, source: PolicySource): string[] {
  const out = ['flowchart LR'];
  const levels = [...new Set([...ladderLevels(app), ...Object.values(source.actions).map((a) => a.level)])].sort((a, b) => a - b);
  const edges: string[] = [];
  let person = false;
  let refused = false;
  for (const level of levels) {
    const here = Object.entries(source.actions).filter(([, a]) => a.level === level);
    if (here.length === 0) continue;
    out.push(`  subgraph lv${level}[${mermaidLabel(`Level ${level}: ${levelName(app, level)}`)}]`);
    for (const [tool, action] of here) {
      const rules = action.rules.map(ruleName);
      out.push(`    ${nodeId('a', tool)}[${mermaidLabel(action.say === undefined ? tool : capitalize(action.say), rules.join(' · ') || 'no rules')}]`);
      for (const rule of action.rules) {
        if (rule.rule !== 'role') continue;
        for (const [role, access] of Object.entries(rule.access)) {
          if (access === 'allow') continue;
          edges.push(`  ${nodeId('a', tool)} -.->|${mermaidLabel(humanize(role))}| ${access === 'person' ? 'person' : 'refused'}`);
          if (access === 'person') person = true;
          else refused = true;
        }
      }
    }
    out.push('  end');
  }
  const placed = levels.filter((l) => Object.values(source.actions).some((a) => a.level === l));
  for (let i = 1; i < placed.length; i += 1) out.push(`  lv${placed[i - 1]} -->|${mermaidLabel('step up')}| lv${placed[i]}`);
  if (person) out.push(`  person([${mermaidLabel('goes to a person')}])`);
  if (refused) out.push(`  refused([${mermaidLabel('refused')}])`);
  out.push(...edges);
  return out;
}

/** A section and the blank line after it; nothing for a section that is not there. */
const withGap = (lines: string[]): string[] => (lines.length === 0 ? [] : [...lines, '']);

/** The policy card for `app`, as Markdown. `dir` is the app's folder: the config hashes of policy.yaml and identity.yaml are read from it when the app carries none. */
export function policyCardText(app: App, dir: string): string {
  const source = gateOf(app).source;
  const lines = [
    ...header(app, dir),
    '',
    ...defaults(app, source),
    '',
    ...identitySection(app, source),
    '',
    ...principalsSection(app, source),
    '',
    ...withGap(redactionSection(app, source)),
    ...withGap(recordingSection(app, source)),
    ...actionsSection(app, source),
    '',
    '### Actions by level, with their rules and what each role gets',
    '',
    '```mermaid',
    ...policyDiagram(app, source),
    '```',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Fails, with a readable diff, when `file` (an app's POLICY.md) is not the card the app generates
 * today. `regenerate` is the command to tell the reader to run (default: `pnpm policy:card <the
 * file's folder, from the working directory>`). Never writes the file.
 */
export function expectPolicyCard(app: App, file: string, regenerate = `pnpm policy:card ${relativeFolder(file)}`): void {
  expectGeneratedPage(app, file, policyCardText(app, dirname(file)), regenerate, 'policy card');
}

/** Writes `app`'s policy card to `file`; whether it changed. For the policy:card command, never a test. */
export function writePolicyCard(app: App, file: string): { changed: boolean; lines: number } {
  return writeGeneratedPage(file, policyCardText(app, dirname(file)));
}

function relativeFolder(file: string): string {
  const rel = relative(process.cwd(), dirname(file));
  return rel === '' ? '.' : rel;
}
