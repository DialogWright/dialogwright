import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { handoffPromptId } from '../prompts/render';
import { VAR } from '../prompts/segments';
import { CODE_FILE, codePath, crossLink, isAppDefinitionError, linkSlots, type AppCode } from './defineApp';
import { loadAppFolder, type LoadedConfig, type LoadResult } from './load';
import { DEFAULT_ACTION_LEVEL, DEFAULT_ROLE_PERSON_REASON, personReasons, readRule } from './policyFile';
import { WHOLE_FILE, closest, formatPath, type DataPath, type Problem } from './problems';
import { FILE_NAMES, FOLDER_FILES, SLOTS_FILE } from './schema/index';
import type { SlotSpec } from '../core/slots/types';
import { kbLinkProblems, kbStateProblems } from '../kb/rules';
import { withoutFallbackWarnings } from '../kb/fallback';
import { knowledgePromptReferences, knowledgeUseProblems, knowledgeUseStateProblems } from './knowledgeUse';
import { checkPromptReferences, checkWarnings } from './formChecks';

/**
 * `dialogwright check`: everything that can be wrong with an app folder, found in one pass.
 *
 * It runs the loader (./load.ts: every file against its schema), then, when the folder has an app
 * module it can import, every cross-check between the folder and the code (./defineApp.ts
 * crossLink: forms, hooks, slots, tools and policy rows, custom rules, identity tools, carried
 * slots, threshold names), and adds what only a check needs:
 *
 *  - every prompt an intent, a form, identity.yaml or app.yaml names exists in every locale the
 *    folder has (crossLink checks the default locale's when it runs; without the code, this does);
 *  - every prompt the engine itself says exists in every locale (ENGINE_PROMPTS below, and the
 *    lines it builds from a slot's id or a policy's reason: enginePrompts);
 *  - every line a slot declares (SlotSpec.prompts) exists in every locale, and uses only the
 *    variables the slot declares for it;
 *  - every line of another locale is a line prompts.yaml has, and uses no variable the
 *    prompts.yaml line lacks (the code fills the default line's variables, and no others);
 *  - every intent has examples in the app's corpus, when app.yaml names a fixtures directory;
 *  - the knowledge base, when the folder has a kb/ (../kb/rules.ts): what it names in policy.yaml
 *    (crossLink checks it against the code when it runs; without the code, this does against
 *    policy.yaml), and what changes with time and review: every passage approved and fresh, and a
 *    passage in force today for every topic and every combination of the applies domain;
 *  - the knowledge answers the folder says (./knowledgeUse.ts): a form's `answers:` and an
 *    informational intent's `passage:`, their lines in every locale, and the passage an intent
 *    says approved and fresh;
 *  - every prompt is `mode: fixed`: the schema allows no other mode, and refuses one with a message
 *    that says so (see the load tests), so there is nothing more to check here.
 *
 * The app module: `app.ts` (or `app.mts`, `app.js`, `app.mjs`) in the app folder, or, when the
 * folder has none, in its `src/` (an app whose folder is its package keeps its code there),
 * exporting the app's code parts as `code` (an AppCode), or as the default export. It may also call defineApp
 * itself, as the example app does, to be the app's build: a defineApp that throws an
 * AppDefinitionError at import is reported as the problems it carries. Importing needs a TypeScript
 * loader for an app.ts, which is how the `dialogwright` command runs (tsx); a folder with no app
 * module is checked as YAML only, and the check says so. Importing the module runs it: never check
 * a folder whose code you would not run.
 */

/**
 * A line the engine says: when it says it (for the message), and the variables it gives the line,
 * which are the only ones the line's text may use (read from where core/ says the line).
 */
export interface EngineLine {
  why: string;
  vars?: readonly string[];
}

/** A line the engine says by name in every app: its id, when it says it, and the variables it gives it. */
export const ENGINE_PROMPTS: Readonly<Record<string, EngineLine>> = {
  ask_intent: { why: 'it asks what the caller wants' },
  nomatch_open: { why: 'it did not understand the caller and asks again' },
  no_input: { why: 'the caller said nothing' },
  ack_intent: { why: 'it starts the form the caller asked for', vars: ['intentLabel'] },
  confirm_intent_explicit: { why: 'it checks which request the caller meant', vars: ['intentLabel'] },
  disambiguate_intent: { why: 'it asks which of two requests the caller meant', vars: ['a', 'b'] },
  ack_intent_then: { why: 'the caller asked for two things and it starts the first', vars: ['a', 'b'] },
  ack_queued: { why: 'the caller asked for a second thing mid-form and it is put in the queue', vars: ['intentLabel'] },
  bridge_next: { why: 'it moves from one form to the next queued one', vars: ['intentLabel'] },
  ack_frustration: { why: 'the caller is frustrated' },
  offer_transfer: { why: 'it offers to connect the caller to a person' },
  ack_declined: { why: 'the caller declined a read-back or the transfer offer' },
  system_slow_dtmf_hint: { why: 'a system is slow on a call with a keypad' },
  system_slow_chat: { why: 'a system is slow in a chat' },
  ask_change: { why: 'it asks which detail of a read-back to change' },
  confirm_dtmf: { why: 'it asks the caller to confirm on the keypad' },
  anything_else: { why: 'a form is done and it asks whether there is more' },
  goodbye: { why: 'a call ends' },
  goodbye_chat: { why: 'a chat ends' },
  screen_reprompt: { why: 'it declines something the caller said outside a form and steers back' },
  screen_reprompt_form: { why: 'it declines something the caller said in a form and steers back' },
  handoff_live_agent: { why: 'the caller asks for a person' },
  handoff_frustrated: { why: 'the caller is frustrated and is handed to a person' },
  handoff_max_attempts: { why: 'the caller was asked too many times and is handed to a person' },
  handoff_system_failure: { why: 'a system failed and the caller is handed to a person' },
  handoff_needs_human: { why: 'a request that needs a person is handed over' },
  handoff_security: { why: 'a caller who tried to manipulate the agent is handed to a person' },
};

/** A line the engine needs from this app: its id, when it says it, and the variables it gives it. */
export interface EngineNeed extends EngineLine {
  id: string;
}

/** What the engine says only when the app has the feature: the menu, identity, a portal. */
const MENU_PROMPT: EngineNeed = { id: 'nomatch_dtmf_menu', why: 'it offers the keypad menu after a caller was not understood' };
export const IDENTITY_PROMPTS: readonly EngineNeed[] = [
  { id: 'handoff_identity', why: 'a caller who could not be verified is handed to a person' },
  { id: 'identity_verified', why: 'the caller was verified', vars: ['first'] },
];
/** The one-time code's lines: only for a ladder with level 2 (a ladder of one rung has no code). */
export const CODE_PROMPTS: readonly EngineNeed[] = [
  { id: 'ask_otp', why: 'it asks for the one-time code', vars: ['phoneLast4'] },
  { id: 'ask_otp_spoken', why: 'the caller said the code instead of keying it' },
  { id: 'otp_spoken_reissued', why: 'the caller said the code and a new one is sent' },
  { id: 'otp_verified', why: 'the one-time code matched' },
  { id: 'otp_failed', why: 'the one-time code did not match' },
];
export const PORTAL_PROMPTS: readonly EngineNeed[] = [
  { id: 'signin_required', why: 'a chat caller must sign in to the portal' },
  { id: 'signin_reminder', why: 'a chat caller has not signed in yet' },
  { id: 'signin_thanks', why: 'a chat caller signed in', vars: ['first'] },
  { id: 'signin_ready', why: 'a chat caller signed in with nothing waiting' },
  { id: 'greeting_chat_signed_in', why: 'a chat opens for a signed-in subject', vars: ['first'] },
  { id: 'greeting_chat_delegate', why: 'a chat opens for someone acting for subjects', vars: ['first'] },
];

/** The role rule's NEEDS_HUMAN reason when policy.yaml names none: the gate's own (gate/lines.ts). */
export { DEFAULT_ROLE_PERSON_REASON };

/** The identity factors' slots, the line said after a failed match (with where it is named), and whether the ladder has the one-time code. */
function identityParts(config: LoadedConfig): { factors: readonly string[]; failedPromptId?: string; failedPath: DataPath; code: boolean } | null {
  const identity = config.identity;
  if (!identity) return null;
  const one = identity.levels[1];
  return { factors: one.factors, ...(one.failedPrompt === undefined ? {} : { failedPromptId: one.failedPrompt }), failedPath: ['levels', '1', 'failedPrompt'], code: identity.levels[2] !== undefined };
}

/**
 * The prompt ids the engine says for this app, each with when it says it: the fixed list, and the
 * ones it builds. For each slot a form or identity asks for (core/turn.ts, core/fia.ts,
 * core/decision.ts): `ask_<slot>` and `ask_<slot>_retry` always; with the code's slot spec,
 * `ask_<slot>_dtmf` when the spec has a keypad rung (`dtmf`) or reads every spoken value back
 * (`spokenConfirm: always`, whose declined or unanswered read-back goes to the keypad),
 * `confirm_<slot>` for that read-back, `ack_<slot>` when a spoken value may be acknowledged
 * (`spokenConfirm: by-confidence`), and the spec's `partialPromptId`. And the handoff line for the role rule's
 * reason, when a role's access to a tool is `person`. And every line a slot declares it can lead
 * the engine to say (SlotSpec.prompts: e.g. `disambiguate_<slot>`, a help prompt, a retryPromptId),
 * which only the code knows; a slot that declares none adds none.
 */
export function enginePrompts(config: LoadedConfig, code?: AppCode): EngineNeed[] {
  const greetings = config.app.prompts?.greetings;
  const needs: EngineNeed[] = [
    { id: greetings?.voice ?? 'greeting', why: 'a call opens' },
    { id: greetings?.chat ?? 'greeting_chat', why: 'a chat opens' },
    ...Object.entries(ENGINE_PROMPTS).map(([id, line]) => ({ id, ...line })),
  ];
  if (config.intents.menu.length > 0) needs.push(MENU_PROMPT);
  for (const slot of askedSlots(config)) {
    needs.push({ id: `ask_${slot}`, why: `it asks for the slot "${slot}"` });
    needs.push({ id: `ask_${slot}_retry`, why: `it asks for the slot "${slot}" again after an answer that missed` });
    const spec = code?.slots && Object.hasOwn(code.slots, slot) ? code.slots[slot] : undefined;
    if (!spec) continue;
    if (spec.dtmf !== undefined) {
      needs.push({ id: `ask_${slot}_dtmf`, why: `it asks for the slot "${slot}" on the keypad after spoken answers missed (its slot spec has dtmf)` });
    } else if (spec.spokenConfirm === 'always') {
      needs.push({ id: `ask_${slot}_dtmf`, why: `a read-back of the slot "${slot}" was declined or not answered, and it asks on the keypad (its slot spec's spokenConfirm is "always")` });
    }
    if (spec.spokenConfirm === 'always') needs.push({ id: `confirm_${slot}`, why: `it reads a spoken value of the slot "${slot}" back for a yes (its slot spec's spokenConfirm is "always")`, vars: [slot] });
    if (spec.spokenConfirm === 'by-confidence') needs.push({ id: `ack_${slot}`, why: `it acknowledges a value it heard for the slot "${slot}" (its slot spec's spokenConfirm is "by-confidence")`, vars: [slot] });
    if (typeof spec.partialPromptId === 'string') needs.push({ id: spec.partialPromptId, why: `it asks for the rest of a value the slot "${slot}" holds only part of (its slot spec's partialPromptId)` });
    for (const declared of spec.prompts ?? []) needs.push({ id: declared.id, why: `${declared.why} (the slot "${slot}" declares it in its prompts)`, ...(declared.vars && declared.vars.length > 0 ? { vars: declared.vars } : {}) });
    if (spec.offer === 'facts') needs.push({ id: `offer_${slot}`, why: `it proposes a value from the facts for the slot "${slot}", as a yes or no (its offer is "facts")`, vars: [slot] });
  }
  for (const reason of personReasons(config.policy)) {
    needs.push({ id: handoffPromptId(reason), why: `a role's access to a tool is "person" (a role rule in policy.yaml) and the call goes to a person for the reason "${reason}"` });
  }
  const identity = identityParts(config);
  if (identity) {
    needs.push(...IDENTITY_PROMPTS);
    if (identity.code) needs.push(...CODE_PROMPTS);
    needs.push({ id: identity.failedPromptId ?? 'identity_failed', why: 'the identity factors did not match' });
  }
  if (code?.portal) needs.push(...PORTAL_PROMPTS);
  const seen = new Set<string>();
  return needs.filter(({ id }) => !seen.has(id) && seen.add(id));
}

/** The slots a form or identity asks for, whose lines the engine says: each form's, then the identity factors. */
function askedSlots(config: LoadedConfig): Set<string> {
  const slots = new Set<string>(Object.values(config.forms.forms).flatMap((form) => form.slots));
  for (const slot of identityParts(config)?.factors ?? []) slots.add(slot);
  return slots;
}

/** The files an app's module may be, in the order they are looked for. */
export const APP_MODULES = ['app.ts', 'app.mts', 'app.js', 'app.mjs'] as const;

/** Where an app's module may be, from the app folder, in the order looked in: the folder, then its src/. */
export const APP_MODULE_PATHS: readonly string[] = [...APP_MODULES, ...APP_MODULES.map((name) => `src/${name}`)];

export interface CheckOptions {
  /** The app's code parts, when the caller has them: they are checked, and no app module is imported. */
  code?: AppCode;
  /** The directory app.yaml's `fixtures.dir` is relative to. Default: the nearest folder above the app folder with a package.json, else the working directory. */
  fixturesRoot?: string;
  /** The day the knowledge base must have a passage in force on, as an ISO date. Default: today (UTC). */
  todayIso?: string;
}

export interface CheckResult {
  problems: Problem[];
  /** Whether the folder was checked against the app's code: false when there was none to check. */
  codeChecked: boolean;
  /**
   * What is not wrong but likely a mistake: printed, never counted as a problem (the exit code is
   * the problems'). Absent when there is none. A form's checks (./formChecks.ts checkWarnings): an
   * `on` reason the check never refuses for, and a rule a check holds the caller to that the form's
   * write does not; a slot that offers the caller's number (callerNumberWarnings); and a priority
   * intent's correctsForm or the handoff's unconfirmed option with nothing to act on
   * (priorityHandoffWarnings).
   */
  warnings?: Problem[];
}

/** Every problem with the app folder `dir`: the loader's, the cross-checks against the code, and the checks above. */
export async function checkApp(dir: string, options: CheckOptions = {}): Promise<Problem[]> {
  return (await checkAppFully(dir, options)).problems;
}

/** checkApp, and whether the app's code was part of it. */
export async function checkAppFully(dir: string, options: CheckOptions = {}): Promise<CheckResult> {
  const loaded = loadAppFolder(dir);
  if (!loaded.config) return { problems: loaded.problems, codeChecked: false };
  const { config, locate } = loaded;

  const found = options.code ? { code: options.code } : await loadCode(dir);
  const codeFile = ('file' in found ? found.file : undefined) ?? CODE_FILE;
  const problems: Problem[] = [];
  const warnings: Problem[] = [];
  let code: AppCode | undefined;
  let linked = false;
  if ('problems' in found) {
    problems.push(...found.problems);
    linked = found.linked;
    // The module threw while it built the app with defineApp, which still says what code it was
    // given: the lines the engine needs because of that code are reported in this run too, not on
    // the next one, once these problems are fixed. Slots that do not link add nothing here; their
    // own problems are among the ones above.
    if (found.code) code = codeWithLinkedSlots(config, found.code, loaded.document, codeFile);
  } else if (found.code) {
    problems.push(...crossLink(config, found.code, locate, codeFile, loaded.locateKey, loaded.document));
    checkWarnings({
      config,
      report: (file, path, message, fix, atKey = false) => {
        const at = (atKey && loaded.locateKey ? loaded.locateKey(file, path) : locate(file, path)) ?? { line: 1, column: 1 };
        warnings.push({ file, line: at.line, column: at.column, path: formatPath(path), message, fix });
      },
    }, found.code.customRules ?? {});
    // The checks below read the slots' specs: the folder's library slots count as the code's.
    code = { ...found.code, slots: linkSlots(config, found.code, loaded.document, codeFile).slots };
    linked = true;
    callerNumberWarnings(config, code.slots ?? {}, (file, path, message, fix) => {
      const at = locate(file, path) ?? { line: 1, column: 1 };
      warnings.push({ file, line: at.line, column: at.column, path: formatPath(path), message, fix });
    }, codeFile);
    callerHintWarnings(config, code.slots ?? {}, (file, path, message, fix) => {
      const at = locate(file, path) ?? { line: 1, column: 1 };
      warnings.push({ file, line: at.line, column: at.column, path: formatPath(path), message, fix });
    });
  }
  priorityHandoffWarnings(config, (file, path, message, fix) => {
    const at = locate(file, path) ?? { line: 1, column: 1 };
    warnings.push({ file, line: at.line, column: at.column, path: formatPath(path), message, fix });
  });
  problems.push(...checkPrompts(config, locate, code, linked, codeFile));
  problems.push(...checkMenu(config, locate));
  problems.push(...checkDone(config, locate));
  problems.push(...checkCorpus(config, locate, dir, options.fixturesRoot));
  if (config.knowledge) {
    if (!linked) problems.push(...kbLinkProblems(config.knowledge, { actions: new Set(Object.keys(config.policy.actions)), locales: Object.keys(config.prompts) }, locate));
    problems.push(...kbStateProblems(config.knowledge, options.todayIso ?? new Date().toISOString().slice(0, 10), locate));
  }
  // Forms that answer from the knowledge base, and intents that say a passage: crossLink holds them
  // to the code when it ran; without it, to the folder alone. A passage an intent says must be fresh.
  if (!linked) problems.push(...knowledgeUseProblems(config, locate));
  problems.push(...knowledgeUseStateProblems(config, locate));
  const result: CheckResult = { problems: sortProblems(problems, codeFile), codeChecked: code !== undefined || linked };
  if (warnings.length > 0) result.warnings = sortProblems(warnings, codeFile);
  return result;
}

/**
 * The warnings for a priority switch's correction and the handoff's unconfirmed values: `correctsForm`
 * on an informational priority intent, which opens no form (the turn already fills the form in hand
 * as it is said), and `handoff.data.unconfirmed` marking or leaving out values when `slots: none`
 * sends none.
 */
function priorityHandoffWarnings(config: LoadedConfig, report: (file: string, path: DataPath, message: string, fix: string) => void): void {
  for (const [id, def] of Object.entries(config.intents.intents)) {
    const priority = def.priority;
    if (typeof priority !== 'object' || priority.correctsForm !== true || def.kind !== 'informational') continue;
    report('intents.yaml', ['intents', id, 'priority', 'correctsForm'], `the informational intent "${id}" says correctsForm, but it opens no form, so there is nothing to correct: what the turn says already fills the form in hand`, 'delete "correctsForm", or write priority: true');
  }
  const data = config.app.handoff?.data;
  const unconfirmed = data?.unconfirmed;
  if ((unconfirmed === 'mark' || unconfirmed === 'omit') && data?.slots === 'none') {
    report('app.yaml', ['handoff', 'data', 'unconfirmed'], `unconfirmed is ${unconfirmed}, but slots is none, so a transfer sends no value to ${unconfirmed === 'mark' ? 'mark' : 'leave out'}`, 'delete "unconfirmed", or name the slots that go');
  }
}

/**
 * The warnings for a slot that offers the number the caller is calling from (SlotSpec.callerNumber):
 * a form with the slot and no summary, where a yes would fill a number the caller never heard whole;
 * and a slot that listens for the call or is carried, which is offered once per form and, once
 * filled, not offered again.
 */
function callerNumberWarnings(config: LoadedConfig, slots: Readonly<Record<string, SlotSpec | undefined>>, report: (file: string, path: DataPath, message: string, fix: string) => void, codeFile: string): void {
  for (const [id, spec] of Object.entries(slots)) {
    if (spec?.callerNumber === undefined) continue;
    const library = config.slots !== null && Object.hasOwn(config.slots, id);
    const at = (message: string, fix: string): void => {
      if (library) report(SLOTS_FILE, [id, 'callerNumber'], message, fix);
      else report(codeFile, ['slots', id, 'callerNumber'], message, fix);
    };
    const forms = Object.entries(config.forms.forms).filter(([, form]) => form.slots.includes(id));
    const unread = forms.filter(([, form]) => form.summaryPromptId === null).map(([form]) => form);
    if (unread.length > 0) {
      at(`the slot "${id}" offers the number the caller is calling from, but ${unread.length === 1 ? 'the form' : 'the forms'} ${unread.map((f) => `"${f}"`).join(', ')} ${unread.length === 1 ? 'has' : 'have'} no summary, so a yes fills a number the caller only heard the last four digits of`, `give ${unread.length === 1 ? 'the form' : 'each form'} a summaryPromptId that reads {${id}} back, or delete "callerNumber"`);
    }
    if (spec.listen === 'call' || (config.app.carrySlots ?? []).includes(id)) {
      at(`the slot "${id}" offers the number the caller is calling from and is kept for the whole call, so it is offered once, in the first form that asks it; a later form uses the value kept`, `nothing to do if that is meant; otherwise give the slot listen: form or up-front`);
    }
  }
}

/**
 * The warnings for the number the caller is calling from as the app's code and its policy use it
 * (app.yaml's `callerNumber`, policy.yaml's callerNumber rule): a call-start lookup above level 0,
 * which the caller not yet proven can never run, so it is always refused; the lookup's param recorded
 * as it is (`audit: callerNumber: keep`); a callerNumber rule (else refuse) in an app that keeps no
 * caller's number, which then refuses every call; and a rule on a param that is no slot offering the
 * number and not `callerNumber` (the number as kept), which is compared digit for digit.
 */
function callerHintWarnings(config: LoadedConfig, slots: Readonly<Record<string, SlotSpec | undefined>>, report: (file: string, path: DataPath, message: string, fix: string) => void): void {
  const policy = config.policy;
  const block = config.app.callerNumber;
  const lookup = block?.lookup;
  if (lookup !== undefined && Object.hasOwn(policy.actions, lookup)) {
    const level = policy.actions[lookup]!.level ?? DEFAULT_ACTION_LEVEL;
    if (level > 0) report('policy.yaml', ['actions', lookup, ...(policy.actions[lookup]!.level !== undefined ? ['level'] : [])], `the action "${lookup}" is the call-start lookup (app.yaml's callerNumber.lookup), which runs before anyone is verified, but it needs level ${level}, so the gate always refuses it and nothing is looked up`, `set its level to 0, and return only what may be said before identity; or delete "lookup" and call it from a form after identity`);
  }
  if (lookup !== undefined && policy.audit?.callerNumber === 'keep') {
    report('policy.yaml', ['audit', 'callerNumber'], 'the call-start lookup\'s param, the number the caller is calling from, is recorded as it is (keep) in the trace, the console and the audit', 'write "callerNumber: last4" unless the whole number must be recorded');
  }
  const factors: readonly string[] = config.identity?.levels[1].factors ?? [];
  const offering = Object.entries(slots).filter(([id, spec]) => spec?.callerNumber !== undefined && !factors.includes(id)).map(([id]) => id);
  const keeps = block?.use === 'hint' || offering.length > 0;
  for (const [tool, action] of Object.entries(policy.actions)) {
    action.rules.forEach((entry, i) => {
      if (typeof entry !== 'object' || entry === null || !('callerNumber' in entry)) return;
      const rule = readRule(entry);
      if (rule.rule !== 'callerNumber') return;
      const path: DataPath = ['actions', tool, 'rules', i, 'callerNumber'];
      if (!keeps && rule.else !== 'confirmed') report('policy.yaml', path, `the callerNumber rule of "${tool}" holds "${rule.field}" to the number the caller is calling from, but the app keeps no caller's number (no callerNumber in app.yaml, and no slot that offers it), so the rule refuses every call`, 'add "callerNumber: { use: hint }" to app.yaml, or give the slot that takes the number a callerNumber offer');
      // A param named callerNumber is the number as the session keeps it (the lookup's param, callerOf(s).number): compared as it is meant to be.
      else if (keeps && !offering.includes(rule.field) && rule.field !== 'callerNumber') report('policy.yaml', [...path, 'field'], `"${rule.field}" is no slot that offers the caller's number, so the rule compares it with the number as the carrier sent it, digit for digit (+15555550142 is not 5555550142)`, `name the slot that offers the number (its value is the number as the slot holds it), or pass the number in that form`);
    });
  }
}

// ---------------------------------------------------------------------------------------------
// The app's code
// ---------------------------------------------------------------------------------------------

/**
 * What loadCode found: the code and the module's path from the app folder (none when there is no
 * module), or the problems importing it raised (with the code defineApp was given, when it says).
 */
type Found = { code?: AppCode; file?: string } | { problems: Problem[]; linked: boolean; file: string; code?: AppCode };

/** The code with the folder's library slots counted as its own, or the code as it is when they do not link. */
function codeWithLinkedSlots(config: LoadedConfig, code: AppCode, document: LoadResult['document'], codeFile: string): AppCode {
  try {
    return { ...code, slots: linkSlots(config, code, document, codeFile).slots };
  } catch {
    return code;
  }
}

/**
 * Imports the folder's app module and takes its `code` (or default) export. A module that throws
 * an AppDefinitionError while it is imported (it builds the app with defineApp) has already
 * cross-checked the folder, and its problems are the answer.
 */
async function loadCode(dir: string): Promise<Found> {
  const file = APP_MODULE_PATHS.find((path) => existsSync(join(dir, path)));
  if (!file) return {};
  let module: Record<string, unknown>;
  try {
    // Check is independent of the model cache: the app's default retriever falling back is not said here (../kb/fallback.ts).
    module = (await withoutFallbackWarnings(() => import(/* @vite-ignore */ pathToFileURL(resolve(dir, file)).href))) as Record<string, unknown>;
  } catch (error) {
    // By its brand, not instanceof: the module may have reached defineApp through another copy of this one.
    if (isAppDefinitionError(error) && error.problems.length > 0 && error.problems.every(isProblem)) {
      const code = typeof error.appCode === 'object' && error.appCode !== null ? (error.appCode as AppCode) : undefined;
      return { problems: [...error.problems], linked: true, file, ...(code ? { code } : {}) };
    }
    // The whole message, on one line: an error that lists several things must keep every one of them.
    const message = typeof (error as { message?: unknown } | null)?.message === 'string' ? oneLine((error as { message: string }).message) : String(error);
    return {
      problems: [{ file, line: 0, column: 0, path: WHOLE_FILE, message: `${file} could not be loaded (${message})`, fix: `run \`tsx ${file}\` in the app folder to see the full error; ${file} must import without running anything else` }],
      linked: false,
      file,
    };
  }
  const code = module.code ?? module.default;
  if (typeof code !== 'object' || code === null) {
    return {
      problems: [{ file, line: 0, column: 0, path: WHOLE_FILE, message: `${file} exports no app code: neither \`code\` nor a default export is an object`, fix: `in ${file}, write \`export const code: AppCode = { slots, tools, systems, forms }\` (AppCode is exported by "dialogwright")` }],
      linked: false,
      file,
    };
  }
  return { code: code as AppCode, file };
}

/** Whether a value has the shape of a Problem (what another copy of defineApp put in its error). */
function isProblem(p: unknown): p is Problem {
  if (typeof p !== 'object' || p === null) return false;
  const { file, line, column, path, message, fix } = p as Record<string, unknown>;
  return typeof file === 'string' && typeof line === 'number' && typeof column === 'number' && typeof path === 'string' && typeof message === 'string' && typeof fix === 'string';
}

/** A message of several lines as one: each line trimmed, joined with " / ". */
const oneLine = (message: string): string => message.split('\n').map((l) => l.trim()).filter((l) => l !== '').join(' / ');

// ---------------------------------------------------------------------------------------------
// The keypad menu: every key does something
// ---------------------------------------------------------------------------------------------

/**
 * A key of the keypad menu starts a form, plays an informational intent's line, or (`agent`) goes to
 * a person: core/turn.ts takes no other key on the menu, so a key for another control intent is
 * ignored and the caller hears nothing. A menu entry that names no intent at all is crossLink's to report.
 */
function checkMenu(config: LoadedConfig, locate: LoadResult['locate']): Problem[] {
  const { intents, menu } = config.intents;
  const problems: Problem[] = [];
  menu.forEach(({ digit, intent }, i) => {
    const def = Object.hasOwn(intents, intent) ? intents[intent] : undefined;
    if (!def || def.kind !== 'control' || intent === 'agent') return;
    const path: DataPath = ['menu', i, 'intent'];
    const at = locate('intents.yaml', path) ?? { line: 0, column: 0 };
    problems.push({
      file: 'intents.yaml',
      line: at.line,
      column: at.column,
      path: formatPath(path),
      message: `menu digit "${digit}" names "${intent}", a control intent: a key on the menu starts a form, plays an informational line or (agent) goes to a person, and any other key is ignored, so a caller who presses ${digit} hears nothing`,
      fix: `take digit "${digit}" off the menu (and out of the nomatch_dtmf_menu line); a caller still asks for "${intent}" in words`,
    });
  });
  return problems;
}

// ---------------------------------------------------------------------------------------------
// "Anything else?": a caller who is done is understood
// ---------------------------------------------------------------------------------------------

/**
 * The `done` intent, as a line to paste under `intents:` in intents.yaml: the criteria name the
 * ways a caller says they are finished, a bare no to "anything else?" among them.
 */
export const DONE_INTENT_YAML =
  'done: { criteria: "Says they are finished and need nothing more, as in no thanks, that\'s all, I\'m all set, nothing else, I don\'t need anything else, or goodbye, including a bare no when just asked whether there is anything else", label: finish up, kind: control }';

/**
 * An app that asks "anything else?" (the engine's `anything_else` line, said when a form is done:
 * core/turn.ts finishForm) understands the caller who answers that they are done only through the
 * `done` control intent: `done` ends the call with the goodbye (core/turn.ts, the route verdict and
 * the confirmed intent). Without it, "no, that's all" is no intent the app knows, so the caller hears
 * the no-match line and then the keypad menu. The engine treats `done` as optional, so an app without
 * it still loads; this is a problem for `check`, so CI fails until the intent is there.
 */
function checkDone(config: LoadedConfig, locate: LoadResult['locate']): Problem[] {
  const prompts = config.prompts[config.defaultLocale] ?? {};
  if (!has(prompts, 'anything_else') || has(config.intents.intents, 'done')) return [];
  const at = locate('intents.yaml', ['intents']) ?? { line: 1, column: 1 };
  const corpus = config.app.fixtures ? ` in ${config.app.fixtures.dir.replace(/\/+$/, '')}/corpus.jsonl` : '';
  return [{
    file: 'intents.yaml',
    line: at.line,
    column: at.column,
    path: formatPath(['intents']),
    message: 'the app asks whether there is anything else (the line "anything_else", said when a form is done) but has no "done" intent, so a caller who answers "no, that\'s all" is not understood: they hear the no-match line instead of the goodbye, then the keypad menu or a person',
    fix: `add under intents: ${DONE_INTENT_YAML}; then give it corpus lines${corpus}, such as {"id":"dn-01","text":"no, that's all","intent":"done","context":"anything_else"} (the anything_else context needs testing.seed.anythingElse; "no_form" otherwise)`,
  }];
}

// ---------------------------------------------------------------------------------------------
// Prompts: every reference and every line the engine says, in every locale
// ---------------------------------------------------------------------------------------------

/** One place a prompt id is named: where, and the data path there. */
interface Reference {
  id: string;
  file: string;
  path: DataPath;
}

function referencesOf(config: LoadedConfig): Reference[] {
  const refs: Reference[] = [];
  for (const [id, def] of Object.entries(config.intents.intents)) {
    if (def.promptId !== undefined) refs.push({ id: def.promptId, file: 'intents.yaml', path: ['intents', id, 'promptId'] });
  }
  for (const [id, form] of Object.entries(config.forms.forms)) {
    if (form.summaryPromptId !== null) refs.push({ id: form.summaryPromptId, file: 'forms.yaml', path: ['forms', id, 'summaryPromptId'] });
  }
  // The lines a form's checks say: each outcome's line, each handoff's, and checksPassed (./formChecks.ts).
  for (const ref of checkPromptReferences(config)) refs.push(ref);
  // The lines a knowledge answer is said through: a form's answers (kb_answer and kb_unavailable, or its own) and an intent's passage.
  for (const { id, file, path } of knowledgePromptReferences(config)) refs.push({ id, file, path });
  const identity = identityParts(config);
  if (identity?.failedPromptId !== undefined) refs.push({ id: identity.failedPromptId, file: 'identity.yaml', path: identity.failedPath });
  for (const [which, id] of Object.entries(config.app.prompts?.greetings ?? {})) {
    if (id !== undefined) refs.push({ id, file: 'app.yaml', path: ['prompts', 'greetings', which] });
  }
  return refs;
}

const promptsFile = (locale: string, config: LoadedConfig): string => (locale === config.defaultLocale ? FILE_NAMES.prompts : `locale/${locale}/prompts.yaml`);

/**
 * The prompts a locale lacks. `linked` says crossLink has already checked the references against
 * the default locale's prompts, so those are not reported twice.
 */
function checkPrompts(config: LoadedConfig, locate: LoadResult['locate'], code: AppCode | undefined, linked: boolean, codeFile: string = CODE_FILE): Problem[] {
  const problems: Problem[] = [];
  const refs = referencesOf(config);
  const engine = enginePrompts(config, code);
  // A line prompts.yaml lacks that the engine or the YAML names is reported missing there, not as a translation of nothing.
  const needed = new Set([...refs.map((r) => r.id), ...engine.map((e) => e.id)]);
  for (const [locale, prompts] of Object.entries(config.prompts)) {
    const file = promptsFile(locale, config);
    const at = locate(file, ['prompts']) ?? { line: 1, column: 1 };
    // A rename is offered only from a line nothing else needs: renaming a needed one would lose it.
    const known = Object.keys(prompts).filter((id) => !needed.has(id));
    const where = locale === config.defaultLocale ? file : `the ${locale} prompts`;
    const missing = (id: string, why: string, vars: readonly string[] = []): void => {
      const near = closest(id, known);
      // The variables the engine gives the line: the only ones its text may use.
      const given = vars.map((v) => `{${v}}`).join(', ');
      problems.push({
        file,
        line: at.line,
        column: at.column,
        path: formatPath(['prompts']),
        message: `prompt "${id}" is missing from ${where}; ${why}${given ? `, and gives it ${given}` : ''}`,
        fix: `${near ? `rename "${near}" to "${id}" if that is the line, or ` : ''}add "${id}:" with its text${given ? ` (it may use ${given})` : ''} and interruptible to ${file}`,
      });
    };
    const reported = new Set<string>();
    for (const ref of refs) {
      if (has(prompts, ref.id) || reported.has(ref.id)) continue;
      reported.add(ref.id);
      if (locale === config.defaultLocale && linked) continue;
      const line = locate(ref.file, ref.path)?.line;
      missing(ref.id, `${ref.file}${line ? `:${line}` : ''} (${formatPath(ref.path)}) says it`);
    }
    for (const { id, why, vars } of engine) {
      if (!has(prompts, id) && !reported.has(id)) missing(id, `the engine says it when ${why}`, vars);
    }
    problems.push(...checkSlotPromptVariables(config, locale, prompts, file, locate, code, codeFile));
    problems.push(...checkFactsOfferLines(config, locale, prompts, file, locate, code));
    if (locale !== config.defaultLocale) problems.push(...checkTranslation(config, locale, prompts, file, locate, needed));
  }
  return problems;
}

/**
 * The line of a slot that proposes a value from the facts (`offer_<slot>`, its offer `facts`), in
 * each locale that has it: it says the value proposed, `{<slot>}`, so a yes is to a value the caller
 * heard, and it is given nothing else, so a line that uses another fails when it is said.
 */
function checkFactsOfferLines(
  config: LoadedConfig,
  locale: string,
  prompts: LoadedConfig['prompts'][string],
  file: string,
  locate: LoadResult['locate'],
  code: AppCode | undefined,
): Problem[] {
  const problems: Problem[] = [];
  for (const slot of askedSlots(config)) {
    const spec = code?.slots && Object.hasOwn(code.slots, slot) ? code.slots[slot] : undefined;
    const id = `offer_${slot}`;
    if (spec?.offer !== 'facts' || !has(prompts, id)) continue;
    const used = variablesOf(prompts[id]!.text);
    const extra = used.filter((name) => name !== slot);
    const line = locale === config.defaultLocale ? `the line "${id}"` : `the ${locale} line "${id}"`;
    const at = locate(file, ['prompts', id, 'text']) ?? { line: 1, column: 1 };
    const path = formatPath(['prompts', id, 'text']);
    if (!used.includes(slot)) {
      problems.push({ file, ...at, path, message: `${line} proposes a value for the slot "${slot}" but does not say it ({${slot}}), so a yes would fill a value the caller never heard`, fix: `say {${slot}} in the line ("Is this about {${slot}}?")` });
    }
    if (extra.length > 0) {
      problems.push({ file, ...at, path, message: `${line} uses ${extra.map((name) => `{${name}}`).join(', ')}, which the engine does not give it (it gives a proposal only {${slot}}), so saying it would fail`, fix: `use only {${slot}} in this line` });
    }
  }
  return problems;
}

/**
 * The lines a slot declares (SlotSpec.prompts) against the variables it says it gives them: a line
 * that uses another fails when it is said, in whichever locale has it.
 */
function checkSlotPromptVariables(
  config: LoadedConfig,
  locale: string,
  prompts: LoadedConfig['prompts'][string],
  file: string,
  locate: LoadResult['locate'],
  code: AppCode | undefined,
  codeFile: string,
): Problem[] {
  const problems: Problem[] = [];
  const reported = new Set<string>();
  for (const slot of askedSlots(config)) {
    const spec = code?.slots && Object.hasOwn(code.slots, slot) ? code.slots[slot] : undefined;
    for (const { id, vars } of spec?.prompts ?? []) {
      if (!has(prompts, id) || reported.has(id)) continue;
      const allowed = vars ?? [];
      const extra = variablesOf(prompts[id]!.text).filter((name) => !allowed.includes(name));
      if (extra.length === 0) continue;
      reported.add(id);
      const at = locate(file, ['prompts', id, 'text']) ?? { line: 1, column: 1 };
      const names = extra.map((name) => `{${name}}`).join(', ');
      const given = allowed.length > 0 ? allowed.map((name) => `{${name}}`).join(', ') : 'no variables';
      const line = locale === config.defaultLocale ? `the line "${id}"` : `the ${locale} line "${id}"`;
      problems.push({
        file,
        ...at,
        path: formatPath(['prompts', id, 'text']),
        message: `${line} uses ${names}, which the slot "${slot}" does not give it (its prompts declare ${given} for this line), so saying it would fail`,
        fix: `${allowed.length > 0 ? `use only ${given} in this line (check the spelling)` : 'write this line without variables'}, or add ${extra.map((name) => `"${name}"`).join(', ')} to the vars of "${id}" in ${codeFile} (${codePath('slots', slot, 'prompts')}) if the slot gives ${extra.length === 1 ? 'it' : 'them'}`,
      });
    }
  }
  return problems;
}


/** The variables a line's text uses, in order, each once. */
function variablesOf(text: string): string[] {
  return [...new Set([...text.matchAll(VAR)].map((m) => m[1]!))];
}

/**
 * A locale's lines against the default's: a line only the locale has is never said (the engine and
 * the code name lines by the default's ids; one the engine or the YAML needs is reported missing from
 * prompts.yaml instead), and a line that uses a variable the default line lacks fails when it is
 * said (the code passes the default line's variables, and no others).
 */
function checkTranslation(
  config: LoadedConfig,
  locale: string,
  prompts: LoadedConfig['prompts'][string],
  file: string,
  locate: LoadResult['locate'],
  needed: ReadonlySet<string>,
): Problem[] {
  const problems: Problem[] = [];
  const defaults = config.prompts[config.defaultLocale] ?? {};
  const ids = Object.keys(defaults);
  for (const [id, line] of Object.entries(prompts)) {
    if (!has(defaults, id)) {
      if (needed.has(id)) continue;
      const at = locate(file, ['prompts', id]) ?? { line: 1, column: 1 };
      const near = closest(id, ids.filter((known) => !has(prompts, known)));
      // A misspelt line the engine or the YAML needs is reported missing, with this rename as its fix.
      if (near !== undefined && needed.has(near)) continue;
      problems.push({
        file,
        ...at,
        path: formatPath(['prompts', id]),
        message: `prompt "${id}" is in the ${locale} prompts but not in ${FILE_NAMES.prompts}, so it is never said`,
        fix: near ? `rename it to "${near}" if it is that line, or delete it` : `add "${id}:" to ${FILE_NAMES.prompts} if the app says it, or delete it here`,
      });
      continue;
    }
    const allowed = variablesOf(defaults[id]!.text);
    const extra = variablesOf(line.text).filter((name) => !allowed.includes(name));
    if (extra.length === 0) continue;
    const at = locate(file, ['prompts', id, 'text']) ?? { line: 1, column: 1 };
    const names = extra.map((name) => `{${name}}`).join(', ');
    problems.push({
      file,
      ...at,
      path: formatPath(['prompts', id, 'text']),
      message: `the ${locale} line "${id}" uses ${names}, which the ${FILE_NAMES.prompts} line does not, so saying it would fail: the line is given only the variables the ${FILE_NAMES.prompts} line has`,
      fix: allowed.length > 0
        ? `use only ${allowed.map((name) => `{${name}}`).join(', ')} in this line (check the spelling), or add ${names} to the ${FILE_NAMES.prompts} line and to the code that says it`
        : `write this line without variables, as the ${FILE_NAMES.prompts} line has none, or add ${names} to the ${FILE_NAMES.prompts} line and to the code that says it`,
    });
  }
  return problems;
}

const has = (obj: object, key: string): boolean => Object.hasOwn(obj, key);

// ---------------------------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------------------------

/**
 * The folder app.yaml's fixtures `dir` is relative to: the app's package, which is the nearest
 * folder above the app folder that has a package.json. The engine reads the directory relative to
 * the working directory (run/fixtures.ts), and an app's commands (its regress, cli and serve
 * scripts) run in its package, so the two are the same folder.
 */
function packageRootOf(dir: string): string {
  for (let at = resolve(dir); ; at = dirname(at)) {
    if (existsSync(join(at, 'package.json'))) return at;
    if (dirname(at) === at) return process.cwd();
  }
}

/** A corpus bigger than this is refused rather than read: it is a list of labelled sentences, and reading it is bounded by size. */
export const MAX_CORPUS_BYTES = 16 * 1024 * 1024;

/** Whether `child` is `parent` or inside it. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Every intent has a labelled example in the corpus, for an app whose app.yaml names a fixtures directory. */
function checkCorpus(config: LoadedConfig, locate: LoadResult['locate'], dir: string, fixturesRoot?: string): Problem[] {
  const fixtures = config.app.fixtures;
  if (!fixtures) return [];
  const corpus = `${fixtures.dir.replace(/\/+$/, '')}/corpus.jsonl`;
  const root = fixturesRoot ?? packageRootOf(dir);
  const absolute = resolve(root, corpus);
  const at = locate('app.yaml', ['fixtures', 'dir']) ?? { line: 1, column: 1 };
  const atDir = (message: string, fix: string): Problem[] => [{ file: 'app.yaml', line: at.line, column: at.column, path: 'fixtures.dir', message, fix }];
  if (!existsSync(absolute)) {
    return atDir(
      `the app has no corpus: ${corpus} does not exist (looked in ${absolute})`,
      `create ${corpus} with a line per labelled utterance, such as {"id":"hours-01","text":"when are you open","intent":"hours","context":"no_form"}, or point fixtures.dir at the folder that has it (it is relative to the package)`,
    );
  }
  // The schema refuses an absolute dir and one with "..", so only a link can lead out of the package.
  const real = realpathSync(absolute);
  if (!isInside(realpathSync(root), real)) {
    return atDir(`${corpus} resolves to ${real}, which is outside the app's package (${root})`, `keep the fixtures inside the package, and replace the link with the folder itself`);
  }
  const stat = statSync(real);
  if (!stat.isFile()) return atDir(`${corpus} is not a regular file`, `make ${corpus} a file with one JSON object per line`);
  if (stat.size > MAX_CORPUS_BYTES) {
    return atDir(`${corpus} is ${stat.size} bytes, over the ${MAX_CORPUS_BYTES} byte limit for a corpus`, 'keep the corpus to labelled sentences, one per line; split anything else out of it');
  }
  const problems: Problem[] = [];
  const file = relative(resolve(dir), absolute).split('\\').join('/');
  const counts = new Map<string, number>();
  readFileSync(real, 'utf8').split('\n').forEach((text, i) => {
    if (text.trim() === '') return;
    let entry: unknown;
    try {
      entry = JSON.parse(text);
    } catch {
      problems.push({ file, line: i + 1, column: 1, path: WHOLE_FILE, message: `line ${i + 1} is not JSON`, fix: 'write one JSON object per line: {"id":"...","text":"...","intent":"...","context":"no_form"}' });
      return;
    }
    const intent = (entry as { intent?: unknown } | null)?.intent;
    if (typeof intent !== 'string') {
      problems.push({ file, line: i + 1, column: 1, path: WHOLE_FILE, message: `line ${i + 1} has no "intent"`, fix: 'add "intent": "<an intent id from intents.yaml>" to the line' });
      return;
    }
    counts.set(intent, (counts.get(intent) ?? 0) + 1);
  });
  for (const id of Object.keys(config.intents.intents)) {
    if (counts.has(id)) continue;
    const where = locate('intents.yaml', ['intents', id]) ?? { line: 1, column: 1 };
    problems.push({
      file: 'intents.yaml',
      line: where.line,
      column: where.column,
      path: formatPath(['intents', id]),
      message: `intent "${id}" has no examples in the corpus (${corpus})`,
      fix: `add a line to ${corpus} such as {"id":"${id}-01","text":"<what a caller says to mean this>","intent":"${id}","context":"no_form"}`,
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------

/** Problems by file (the folder's files in their order, locale files, any other file, then the app module), then position. */
function sortProblems(problems: readonly Problem[], codeFile: string): Problem[] {
  const names: string[] = [...FOLDER_FILES];
  const rank = (file: string): number => {
    if (file === codeFile) return names.length + 2;
    const i = names.indexOf(file);
    if (i !== -1) return i;
    return file.startsWith('locale/') ? names.length : names.length + 1;
  };
  const seen = new Set<string>();
  return problems
    .filter((p) => {
      const key = JSON.stringify(p);
      return !seen.has(key) && seen.add(key);
    })
    .sort((a, b) => rank(a.file) - rank(b.file) || a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
}
