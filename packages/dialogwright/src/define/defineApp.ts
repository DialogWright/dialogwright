import type {
  App, AppBrand, AppLocales, CheckOutcome, ConsoleConfig, FormCheck, FormDef, FormId, HandoffData, HandoffWording, IdentityConfig, IntentDef, ModelWording, PolicyTables, PolicyWording,
  PromptManifestEntry, Recognition, RoleAccess, SlotId, ToolDef, ToolName, VoiceConfig, VoiceLocale, CallerNumberUse,
} from '../core/app/types';
import { SLOT_LISTEN_VALUES, type SlotSpec } from '../core/slots/types';
import { CONSOLE_ELEMENT_IDS, validateApp } from '../core/app/validate';
import { askedQuestionIdClashes, clashMessage, declaredQuestionIdClashes } from '../core/questionIds';
import { askedQuestionIds, probeContexts } from '../core/app/probeQuestions';
import { thresholdNamesOf, unknownSlotThresholds, unknownThresholdMessage } from '../core/slotThresholds';
import { reachOf, unreachedActions } from '../core/app/reach';
import { VAR } from '../prompts/segments';
import type { SlotSource } from '../slots/defineSlot';
import { mergeSlotTypes, resolveSlots, type ResolvedSlots } from '../slots/resolveSlots';
import type { LibrarySlotSpec, SlotTypes } from '../slots/types';
import { applySlotWording, isLibrarySlot, localeSlotsFile } from '../slots/wording';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { BUILT_IN_IDS_NOTE, BUILT_IN_RULES } from '../gate/compiled';
import { loadAppFolder, type LoadedConfig, type LoadResult } from './load';
import { ruleDefinitionProblems } from '../gate/defineRule';
import { compileIdentity, compilePolicy, customRulesNamed, declaredFields, declaredParams, identityProblems, isBuiltInRuleId, lookupDeclarationProblems, policyProblems, slotChoicesOf, slotRedactOf, toolFieldProblems, toolParamProblems } from './policyFile';
import { WHOLE_FILE, closest, formatPath, formatProblem, keyPositionOf, type DataPath, type Problem } from './problems';
import { FOLDER_FILES, FORM_HOOKS, SLOTS_FILE, type AppYaml, type FormHook } from './schema/index';
import { kbLinkProblems } from '../kb/rules';
import { checkProblems } from './formChecks';
import type { Retriever } from '../kb/types';
import { kbCatalog } from '../kb/catalog';
import { defaultRetriever } from '../kb/hybrid';
import { warnFallback } from '../kb/fallback';
import { KB_ANSWER_PROMPT, KB_UNAVAILABLE_PROMPT, kbCompletion } from '../kb/answer';
import { answerPromptsOf, knowledgeUseProblems } from './knowledgeUse';
import { VOICE_PROVIDER_IDS } from '../channel/voiceProviders';
import { handoffDataProblems } from '../handoff/data';

/**
 * defineApp: an app folder's YAML joined with the app's TypeScript into the App the engine runs.
 *
 * The folder holds what is data (intents, forms, prompts, the policy tables, identity settings and
 * presentation; ./load.ts reads it); the code holds what runs (slot specs, tools and systems, form
 * hooks, custom rules, test hooks, principals). defineApp loads the folder, checks that the two name
 * the same things (every hook a form declares is written and none is written that is not declared;
 * every tool, slot and custom rule the YAML names exists in the code, and every tool in the code has
 * a policy row), builds the App, and runs validateApp. A folder may also have a slots.yaml, which names
 * every slot the app has: a library type with its options (built here, with its problems pointed at
 * the file's lines), or `{ type: code }` for a slot the code writes; its key order is the order of
 * App.slots (slots/resolveSlots.ts). Anything wrong anywhere is thrown as one
 * AppDefinitionError listing every problem, each with the file and line to change and the fix.
 *
 * The App carries the folder's content hashes (App.configHashes: each file's, over its parsed
 * content, and the combined one), which the engine records once per call so a call can be tied to
 * the configuration it ran under.
 *
 * Nothing in the YAML is ever run: prompt text, criteria and wording templates stay strings (a
 * policy wording template has its {role} and {tool} replaced, nothing else), and a spoken-digits
 * pattern becomes a RegExp, as the schema documents.
 */

/** The FormDef hooks, as an app writes them for one form: `complete` and whichever of the others the form declares in forms.yaml. */
export type FormHooks = Pick<FormDef, FormHook>;

/** FORM_HOOKS names exactly FormDef's functions: a hook added to the contract must be added to forms.yaml's list. */
type FormDefHook = Exclude<keyof FormDef, 'slots' | 'summaryPromptId' | 'calls' | 'checks' | 'checksPassed'>;
const hooksMatchTheContract: [FormDefHook] extends [FormHook] ? ([FormHook] extends [FormDefHook] ? true : never) : never = true;
void hooksMatchTheContract;

/** The TypeScript parts of an app: what runs, beside what the folder's YAML describes. */
export interface AppCode {
  /**
   * The slots the code writes, by slot id; each form's slots, the identity factor slots and the carried slots name these.
   * With a slots.yaml, the slots it marks `{ type: code }` and no others (it lists every slot; the library's types are built from it).
   */
  slots: Record<SlotId, SlotSpec>;
  /** The slot types the app adds to the built-in ones (`registerSlotType`), for a slots.yaml to name. A name a built-in type has is refused. */
  slotTypes?: SlotTypes;
  /** Every tool, by name; each has a row under rulesFor in policy.yaml, and policy.yaml names no other. */
  tools: Record<ToolName, ToolDef>;
  /** A fresh copy of the app's systems and the gate's lookups over them (App.systems). */
  systems: App['systems'];
  /** Each form's hooks, by form id: every form in forms.yaml, with exactly the hooks its `hooks:` list declares. */
  forms: Record<FormId, FormHooks>;
  services?: App['services'];
  /** The app's own policy rules, by the id rulesFor names them by (PolicyTables.customRules). */
  customRules?: PolicyTables['customRules'];
  /**
   * The lookups policy.yaml's range rules may call in their references (`max: orderTotal(orderId)`):
   * names of functions on the gate's lookups (`systems().lookups`), each called with one param's
   * value. A reference to any other is refused. Default: none.
   */
  lookups?: readonly string[];
  principals?: App['principals'];
  portal?: App['portal'];
  facts?: App['facts'];
  questions?: App['questions'];
  callerState?: App['callerState'];
  /** Whether the caller's number may be offered for a slot (App.callerOffer). */
  callerOffer?: App['callerOffer'];
  blockPromptId?: App['blockPromptId'];
  onServiceResult?: App['onServiceResult'];
  testing?: App['testing'];
  /** identity.yaml's code: the one-time code call's params (IdentityConfig.sendCodeParams). Only with an identity.yaml. */
  identity?: { sendCodeParams?: IdentityConfig['sendCodeParams'] };
  /** The knowledge base's code: a retriever of the app's own (App.knowledge.retriever), in place of the engine's default (kb/hybrid.ts defaultRetriever). Only with a kb/ folder. */
  knowledge?: { retriever?: Retriever };
}

/**
 * The brand every AppDefinitionError carries. It is a registered symbol, so an error thrown by
 * another copy of this module (the app module imported through a different loader, or a second
 * installed copy of the package) has it too, where `instanceof` would say no.
 */
export const APP_DEFINITION_ERROR = Symbol.for('dialogwright.AppDefinitionError');

/** Thrown by defineApp when the folder, the code or the two together are not a valid app: every problem, in one message. */
export class AppDefinitionError extends Error {
  readonly problems: readonly Problem[];
  readonly [APP_DEFINITION_ERROR] = true;
  /**
   * The code parts defineApp was given, when it was given any. `dialogwright check` reads them from
   * an app module that threw while it was imported, so the lines the engine needs because of the
   * code (a slot's keypad line, a portal's sign-in lines) are reported in the same run as these problems.
   * It is not enumerable, so logging or serializing the error does not dump the app's code, and it is
   * not named `code`, which Node and most libraries read as an error's string code.
   */
  declare readonly appCode?: AppCode;

  /** `what` names the thing that is not valid when it is not an app folder ("the slots in src/slots.yaml"). */
  constructor(dir: string, problems: readonly Problem[], what: string = `the app in ${dir}`, code?: AppCode) {
    const count = `${problems.length} problem${problems.length === 1 ? '' : 's'}`;
    super(`${what} is not valid (${count}):\n${problems.map((p) => `  ${formatProblem(p)}`).join('\n')}`);
    this.name = 'AppDefinitionError';
    this.problems = problems;
    if (code !== undefined) Object.defineProperty(this, 'appCode', { value: code, enumerable: false, writable: false, configurable: false });
  }
}

/**
 * Whether `error` is an AppDefinitionError from any copy of this module: it carries the brand, or
 * (from a copy older than the brand) the name, and in either case a list of problems.
 */
export function isAppDefinitionError(error: unknown): error is { problems: readonly Problem[]; message: string; appCode?: unknown } {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { [APP_DEFINITION_ERROR]?: unknown; name?: unknown; problems?: unknown };
  return (e[APP_DEFINITION_ERROR] === true || e.name === 'AppDefinitionError') && Array.isArray(e.problems);
}

/** The file a problem in the app's code is reported against by default: the code has no YAML line to point at. */
export const CODE_FILE = 'app.ts';

export interface DefineAppOptions {
  /** The app module's path from the app folder, as fixes name it: `src/app.ts` for an app whose code lives in src/. Default: `app.ts`. */
  codeFile?: string;
}

/**
 * Builds the app in the folder `dir` with its TypeScript parts `code`. Throws an AppDefinitionError
 * listing every problem when the folder does not load, when the folder and the code do not name the
 * same things, or when validateApp refuses the result.
 */
export function defineApp(dir: string, code: AppCode, options: DefineAppOptions = {}): App {
  const codeFile = options.codeFile ?? CODE_FILE;
  const loaded = loadAppFolder(dir);
  if (!loaded.config) throw new AppDefinitionError(dir, loaded.problems);
  const problems = crossLink(loaded.config, code, loaded.locate, codeFile, loaded.locateKey, loaded.document);
  if (problems.length > 0) throw new AppDefinitionError(dir, problems, undefined, code);
  const app = buildApp(loaded.config, code, linkSlots(loaded.config, code, loaded.document, codeFile).slots);
  try {
    validateApp(app);
  } catch (error) {
    // The cross-links above cover what validateApp checks of the folder; this is the backstop.
    const message = error instanceof Error ? error.message : String(error);
    throw new AppDefinitionError(dir, [
      { file: '.', line: 0, column: 0, path: WHOLE_FILE, message: `validateApp refused the app: ${message}`, fix: `correct the reference it names, in the YAML file or in ${codeFile}` },
    ], undefined, code);
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

const has = (obj: object | null | undefined, key: string): boolean => obj != null && Object.hasOwn(obj, key);

const quoteList = (items: readonly string[]): string => items.map((i) => `"${i}"`).join(', ');

/** Where an author writes a part of the code, as a fix names it: `app.ts (code.forms.renew.complete)`. */
const codeAt = (codeFile: string) => (...segs: readonly string[]): string => `${codeFile} (${codePath(...segs)})`;

/** What linkSlots found: the app's slots as built, and every slot id there is. */
export interface LinkedSlots extends ResolvedSlots {
  /** Every slot id the app has: the ones slots.yaml lists and the ones the code writes (a code slot the file leaves out is reported, and still exists). */
  known: ReadonlySet<string>;
}

/**
 * The app's slots: `code.slots` as it is when the folder has no slots.yaml; with one, the library
 * slots built from it and the code's slots it marks `{ type: code }`, in its order (slots/resolveSlots.ts).
 * Also checks the types the code adds (`code.slotTypes`). `document` is the loader's (LoadResult.document),
 * which lets a library slot's problems point at its line in slots.yaml.
 */
export function linkSlots(config: LoadedConfig, code: AppCode, document: LoadResult['document'], codeFile: string = CODE_FILE): LinkedSlots {
  const inCode = codeAt(codeFile);
  const merged = mergeSlotTypes(code.slotTypes, inCode);
  const typeProblems: Problem[] = merged.problems.map((p) => ({ file: codeFile, line: 0, column: 0, ...p }));
  const codeSlots = code.slots ?? {};
  if (!config.slots) {
    return withLocaleWording({ slots: codeSlots, library: new Set(), ids: Object.keys(codeSlots), known: new Set(Object.keys(codeSlots)), problems: typeProblems }, config, merged.types, document, inCode);
  }
  // A topic slot is built with the knowledge base's topics (kb/catalog.ts), when the folder has a kb/.
  const catalog = config.knowledge ? kbCatalog(config.knowledge) : undefined;
  const resolved = resolveSlots({
    configs: config.slots, codeSlots, types: merged.types, file: SLOTS_FILE, source: document?.(SLOTS_FILE) ?? undefined, inCode, ...(catalog !== undefined ? { catalog } : {}),
  });
  return withLocaleWording({ ...resolved, known: new Set([...resolved.ids, ...Object.keys(codeSlots)]), problems: [...typeProblems, ...resolved.problems] }, config, merged.types, document, inCode);
}

/**
 * The slots with each locale's wording (locale/<tag>/slots.yaml) applied: every library slot a
 * locale gives wording for is built again with it (slots/wording.ts), keeping its place in the
 * order. A slot the app does not have, one the code writes by hand (it has no options to merge
 * over), and wording its type does not take are problems, each at its line in the locale's file.
 * A folder without any locale slots.yaml gets its slots exactly as they were.
 */
function withLocaleWording(linked: LinkedSlots, config: LoadedConfig, types: SlotTypes, document: LoadResult['document'], inCode: (...segs: readonly string[]) => string): LinkedSlots {
  const tags = Object.keys(config.localeSlots ?? {});
  if (tags.length === 0) return linked;
  const problems: Problem[] = [];
  const raw: Record<string, Record<string, unknown>> = {};
  const sources: Record<string, Record<string, SlotSource>> = {};
  const known = [...linked.known];
  for (const tag of tags) {
    const file = localeSlotsFile(tag);
    const read = document?.(file) ?? null;
    const atKey = (id: string, message: string, fix: string): void => {
      const at = read ? keyPositionOf(read.doc, read.lines, [id]) : { line: 0, column: 0 };
      problems.push({ file, ...at, path: formatPath([id]), message, fix });
    };
    for (const [id, entry] of Object.entries(config.localeSlots[tag]!)) {
      if (!linked.known.has(id)) {
        atKey(
          id,
          `slot "${id}" has wording in ${file}, but ${config.slots ? 'the app' : 'the code'} defines no slot "${id}"`,
          `${renameHint(id, known)}delete it, or ${config.slots ? `add "${id}:" to ${SLOTS_FILE}` : `add the slot to ${inCode('slots', id)}`}`,
        );
        continue;
      }
      const spec = linked.slots[id];
      // A slot that did not build has its own problem already.
      if (spec === undefined) continue;
      if (!isLibrarySlot(spec)) {
        atKey(
          id,
          `the slot "${id}" is written in code (${inCode('slots', id)}), so ${file} cannot give its wording: only a library slot (a type in slots.yaml, or one built with defineSlot) takes a locale's wording`,
          `delete "${id}" from ${file}, and have the code's slot say its value by SlotContext.locale and display(value, locale)`,
        );
        continue;
      }
      (raw[id] ??= {})[tag] = entry;
      if (read) (sources[id] ??= {})[tag] = { file, doc: read.doc, lines: read.lines, at: [id] };
    }
  }
  const slots = { ...linked.slots };
  for (const [id, byTag] of Object.entries(raw)) {
    const result = applySlotWording({ spec: slots[id] as LibrarySlotSpec, types, raw: byTag, ...(sources[id] ? { sources: sources[id] } : {}) });
    if (result.ok) slots[id] = result.spec;
    else problems.push(...result.problems);
  }
  return { ...linked, slots, problems: [...linked.problems, ...problems] };
}

/** "a", "a or b", "a, b or c". */
function orList(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} or ${items.at(-1)!}` : items.join('');
}

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
export function crossLink(
  config: LoadedConfig,
  code: AppCode,
  locate: LoadResult['locate'],
  codeFile: string = CODE_FILE,
  locateKey: LoadResult['locateKey'] = locate,
  document?: LoadResult['document'],
): Problem[] {
  const problems: Problem[] = [];
  const inCode = codeAt(codeFile);
  /** A problem in a YAML file, at the value `path` leads to, or at its key when the key is what is wrong. */
  const yaml = (file: string, path: DataPath, message: string, fix: string, atKey = false): void => {
    const at = (atKey ? locateKey(file, path) : locate(file, path)) ?? { line: 1, column: 1 };
    problems.push({ file, line: at.line, column: at.column, path: formatPath(path), message, fix });
  };
  const inTs = (segs: readonly string[], message: string, fix: string): void => {
    problems.push({ file: codeFile, line: 0, column: 0, path: codePath(...segs), message, fix });
  };

  // slots.yaml, when there is one, and the code's own: every slot there is, and the specs built.
  const linked = linkSlots(config, code, document, codeFile);
  problems.push(...linked.problems);
  const slots = [...linked.known];
  const tools = Object.keys(code.tools ?? {});
  const prompts = config.prompts[config.defaultLocale] ?? {};
  const promptIds = Object.keys(prompts);
  const { intents, menu } = config.intents;
  const forms = config.forms.forms;
  const policy = config.policy;
  const customRules = code.customRules ?? {};

  /** What to do about a slot that is named and does not exist: where it would be added. */
  const addSlot = (slot: string): string =>
    config.slots ? `add "${slot}:" to ${SLOTS_FILE} (a library type, or { type: code } with the slot in ${inCode('slots', slot)})` : `add it to the app's slots in ${inCode('slots', slot)}`;
  const slotExists = (file: string, path: DataPath, slot: string): void => {
    if (!linked.known.has(slot)) yaml(file, path, `slot "${slot}" is not defined`, `${renameHint(slot, slots)}${addSlot(slot)}`);
  };
  const promptExists = (file: string, path: DataPath, id: string): void => {
    if (!has(prompts, id)) {
      yaml(file, path, `prompt "${id}" is not in prompts.yaml`, `${renameHint(id, promptIds)}add "${id}:" to prompts.yaml with its text and interruptible`);
    }
  };

  /** A locale the folder names (an intent's switch, app.yaml's voice) that is not one the app speaks. */
  const appLocales = [config.defaultLocale, ...Object.keys(config.prompts).filter((l) => l !== config.defaultLocale)];
  const localeNamed = (file: string, path: DataPath, tag: string, atKey = false): void => {
    if (!appLocales.includes(tag)) yaml(file, path, `"${tag}" is not a locale of this app`, `add locale/${tag}/ or use one of ${appLocales.join(', ')}`, atKey);
  };

  // intents.yaml
  for (const [id, def] of Object.entries(intents)) {
    if (def.locale !== undefined) localeNamed('intents.yaml', ['intents', id, 'locale'], def.locale);
    if (def.kind === 'form' && !has(forms, id)) {
      yaml('intents.yaml', ['intents', id], `intent "${id}" is a form intent, but forms.yaml has no form "${id}"`, `add "${id}:" under forms in forms.yaml (its slots, summaryPromptId and hooks), or change this intent's kind`);
    }
    if (def.promptId !== undefined) promptExists('intents.yaml', ['intents', id, 'promptId'], def.promptId);
    // Only a form intent, an informational one and done are confirmed when the model is unsure (gates.ts):
    // agent and repeat_prompt act only when it is sure, and other and none are never acted on.
    if (def.unsure !== undefined && def.kind === 'control' && id !== 'done') {
      yaml('intents.yaml', ['intents', id, 'unsure'], `the control intent "${id}" is never confirmed, so "unsure" does nothing for it`, 'delete "unsure": only a form intent, an informational one and done are confirmed when the model is unsure of them', true);
    }
    // A priority intent is acted on as a form or an answer (gates.ts priorityIntent); a control
    // intent is neither, and the agent intent already reaches a person through wantsHuman.
    if (def.priority !== undefined && def.priority !== false && def.kind === 'control') {
      yaml('intents.yaml', ['intents', id, 'priority'], `the control intent "${id}" cannot be a priority intent: a priority intent starts its form or says its answer`, 'delete "priority": only a form intent or an informational one is a priority intent (a person on request is the agent intent, and wantsHuman already acts on it at once)', true);
    }
    if (typeof def.priority === 'object' && def.priority.threshold !== undefined && !thresholdNamesOf(config.app.thresholds).includes(def.priority.threshold)) {
      const name = def.priority.threshold;
      yaml('intents.yaml', ['intents', id, 'priority', 'threshold'], `intent "${id}" names the threshold "${name}", which is neither one of the engine's thresholds nor one the app names`, `${renameHint(name, thresholdNamesOf(config.app.thresholds))}add "${name}" under thresholds in app.yaml, or write priority: true for PRIORITY_INTENT`);
    }
    if (def.passage !== undefined) {
      promptExists('intents.yaml', ['intents', id, 'passage'], KB_ANSWER_PROMPT);
      promptExists('intents.yaml', ['intents', id, 'passage'], KB_UNAVAILABLE_PROMPT);
    }
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

    if (form.answers) {
      const lines = answerPromptsOf(form.answers);
      promptExists('forms.yaml', ['forms', id, 'answers', ...(form.answers.answer !== undefined ? ['answer'] : [])], lines.answer);
      promptExists('forms.yaml', ['forms', id, 'answers', ...(form.answers.unavailable !== undefined ? ['unavailable'] : [])], lines.unavailable);
    }

    const declared = form.hooks ?? [];
    const hooks = code.forms?.[id];
    // A form with no hooks (one that answers from the knowledge base) needs nothing in the code.
    if (!has(code.forms, id) && declared.length === 0) continue;
    if (!has(code.forms, id) || typeof hooks !== 'object' || hooks === null) {
      yaml('forms.yaml', ['forms', id], `form "${id}" has no hooks in the code`, `write them in ${inCode('forms', id)}: ${declared.join(', ')}`);
      continue;
    }
    declared.forEach((hook, i) => {
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
      } else if (!declared.includes(key as FormHook)) {
        yaml('forms.yaml', ['forms', id, 'hooks'], `form "${id}" has the hook "${key}" in the code, but forms.yaml does not declare it`, `add "${key}" to forms.${id}.hooks, or delete the hook from ${inCode('forms', id, key)}`);
      }
    }
  }
  // forms.yaml's checks: their actions, slots, levels and lines (./formChecks.ts).
  checkProblems({ config, report: yaml, promptExists });
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

  // forms.yaml's `calls`: the actions each form's hooks call. A form says so, or none does; each is a
  // tool; and an action no form lists and the identity flow does not call is one nothing can reach.
  const reach = reachOf(forms);
  for (const [id, form] of Object.entries(forms)) {
    form.calls?.forEach((tool, i) => {
      if (!tools.includes(tool)) yaml('forms.yaml', ['forms', id, 'calls', i], `form "${id}" calls "${tool}", which is not a tool in the code`, `${renameHint(tool, tools)}add it to the app's tools in ${inCode('tools', tool)}, or delete it from this list`);
    });
    if (reach.undeclared.includes(id)) {
      yaml('forms.yaml', ['forms', id], `form "${id}" does not say which actions it calls, though other forms do`, `add "calls: [<the tools its hooks call>]" to it ("calls: []" for none): every form says, or none does`, true);
    }
  }
  const flow = config.identity ? { verifyTool: config.identity.levels[1].verify, ...(config.identity.levels[2] ? { codeTool: config.identity.levels[2].verify, sendCodeTool: config.identity.levels[2].send } : {}) } : undefined;
  // A check no form names is formChecks.ts's to report, in its own words.
  // The call-start lookup (app.yaml's callerNumber.lookup) is reached at call start, by no form.
  const startLookup = config.app.callerNumber?.lookup;
  for (const tool of unreachedActions(Object.keys(policy.actions).filter((t) => policy.actions[t]!.check !== true && t !== startLookup), forms, flow)) {
    yaml('policy.yaml', ['actions', tool], `action "${tool}" is reached by no form: no form's calls list it, and the identity flow does not call it`, `add "${tool}" to the calls of the form whose hooks call it in forms.yaml, or delete the action from policy.yaml and the tool from ${inCode('tools', tool)}`, true);
  }

  // policy.yaml and identity.yaml: ./policyFile.ts checks them, against each other and the code.
  const check = {
    policy,
    identity: config.identity,
    files: { policy: 'policy.yaml', identity: 'identity.yaml' },
    locate,
    locateKey,
    tools,
    toolFields: Object.fromEntries(tools.map((tool) => [tool, declaredFields(code.tools?.[tool])])),
    toolParams: Object.fromEntries(tools.map((tool) => [tool, declaredParams(code.tools?.[tool])])),
    slotRedact: slotRedactOf(linked.slots),
    slotChoices: slotChoicesOf(linked.slots),
    slots: linked.known,
    addSlot,
    customRules: Object.keys(customRules),
    lookups: Array.isArray(code.lookups) ? code.lookups.filter((x): x is string => typeof x === 'string') : [],
    prompts: promptIds,
    confirms: Object.values(forms).some((form) => (form.hooks ?? []).includes('confirmedParams')),
    inCode,
    codePath,
  };
  problems.push(...policyProblems(check), ...identityProblems(check));
  for (const tool of tools) {
    for (const message of toolFieldProblems(code.tools?.[tool])) inTs(['tools', tool, 'fields'], `tool "${tool}": ${message}`, `make ${inCode('tools', tool, 'fields')} a list of the distinct fields of its result the policy may withhold`);
    for (const message of toolParamProblems(code.tools?.[tool])) inTs(['tools', tool, 'params'], `tool "${tool}": ${message}`, `make ${inCode('tools', tool, 'params')} a list of the distinct params its calls carry`);
  }
  const named = customRulesNamed(policy);
  for (const [id, rule] of Object.entries(customRules)) {
    if (isBuiltInRuleId(id)) inTs(['customRules', id], `custom rule "${id}" has a built-in rule's id`, `rename it in ${inCode('customRules', id)} and in policy.yaml's custom: rules; ${(BUILT_IN_RULES as readonly string[]).includes(id) ? `"${id}" is a built-in rule written by its name with its parameters` : BUILT_IN_IDS_NOTE}`);
    else if (typeof rule !== 'function') inTs(['customRules', id], `custom rule "${id}" is not a function`, `make ${inCode('customRules', id)} a function of the rule context`);
    else if (!named.has(id)) yaml('policy.yaml', ['actions'], `custom rule "${id}" (${codePath('customRules', id)}) is not named by any action's rules, so it never runs`, `add "- custom: ${id}" to the rules of the action it guards, or delete the rule from ${inCode('customRules', id)}`);
    else for (const { message, fix } of ruleDefinitionProblems(id, rule, inCode('customRules', id))) inTs(['customRules', id], message, fix);
  }
  if (code.lookups !== undefined && !Array.isArray(code.lookups)) inTs(['lookups'], 'lookups is not a list', `make ${inCode('lookups')} a list of the names of the gate's lookups the policy may call`);
  for (const { index, message } of lookupDeclarationProblems(Array.isArray(code.lookups) ? code.lookups : [])) {
    inTs(['lookups', String(index)], message, `name a function of the gate's lookups with a plain word of its own, in ${inCode('lookups')}`);
  }
  for (const [access, template] of Object.entries(policy.wording?.role ?? {})) {
    for (const [, name] of (template ?? '').matchAll(/\{([^}]*)\}/g)) {
      if (name !== 'role' && name !== 'tool') yaml('policy.yaml', ['wording', 'role', access], `the template names {${name}}; only {role} and {tool} are filled in`, `write {role} or {tool} in its place, or plain words`);
    }
  }

  if (config.identity) {
    const send = code.identity?.sendCodeParams;
    if (send !== undefined && typeof send !== 'function') inTs(['identity', 'sendCodeParams'], 'sendCodeParams is not a function', `make ${inCode('identity', 'sendCodeParams')} a function of the session`);
  } else if (code.identity !== undefined) {
    inTs(['identity'], 'the code has identity hooks, but the folder has no identity.yaml', `add identity.yaml (principals, levels and attempts, with the identity tools), or delete it from ${inCode('identity')}`);
  }

  // kb/: the tools the knowledge base reads through, their actions and fields, and the locales it speaks.
  if (config.knowledge) {
    problems.push(...kbLinkProblems(config.knowledge, {
      actions: new Set(Object.keys(policy.actions)),
      tools: Object.fromEntries(tools.map((tool) => [tool, declaredFields(code.tools?.[tool])])),
      locales: Object.keys(config.prompts),
      inCode,
    }, locate));
    const retriever = code.knowledge?.retriever;
    if (retriever !== undefined && (typeof retriever !== 'object' || retriever === null || typeof (retriever as { nominate?: unknown }).nominate !== 'function')) {
      inTs(['knowledge', 'retriever'], 'the knowledge retriever has no nominate function', `make ${inCode('knowledge', 'retriever')} an object with nominate({ text, locale, todayIso }), which returns the topics it nominates with their scores`);
    } else if (retriever !== undefined && (typeof retriever.id !== 'string' || retriever.id.trim() === '')) {
      inTs(['knowledge', 'retriever', 'id'], 'the knowledge retriever has no id', `give ${inCode('knowledge', 'retriever')} an id: its name in the trace, beside the topics it nominates`);
    }
  } else if (code.knowledge !== undefined) {
    inTs(['knowledge'], 'the code has a knowledge retriever, but the folder has no kb/', `add the knowledge base (kb/kb.yaml, kb/topics.yaml, kb/passages/), or delete it from ${inCode('knowledge')}`);
  }
  // forms.yaml's answers and intents.yaml's passages: what they name in the knowledge base, the policy and the code.
  problems.push(...knowledgeUseProblems(config, locate, { tools, inCode }));
  // A slot that reads nominated topics (a `topic` slot) needs something to nominate them: a kb/, whose
  // retriever is the code's or the engine's default (kb/hybrid.ts defaultRetriever). Without a kb/ it
  // would never ask, so check refuses it rather than let it sit silent.
  for (const [id, spec] of Object.entries(linked.slots)) {
    // core/knowledge.ts isTopicSlot, read here directly: that module reads the session's app.
    if (spec?.nominates !== true) continue;
    const at = (message: string, fix: string): void => {
      if (linked.library.has(id)) yaml(SLOTS_FILE, [id], message, fix, true);
      else inTs(['slots', id], message, fix);
    };
    if (!config.knowledge) {
      at(`the slot "${id}" asks about the topics retrieval nominates, but the app has no knowledge base (kb/), so it would never ask`, `add the knowledge base (kb/kb.yaml, kb/topics.yaml, kb/passages/), or give the slot another type`);
    }
  }

  // app.yaml
  const app = config.app;
  app.carrySlots?.forEach((slot, i) => slotExists('app.yaml', ['carrySlots', i], slot));
  // What a transfer hands the channel (handoff.data): every slot it names is one, and what it says
  // of each is something it can do (handoff/data.ts). An unknown slot gets the usual fix.
  const handoffData = app.handoff?.data as HandoffData | undefined;
  for (const p of handoffDataProblems(handoffData, linked.slots, config.identity?.levels[1].factors ?? [])) {
    const path: DataPath = ['handoff', 'data', ...p.path];
    if (p.unknownSlot !== undefined) slotExists('app.yaml', path, p.unknownSlot);
    else yaml('app.yaml', path, p.message, p.fix);
  }

  // Where each slot listens (SlotSpec.listen): written in slots.yaml for a library slot, on the
  // spec for the code's. An identity factor listens as identity.yaml says, so it takes none; a slot
  // app.yaml carries listens for the call (carrySlots is the shorthand), so it may say only that.
  const factors: readonly string[] = config.identity?.levels[1].factors ?? [];
  for (const [id, spec] of Object.entries(linked.slots)) {
    const listen = spec?.listen;
    if (listen === undefined) continue;
    const library = linked.library.has(id);
    const at = (message: string, fix: string): void => {
      if (library) yaml(SLOTS_FILE, [id, 'listen'], message, fix);
      else inTs(['slots', id, 'listen'], message, fix);
    };
    const deleteIt = library ? 'delete "listen"' : `delete "listen" from ${inCode('slots', id)}`;
    if (!library && !SLOT_LISTEN_VALUES.includes(listen)) {
      const guess = typeof listen === 'string' ? closest(listen, SLOT_LISTEN_VALUES) : undefined;
      at(`the slot "${id}" says listen: ${JSON.stringify(listen)}, which is not one of ${SLOT_LISTEN_VALUES.map((v) => `"${v}"`).join(', ')}`, guess ? `change it to "${guess}"` : `use one of ${SLOT_LISTEN_VALUES.map((v) => `"${v}"`).join(', ')}, or ${deleteIt} for "up-front"`);
    } else if (factors.includes(id)) {
      at(`the slot "${id}" is an identity factor (identity.yaml), which listens while the caller is still to be verified and stays for the call, so listen does not apply to it`, deleteIt);
    } else if (listen !== 'call' && app.carrySlots?.includes(id)) {
      at(`the slot "${id}" is in app.yaml's carrySlots, which keeps it for the whole call (listen: call), but it says listen: ${listen}`, `${deleteIt} (carrySlots already makes it call), or take "${id}" out of carrySlots in app.yaml`);
    }
  }
  // A slot that offers the number the caller is calling from (SlotSpec.callerNumber, a digits slot's
  // `callerNumber`) is never an identity factor: a caller ID can be forged, so it proves no one.
  for (const [id, spec] of Object.entries(linked.slots)) {
    if (spec?.callerNumber === undefined || !factors.includes(id)) continue;
    const message = `the slot "${id}" is an identity factor (identity.yaml), but it offers the number the caller is calling from (callerNumber): a caller ID can be forged, so it must never stand in for proving who the caller is`;
    if (linked.library.has(id)) yaml(SLOTS_FILE, [id, 'callerNumber'], message, `delete "callerNumber" here, or use a slot of its own for a callback number`);
    else inTs(['slots', id, 'callerNumber'], message, `delete callerNumber from ${inCode('slots', id)}, or use a slot of its own for a callback number`);
  }
  // A slot that proposes a value from the facts (SlotSpec.offer `facts`): never an identity factor
  // (a proposal is no proof), never beside the caller's number's offer on one slot, and only with
  // the call-start lookup that feeds it (app.yaml's callerNumber with a lookup) and the code that
  // proposes (code.facts.offers).
  for (const [id, spec] of Object.entries(linked.slots)) {
    const offer = spec?.offer;
    if (offer === undefined) continue;
    const library = linked.library.has(id);
    const at = (message: string, fix: string): void => {
      if (library) yaml(SLOTS_FILE, [id, 'offer'], message, fix);
      else inTs(['slots', id, 'offer'], message, fix);
    };
    const deleteIt = library ? 'delete "offer"' : `delete "offer" from ${inCode('slots', id)}`;
    if (offer !== 'facts') {
      at(`the slot "${id}" says offer: ${JSON.stringify(offer)}, which is not "facts"`, `change it to "facts", or ${deleteIt}`);
      continue;
    }
    if (factors.includes(id)) {
      at(`the slot "${id}" is an identity factor (identity.yaml), but it proposes a value from the facts (offer: facts): a proposal from a lookup by the number calling proves no one, so it must never stand in for a factor`, `${deleteIt}; the factors are always asked`);
      continue;
    }
    if (spec?.callerNumber !== undefined) {
      at(`the slot "${id}" offers both the number the caller is calling from (callerNumber) and a value from the facts (offer: facts), but a slot makes one offer`, `${deleteIt}, or delete "callerNumber"`);
    }
    if (app.callerNumber?.use !== 'hint' || app.callerNumber.lookup === undefined) {
      at(`the slot "${id}" proposes a value from the facts (offer: facts), but app.yaml has no callerNumber with a lookup, so nothing looks the caller up to propose from`, `add "callerNumber: { use: hint, lookup: <tool> }" to app.yaml, with the lookup's action in policy.yaml, or ${deleteIt}`);
    }
    if (code.facts?.offers === undefined) {
      at(`the slot "${id}" proposes a value from the facts (offer: facts), but the code has no facts.offers, so it never has a value to propose`, `add offers(f) to ${inCode('facts')}, returning { ${id}: { value, display } } from what the lookup kept, or ${deleteIt}`);
    }
  }
  // A slot that may be left empty (a callerNumber offer with onNo or ifNone: skip, SlotState.declined)
  // is never named in its form's summary line: the line would read an empty value. A form's summary
  // hook (onSummaryRead) may read another line that names it when it is filled.
  for (const [id, spec] of Object.entries(linked.slots)) {
    const offer = spec?.callerNumber;
    if (offer === undefined || (offer.onNo !== 'skip' && offer.ifNone !== 'skip')) continue;
    for (const [formId, form] of Object.entries(forms)) {
      const summary = form.summaryPromptId;
      if (!form.slots.includes(id) || summary === null || !has(prompts, summary)) continue;
      if (!prompts[summary]!.text.includes(`{${id}}`)) continue;
      yaml('prompts.yaml', ['prompts', summary, 'text'], `the summary of the form "${formId}" names {${id}}, but the slot may be left empty (its callerNumber says ${offer.onNo === 'skip' ? 'onNo' : 'ifNone'}: skip), so the line would read nothing there`, `take {${id}} out of "${summary}", and read it back from a line of its own when it is filled (the form's onSummaryRead hook can return that line's promptId)`);
    }
  }
  // app.yaml's callerNumber: the call-start lookup is an action of the policy, a tool called with one
  // param, the number (lookup: its params are exactly [callerNumber]).
  const lookup = app.callerNumber?.lookup;
  if (lookup !== undefined) {
    const actions = Object.keys(policy.actions);
    if (!has(policy.actions, lookup)) {
      yaml('app.yaml', ['callerNumber', 'lookup'], `the call-start lookup "${lookup}" is not an action in policy.yaml`, `${renameHint(lookup, actions)}add "${lookup}:" under actions in policy.yaml with its level and rules, and the tool to ${inCode('tools', lookup)}`);
    } else if (policy.actions[lookup]!.check === true) {
      yaml('app.yaml', ['callerNumber', 'lookup'], `the call-start lookup "${lookup}" is a check (check: true in policy.yaml), which runs nothing, so it returns nothing to look up`, `name an action with a tool, or delete "lookup"`);
    }
    const params = has(code.tools, lookup) ? code.tools[lookup]!.params : undefined;
    if (params !== undefined && !(params.length === 1 && params[0] === 'callerNumber')) {
      inTs(['tools', lookup, 'params'], `the tool "${lookup}" is the call-start lookup (app.yaml's callerNumber.lookup), which is called with one param, callerNumber, but it lists ${params.length === 0 ? 'none' : params.join(', ')}`, `make ${inCode('tools', lookup, 'params')} ["callerNumber"]`);
    }
  }
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

  // app.yaml: what the console and the clip generator name, which nothing else would notice is wrong
  const formIds = Object.keys(forms);
  const shown = app.console;
  for (const id of Object.keys(shown?.formLabels ?? {})) {
    if (!has(forms, id)) yaml('app.yaml', ['console', 'formLabels', id], `form "${id}" has a label, but forms.yaml has no form "${id}"`, `${renameHint(id, formIds)}delete the label`, true);
  }
  const slotNamed = (path: DataPath, slot: string, what: string, atKey = false): void => {
    if (!linked.known.has(slot)) yaml('app.yaml', path, `slot "${slot}" ${what}, but ${config.slots ? 'the app' : 'the code'} defines no slot "${slot}"`, `${renameHint(slot, slots)}delete it, or ${config.slots ? addSlot(slot) : `add the slot to ${inCode('slots', slot)}`}`, atKey);
  };
  for (const slot of Object.keys(shown?.slotLabels ?? {})) slotNamed(['console', 'slotLabels', slot], slot, 'has a label', true);
  shown?.slotOrder?.forEach((slot, i) => slotNamed(['console', 'slotOrder', i], slot, 'is in the console\'s slot order'));
  for (const slot of Object.keys(shown?.questionPrefixes ?? {})) slotNamed(['console', 'questionPrefixes', slot], slot, 'has question prefixes', true);
  shown?.facts?.forEach((fact, i) => {
    if (fact.kind === 'lookup' && !has(code.tools, fact.tool)) {
      yaml('app.yaml', ['console', 'facts', i, 'tool'], `the console fact names the tool "${fact.tool}", which the code does not define`, `${renameHint(fact.tool, tools)}name a tool in ${inCode('tools')}`);
    }
    if (fact.kind === 'answer' && fact.topicSlot !== undefined) slotNamed(['console', 'facts', i, 'topicSlot'], fact.topicSlot, 'is a console fact\'s topic');
  });
  const vocabulary = app.prompts?.vocabulary ?? [];
  const clipIds = vocabulary.map((v) => v.id);
  const promptVars = new Set(Object.values(prompts).flatMap((p) => [...p.text.matchAll(VAR)].map((m) => m[1]!)));
  vocabulary.forEach((entry, i) => {
    if (clipIds.indexOf(entry.id) !== i) yaml('app.yaml', ['prompts', 'vocabulary', i, 'id'], `vocabulary id "${entry.id}" is used twice`, 'give each clip its own id');
    entry.vars.forEach((name, j) => {
      if (!promptVars.has(name)) yaml('app.yaml', ['prompts', 'vocabulary', i, 'vars', j], `the clip "${entry.id}" plays for {${name}}, but no line in prompts.yaml has {${name}}`, `${renameHint(name, [...promptVars])}delete it`);
    });
  });
  for (const id of Object.keys(app.prompts?.tags ?? {})) {
    if (!clipIds.includes(id)) {
      yaml('app.yaml', ['prompts', 'tags', id], `the voice tag for "${id}" names no clip: the tags are keyed by the vocabulary's clip ids`, `${renameHint(id, clipIds)}delete it, or add "${id}" to prompts.vocabulary`, true);
    }
  }

  // app.yaml's voice: every locale it names is one the app speaks, and every carrier one the engine knows.
  for (const [number, tag] of Object.entries(app.voice?.numbers ?? {})) localeNamed('app.yaml', ['voice', 'numbers', number], tag);
  for (const [tag, settings] of Object.entries(app.voice?.locales ?? {})) {
    localeNamed('app.yaml', ['voice', 'locales', tag], tag, true);
    for (const key of ['voices', 'recognition'] as const) {
      for (const provider of Object.keys(settings[key] ?? {})) {
        if (!(VOICE_PROVIDER_IDS as readonly string[]).includes(provider)) {
          yaml('app.yaml', ['voice', 'locales', tag, key, provider], `unknown voice provider "${provider}"`, `${renameHint(provider, VOICE_PROVIDER_IDS)}use ${orList(VOICE_PROVIDER_IDS)}`, true);
        }
      }
    }
    // Only Twilio names a voice's TTS provider apart from the voice: another carrier's voice name carries it.
    for (const [provider, v] of Object.entries(settings.voices ?? {})) {
      if (typeof v === 'string' || provider === 'twilio' || !(VOICE_PROVIDER_IDS as readonly string[]).includes(provider)) continue;
      yaml('app.yaml', ['voice', 'locales', tag, 'voices', provider], `a ${provider} voice names its provider in its own name; only a Twilio voice takes { voice, provider }`, `write the voice name alone, like ${provider}: ${v.voice}`, true);
    }
  }

  // The code alone
  for (const [id, spec] of Object.entries(code.slots ?? {})) {
    if (spec?.id !== id) inTs(['slots', id], `the slot spec filed under "${id}" has the id "${String(spec?.id)}"`, `file it under ${codePath('slots', String(spec?.id))}, or give it the id "${id}"`);
  }
  // The question ids a slot declares (SlotSpec.questionIds): none the engine asks, none another slot declares.
  for (const clash of declaredQuestionIdClashes(linked.slots)) {
    if (linked.library.has(clash.slot)) {
      // A library slot's own clashes are found as it is built; this is one with another slot's.
      yaml(SLOTS_FILE, [clash.slot], clashMessage(clash), `give one of the two questions another id (a library type's \`ids\` option renames its questions), or rename one of the slots`, true);
      continue;
    }
    const where = inCode('slots', clash.slot, 'questionIds');
    const own = `${clash.slot}${clash.id.charAt(0).toUpperCase()}${clash.id.slice(1)}`;
    const fix = clash.with === 'twice'
      ? `list it once in ${where}`
      : `give the question an id of the slot's own, such as "${own}", in the slot's questions and in ${where}`;
    inTs(['slots', clash.slot, 'questionIds'], clashMessage(clash), fix);
  }

  // The question ids a slot asks, tried on a few made-up turns: none the engine asks, none another
  // slot asks or declares, and none its own questionIds leave out.
  const locales = Object.keys(config.prompts).length > 1 ? Object.keys(config.prompts) : [];
  const asked = askedQuestionIds(linked.slots, probeContexts(locales, app.thresholds ?? {}));
  for (const clash of askedQuestionIdClashes(linked.slots, asked)) {
    const own = `${clash.slot}${clash.id.charAt(0).toUpperCase()}${clash.id.slice(1)}`;
    if (linked.library.has(clash.slot)) {
      yaml(SLOTS_FILE, [clash.slot], clashMessage(clash), `give one of the two questions another id (a library type's \`ids\` option renames its questions), or rename one of the slots`, true);
      continue;
    }
    const fix = clash.with === 'undeclared'
      ? `add "${clash.id}" to ${inCode('slots', clash.slot, 'questionIds')}, or stop asking it`
      : `give the question an id of the slot's own, such as "${own}", in the slot's questions${linked.slots[clash.slot]?.questionIds ? ` and in ${inCode('slots', clash.slot, 'questionIds')}` : ''}`;
    inTs(clash.with === 'undeclared' ? ['slots', clash.slot, 'questionIds'] : ['slots', clash.slot], clashMessage(clash), fix);
  }

  // The thresholds a slot's options name (SlotSpec.thresholds): each the engine's or one app.yaml names.
  for (const u of unknownSlotThresholds(linked.slots, app.thresholds)) {
    const known = thresholdNamesOf(app.thresholds);
    const message = unknownThresholdMessage(u);
    const rename = renameHint(u.name, known);
    if (linked.library.has(u.slot)) {
      const config = (linked.slots[u.slot] as LibrarySlotSpec).config;
      const at = pathsOfValue(config, u.name);
      for (const path of at.length > 0 ? at : [[]]) yaml(SLOTS_FILE, [u.slot, ...path], message, `${rename}add "${u.name}" under thresholds in app.yaml`);
    } else {
      inTs(['slots', u.slot, 'thresholds'], message, `${rename}add "${u.name}" under thresholds in app.yaml`);
    }
  }

  return sortProblems(problems, codeFile);
}

/** Where in an options object (as it was written) a string value `value` stands: every path to it, in order. */
function pathsOfValue(config: unknown, value: string, path: DataPath = []): DataPath[] {
  if (config === value) return [path];
  if (Array.isArray(config)) return config.flatMap((item, i) => pathsOfValue(item, value, [...path, i]));
  if (typeof config === 'object' && config !== null) return Object.entries(config).flatMap(([key, item]) => pathsOfValue(item, value, [...path, key]));
  return [];
}

/** Problems by file (in the folder's file order, the code's file last), then position. */
function sortProblems(problems: readonly Problem[], codeFile: string): Problem[] {
  const order: string[] = [...FOLDER_FILES, codeFile];
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
function buildApp(config: LoadedConfig, code: AppCode, slots: Record<SlotId, SlotSpec>): App {
  const a = config.app;
  const app: Partial<App> = {
    id: a.id,
    intents: Object.fromEntries(Object.entries(config.intents.intents).map(([id, def]) => [id, intentOf(def)])),
    menu: config.intents.menu.map(({ digit, intent }) => ({ digit, intent })),
    forms: Object.fromEntries(Object.entries(config.forms.forms).map(([id, form]) => [id, formOf(form, code.forms?.[id])])),
    slots,
  };
  // identity.yaml's attempts are the policy's: what the attempts rule holds an identity check to.
  const compiled = config.identity ? compileIdentity(config.identity, code.identity?.sendCodeParams ? { sendCodeParams: code.identity.sendCodeParams } : {}) : null;
  if (compiled) app.identity = compiled.identity;
  app.tools = code.tools;
  app.policy = compilePolicy(config.policy, { ...(compiled ? { maxAttempts: compiled.maxAttempts } : {}), ...(code.customRules !== undefined ? { customRules: code.customRules } : {}) });
  put(app, 'facts', code.facts);
  app.systems = code.systems;
  put(app, 'services', code.services);
  put(app, 'onServiceResult', code.onServiceResult);
  put(app, 'blockPromptId', code.blockPromptId);
  put(app, 'wording', a.wording as ModelWording | undefined);
  put(app, 'carrySlots', a.carrySlots);
  put(app, 'unsureIntent', a.unsureIntent);
  put(app, 'changeSlotWithValue', a.changeSlotWithValue);
  put(app, 'anythingElseSilence', a.anythingElseSilence);
  put(app, 'thresholds', a.thresholds);
  put(app, 'callerState', code.callerState);
  put(app, 'callerNumber', a.callerNumber === undefined ? undefined : callerNumberOf(a.callerNumber));
  put(app, 'callerOffer', code.callerOffer);
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
  // The knowledge base, with the code's retriever when it gives one, else the engine's default:
  // hybrid when kb.yaml names an embedder whose index and weights are there, else keywords alone.
  // A default that fell back to keywords although kb.yaml names an embedder is said, with the fix (../kb/fallback.ts).
  if (config.knowledge) {
    app.knowledge = { kb: config.knowledge, retriever: code.knowledge?.retriever ?? defaultRetriever(config.knowledge).retriever };
    warnFallback(app.knowledge.retriever, `app "${app.id}"`);
  }
  // The folder's content hashes: what the engine records on each call (call_started, the trace).
  app.configHashes = config.hashes;
  return app as App;
}

/** app.yaml's callerNumber as App.callerNumber carries it: `called` only when true. */
function callerNumberOf(c: NonNullable<AppYaml['callerNumber']>): CallerNumberUse {
  return { use: c.use, ...(c.called === true ? { called: true } : {}), ...(c.lookup !== undefined ? { lookup: c.lookup } : {}) };
}

function intentOf(def: LoadedConfig['intents']['intents'][string]): IntentDef {
  const intent: IntentDef = { criteria: def.criteria, label: def.label, kind: def.kind };
  put(intent, 'promptId', def.promptId);
  put(intent, 'passage', def.passage);
  put(intent, 'locale', def.locale);
  put(intent, 'unsure', def.unsure);
  put(intent, 'priority', def.priority);
  return intent;
}

/**
 * A form: its slots and summary from forms.yaml, then its hooks from the code, in the order
 * forms.yaml declares them. A form that answers from the knowledge base (`answers:`) has the
 * engine's completion (kb/answer.ts kbCompletion) in place of a `complete` hook.
 */
function formOf(form: LoadedConfig['forms']['forms'][string], hooks: FormHooks | undefined): FormDef {
  const def: Record<string, unknown> = { slots: form.slots, summaryPromptId: form.summaryPromptId };
  if (form.calls !== undefined) def.calls = form.calls;
  if (form.checks !== undefined && form.checks.length > 0) def.checks = form.checks.map(checkOf);
  if (form.checksPassed !== undefined) def.checksPassed = form.checksPassed;
  for (const hook of form.hooks ?? []) def[hook] = hooks?.[hook];
  if (form.answers) {
    const { slot, via, answer, unavailable } = form.answers;
    def.complete = kbCompletion({ slot, ...(via !== undefined ? { via } : {}), ...(answer !== undefined ? { answer } : {}), ...(unavailable !== undefined ? { unavailable } : {}) });
  }
  return def as unknown as FormDef;
}

/** A form's check as forms.yaml writes it, as FormDef carries it. */
function checkOf(check: NonNullable<LoadedConfig['forms']['forms'][string]['checks']>[number]): FormCheck {
  const on = check.on === undefined ? undefined : Object.fromEntries(Object.entries(check.on).map(([reason, o]) => {
    const outcome = { ...(o.say !== undefined ? { say: o.say } : {}), then: o.then, ...(o.reason !== undefined ? { reason: o.reason } : {}) } satisfies CheckOutcome;
    return [reason, outcome];
  }));
  return on === undefined ? { action: check.action, with: check.with } : { action: check.action, with: check.with, on };
}

function voiceOf(voice: NonNullable<AppYaml['voice']>): VoiceConfig {
  const config: { -readonly [K in keyof VoiceConfig]: VoiceConfig[K] } = {};
  put(config, 'hints', voice.hints);
  put(config, 'spokenDigits', voice.spokenDigits?.map(({ pattern, spell }) => ({ pattern: new RegExp(pattern, 'g'), spell })));
  put(config, 'pronounce', voice.pronounce);
  put(config, 'continueWithinMs', voice.continueWithinMs);
  put(config, 'numbers', voice.numbers);
  put(config, 'locales', voice.locales === undefined ? undefined : Object.fromEntries(Object.entries(voice.locales).map(([tag, l]) => {
    const one: { -readonly [K in keyof VoiceLocale]: VoiceLocale[K] } = {};
    put(one, 'tts', l.tts);
    put(one, 'transcription', l.transcription);
    put(one, 'voices', l.voices === undefined ? undefined : Object.fromEntries(Object.entries(l.voices).map(([provider, v]) => [provider, typeof v === 'string' ? v : { voice: v.voice, provider: v.provider }])));
    put(one, 'hints', l.hints);
    put(one, 'pronounce', l.pronounce);
    put(one, 'recognition', l.recognition === undefined ? undefined : Object.fromEntries(Object.entries(l.recognition).map(([provider, r]) => {
      const each: { -readonly [K in keyof Recognition]: Recognition[K] } = {};
      put(each, 'provider', r.provider);
      put(each, 'model', r.model);
      return [provider, each];
    })));
    return [tag, one];
  })));
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
