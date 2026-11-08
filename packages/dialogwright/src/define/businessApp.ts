import type { AgentApp, AgentAppField, AgentAppForm } from '../agent/types';
import type { App, Completion, CompletionContext, FactsConfig, SummaryContext, ToolDef } from '../core/app/types';
import type { Session, SessionFacts } from '../core/session';
import { openPart, replyShape } from '../core/replyShape';
import { isAnonymous, type Principal } from '../gate/types';
import { ACCOUNT_SLOT, BUSINESS_FILE, businessForms, factsOf, slotIdOf } from './business';
import { ACCOUNTS_ONLY_PROMPT } from './businessLines';
import { accountOptions, BUSINESS_TOOLS, donePromptOf, fieldOptions, fieldSlotConfig, formParams, PRICE_PROMPT, wordsOf } from './businessFiles';
import { buildSlot } from '../slots/defineSlot';
import type { BuiltSlotSpec } from '../slots/types';
import { ANONYMOUS } from '../gate/principal';
import { REGRESS_TODAY } from '../harness-text/baseline';
import { styleOf } from '../render/config';
import type { AppCode } from './defineApp';
import type { LoadedConfig } from './load';
import { closest, formatPath, type DataPath, type Problem } from './problems';
import { DEFAULT_AGENT_MODEL } from './schema/style';
import type { BusinessFieldYaml, BusinessFormName, BusinessYaml } from './schema/business';

/**
 * An app in agent mode, joined with its code: what the engine adds to the app's code for the app
 * business.yaml stands for (./businessFiles.ts builds its files), and what the code must hold for it.
 *
 * The code of an agent-mode app is its tools (each a form's `then` names, and each a field `sees`),
 * its systems, and its testing hooks. The engine writes the rest from business.yaml:
 *
 * - each form's hooks: `confirmedParams`, the form's values by field name (and the account, on a form
 *   for accounts), which the read-back is fingerprinted over and every call of its `then` carries; and
 *   `complete`, the `then` tools called in order through the gate after the caller's yes, then the
 *   form's done line. A tool the gate refuses ends the form with its refusal, as any completion does.
 * - with a booking, the two identity tools: the call-start lookup of the number calling in `accounts`
 *   (BUSINESS_TOOLS.lookup) and the recognition of the account it matched (BUSINESS_TOOLS.recognize),
 *   with the facts that keep the match (FactsConfig.fromCallerLookup, callerMatch), and the gate's
 *   lookups (an account sees its own account).
 *
 * The App gains `mode: 'agent'` and `agent` (AgentApp): the facts the model may use, the owner's
 * sample replies, the forms as the model is told of them, the tools whose results it sees, and the
 * model. No turn runs in agent mode here: core/agentTurn.ts reads App.agent.
 */

/** App.agent for an app built from business.yaml (`style`: style.yaml's `agent`, as read). */
export function agentAppOf(b: BusinessYaml, style: LoadedConfig['style']): AgentApp {
  const forms: Record<string, AgentAppForm> = {};
  const sees: Record<string, string> = {};
  for (const { name, form } of businessForms(b)) {
    const fields = form.fields.map((f): AgentAppField => {
      const options = f.type === 'choice' ? Object.values(fieldOptions(b, f)) : undefined;
      if (f.sees !== undefined) sees[slotIdOf(name, f.name)] = f.sees;
      return {
        name: f.name,
        slot: slotIdOf(name, f.name),
        type: f.type,
        ...(f.about !== undefined ? { about: f.about } : {}),
        ...(options !== undefined ? { options } : {}),
        required: f.optional !== true,
        ...(f.sees !== undefined ? { sees: f.sees } : {}),
      };
    });
    forms[name] = { about: form.about ?? name, fields, then: [...form.then], ...(name === 'booking' ? { for: 'accounts' as const } : {}) };
  }
  const chosen = style?.agent;
  return {
    facts: factsOf(b),
    examples: [...(b.business.examples ?? [])],
    forms,
    sees,
    model: { provider: chosen?.provider ?? DEFAULT_AGENT_MODEL.provider, model: chosen?.model ?? DEFAULT_AGENT_MODEL.model, effort: chosen?.effort ?? DEFAULT_AGENT_MODEL.effort },
    // The price line, where the business has one: an answer may name it in place of its reply, so a price is never worded.
    lines: b.prices !== undefined ? { price: PRICE_PROMPT } : {},
    // How a reply is held: style.yaml's word budget, its phrases to avoid and its judge's cutoff (render/agentLine.ts).
    style: styleOf(style),
  };
}

// ---------------------------------------------------------------------------------------------
// The code: what the engine writes, and what the app's code must hold
// ---------------------------------------------------------------------------------------------

/** The parts of AppCode the engine writes for an agent-mode app from business.yaml: the code gives none of them. */
const ENGINE_PARTS = ['facts', 'identity', 'customRules', 'lookups'] as const;
const ENGINE_WRITES: Readonly<Record<(typeof ENGINE_PARTS)[number], string>> = {
  facts: 'the facts of its accounts',
  identity: 'its identity (the caller-ID match against its accounts)',
  customRules: 'its policy, which has no custom rule',
  lookups: 'its policy, which reads no lookup',
};

/** The session's facts in an agent-mode app with accounts: the accounts the number calling is on file for, once the call-start lookup found any. */
type AccountFacts = SessionFacts & { numberAccounts?: string[] };

/** The tools the engine writes for an app with accounts: the call-start lookup and the recognition, over business.yaml's accounts. */
export function accountTools(b: BusinessYaml): Record<string, ToolDef> {
  const keys = accountOptions(b);
  const ids = Object.keys(keys);
  const byNumber = new Map<string, string>();
  for (const a of b.accounts ?? []) {
    const key = ids.find((k) => keys[k] === a.name)!;
    for (const n of a.numbers) byNumber.set(n, key);
  }
  return {
    [BUSINESS_TOOLS.lookup]: {
      params: ['callerNumber'],
      run(call) {
        const key = byNumber.get(call.params.callerNumber ?? '');
        return key === undefined ? { value: null, summary: 'no account for the number' } : { value: { accounts: [key] }, summary: 'an account on file' };
      },
      // Only an account's key: nothing of it is said before it is recognized.
      check: replyShape.nullable(replyShape.object({ accounts: replyShape.list(replyShape.oneOf(ids)) })),
    },
    [BUSINESS_TOOLS.recognize]: {
      params: [ACCOUNT_SLOT],
      // Only the caller-ID match recognizes an account: the account the call-start lookup found for the
      // number calling, held in the slot as the match filled it. Anything else (a name said, a key
      // given, a match gone stale) is no account.
      run(call, _sys, ctx) {
        const key = call.params[ACCOUNT_SLOT] ?? '';
        const name = keys[key];
        const slot = ctx.s.slots[ACCOUNT_SLOT];
        const found = (ctx.s.facts as AccountFacts).numberAccounts ?? [];
        const byCallerId = slot?.by === 'caller-id' && slot.value === key;
        const ofNumber = ctx.s.callerNumber !== undefined && byNumber.get(ctx.s.callerNumber) === key;
        return name === undefined || !byCallerId || !found.includes(key) || !ofNumber
          ? { value: { ok: false }, summary: 'no account' }
          : { value: { ok: true, principal: { kind: ACCOUNT_SLOT, level: 1, id: key, first: name } }, summary: 'recognized' };
      },
      check: replyShape.any(replyShape.object({ ok: replyShape.oneOf([false]) }), replyShape.object({ ok: replyShape.oneOf([true]), principal: replyShape.object({ id: replyShape.oneOf(ids) }) })),
      // The identity row: recognized or not, the level, and how (by caller ID). Never the number.
      audit({ summary, after }) {
        const p = after.principal;
        const detail: Record<string, string | number | boolean> = { factor: 'caller_id', pass: summary === 'recognized', level: p.level };
        if (!isAnonymous(p) && p.via !== undefined) detail.via = p.via;
        return [{ type: 'identity', detail }];
      },
    },
  };
}

/** The facts of an app with accounts: the accounts the number calling is on file for, and the match when it is one. */
function accountFacts(): FactsConfig {
  return {
    initial: (): AccountFacts => ({}),
    clone: (f) => ({ ...f, ...((f as AccountFacts).numberAccounts ? { numberAccounts: [...(f as AccountFacts).numberAccounts!] } : {}) }),
    fromCallerLookup(f, value) {
      const found = (value as { accounts?: unknown } | null)?.accounts;
      if (Array.isArray(found) && found.every((k) => typeof k === 'string')) (f as AccountFacts).numberAccounts = [...(found as string[])];
    },
    callerMatch(f) {
      const found = (f as AccountFacts).numberAccounts;
      return found?.length === 1 ? { [ACCOUNT_SLOT]: found[0]! } : null;
    },
  };
}

/** What an account may see, for the scope rule: its own account. */
export function accountScopeOf(p: Principal): readonly string[] {
  return p.kind === ACCOUNT_SLOT && p.level > 0 ? [p.id] : [];
}

/** The values a form's calls carry, read from the session: what the caller heard read back and said yes to. */
function formValues(b: BusinessYaml, name: BusinessFormName): (s: Session) => Record<string, string> {
  const form = businessForms(b).find((f) => f.name === name)!.form;
  const params = formParams(name, form);
  return (s) => Object.fromEntries(params.map((p) => [p, s.slots[p === ACCOUNT_SLOT && name === 'booking' ? ACCOUNT_SLOT : slotIdOf(name, p)]?.value ?? '']));
}

/** A form's completion: its `then` called in order through the gate, then its done line, given every slot's display. */
function completeForm(b: BusinessYaml, name: BusinessFormName): (c: CompletionContext) => Completion {
  const form = businessForms(b).find((f) => f.name === name)!.form;
  const values = formValues(b, name);
  return (c) => {
    const { s, acks } = c;
    s.confirmedHash = s.pendingHash;
    const params = values(s);
    for (const tool of form.then) {
      const { decision } = c.callTool({ tool, params });
      if (decision.verdict === 'BLOCK' && decision.reason === 'confirmation') {
        s.confirmedHash = null;
        return { kind: 'reconfirm', acks };
      }
      if (decision.verdict !== 'ALLOW') {
        s.confirmedHash = null;
        return c.refusal(decision);
      }
    }
    s.confirmedHash = null;
    s.pendingHash = null;
    const vars = { ...Object.fromEntries(Object.entries(s.slots).map(([id, slot]) => [id, slot.display ?? ''])), ...accountVars(s) };
    return { kind: 'said', acks: [...acks, { promptId: donePromptOf(name), vars }] };
  };
}

/**
 * {account} in a form's lines: the name of the account the caller-ID match recognized (the principal's,
 * as the recognition gave it), never a value said. Nothing for a caller not recognized.
 */
export function accountVars(s: Session): Record<string, string> {
  const p = s.principal;
  return !isAnonymous(p) && p.kind === ACCOUNT_SLOT ? { [ACCOUNT_SLOT]: p.first } : {};
}

/**
 * The code an agent-mode app runs with: the app's own (its tools, systems and testing hooks) and what
 * the engine writes from business.yaml (above). Call only with code businessCodeProblems found nothing
 * wrong with.
 */
export function businessCode(b: BusinessYaml, code: AppCode): AppCode {
  const accounts = b.booking !== undefined;
  const forms = Object.fromEntries(businessForms(b).map(({ name }) => [name, {
    confirmedParams: formValues(b, name),
    complete: completeForm(b, name),
    // The booking's read-back names {account}: the recognized account's name.
    ...(name === 'booking' ? { onSummaryRead: (c: SummaryContext) => ({ vars: accountVars(c.s) }) } : {}),
  }]));
  const systems: AppCode['systems'] = () => {
    const made = code.systems();
    // The policy is the engine's, built from business.yaml: its scope rule is an account's own.
    return { ...made, lookups: { ...made.lookups, ownerOf: () => null, scopeOf: accountScopeOf } };
  };
  return {
    ...code,
    slots: {},
    tools: { ...code.tools, ...(accounts ? accountTools(b) : {}) },
    forms,
    systems,
    ...(accounts ? { facts: accountFacts() } : {}),
    // A corpus line said mid-call is seeded by the slots the engine builds: the app's own seed where it writes one.
    testing: { ...code.testing, seed: code.testing?.seed ?? defaultSeed(b, code) },
  };
}

/** The day a default seed's date fields hold where the app's grid gives none: a week after the regression's day. */
const SEED_DAY = new Date(Date.parse(`${REGRESS_TODAY}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);

/** A stand-in for a field of its type, where the app's grid (App.testing.policyMatrix values) gives none. */
function standIn(f: BusinessFieldYaml, options: Record<string, string>): string {
  switch (f.type) {
    case 'choice': return Object.keys(options)[0] ?? '';
    case 'date': return SEED_DAY;
    case 'digits': return '5555550100'.padEnd(f.length ?? 10, '0').slice(0, f.length ?? 10);
    case 'name': return 'avery lane';
    default: return wordsOf(f.name);
  }
}

/**
 * The seed a corpus line said mid-call is set up with (App.testing.seed), for an app in agent mode whose
 * code writes none: the stand-in of every field of every form, by the slot the engine builds for it
 * (`<form>_<field>`), each value the app's own grid's (App.testing.policyMatrix `values`, by field) or one
 * of its type, and its display as the slot's own check shows it (what the read-back says); with accounts,
 * the first account, recognized at level 1, calling from its first number.
 */
export function defaultSeed(b: BusinessYaml, code: AppCode): NonNullable<NonNullable<AppCode['testing']>['seed']> {
  let given: Readonly<Record<string, string>> = {};
  try {
    given = code.testing?.policyMatrix?.().values ?? {};
  } catch {
    given = {};
  }
  const placeholders: Record<string, { value: string; display: string }> = {};
  for (const { name, form } of businessForms(b)) {
    for (const f of form.fields) {
      const id = slotIdOf(name, f.name);
      const options = f.type === 'choice' ? fieldOptions(b, f) : {};
      const value = given[f.name] ?? standIn(f, options);
      const built = buildSlot(id, fieldSlotConfig(b, f));
      // The display the slot's own check gives the value, as of the day before a date's (a date ahead is in range).
      const day = f.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(Date.parse(`${value}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) : REGRESS_TODAY;
      const checked = built.ok ? (built.spec as BuiltSlotSpec).check?.(value, value, value, { today: day }) : undefined;
      placeholders[id] = checked?.ok === true ? { value: String(checked.value), display: checked.shown } : { value, display: options[value] ?? value };
    }
  }
  const first = b.accounts?.[0];
  const keys = accountOptions(b);
  const key = first === undefined ? undefined : Object.keys(keys).find((k) => keys[k] === first.name);
  if (first !== undefined && key !== undefined && b.booking !== undefined) {
    placeholders[ACCOUNT_SLOT] = { value: key, display: first.name };
    return { caller: () => ({ kind: ACCOUNT_SLOT, level: 1, id: key, first: first.name }), placeholders, ...(first.numbers[0] !== undefined ? { callerNumber: first.numbers[0] } : {}) };
  }
  return { caller: () => ANONYMOUS, placeholders };
}

/**
 * What the app's code must hold for business.yaml, each problem in business.yaml where the file names
 * something (at its line, through `locate`) and in the code where only the code does: every tool a
 * form calls or a field sees is in the code, with the params its calls carry; no tool is in the code
 * that no form calls; and the code writes none of what the engine writes (form hooks, facts, identity,
 * custom rules, lookups), nor a slot, nor a tool of the engine's own name: its forms and slots are {}.
 */
export function businessCodeProblems(b: BusinessYaml, code: AppCode, codeFile: string, locate: (path: DataPath) => { line: number; column: number } | null): Problem[] {
  const problems: Problem[] = [];
  const inYaml = (path: DataPath, message: string, fix: string): void => {
    problems.push({ file: BUSINESS_FILE, ...(locate(path) ?? { line: 1, column: 1 }), path: formatPath(path), message, fix });
  };
  const inCode = (path: string, message: string, fix: string): void => {
    problems.push({ file: codeFile, line: 0, column: 0, path, message, fix });
  };
  const tools = code.tools ?? {};
  const names = Object.keys(tools);
  const sameList = (a: readonly string[], b2: readonly string[]): boolean => a.length === b2.length && a.every((x) => b2.includes(x));
  const called = new Set<string>();

  for (const { name, form } of businessForms(b)) {
    const params = formParams(name, form);
    form.then.forEach((tool, i) => {
      called.add(tool);
      const def = tools[tool];
      if (def === undefined) {
        const near = closest(tool, names);
        inYaml([name, 'then', i], `the ${name} calls "${tool}", which is not a tool in the code`, `${near ? `rename it to "${near}" if it is that tool, or ` : ''}add it to the app's tools in ${codeFile} (code.tools.${tool}), with params [${params.join(', ')}]`);
      } else if (!sameList(def.params ?? [], params)) {
        inYaml([name, 'then', i], `the tool "${tool}" lists the params [${(def.params ?? []).join(', ')}], but every call the ${name} makes carries its values, [${params.join(', ')}]`, `make code.tools.${tool}.params [${params.join(', ')}] in ${codeFile}`);
      }
    });
    form.fields.forEach((f, i) => {
      if (f.sees === undefined) return;
      called.add(f.sees);
      const def = tools[f.sees];
      if (def === undefined) {
        const near = closest(f.sees, names);
        inYaml([name, 'fields', i, 'sees'], `the field "${f.name}" sees "${f.sees}", which is not a tool in the code`, `${near ? `rename it to "${near}" if it is that tool, or ` : ''}add it to the app's tools in ${codeFile} (code.tools.${f.sees}), with params [${f.name}] and a reply check in a closed form`);
      } else if (!sameList(def.params ?? [], [f.name])) {
        inYaml([name, 'fields', i, 'sees'], `the tool "${f.sees}" lists the params [${(def.params ?? []).join(', ')}], but it is called with the field it sees, [${f.name}]`, `make code.tools.${f.sees}.params [${f.name}] in ${codeFile}`);
      } else if (def.check === undefined) {
        // Its result is shown to the model: only a reply that passes its check, in a closed form (the design's decision 2).
        inYaml([name, 'fields', i, 'sees'], `the field "${f.name}" sees "${f.sees}", whose result is shown to the agent model, but the tool declares no reply check`, `give code.tools.${f.sees} a check in ${codeFile}, written with replyShape in closed forms (oneOf, digits, code, isoDate, amount, number, boolean, and lists and objects of them), naming each field the model may see`);
      } else {
        const open = openPart(def.check);
        if (open !== null) inYaml([name, 'fields', i, 'sees'], `the field "${f.name}" sees "${f.sees}", whose result is shown to the agent model, but its reply check is not a closed form: ${open}`, `check that field of code.tools.${f.sees} in ${codeFile} with a closed form of replyShape (oneOf, digits, code, isoDate, amount, number, boolean), or leave it out of the check, so it is never shown`);
      }
    });
  }
  // The tools seen by fields of two forms: each called with one field's value, the same name in both.
  for (const tool of names) {
    if (Object.values(BUSINESS_TOOLS).includes(tool as never)) {
      inCode(`code.tools.${tool}`, `"${tool}" is the name of a tool the engine writes for an app in agent mode (the account the number calling is on file for)`, `rename the tool in ${codeFile}, and in business.yaml where a form names it`);
    } else if (!called.has(tool)) {
      inCode(`code.tools.${tool}`, `the tool "${tool}" is in the code, but no form of business.yaml calls it (a then) and no field sees it, so it can never be called`, `name it in a form's then or a field's sees in business.yaml, or delete it from ${codeFile}`);
    }
  }
  for (const part of ENGINE_PARTS) {
    if (code[part] !== undefined) inCode(`code.${part}`, `an app in agent mode does not write ${part}: the engine writes ${ENGINE_WRITES[part]} from business.yaml`, `delete code.${part} from ${codeFile}`);
  }
  if (Object.keys(code.forms ?? {}).length > 0) inCode('code.forms', 'an app in agent mode writes no form hooks: the engine writes each form\'s from business.yaml (its read-back\'s values and its then)', `make code.forms {} in ${codeFile}`);
  if (Object.keys(code.slots ?? {}).length > 0) inCode('code.slots', 'an app in agent mode writes no slot: each field of business.yaml is a slot of its library type', `make code.slots {} in ${codeFile}, and say each field in business.yaml`);
  return problems;
}

/** Puts `mode: 'agent'` and App.agent on an app built from business.yaml. */
export function asAgentApp(app: App, b: BusinessYaml, style: LoadedConfig['style']): App {
  app.mode = 'agent';
  app.agent = agentAppOf(b, style);
  // The booking is offered only to an account the number calling recognized: any other caller is told
  // so, in the business's words, and begun on the request.
  // A person asked for is the callback note, where the business takes one: the handoff line, then its number.
  if (b.callback !== undefined) app.personForm = { form: 'callback', say: 'handoff_live_agent' };
  if (b.booking !== undefined && app.forms.booking !== undefined) {
    app.forms.booking = { ...app.forms.booking, recognizedOnly: { say: ACCOUNTS_ONLY_PROMPT, ...(b.request !== undefined ? { instead: 'request' } : {}) } };
  }
  return app;
}
