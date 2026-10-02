import type {
  App, AppBrand, AppLocales, ConsoleConfig, FormDef, FormId, HandoffWording, IdentityConfig, IntentDef, ModelWording, PolicyTables, PolicyWording,
  PromptManifestEntry, RoleAccess, SlotId, SpokenDigitRule, ToolDef, ToolName, VoiceConfig,
} from '../core/app/types';
import type { SlotSpec } from '../core/slots/types';
import { CONSOLE_ELEMENT_IDS, validateApp } from '../core/app/validate';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { RULE_IDS, isRuleId } from '../gate/policy';
import { loadAppFolder, type LoadedConfig, type LoadResult } from './load';
import { WHOLE_FILE, closest, formatPath, formatProblem, type DataPath, type Problem } from './problems';
import { FILE_NAMES, FORM_HOOKS, type AppYaml, type FormHook, type PolicyYaml } from './schema/index';

/**
 * defineApp: an app folder's YAML joined with the app's TypeScript into the App the engine runs.
 *
 * The folder holds what is data (intents, forms, prompts, the policy tables, identity settings and
 * presentation; ./load.ts reads it); the code holds what runs (slot specs, tools and systems, form
 * hooks, custom rules, test hooks, principals). defineApp loads the folder, checks that the two name
 * the same things (every hook a form declares is written and none is written that is not declared;
 * every tool, slot and custom rule the YAML names exists in the code, and every tool in the code has
 * a policy row), builds the App, and runs validateApp. Anything wrong anywhere is thrown as one
 * AppDefinitionError listing every problem, each with the file and line to change and the fix.
 *
 * Nothing in the YAML is ever run: prompt text, criteria and wording templates stay strings (a
 * policy wording template has its {role} and {tool} replaced, nothing else), and a spoken-digits
 * pattern becomes a RegExp, as the schema documents.
 */

/** The FormDef hooks, as an app writes them for one form: `complete` and whichever of the others the form declares in forms.yaml. */
export type FormHooks = Pick<FormDef, FormHook>;

/** FORM_HOOKS names exactly FormDef's functions: a hook added to the contract must be added to forms.yaml's list. */
type FormDefHook = Exclude<keyof FormDef, 'slots' | 'summaryPromptId'>;
const hooksMatchTheContract: [FormDefHook] extends [FormHook] ? ([FormHook] extends [FormDefHook] ? true : never) : never = true;
void hooksMatchTheContract;

/** The TypeScript parts of an app: what runs, beside what the folder's YAML describes. */
export interface AppCode {
  /** Every slot spec, by slot id; each form's slots, the identity factor slots and the carried slots name these. */
  slots: Record<SlotId, SlotSpec>;
  /** Every tool, by name; each has a row under rulesFor in policy.yaml, and policy.yaml names no other. */
  tools: Record<ToolName, ToolDef>;
  /** A fresh copy of the app's systems and the gate's lookups over them (App.systems). */
  systems: App['systems'];
  /** Each form's hooks, by form id: every form in forms.yaml, with exactly the hooks its `hooks:` list declares. */
  forms: Record<FormId, FormHooks>;
  services?: App['services'];
  /** The app's own policy rules, by the id rulesFor names them by (PolicyTables.customRules). */
  customRules?: PolicyTables['customRules'];
  principals?: App['principals'];
  portal?: App['portal'];
  facts?: App['facts'];
  questions?: App['questions'];
  callerState?: App['callerState'];
  blockPromptId?: App['blockPromptId'];
  onServiceResult?: App['onServiceResult'];
  testing?: App['testing'];
  /** identity.yaml's code: the one-time code call's params (IdentityConfig.sendCodeParams). Only with an identity.yaml. */
  identity?: { sendCodeParams?: IdentityConfig['sendCodeParams'] };
}

/** Thrown by defineApp when the folder, the code or the two together are not a valid app: every problem, in one message. */
export class AppDefinitionError extends Error {
  readonly problems: readonly Problem[];

  constructor(dir: string, problems: readonly Problem[]) {
    const count = `${problems.length} problem${problems.length === 1 ? '' : 's'}`;
    super(`the app in ${dir} is not valid (${count}):\n${problems.map((p) => `  ${formatProblem(p)}`).join('\n')}`);
    this.name = 'AppDefinitionError';
    this.problems = problems;
  }
}

/** The file a problem in the app's code is reported against: the code has no YAML line to point at. */
export const CODE_FILE = 'app.ts';

/**
 * Builds the app in the folder `dir` with its TypeScript parts `code`. Throws an AppDefinitionError
 * listing every problem when the folder does not load, when the folder and the code do not name the
 * same things, or when validateApp refuses the result.
 */
export function defineApp(dir: string, code: AppCode): App {
  const loaded = loadAppFolder(dir);
  if (!loaded.config) throw new AppDefinitionError(dir, loaded.problems);
  const problems = crossLink(loaded.config, code, loaded.locate);
  if (problems.length > 0) throw new AppDefinitionError(dir, problems);
  const app = buildApp(loaded.config, code);
  try {
    validateApp(app);
  } catch (error) {
    // The cross-links above cover what validateApp checks of the folder; this is the backstop.
    const message = error instanceof Error ? error.message : String(error);
    throw new AppDefinitionError(dir, [
      { file: '.', line: 0, column: 0, path: WHOLE_FILE, message: `validateApp refused the app: ${message}`, fix: 'correct the reference it names, in the YAML file or in app.ts' },
    ]);
  }
  return app;
}

// ---------------------------------------------------------------------------------------------
// Cross-links: the folder and the code name the same things
// ---------------------------------------------------------------------------------------------

/** A path in the app's code, as a TypeScript accessor: `code.forms.renew.complete`, `code.customRules["known-branch"]`. */
export function codePath(...segs: readonly string[]): string {
  return `code${segs.map((s) => (/^[A-Za-z_$][\w$]*$/.test(s) ? `.${s}` : `[${JSON.stringify(s)}]`)).join('')}`;
}

/** Where an author writes a part of the code, as a fix names it: `app.ts (code.forms.renew.complete)`. */
const inCode = (...segs: readonly string[]): string => `${CODE_FILE} (${codePath(...segs)})`;

const has = (obj: object | null | undefined, key: string): boolean => obj != null && Object.hasOwn(obj, key);

const quoteList = (items: readonly string[]): string => items.map((i) => `"${i}"`).join(', ');

/** ", or rename it to "x"" when a known name is close enough to be what was meant. */
function renameHint(word: string, known: readonly string[]): string {
  const guess = closest(word, known);
  return guess ? `rename it to "${guess}", or ` : '';
}

/**
 * Every place the folder and the code disagree, as problems in the loader's format: located in the
 * YAML file where the YAML names something, and in app.ts (line 0) where only the code does.
 * Exported for `dialogwright check`.
 */
export function crossLink(config: LoadedConfig, code: AppCode, locate: LoadResult['locate']): Problem[] {
  const problems: Problem[] = [];
  const yaml = (file: string, path: DataPath, message: string, fix: string): void => {
    const at = locate(file, path) ?? { line: 1, column: 1 };
    problems.push({ file, line: at.line, column: at.column, path: formatPath(path), message, fix });
  };
  const inTs = (segs: readonly string[], message: string, fix: string): void => {
    problems.push({ file: CODE_FILE, line: 0, column: 0, path: codePath(...segs), message, fix });
  };

  const slots = Object.keys(code.slots ?? {});
  const tools = Object.keys(code.tools ?? {});
  const prompts = config.prompts[config.defaultLocale] ?? {};
  const promptIds = Object.keys(prompts);
  const { intents, menu } = config.intents;
  const forms = config.forms.forms;
  const policy = config.policy;
  const customRules = code.customRules ?? {};

  const slotExists = (file: string, path: DataPath, slot: string): void => {
    if (!has(code.slots, slot)) yaml(file, path, `slot "${slot}" is not defined`, `${renameHint(slot, slots)}add it to the app's slots in ${inCode('slots', slot)}`);
  };
  const promptExists = (file: string, path: DataPath, id: string): void => {
    if (!has(prompts, id)) {
      yaml(file, path, `prompt "${id}" is not in prompts.yaml`, `${renameHint(id, promptIds)}add "${id}:" to prompts.yaml with its text and interruptible`);
    }
  };

  // intents.yaml
  for (const [id, def] of Object.entries(intents)) {
    if (def.kind === 'form' && !has(forms, id)) {
      yaml('intents.yaml', ['intents', id], `intent "${id}" is a form intent, but forms.yaml has no form "${id}"`, `add "${id}:" under forms in forms.yaml (its slots, summaryPromptId and hooks), or change this intent's kind`);
    }
    if (def.promptId !== undefined) promptExists('intents.yaml', ['intents', id, 'promptId'], def.promptId);
  }
  menu.forEach(({ digit, intent }, i) => {
    if (!has(intents, intent)) {
      yaml('intents.yaml', ['menu', i, 'intent'], `menu digit "${digit}" names the intent "${intent}", which is not under intents`, `${renameHint(intent, Object.keys(intents))}add "${intent}:" under intents`);
    }
  });

  // forms.yaml, and each form's hooks in the code
  for (const [id, form] of Object.entries(forms)) {
    const intent = intents[id];
    if (!intent) {
      yaml('forms.yaml', ['forms', id], `form "${id}" has no intent in intents.yaml`, `add "${id}:" under intents in intents.yaml with kind: form, its criteria and its label`);
    } else if (intent.kind !== 'form') {
      yaml('forms.yaml', ['forms', id], `form "${id}" has an intent in intents.yaml of kind ${intent.kind}, not form`, `change intents.${id}.kind in intents.yaml to form`);
    }
    form.slots.forEach((slot, i) => slotExists('forms.yaml', ['forms', id, 'slots', i], slot));
    if (form.summaryPromptId !== null) promptExists('forms.yaml', ['forms', id, 'summaryPromptId'], form.summaryPromptId);

    const hooks = code.forms?.[id];
    if (!has(code.forms, id) || typeof hooks !== 'object' || hooks === null) {
      yaml('forms.yaml', ['forms', id], `form "${id}" has no hooks in the code`, `write them in ${inCode('forms', id)}: ${form.hooks.join(', ')}`);
      continue;
    }
    form.hooks.forEach((hook, i) => {
      const fn = (hooks as Record<string, unknown>)[hook];
      if (fn === undefined) {
        yaml('forms.yaml', ['forms', id, 'hooks', i], `form "${id}" declares the hook "${hook}", but the code does not define it`, `write it in ${inCode('forms', id, hook)}, or delete "${hook}" from this list`);
      } else if (typeof fn !== 'function') {
        inTs(['forms', id, hook], `form "${id}"'s hook "${hook}" is not a function`, `make ${inCode('forms', id, hook)} a function`);
      }
    });
    for (const [key, value] of Object.entries(hooks)) {
      if (value === undefined) continue;
      if (!(FORM_HOOKS as readonly string[]).includes(key)) {
        inTs(['forms', id, key], `"${key}" is not a form hook; the hooks are ${FORM_HOOKS.join(', ')}`, `${renameHint(key, FORM_HOOKS)}delete it from ${inCode('forms', id, key)}`);
      } else if (!form.hooks.includes(key as FormHook)) {
        yaml('forms.yaml', ['forms', id, 'hooks'], `form "${id}" has the hook "${key}" in the code, but forms.yaml does not declare it`, `add "${key}" to forms.${id}.hooks, or delete the hook from ${inCode('forms', id, key)}`);
      }
    }
  }
  for (const id of Object.keys(code.forms ?? {})) {
    if (has(forms, id)) continue;
    const guess = closest(id, Object.keys(forms));
    yaml(
      'forms.yaml',
      ['forms'],
      `the code has hooks for the form "${id}" (${codePath('forms', id)}), but forms.yaml has no form "${id}"`,
      `${guess ? `rename it to "${guess}" in ${inCode('forms', id)}, or ` : ''}add "${id}:" under forms in forms.yaml, or delete the hooks from ${inCode('forms', id)}`,
    );
  }

  // policy.yaml: every tool it names is in the code, and every tool in the code has rules
  const toolExists = (path: DataPath, tool: string): boolean => {
    if (has(code.tools, tool)) return true;
    yaml('policy.yaml', path, `tool "${tool}" is not defined in the code`, `${renameHint(tool, tools)}add it to the app's tools in ${inCode('tools', tool)}, or delete this row`);
    return false;
  };
  const tables: [keyof PolicyYaml, string][] = [['toolLevel', 'a level'], ['subjects', 'a subject'], ['serviceFields', 'service fields'], ['roles', 'roles']];
  for (const [tool, rules] of Object.entries(policy.rulesFor)) {
    if (!toolExists(['rulesFor', tool], tool)) continue;
    if (!has(policy.toolLevel, tool)) yaml('policy.yaml', ['rulesFor', tool], `tool "${tool}" has rules but no level under toolLevel`, `add "${tool}: 0" under toolLevel (0 anonymous, 1 the factors matched, 2 the factors and the code)`);
    rules.forEach((rule, i) => {
      if (isRuleId(rule) || has(customRules, rule)) return;
      yaml(
        'policy.yaml',
        ['rulesFor', tool, i],
        `rule "${rule}" is not a built-in rule (${RULE_IDS.join(', ')}) and the code defines no custom rule by that name`,
        `${renameHint(rule, [...RULE_IDS, ...Object.keys(customRules)])}add it to ${inCode('customRules', rule)}, or name a built-in rule instead`,
      );
    });
    if (rules.includes('R2') && !has(policy.subjects, tool)) yaml('policy.yaml', ['rulesFor', tool], `tool "${tool}" runs R2, but has no row under subjects`, `add "${tool}: { param: <the param that names the subject> }" under subjects`);
  }
  for (const [table, what] of tables) {
    for (const tool of Object.keys((policy[table] as object | undefined) ?? {})) {
      if (!toolExists([table, tool], tool)) continue;
      if (!has(policy.rulesFor, tool)) yaml('policy.yaml', [table, tool], `tool "${tool}" has ${what} but no rules under rulesFor`, `add "${tool}: [R1]" under rulesFor, or delete this row`);
    }
  }
  for (const tool of tools) {
    if (!has(policy.rulesFor, tool)) {
      yaml('policy.yaml', ['rulesFor'], `tool "${tool}" (${codePath('tools', tool)}) has no row under rulesFor, so it can never be called`, `add "${tool}: [R1]" under rulesFor and its level under toolLevel, or delete the tool from ${inCode('tools', tool)}`);
    }
  }
  const named = new Set(Object.values(policy.rulesFor).flat());
  for (const [id, rule] of Object.entries(customRules)) {
    if (isRuleId(id) || id === 'R0') inTs(['customRules', id], `custom rule "${id}" has a built-in rule's id`, `rename it in ${inCode('customRules', id)} and in policy.yaml's rulesFor; the built-in ids are R0, ${RULE_IDS.join(', ')}`);
    else if (typeof rule !== 'function') inTs(['customRules', id], `custom rule "${id}" is not a function`, `make ${inCode('customRules', id)} a function of the rule context`);
    else if (!named.has(id)) yaml('policy.yaml', ['rulesFor'], `custom rule "${id}" (${codePath('customRules', id)}) is not named under rulesFor, so it never runs`, `add "${id}" to the rules of the tool it guards, or delete the rule from ${inCode('customRules', id)}`);
  }
  if (!config.identity) {
    for (const [tool, level] of Object.entries(policy.toolLevel)) {
      if (level !== 0) yaml('policy.yaml', ['toolLevel', tool], `tool "${tool}" needs identity level ${level}, but the app has no identity.yaml, so no caller can reach it`, 'set it to 0, or add identity.yaml so callers can verify');
    }
    for (const [purpose, level] of Object.entries(policy.purposeLevel)) {
      if (level !== 0) yaml('policy.yaml', ['purposeLevel', purpose], `purpose "${purpose}" needs identity level ${level}, but the app has no identity.yaml`, 'set it to 0, or add identity.yaml so callers can verify');
    }
  }
  for (const [access, template] of Object.entries(policy.wording?.role ?? {})) {
    for (const [, name] of (template ?? '').matchAll(/\{([^}]*)\}/g)) {
      if (name !== 'role' && name !== 'tool') yaml('policy.yaml', ['wording', 'role', access], `the template names {${name}}; only {role} and {tool} are filled in`, `write {role} or {tool} in its place, or plain words`);
    }
  }

  // identity.yaml
  const identity = config.identity;
  if (identity) {
    identity.factorSlots.forEach((slot, i) => slotExists('identity.yaml', ['factorSlots', i], slot));
    for (const role of ['verifyTool', 'codeTool', 'sendCodeTool'] as const) {
      const tool = identity[role];
      if (!has(code.tools, tool)) yaml('identity.yaml', [role], `tool "${tool}" is not defined in the code`, `${renameHint(tool, tools)}add it to the app's tools in ${inCode('tools', tool)}`);
      else if (!has(policy.rulesFor, tool)) yaml('identity.yaml', [role], `tool "${tool}" has no row under rulesFor in policy.yaml`, `add "${tool}: [R1, R6]" under rulesFor in policy.yaml, and its level under toolLevel`);
    }
    if (identity.failedPromptId !== undefined) promptExists('identity.yaml', ['failedPromptId'], identity.failedPromptId);
    const send = code.identity?.sendCodeParams;
    if (send !== undefined && typeof send !== 'function') inTs(['identity', 'sendCodeParams'], 'sendCodeParams is not a function', `make ${inCode('identity', 'sendCodeParams')} a function of the session`);
  } else if (code.identity !== undefined) {
    inTs(['identity'], 'the code has identity hooks, but the folder has no identity.yaml', `add identity.yaml (subjectKind, factorSlots and the identity tools), or delete it from ${inCode('identity')}`);
  }

  // app.yaml
  const app = config.app;
  app.carrySlots?.forEach((slot, i) => slotExists('app.yaml', ['carrySlots', i], slot));
  for (const name of Object.keys(app.thresholds ?? {})) {
    if (has(DEFAULT_THRESHOLDS, name)) yaml('app.yaml', ['thresholds', name], `threshold "${name}" is one of the engine's own`, `rename it: an app's thresholds need names of their own (the engine's are set with --threshold ${name}=VALUE on a run)`);
  }
  const change = app.wording?.changeSlot;
  change?.order?.forEach((slot, i) => {
    slotExists('app.yaml', ['wording', 'changeSlot', 'order', i], slot);
    if (change.text && !has(change.text, slot)) yaml('app.yaml', ['wording', 'changeSlot', 'order', i], `slot "${slot}" is in the change question's order but has no text`, `add "${slot}:" under wording.changeSlot.text with the criterion for naming it`);
  });
  for (const slot of Object.keys(change?.text ?? {})) {
    if (!(change?.order ?? []).includes(slot)) yaml('app.yaml', ['wording', 'changeSlot', 'text', slot], `slot "${slot}" has a text in the change question but is not in its order`, `add "${slot}" to wording.changeSlot.order, or delete this text`);
  }
  const linkIds = new Set<string>();
  app.console?.links?.forEach(({ id }, i) => {
    if (CONSOLE_ELEMENT_IDS.includes(id)) yaml('app.yaml', ['console', 'links', i, 'id'], `link id "${id}" is an element id the console page already uses`, `choose another id, for example "${id}-page"`);
    else if (linkIds.has(id)) yaml('app.yaml', ['console', 'links', i, 'id'], `link id "${id}" is used twice`, 'give each link its own id');
    linkIds.add(id);
  });
  for (const [which, id] of Object.entries(app.prompts?.greetings ?? {})) {
    if (id !== undefined) promptExists('app.yaml', ['prompts', 'greetings', which], id);
  }

  // The code alone
  for (const [id, spec] of Object.entries(code.slots ?? {})) {
    if (spec?.id !== id) inTs(['slots', id], `the slot spec filed under "${id}" has the id "${String(spec?.id)}"`, `file it under ${codePath('slots', String(spec?.id))}, or give it the id "${id}"`);
  }

  return sortProblems(problems);
}

/** Problems by file (in the folder's file order, app.ts last), then position. */
function sortProblems(problems: readonly Problem[]): Problem[] {
  const order: string[] = [...Object.values(FILE_NAMES), CODE_FILE];
  const rank = (file: string) => {
    const i = order.indexOf(file);
    return i === -1 ? order.length : i;
  };
  return [...problems].sort((a, b) => rank(a.file) - rank(b.file) || a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
}

// ---------------------------------------------------------------------------------------------
// Building the App
// ---------------------------------------------------------------------------------------------

/** Sets `key` only when it has a value, so an App has no keys standing for nothing. */
function put<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

function manifestOf(prompts: Readonly<Record<string, { text: string; interruptible: boolean }>>): Record<string, PromptManifestEntry> {
  return Object.fromEntries(Object.entries(prompts).map(([id, p]) => [id, { text: p.text, interruptible: p.interruptible }]));
}

/**
 * The App, its fields in the contract's order and every map in the order its file lists it, so two
 * builds of the same folder are the same object, field for field.
 */
function buildApp(config: LoadedConfig, code: AppCode): App {
  const a = config.app;
  const app: Partial<App> = {
    id: a.id,
    intents: Object.fromEntries(Object.entries(config.intents.intents).map(([id, def]) => [id, intentOf(def)])),
    menu: config.intents.menu.map(({ digit, intent }) => ({ digit, intent })),
    forms: Object.fromEntries(Object.entries(config.forms.forms).map(([id, form]) => [id, formOf(form, code.forms[id]!)])),
    slots: code.slots,
  };
  if (config.identity) app.identity = identityOf(config.identity, code);
  app.tools = code.tools;
  app.policy = policyOf(config.policy, code);
  put(app, 'facts', code.facts);
  app.systems = code.systems;
  put(app, 'services', code.services);
  put(app, 'onServiceResult', code.onServiceResult);
  put(app, 'blockPromptId', code.blockPromptId);
  put(app, 'wording', a.wording as ModelWording | undefined);
  put(app, 'carrySlots', a.carrySlots);
  put(app, 'thresholds', a.thresholds);
  put(app, 'callerState', code.callerState);
  put(app, 'questions', code.questions);
  put(app, 'brand', a.brand as AppBrand | undefined);
  put(app, 'console', a.console as ConsoleConfig | undefined);
  put(app, 'voice', a.voice ? voiceOf(a.voice) : undefined);
  put(app, 'handoff', a.handoff as HandoffWording | undefined);
  app.prompts = promptsOf(config, a);
  put(app, 'locales', localesOf(config));
  put(app, 'principals', code.principals);
  put(app, 'portal', code.portal);
  put(app, 'testing', code.testing);
  put(app, 'fixtures', a.fixtures);
  return app as App;
}

function intentOf(def: LoadedConfig['intents']['intents'][string]): IntentDef {
  const intent: IntentDef = { criteria: def.criteria, label: def.label, kind: def.kind };
  put(intent, 'promptId', def.promptId);
  return intent;
}

/** A form: its slots and summary from forms.yaml, then its hooks from the code, in the order forms.yaml declares them. */
function formOf(form: LoadedConfig['forms']['forms'][string], hooks: FormHooks): FormDef {
  const def: Record<string, unknown> = { slots: form.slots, summaryPromptId: form.summaryPromptId };
  for (const hook of form.hooks) def[hook] = hooks[hook];
  return def as unknown as FormDef;
}

function identityOf(identity: NonNullable<LoadedConfig['identity']>, code: AppCode): IdentityConfig {
  const config = { subjectKind: identity.subjectKind } as IdentityConfig;
  put(config, 'delegateKind', identity.delegateKind);
  config.factorSlots = identity.factorSlots;
  config.verifyTool = identity.verifyTool;
  config.codeTool = identity.codeTool;
  config.sendCodeTool = identity.sendCodeTool;
  put(config, 'sendCodeParams', code.identity?.sendCodeParams);
  put(config, 'failedPromptId', identity.failedPromptId);
  return config;
}

/** The engine's words for R5's compared line (gate/policy.ts), where policy.yaml's wording.role leaves an access out. */
const DEFAULT_ROLE_TEMPLATES: Readonly<Record<RoleAccess, string>> = {
  allow: 'role {role} may {tool}: yes',
  refuse: 'role {role} may {tool}: no',
  person: 'role {role} may {tool}: with a person',
};

/** R5's compared line from policy.yaml's templates: {role} and {tool} filled in, nothing else read. */
export function roleLine(templates: Partial<Record<RoleAccess, string>>): NonNullable<PolicyWording['role']> {
  return (role, tool, access) =>
    (templates[access] ?? DEFAULT_ROLE_TEMPLATES[access]).replace(/\{(role|tool)\}/g, (_, name: string) => (name === 'role' ? role : tool));
}

function policyOf(policy: PolicyYaml, code: AppCode): PolicyTables {
  const tables: Partial<PolicyTables> = {
    toolLevel: policy.toolLevel,
    purposeLevel: policy.purposeLevel,
    rulesFor: policy.rulesFor,
    serviceFields: policy.serviceFields,
    confirmedFields: policy.confirmedFields,
    maxAttempts: policy.maxAttempts,
  };
  put(tables, 'roles', policy.roles);
  put(tables, 'rolePersonReason', policy.rolePersonReason);
  tables.subjects = policy.subjects;
  put(tables, 'customRules', code.customRules);
  if (policy.wording) {
    const { role, ...words } = policy.wording;
    const wording: PolicyWording = { ...words };
    put(wording, 'role', role ? roleLine(role) : undefined);
    tables.wording = wording;
  }
  return tables as PolicyTables;
}

function voiceOf(voice: NonNullable<AppYaml['voice']>): VoiceConfig {
  const config: { hints?: readonly string[]; spokenDigits?: readonly SpokenDigitRule[] } = {};
  put(config, 'hints', voice.hints);
  put(config, 'spokenDigits', voice.spokenDigits?.map(({ pattern, spell }) => ({ pattern: new RegExp(pattern, 'g'), spell })));
  return config;
}

/**
 * The app's locales (App.locales), for a folder that declares any: app.yaml's `locale:` (the
 * default, whose lines are prompts.yaml), and each locale/<tag>/prompts.yaml. A folder with neither
 * has none, so its App and every session of it are those of an app written without locales.
 */
function localesOf(config: LoadedConfig): AppLocales | undefined {
  const others = Object.entries(config.prompts).filter(([locale]) => locale !== config.defaultLocale);
  if (config.app.locale === undefined && others.length === 0) return undefined;
  return { default: config.defaultLocale, prompts: Object.fromEntries(others.map(([locale, prompts]) => [locale, manifestOf(prompts)])) };
}

function promptsOf(config: LoadedConfig, a: AppYaml): App['prompts'] {
  const settings = a.prompts;
  const prompts: App['prompts'] = { manifest: manifestOf(config.prompts[config.defaultLocale] ?? {}), tags: settings?.tags ?? {} };
  put(prompts, 'vocabulary', settings?.vocabulary);
  put(prompts, 'spokenVars', settings?.spokenVars);
  put(prompts, 'dataVars', settings?.dataVars);
  put(prompts, 'greetings', settings?.greetings);
  return prompts;
}
