import { dirname, relative } from 'node:path';
import { gateOf } from '../core/app/lookup';
import { reachOf, unreachedActions } from '../core/app/reach';
import { formsLeadingTo } from '../core/app/next';
import type { App, FormId, IntentDef } from '../core/app/types';
import { capitalize, cell, code, expectGeneratedPage, formWords, levelName, mermaidLabel, nodeId, slotNoun, writeGeneratedPage } from './generatedPage';
import { ruleName } from './policyCard';

/**
 * Test support: the app map, a page of Mermaid diagrams written from the compiled app, kept as
 * APP-MAP.md beside the app's policy.yaml. It draws what the configuration says: each intent to its
 * form, the form's slots (with their types), the summary the form reads back, the action it calls and
 * that action's rules; the keypad menu as a tree; the intents that only say a line, to their prompt.
 * It is structure, not a call script: the dialog is mixed-initiative (a caller may give details in any
 * order, change their mind or ask for two things at once), so the map shows what is connected to
 * what and not the order a call goes in.
 *
 * What it cannot reach is drawn and listed: an intent with no form, a form no intent starts, a line
 * that is not there, a call to an action the policy does not list, an action no form reaches
 * (core/app/reach.ts, which `check` reports too). Which actions a form calls is what the form says
 * (FormDef.calls, forms.yaml's `calls`); an app that does not say gets a map that ends at the form.
 *
 * `appMapText(app)` writes it; `expectAppMap(app, file)` fails a test on any difference with a
 * line diff and the command that writes it; `dialogwright app:diagram [dir...]` (pnpm app:diagram)
 * writes it, deliberately, never in CI.
 */

/** The file name of the app map, beside policy.yaml. */
export const APP_MAP_FILE = 'APP-MAP.md';

/** A thing the map cannot connect: what it is and where it is drawn. */
export interface DanglingReference {
  readonly kind: 'intent-without-form' | 'form-without-intent' | 'informational-without-line' | 'menu-without-intent' | 'form-slot-missing' | 'form-calls-unlisted' | 'action-unreached';
  readonly id: string;
  readonly message: string;
}

/** Every reference of the app's dialog that goes nowhere, in the order the app lists them. */
export function danglingReferences(app: App): DanglingReference[] {
  const out: DanglingReference[] = [];
  const add = (kind: DanglingReference['kind'], id: string, message: string): void => void out.push({ kind, id, message });
  const actions = gateOf(app).source.actions;
  for (const [id, intent] of Object.entries(app.intents)) {
    if (intent.kind === 'form' && !Object.hasOwn(app.forms, id)) add('intent-without-form', id, `the intent ${code(id)} starts a form, and there is no form ${code(id)}`);
    if (intent.kind === 'informational' && intent.passage !== undefined) {
      if (!app.knowledge?.kb || !Object.hasOwn(app.knowledge.kb.passages, intent.passage)) add('informational-without-line', id, `the intent ${code(id)} says the passage ${code(intent.passage)}, which the knowledge base does not have`);
    } else if (intent.kind === 'informational' && (intent.promptId === undefined ? intent.locale === undefined : !Object.hasOwn(app.prompts.manifest, intent.promptId))) {
      // An intent that switches the language (locale:) may say no line of its own.
      add('informational-without-line', id, `the intent ${code(id)} says ${intent.promptId === undefined ? 'no line' : `the line ${code(intent.promptId)}, which does not exist`}`);
    }
  }
  for (const { digit, intent } of app.menu) if (!Object.hasOwn(app.intents, intent)) add('menu-without-intent', intent, `the keypad digit ${digit} names the intent ${code(intent)}, which does not exist`);
  for (const [id, form] of Object.entries(app.forms)) {
    // An internal form (FormDef.internal) is no intent: another form's next leads to it.
    if (form.internal !== true && app.intents[id]?.kind !== 'form') add('form-without-intent', id, `the form ${code(id)} has no intent that starts it`);
    for (const slot of form.slots) if (!Object.hasOwn(app.slots, slot)) add('form-slot-missing', id, `the form ${code(id)} asks for the slot ${code(slot)}, which does not exist`);
    for (const tool of form.calls ?? []) if (!Object.hasOwn(actions, tool)) add('form-calls-unlisted', id, `the form ${code(id)} calls ${code(tool)}, which the policy does not list`);
    for (const check of form.checks ?? []) if (!Object.hasOwn(actions, check.action)) add('form-calls-unlisted', id, `the form ${code(id)} checks ${code(check.action)}, which the policy does not list`);
  }
  for (const tool of unreachedActions(Object.keys(actions), app.forms, app.identity)) add('action-unreached', tool, `no form reaches the action ${code(tool)}, and the identity flow does not call it`);
  return out;
}

const DANGLING = 'classDef dangling stroke:#d00,stroke-width:2px,stroke-dasharray:4';

/** A slot as a node says it: its id and its type (a library type's name, or "code" for a slot the app writes). */
function slotLines(app: App, slot: string): string[] {
  const spec = Object.hasOwn(app.slots, slot) ? (app.slots[slot] as { type?: unknown }) : undefined;
  const type = spec === undefined ? 'missing' : typeof spec.type === 'string' ? spec.type : 'code';
  return [slot, `type: ${type}`];
}

/**
 * One form's diagram: the intent, its slots, the checks on them, the summary, the actions it calls and
 * their rules, and the form it goes on to (`next`). An internal form (FormDef.internal) starts from
 * the forms that lead to it instead of an intent.
 */
function formDiagram(app: App, id: FormId): string[] {
  const form = app.forms[id]!;
  const intent = app.intents[id];
  const actions = gateOf(app).source.actions;
  const out = ['flowchart LR'];
  if (form.internal === true) {
    out.push(`  after(${mermaidLabel('After', ...formsLeadingTo(app.forms, id).map((from) => `${from}: ${formWords(app, from)}`))})`, '  after --> slots');
  } else {
    out.push(`  intent(${mermaidLabel('Intent', id, ...(intent ? [intent.label] : []))})`);
  }
  out.push(`  subgraph slots[${mermaidLabel('Slots, in the order they are asked (a caller may give them in any order)')}]`);
  form.slots.forEach((slot) => out.push(`    ${nodeId('s', slot)}[${mermaidLabel(...slotLines(app, slot))}]`));
  if (form.slots.length === 0) out.push(`    none[${mermaidLabel('no slots')}]`);
  out.push('  end');
  if (form.internal !== true) out.push('  intent --> slots');
  let last = 'slots';
  if (form.summaryPromptId !== null) {
    out.push(`  summary[/${mermaidLabel('Summary read back for a yes', form.summaryPromptId)}/]`, '  slots --> summary');
    last = 'summary';
  }
  // The form's checks (forms.yaml `checks`): each runs as soon as the slots it reads are filled, and
  // ends the form on a refusal as its outcomes say.
  const classes: string[] = [];
  for (const check of form.checks ?? []) {
    const action = actions[check.action];
    const node = nodeId('c', check.action);
    const outcomes = Object.entries(check.on ?? {}).map(([reason, o]) => `${reason}: ${o.say !== undefined ? `say ${o.say}, ` : ''}${o.then === 'handoff' ? `handoff ${o.reason ?? reason}` : o.then}`);
    out.push(`  ${node}{{${mermaidLabel('Check', action?.say === undefined ? check.action : action.say, action === undefined ? 'not in the policy' : `level ${action.level}: ${levelName(app, action.level)}`, ...outcomes)}}}`);
    for (const slot of check.with) out.push(`  ${nodeId('s', slot)} -.->|${mermaidLabel('checked')}| ${node}`);
    if (action === undefined) classes.push(node);
    else out.push(`  ${nodeId('r', check.action)}([${mermaidLabel('Rules, in order', ...action.rules.map((r, i) => `${i + 1}. ${ruleName(r)}`))}])`, `  ${node} --> ${nodeId('r', check.action)}`);
  }
  if (form.checksPassed !== undefined && (form.checks ?? []).length > 0) {
    out.push(`  passed[/${mermaidLabel('Said once every check has passed', form.checksPassed)}/]`);
    for (const check of form.checks!) out.push(`  ${nodeId('c', check.action)} -.->|${mermaidLabel('passes')}| passed`);
  }
  const calls = form.calls;
  if (calls === undefined) {
    out.push(`  note[${mermaidLabel('The form does not say which actions it calls')}]`, `  ${last} -.-> note`);
  } else if (calls.length === 0) {
    out.push(`  done[${mermaidLabel('Completes without calling an action')}]`, `  ${last} --> done`);
  }
  for (const tool of calls ?? []) {
    const action = actions[tool];
    const node = nodeId('a', tool);
    if (!action) {
      out.push(`  ${node}[${mermaidLabel(tool, 'not in the policy')}]`, `  ${last} -->|${mermaidLabel('calls')}| ${node}`);
      classes.push(node);
      continue;
    }
    out.push(`  ${node}[${mermaidLabel(action.say === undefined ? tool : capitalize(action.say), `level ${action.level}: ${levelName(app, action.level)}`)}]`);
    out.push(`  ${last} -->|${mermaidLabel('calls')}| ${node}`);
    out.push(`  ${nodeId('r', tool)}([${mermaidLabel('Rules, in order', ...action.rules.map((r, i) => `${i + 1}. ${ruleName(r)}`))}])`, `  ${node} --> ${nodeId('r', tool)}`);
  }
  // The form it goes on to as it completes (`next`), drawn under it on this page.
  if (form.next !== undefined) out.push(`  next[[${mermaidLabel('Then, at once', `${form.next}: ${formWords(app, form.next)}`)}]]`, `  ${calls?.length === 0 ? 'done' : last} -->|${mermaidLabel('completes')}| next`);
  // A form no intent starts is drawn as it is, with its intent marked.
  if (form.internal !== true && intent?.kind !== 'form') classes.push('intent');
  if (classes.length > 0) out.push(`  ${DANGLING}`, `  class ${[...new Set(classes)].join(',')} dangling`);
  return out;
}

/** The keypad menu as a tree, and the intents that only say a line, each to its prompt. */
function menuDiagram(app: App): string[] {
  const out = ['flowchart LR'];
  const intentNode = (id: string): string => nodeId('i', id);
  const label = (id: string): string => app.intents[id]?.label ?? id;
  const shown = new Set<string>();
  const bad: string[] = [];
  const leaf = (id: string): void => {
    if (shown.has(id)) return;
    shown.add(id);
    const intent: IntentDef | undefined = app.intents[id];
    if (!intent) {
      out.push(`  ${intentNode(id)}[${mermaidLabel(id, 'not an intent')}]`);
      bad.push(intentNode(id));
      return;
    }
    out.push(`  ${intentNode(id)}[${mermaidLabel(label(id), intent.kind === 'form' ? `form ${id}` : intent.kind)}]`);
    if (intent.kind === 'form' && !Object.hasOwn(app.forms, id)) {
      out.push(`  ${nodeId('nf', id)}[${mermaidLabel('no form')}]`, `  ${intentNode(id)} --> ${nodeId('nf', id)}`);
      bad.push(nodeId('nf', id));
    }
    if (intent.kind === 'informational' && intent.passage !== undefined) {
      const known = app.knowledge?.kb !== undefined && Object.hasOwn(app.knowledge.kb.passages, intent.passage);
      const p = nodeId('p', id);
      out.push(`  ${p}[/${mermaidLabel(`passage ${intent.passage}`, ...(known ? [] : ['not in the knowledge base']))}/]`, `  ${intentNode(id)} --> ${p}`);
      if (!known) bad.push(p);
    } else if (intent.kind === 'informational') {
      const switches = intent.locale !== undefined ? [`switches to ${intent.locale}`] : [];
      const known = intent.promptId !== undefined ? Object.hasOwn(app.prompts.manifest, intent.promptId) : switches.length > 0;
      const p = nodeId('p', id);
      const lines = intent.promptId === undefined ? (switches.length > 0 ? switches : ['no line']) : [`line ${intent.promptId}`, ...switches];
      out.push(`  ${p}[/${mermaidLabel(lines[0]!, ...lines.slice(1), ...(known ? [] : ['not in the prompts']))}/]`, `  ${intentNode(id)} --> ${p}`);
      if (!known) bad.push(p);
    }
  };
  if (app.menu.length > 0) {
    out.push(`  menu(${mermaidLabel('Keypad menu')})`);
    for (const { digit, intent } of app.menu) {
      leaf(intent);
      out.push(`  menu -->|${mermaidLabel(`press ${digit}`)}| ${intentNode(intent)}`);
    }
  }
  const informational = Object.entries(app.intents).filter(([id, i]) => i.kind === 'informational' && !shown.has(id));
  if (informational.length > 0) {
    out.push(`  ask(${mermaidLabel('Asked in words, outside the menu')})`);
    for (const [id] of informational) {
      leaf(id);
      out.push(`  ask --> ${intentNode(id)}`);
    }
  }
  if (bad.length > 0) out.push(`  ${DANGLING}`, `  class ${bad.join(',')} dangling`);
  return out;
}

function intentsTable(app: App): string[] {
  const out = ['| Intent | Kind | Said as | What happens |', '| --- | --- | --- | --- |'];
  for (const [id, intent] of Object.entries(app.intents)) {
    let then: string;
    if (intent.kind === 'form') {
      const form = app.forms[id];
      then = form ? `opens the form, which asks for ${form.slots.map((s) => slotNoun(app, s)).join(', ') || 'nothing'}${form.next !== undefined ? `, then goes on to ${formWords(app, form.next)} (${form.next})` : ''}` : 'no form: dangling';
    } else if (intent.kind === 'informational' && intent.passage !== undefined) {
      // The passage's words change through review (kb/passages), not here: the map names it.
      const known = app.knowledge?.kb !== undefined && Object.hasOwn(app.knowledge.kb.passages, intent.passage);
      then = known ? `says the passage ${intent.passage} from the knowledge base and goes back to the question` : `says the passage ${intent.passage}, which the knowledge base does not have: dangling`;
    } else if (intent.kind === 'informational' && intent.locale !== undefined && intent.promptId === undefined) {
      then = `switches the call to ${intent.locale} and goes back to the question`;
    } else if (intent.kind === 'informational') {
      const text = intent.promptId === undefined ? undefined : app.prompts.manifest[intent.promptId]?.text;
      const switches = intent.locale !== undefined ? `switches the call to ${intent.locale}, ` : '';
      then = text === undefined ? 'says a line that does not exist: dangling' : `${switches}says "${text.length > 90 ? `${text.slice(0, 87)}...` : text}" and goes back to the question`;
    } else {
      then = 'handled by the engine';
    }
    out.push(`| ${code(id)} | ${intent.kind} | ${cell(intent.label)} | ${cell(then)} |`);
  }
  return out;
}

/**
 * The forms in the order the map draws them: each form an intent starts, in definition order, with
 * the internal forms it goes on to (`next`) right after it; then any internal form no form leads to.
 * For an app without internal forms, the definition order.
 */
function formOrder(app: App): FormId[] {
  const order: FormId[] = [];
  const under = (id: FormId): void => {
    if (order.includes(id)) return;
    order.push(id);
    const next = app.forms[id]!.next;
    if (next !== undefined && Object.hasOwn(app.forms, next) && app.forms[next]!.internal === true) under(next);
  };
  for (const id of Object.keys(app.forms)) if (app.forms[id]!.internal !== true) under(id);
  for (const id of Object.keys(app.forms)) under(id);
  return order;
}

/** The app map for `app`, as Markdown. */
export function appMapText(app: App): string {
  const forms = Object.keys(app.forms);
  const reach = reachOf(app.forms);
  const found = danglingReferences(app);
  const lines: string[] = [
    `# App map: ${app.brand?.name ?? app.id}`,
    '',
    '*Generated from the app\'s configuration by `pnpm app:diagram`: do not edit it by hand. A test fails when this page and the configuration disagree.*',
    '',
    '**This is the structure of the app, not a script for a call.** The dialog is mixed-initiative: a caller may give details in any order, change their mind, answer two questions at once or ask for two things in a row, and the engine follows. The map shows what is connected to what.',
    '',
    '## What a caller can ask for',
    '',
    ...intentsTable(app),
    '',
    '## The keypad menu and the lines that are only said',
    '',
    '```mermaid',
    ...menuDiagram(app),
    '```',
  ];
  for (const id of formOrder(app)) {
    const intro = app.forms[id]!.internal === true
      ? `After ${formsLeadingTo(app.forms, id).map(code).join(', ') || 'no form'}: the internal form ${code(id)}, its slots, the summary, the action and its rules.`
      : `Intent ${code(id)} to its slots, the summary, the action and its rules.`;
    lines.push('', `## ${capitalize(formWords(app, id))}`, '', intro, '', '```mermaid', ...formDiagram(app, id), '```');
  }
  lines.push('', '## Dangling references', '');
  if (found.length === 0) {
    lines.push(`None: every intent reaches a form or a line, and ${reach.declared ? 'every action is reached by a form or the identity flow.' : 'the forms do not declare which actions they call (`calls`), so which actions are reached is not checked.'}`);
  } else {
    for (const d of found) lines.push(`- ${d.message}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Fails, with a readable diff, when `file` (an app's APP-MAP.md) is not the map the app generates today. Never writes the file. */
export function expectAppMap(app: App, file: string, regenerate = `pnpm app:diagram ${relativeFolder(file)}`): void {
  expectGeneratedPage(app, file, appMapText(app), regenerate, 'app map');
}

/** Writes `app`'s map to `file`; whether it changed. For the app:diagram command, never a test. */
export function writeAppMap(app: App, file: string): { changed: boolean; lines: number } {
  return writeGeneratedPage(file, appMapText(app));
}

function relativeFolder(file: string): string {
  const rel = relative(process.cwd(), dirname(file));
  return rel === '' ? '.' : rel;
}
