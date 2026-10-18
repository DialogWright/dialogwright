import { ROTATING_LINES, rotatesLine } from '../core/wordings';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { handoffPromptId } from '../prompts/render';
import { VAR } from '../prompts/segments';
import { CODE_FILE, codePath, crossLink, isAppDefinitionError, linkSlots, routesOf, routeWorldOf, routeYamlProblems, transferYamlProblems, type AppCode } from './defineApp';
import type { RouteRuleYaml } from './schema/index';
import { declaredFacts, ROUTE_HANDOFF_REASON, routeFormEdges, writtenOutcome } from '../core/routes';
import type { RoutePoint } from '../core/app/types';
import { slotOutcomeOf } from '../core/outcome';
import { loadAppFolder, type LoadedConfig, type LoadResult } from './load';
import { DEFAULT_ACTION_LEVEL, DEFAULT_ROLE_PERSON_REASON, personReasons, readRule } from './policyFile';
import { WHOLE_FILE, closest, formatPath, type DataPath, type Problem } from './problems';
import { FILE_NAMES, FOLDER_FILES, SLOTS_FILE } from './schema/index';
import type { SlotSpec } from '../core/slots/types';
import { handoffDataProblems } from '../handoff/data';
import { callDataSourceProblem } from '../channel/callData';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { CONSENT_PROMPT } from '../core/textConsent';
import { kbDocumentWarnings, kbLinkProblems, kbStateProblems } from '../kb/rules';
import { withoutFallbackWarnings } from '../kb/fallback';
import { knowledgePromptReferences, knowledgeUseProblems, knowledgeUseStateProblems } from './knowledgeUse';
import { checkPromptReferences, checkWarnings, provenLevel } from './formChecks';
import { moveCycles, slotOutcomeForm, slotOutcomesOf } from '../core/app/next';
import { digitsMayBeShort } from '../slots/digits/fill';
import { generatedWordingWarnings } from '../render/config';
import { scenarioGapProblems } from '../harness-text/scenarioGap';
import { bareSpeechTags, bareTagFinding, englishOnlyFinding, englishOnlyHearings, speechLocalesOfFolder } from '../channel/speechLanguages';

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
 *  - every scripted call's known gap (`knownGap` in fixtures/scenarios/*.json) has a reason and pins
 *    an end other than the call's own expectation;
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
/**
 * The caller-ID question's lines (identity.yaml's level 1 `callerId`): the question, said in place of
 * the first factor asked, which is given nothing (the match is never said). `identity_caller_declined`,
 * said before the factors are asked after a no or "different account", is optional: said where
 * prompts.yaml has it.
 */
export const CALLER_ID_PROMPTS: readonly EngineNeed[] = [
  { id: 'identity_caller_match', why: 'a call from a number matched to one account asks for the factors that verify it (identity.yaml callerId)' },
];
/** The optional line before the factors are asked, after a no or "different account" to the caller-ID question. */
export const CALLER_ID_DECLINED_PROMPT = 'identity_caller_declined';

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
 * (`spokenConfirm: always`, whose declined or unanswered read-back goes to the keypad, unless a no
 * asks the slot again: `readBackNo: ask`, as every library slot's does), `confirm_<slot>` for that
 * read-back or for one of its values (`confirmValues`), `ack_<slot>` when a spoken value may be acknowledged
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
    } else if (spec.spokenConfirm === 'always' && spec.readBackNo !== 'ask') {
      needs.push({ id: `ask_${slot}_dtmf`, why: `a read-back of the slot "${slot}" was declined or not answered, and it asks on the keypad (its slot spec's spokenConfirm is "always")` });
    } else if ((spec.confirmValues ?? []).length > 0 && spec.readBackNo !== 'ask') {
      needs.push({ id: `ask_${slot}_dtmf`, why: `a read-back of the slot "${slot}" was declined or not answered, and it asks on the keypad (its slot spec has confirmValues)` });
    }
    if (spec.spokenConfirm === 'always') needs.push({ id: `confirm_${slot}`, why: `it reads a spoken value of the slot "${slot}" back for a yes (its slot spec's spokenConfirm is "always")`, vars: [slot] });
    else if ((spec.confirmValues ?? []).length > 0) needs.push({ id: `confirm_${slot}`, why: `it reads the slot "${slot}" back for a yes when it is ${spec.confirmValues!.map((v) => `"${v}"`).join(' or ')} (its confirmValues)`, vars: [slot] });
    if (spec.spokenConfirm === 'by-confidence') needs.push({ id: `ack_${slot}`, why: `it acknowledges a value it heard for the slot "${slot}" (its slot spec's spokenConfirm is "by-confidence")`, vars: [slot] });
    if (typeof spec.partialPromptId === 'string') needs.push({ id: spec.partialPromptId, why: `it asks for the rest of a value the slot "${slot}" holds only part of (its slot spec's partialPromptId)` });
    for (const declared of spec.prompts ?? []) needs.push({ id: declared.id, why: `${declared.why} (the slot "${slot}" declares it in its prompts)`, ...(declared.vars && declared.vars.length > 0 ? { vars: declared.vars } : {}) });
    // A slot written in code that says a line when it runs out of attempts (SlotSpec.onMaxAttempts); a
    // library slot's are slots.yaml's references (referencesOf).
    const outcome = spec.onMaxAttempts;
    if (typeof outcome === 'object' && !isLibrary(config, slot)) {
      if (outcome.say !== undefined) needs.push({ id: outcome.say, why: `the slot "${slot}" runs out of attempts (its onMaxAttempts says it)` });
      if (outcome.then === 'handoff' && outcome.reason !== undefined) needs.push({ id: handoffPromptId(outcome.reason), why: `the slot "${slot}" runs out of attempts and the call goes to a person for the reason "${outcome.reason}" (its onMaxAttempts)` });
    }
    if (spec.offer === 'facts') needs.push({ id: `offer_${slot}`, why: `it proposes a value from the facts for the slot "${slot}", as a yes or no (its offer is "facts")`, vars: [slot] });
    if (spec.offer === 'facts' && spec.offerAt === 'greeting') {
      needs.push({ id: greetings?.offer ?? 'greeting_offer', why: `a call opens on a proposal for the slot "${slot}" (its offerAt is "greeting"), said in place of the greeting before offer_${slot}` });
      needs.push({ id: 'greet_after_offer', why: `the proposal at the greeting for the slot "${slot}" is settled, and it asks the open question` });
    }
  }
  // Consent to text for the whole call (app.yaml's textConsent): asked after the greeting's line before
  // a proposal, and the open question follows once it is settled, as for a proposal at the greeting.
  if (config.app.textConsent !== undefined) {
    needs.push({ id: greetings?.offer ?? 'greeting_offer', why: 'a call opens on the consent to text for the whole call (app.yaml textConsent), said in place of the greeting before consent_texts' });
    needs.push({ id: CONSENT_PROMPT, why: 'it asks consent to text for the whole call (app.yaml textConsent), by the last four digits of the number calling', vars: ['last4', 'callerNumber'] });
    needs.push({ id: 'greet_after_offer', why: 'the consent to text for the whole call is settled, and it asks the open question' });
  }
  // A start route that enters a form says the welcome first, the greeting's line before a proposal.
  const startRules = config.routes?.start ?? [];
  if (startRules.some((r) => writtenOutcome(r)?.outcome.then === 'form')) {
    needs.push({ id: greetings?.offer ?? 'greeting_offer', why: 'a start route (routes.yaml) enters a form as the call opens, said in place of the greeting before the form\'s first question' });
  }
  for (const reason of personReasons(config.policy)) {
    needs.push({ id: handoffPromptId(reason), why: `a role's access to a tool is "person" (a role rule in policy.yaml) and the call goes to a person for the reason "${reason}"` });
  }
  const identity = identityParts(config);
  if (identity) {
    needs.push(...IDENTITY_PROMPTS);
    if (identity.code) needs.push(...CODE_PROMPTS);
    needs.push({ id: identity.failedPromptId ?? 'identity_failed', why: 'the identity factors did not match' });
    const callerId = config.identity?.levels[1].callerId;
    if (callerId !== undefined) {
      needs.push(...CALLER_ID_PROMPTS);
      // Asked at the greeting, it is said after the greeting's line before a proposal, and the open
      // question follows once it is settled, as for a proposal at the greeting.
      if (callerId.ask === 'greeting') {
        needs.push({ id: greetings?.offer ?? 'greeting_offer', why: 'a call opens on the caller-ID question (identity.yaml callerId ask: greeting), said in place of the greeting before identity_caller_match' });
        needs.push({ id: 'greet_after_offer', why: 'the caller-ID question at the greeting is settled, and it asks the open question' });
      }
    }
  }
  if (code?.portal) needs.push(...PORTAL_PROMPTS);
  const seen = new Set<string>();
  return needs.filter(({ id }) => !seen.has(id) && seen.add(id));
}

/** Whether `slot` is a library slot of slots.yaml (any type but code). */
function isLibrary(config: LoadedConfig, slot: string): boolean {
  const raw = config.slots !== null && Object.hasOwn(config.slots, slot) ? (config.slots[slot] as { type?: unknown }) : undefined;
  return raw !== undefined && raw.type !== 'code';
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
   * write does not; a slot that offers the caller's number (callerNumberWarnings); a slot whose
   * `listen` says otherwise than every form that lists it (listenWarnings); and a priority
   * intent's correctsForm or the handoff's unconfirmed option with nothing to act on
   * (priorityHandoffWarnings); a short secret redacted by its last four (shortSecretWarnings); and a
   * check that reads a slot that may be skipped, or a numbered retry line a slot's ladder never
   * reaches (retryWarnings).
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
    greetingOfferWarnings(config, code.slots ?? {}, (file, path, message, fix) => {
      const at = locate(file, path) ?? { line: 1, column: 1 };
      warnings.push({ file, line: at.line, column: at.column, path: formatPath(path), message, fix });
    }, codeFile);
    listenWarnings(config, code.slots ?? {}, (file, path, message, fix) => {
      const at = locate(file, path) ?? { line: 1, column: 1 };
      warnings.push({ file, line: at.line, column: at.column, path: formatPath(path), message, fix });
    }, codeFile);
    retryWarnings(config, code.slots ?? {}, (file, path, message, fix) => {
      const at = file === codeFile ? { line: 0, column: 0 } : (locate(file, path) ?? { line: 1, column: 1 });
      warnings.push({ file, line: at.line, column: at.column, path: file === codeFile ? codePath(...path.map(String)) : formatPath(path), message, fix });
    }, codeFile);
    callerHintWarnings(config, code.slots ?? {}, (file, path, message, fix) => {
      const at = locate(file, path) ?? { line: 1, column: 1 };
      warnings.push({ file, line: at.line, column: at.column, path: formatPath(path), message, fix });
    });
    routeWarnings(config, found.code, Object.keys(code.slots ?? {}), (file, path, message, fix) => {
      const at = locate(file, path) ?? { line: 1, column: 1 };
      warnings.push({ file, line: at.line, column: at.column, path: formatPath(path), message, fix });
    });
  }
  textConsentWarnings(config, (file, path, message, fix) => {
    const at = locate(file, path) ?? { line: 1, column: 1 };
    warnings.push({ file, line: at.line, column: at.column, path: formatPath(path), message, fix });
  });
  transferWarnings(config, (file, path, message, fix) => {
    const at = locate(file, path) ?? { line: 1, column: 1 };
    warnings.push({ file, line: at.line, column: at.column, path: formatPath(path), message, fix });
  });
  callDataWarnings(config, (file, path, message, fix) => {
    const at = locate(file, path) ?? { line: 1, column: 1 };
    warnings.push({ file, line: at.line, column: at.column, path: formatPath(path), message, fix });
  });
  handoffDataWarnings(config, code?.slots ?? {}, (file, path, message, fix) => {
    const at = locate(file, path) ?? { line: 1, column: 1 };
    warnings.push({ file, line: at.line, column: at.column, path: formatPath(path), message, fix });
  });
  priorityHandoffWarnings(config, (file, path, message, fix) => {
    const at = locate(file, path) ?? { line: 1, column: 1 };
    warnings.push({ file, line: at.line, column: at.column, path: formatPath(path), message, fix });
  });
  dictationWarnings(config, (file, path, message, fix) => {
    const at = locate(file, path) ?? { line: 1, column: 1 };
    warnings.push({ file, line: at.line, column: at.column, path: formatPath(path), message, fix });
  });
  telnyxVoiceWarnings(config, (file, path, message, fix) => {
    const at = locate(file, path) ?? { line: 1, column: 1 };
    warnings.push({ file, line: at.line, column: at.column, path: formatPath(path), message, fix });
  });
  localeLabelWarnings(config, (file, path, message, fix) => {
    const at = locate(file, path) ?? { line: 1, column: 1 };
    warnings.push({ file, line: at.line, column: at.column, path: formatPath(path), message, fix });
  });
  speechLanguageWarnings(config, (file, path, message, fix) => {
    const at = locate(file, path) ?? { line: 1, column: 1 };
    warnings.push({ file, line: at.line, column: at.column, path: formatPath(path), message, fix });
  });
  shortSecretWarnings(config, (file, path, message, fix) => {
    const at = locate(file, path) ?? { line: 1, column: 1 };
    warnings.push({ file, line: at.line, column: at.column, path: formatPath(path), message, fix });
  });
  goodbyeTwiceWarnings(config, (file, path, message, fix) => {
    const at = locate(file, path) ?? { line: 1, column: 1 };
    warnings.push({ file, line: at.line, column: at.column, path: formatPath(path), message, fix });
  });
  menuKeyWarnings(config, (file, path, message, fix) => {
    const at = locate(file, path) ?? { line: 1, column: 1 };
    warnings.push({ file, line: at.line, column: at.column, path: formatPath(path), message, fix });
  });
  // A line generated whole from what the caller said: the framed form is the pattern (render/config.ts).
  const redacted = Object.fromEntries(Object.entries(code?.slots ?? {}).flatMap(([id, spec]) => (spec?.redact !== undefined ? [[id, spec.redact]] : [])));
  const summarized = new Set(Object.entries(code?.slots ?? {}).flatMap(([id, spec]) => (spec?.summarized === true ? [id] : [])));
  const nameSlots = new Set(Object.entries(code?.slots ?? {}).flatMap(([id, spec]) => ((spec as { type?: unknown } | undefined)?.type === 'name' ? [id] : [])));
  for (const w of generatedWordingWarnings({ prompts: config.prompts[config.defaultLocale] ?? {}, forms: config.forms.forms, localePrompts: Object.fromEntries(Object.entries(config.prompts).filter(([locale]) => locale !== config.defaultLocale)), redacted, summarized, defaultLocale: config.defaultLocale, nameSlots, style: config.style, ...(config.knowledge ? { kbTopics: config.knowledge.topics } : {}) })) {
    const at = (w.atKey === true && loaded.locateKey ? loaded.locateKey(w.file, w.path) : locate(w.file, w.path)) ?? { line: 1, column: 1 };
    warnings.push({ file: w.file, line: at.line, column: at.column, path: formatPath(w.path), message: w.message, fix: w.fix });
  }
  problems.push(...checkPrompts(config, locate, code, linked, codeFile));
  problems.push(...checkMenu(config, locate));
  problems.push(...checkDone(config, locate));
  problems.push(...checkLocaleLabels(config, loaded.locateKey ?? locate));
  problems.push(...checkCorpus(config, locate, dir, options.fixturesRoot));
  problems.push(...checkScenarioGaps(config, dir, options.fixturesRoot));
  if (config.knowledge) {
    if (!linked) problems.push(...kbLinkProblems(config.knowledge, { actions: new Set(Object.keys(config.policy.actions)), locales: Object.keys(config.prompts) }, locate));
    problems.push(...kbStateProblems(config.knowledge, options.todayIso ?? new Date().toISOString().slice(0, 10), locate));
    for (const w of kbDocumentWarnings(config.knowledge)) {
      const at = locate(w.file, w.path) ?? { line: 1, column: 1 };
      warnings.push({ file: w.file, line: at.line, column: at.column, path: formatPath(w.path), message: w.message, fix: w.fix });
    }
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
 * The warning for a priority intent a dictation does not hear (live findings item 29): an app that marks
 * an intent priority, and a `text` slot of slots.yaml without `pick` in one of its forms that says no
 * `commands`, so the turn at its question is its words, whole (`ignore`, the default), and an emergency
 * said there is read back as the words. A warning, never a refusal: the app may mean it (the secretary
 * does); saying `commands` either way quiets it.
 */
function dictationWarnings(config: LoadedConfig, report: (file: string, path: DataPath, message: string, fix: string) => void): void {
  const priority = Object.entries(config.intents.intents).filter(([, def]) => def.priority !== undefined && def.priority !== false && def.kind !== 'control').map(([id]) => id);
  if (priority.length === 0 || config.slots === null) return;
  const inForms = new Set(Object.values(config.forms.forms).flatMap((form) => form.slots));
  const factors = new Set(identityParts(config)?.factors ?? []);
  for (const [id, raw] of Object.entries(config.slots)) {
    const slot = raw as { type?: unknown; pick?: unknown; commands?: unknown };
    if (slot.type !== 'text' || slot.pick !== undefined || slot.commands !== undefined || !inForms.has(id) || factors.has(id)) continue;
    const named = priority.map((p) => `"${p}"`).join(', ');
    report(SLOTS_FILE, [id], `the turn at the question of "${id}" is its words, whole (commands: ignore, the default for a text slot without pick), so the priority ${priority.length === 1 ? 'intent' : 'intents'} ${named} said there ${priority.length === 1 ? 'is' : 'are'} read back as the words, never acted on`, `add "commands: { listen: [${[...priority, 'agent'].join(', ')}] }" to hear ${priority.length === 1 ? 'it' : 'them'} (and a request for a person) there, or "commands: ignore" if that is meant`);
  }
}

/**
 * The warnings for app.yaml's transfer (core/transfer.ts): a reason no handoff has a line for (the
 * condition never holds), a rule after one that always holds (never taken), a constant that looks like a
 * misspelled reference, and a header the carrier reserves. Warnings, never refusals: each may be meant.
 */
function transferWarnings(config: LoadedConfig, report: (file: string, path: DataPath, message: string, fix: string) => void): void {
  const transfer = config.app.transfer;
  if (transfer === undefined) return;
  const prompts = config.prompts[config.defaultLocale] ?? {};
  const world = {
    ...routeWorldOf(config, Object.keys(config.slots ?? {}), null),
    hasReasonLine: (reason: string) => Object.hasOwn(prompts, handoffPromptId(reason)),
  };
  for (const p of transferYamlProblems(transfer, world)) if (p.warning) report('app.yaml', p.path, p.message, p.fix);
}

/**
 * The warnings for app.yaml's callData (channel/callData.ts callDataSourceProblem): a key that reads the
 * caller's or the called number from the carrier's own field (callerOf(s) and calledOf(s) already read
 * them), and a setup field no carrier documents (the wire passes it through when a carrier sends it).
 * Warnings, never refusals: each may be meant.
 */
function callDataWarnings(config: LoadedConfig, report: (file: string, path: DataPath, message: string, fix: string) => void): void {
  const ignoresWithheld = config.app.callerNumber?.withheld === 'ignore';
  for (const [key, def] of Object.entries(config.app.callData ?? {})) {
    const problem = callDataSourceProblem(def.from);
    if (problem?.warning === true) report('app.yaml', ['callData', key, 'from'], problem.message, problem.fix);
    // The app's own read of the caller's number is never dropped: with withheld: ignore it still carries a withheld one.
    if (ignoresWithheld && CALLER_NUMBER_SOURCES.includes(def.from)) {
      report('app.yaml', ['callData', key, 'from'], `callerNumber.withheld is ignore, but the call data key "${key}" reads the caller's number from "${def.from}", which carries a number the caller withheld as it came: to a transfer that sends it, a route or a transfer rule that reads it, and the app's code`, `keep it if the app means to have the number whatever the caller chose; otherwise take the key out, or test callerOf(s)?.withheld in the code that uses it`);
    }
  }
}

/** The call data sources that carry the caller's own number, whatever the carrier calls them. */
const CALLER_NUMBER_SOURCES: readonly string[] = ['setup.from', 'param.telnyx_call_from', 'webhook.From', 'webhook.Caller'];

/**
 * The warnings for app.yaml's handoff.data (handoff/data.ts handoffDataProblems): a secret held by its
 * length (a PIN) that the app sends as it is (`send: as-is`), which hands the carrier and the person
 * taking the call its digits. Warnings, never refusals: the app may mean it.
 */
function handoffDataWarnings(config: LoadedConfig, slots: Readonly<Record<string, SlotSpec | undefined>>, report: (file: string, path: DataPath, message: string, fix: string) => void): void {
  const data = config.app.handoff?.data;
  for (const p of handoffDataProblems(data, slots, config.identity?.levels[1].factors ?? [])) {
    if (p.warning === true) report('app.yaml', ['handoff', 'data', ...p.path], p.message, p.fix);
  }
}

/** The level a form needs before it can go on: its entry's purpose, and the levels of the actions it calls and checks. */
function formNeed(config: LoadedConfig, form: string): number {
  const actions = config.policy.actions;
  const levelOf = (tool: string): number => (Object.hasOwn(actions, tool) ? (actions[tool]!.level ?? DEFAULT_ACTION_LEVEL) : 0);
  const def = config.forms.forms[form];
  if (def === undefined) return 0;
  return Math.max(provenLevel(config, form), ...(def.calls ?? []).map(levelOf), ...(def.checks ?? []).map((c) => levelOf(c.action)));
}

/**
 * The warnings for routes.yaml (core/routes.ts), never refusals: a rule after one that always holds; a
 * fact the code's facts do not start with (a hook may add it); and a route into a form that needs an
 * identity level the point cannot have reached (start: none; afterIdentity: level 1), where the form
 * will ask for it.
 */
function routeWarnings(config: LoadedConfig, code: AppCode | undefined, slots: readonly string[], report: (file: string, path: DataPath, message: string, fix: string) => void): void {
  const routes = config.routes;
  if (routes === null) return;
  const facts = declaredFacts(code?.facts);
  const predicates = typeof code?.predicates === 'object' && code.predicates !== null ? Object.keys(code.predicates) : null;
  for (const p of routeYamlProblems(routes, { ...routeWorldOf(config, slots, predicates), facts })) if (p.warning) report('routes.yaml', p.path, p.message, p.fix);
  const reached: [RoutePoint, readonly RouteRuleYaml[] | undefined, number][] = [['start', routes.start, 0], ['afterIdentity', routes.afterIdentity, 1]];
  for (const [point, rules, level] of reached) {
    (rules ?? []).forEach((rule, i) => {
      const w = writtenOutcome(rule);
      const written = w?.outcome;
      if (w === null || written?.then !== 'form' || written.form === undefined || !Object.hasOwn(config.forms.forms, written.form)) return;
      const need = formNeed(config, written.form);
      if (need <= level) return;
      const path: DataPath = [point, i, ...w.at, 'form'];
      report('routes.yaml', path, `the route enters "${written.form}", which needs identity level ${need}, and at ${point} the caller is at level ${level}: the form will ask for it first`, 'nothing to do if that is meant; otherwise route to it after identity (afterIdentity), or to a form the caller can use now');
    });
  }
}

/**
 * The warnings for an ending's goodbye (`then: end`: a route's, a check's, a library slot's
 * onMaxAttempts), never refusals, the line's words being the app's. A line ends "as the goodbye does"
 * when it ends with the last sentence of the goodbye line ("Goodbye." of "Thanks for calling. Goodbye.")
 * or of the chat's (goodbye_chat), in any locale.
 * - Such a line with the goodbye after it (no `goodbye: false`): the caller hears goodbye twice. At
 *   `start` the fix is `goodbye: false`; anywhere else a request may be queued, and then the line is said
 *   and the call goes on to it, so the fix is first to take the goodbye out of the line.
 * - Such a line with `goodbye: false` anywhere but `start`: with a request queued, the call goes on after
 *   it, and the caller hears goodbye mid-call.
 * The goodbye lines themselves (goodbye, goodbye_chat) are never warned of.
 */
function goodbyeTwiceWarnings(config: LoadedConfig, report: (file: string, path: DataPath, message: string, fix: string) => void): void {
  const endings: { file: string; path: DataPath; say: string; own: boolean; queueable: boolean }[] = [];
  const ending = (o: unknown, file: string, path: DataPath, queueable: boolean): void => {
    const { then, say, goodbye } = (typeof o === 'object' && o !== null ? o : {}) as { then?: unknown; say?: unknown; goodbye?: unknown };
    if (then === 'end' && typeof say === 'string' && say !== 'goodbye' && say !== 'goodbye_chat') endings.push({ file, path, say, own: goodbye === false, queueable });
  };
  const lists: [DataPath, readonly RouteRuleYaml[]][] = [];
  if (config.routes?.start) lists.push([['start'], config.routes.start]);
  if (config.routes?.afterIdentity) lists.push([['afterIdentity'], config.routes.afterIdentity]);
  for (const [form, rules] of Object.entries(config.routes?.afterForm ?? {})) lists.push([['afterForm', form], rules]);
  for (const [at, rules] of lists) {
    rules.forEach((rule, i) => {
      const w = writtenOutcome(rule);
      // Nothing has been asked at start, so no request can be queued there.
      if (w !== null) ending(w.outcome, 'routes.yaml', [...at, i, ...w.at], at[0] !== 'start');
    });
  }
  for (const [id, form] of Object.entries(config.forms.forms)) {
    (form.checks ?? []).forEach((check, i) => {
      for (const [reason, o] of Object.entries(check.on ?? {})) ending(o, 'forms.yaml', ['forms', id, 'checks', i, 'on', reason], true);
    });
  }
  for (const [id, raw] of Object.entries(config.slots ?? {})) ending((raw as { onMaxAttempts?: unknown }).onMaxAttempts, SLOTS_FILE, [id, 'onMaxAttempts'], true);
  const defaults = config.prompts[config.defaultLocale] ?? {};
  for (const e of endings) {
    for (const prompts of Object.values(config.prompts)) {
      const line = (prompts[e.say] ?? defaults[e.say])?.text;
      const goodbye = ['goodbye', 'goodbye_chat'].map((id) => (prompts[id] ?? defaults[id])?.text).find((g) => line !== undefined && g !== undefined && endsAsGoodbye(line, g));
      if (goodbye === undefined) continue;
      const said = lastSentence(goodbye);
      if (!e.own) {
        report(e.file, [...e.path, 'say'], `the line "${e.say}" ends the call with a goodbye of its own ("${said}"), and the goodbye line follows it: the caller hears goodbye twice`,
          e.queueable
            ? 'take the goodbye out of the line: with a request queued, the line is said and the call goes on to it, so it must read right mid-call too; only where that cannot happen, add "goodbye: false" instead'
            : 'add "goodbye: false" to this outcome, so the call ends on its line alone; or take the goodbye out of the line');
      } else if (e.queueable) {
        report(e.file, [...e.path, 'goodbye'], `the line "${e.say}" says goodbye itself ("${said}"), and with a request queued the call goes on after it, so the caller hears goodbye mid-call`,
          'take the goodbye out of the line and delete "goodbye: false": the goodbye then follows the line only when the call ends there');
      }
      break;
    }
  }
}

/** A line's words, lowercased, its punctuation dropped: what two lines are compared by. */
const wordsOfLine = (text: string): string[] => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter((w) => w !== '');

/** The last sentence of a line ("Goodbye." of "Thanks for calling. Goodbye."), as written. */
const lastSentence = (text: string): string => text.trim().split(/(?<=[.!?])\s+/).filter((t) => t.trim() !== '').at(-1)?.trim() ?? text.trim();

/** Whether `line` ends with the goodbye line's last sentence, word for word. */
function endsAsGoodbye(line: string, goodbye: string): boolean {
  const tail = wordsOfLine(lastSentence(goodbye));
  const words = wordsOfLine(line);
  return tail.length > 0 && words.length >= tail.length && tail.every((w, i) => words[words.length - tail.length + i] === w);
}

/**
 * The warning for a short secret: a library `digits` slot that can be four digits or fewer (its
 * `length`, or a `mask` that lets it; digitsMayBeShort), redacted by its last four (`redact: last4`,
 * the default), which would be all of it. The engine records such a value as bullets (SHORT_MASK)
 * anyway; the warning points to `redact: length`, which records how many digits it has. A warning,
 * never a refusal: the app decides.
 */
function shortSecretWarnings(config: LoadedConfig, report: (file: string, path: DataPath, message: string, fix: string) => void): void {
  if (config.slots === null) return;
  const factors = new Set(config.identity?.levels[1].factors ?? []);
  for (const [id, raw] of Object.entries(config.slots)) {
    const o = raw as { type: string; length?: unknown; mask?: unknown; redact?: unknown };
    if (o.type !== 'digits' || (o.redact !== undefined && o.redact !== 'last4')) continue;
    const length = typeof o.length === 'number' ? o.length : undefined;
    const mask = typeof o.mask === 'string' ? o.mask : undefined;
    let short: boolean;
    try {
      short = digitsMayBeShort({ length, mask });
    } catch {
      continue; // A mask that is no pattern is the slot's own problem.
    }
    if (!short) continue;
    const by = length !== undefined ? `length: ${length}` : `mask: ${mask}`;
    const what = factors.has(id) ? `is an identity factor of 4 digits or fewer (${by})` : `can be 4 digits or fewer (${by})`;
    report(
      SLOTS_FILE,
      o.redact !== undefined ? [id, 'redact'] : [id],
      `the slot "${id}" ${what}, and redact: last4 shows a value by its last four digits, which would be all of it, so it is recorded as bullets (••••)`,
      'set "redact: length" to record it by its length (<4 chars>), or ask a longer number; nothing to do if bullets are meant',
    );
  }
}

/**
 * The warnings for a slot's retries (SlotSpec.attempts, onMaxAttempts; core/outcome.ts), never refusals:
 * a form's check that reads a slot that may be skipped (its onMaxAttempts, or its callerNumber's onNo or
 * ifNone), which then never runs; and a numbered retry or no-input line (`ask_<slot>_retry<k>`,
 * `ask_<slot>_noinput<k>`) the slot's ladder never reaches: a re-ask is failure 1 to attempts - 1; forms
 * that send each other round in a loop through an outcome (moveCycles); and an identity factor whose
 * outcome enters a form that needs identity, which would ask the factor again.
 */
function retryWarnings(config: LoadedConfig, slots: Readonly<Record<string, SlotSpec | undefined>>, report: (file: string, path: DataPath, message: string, fix: string) => void, codeFile: string = CODE_FILE): void {
  const skippable = (spec: SlotSpec | undefined): string | null => {
    if (spec === undefined) return null;
    if (slotOutcomeOf(spec).then === 'skip') return 'its onMaxAttempts skips it';
    if (spec.callerNumber?.onNo === 'skip') return 'its callerNumber says onNo: skip';
    if (spec.callerNumber?.ifNone === 'skip') return 'its callerNumber says ifNone: skip';
    return null;
  };
  for (const [id, form] of Object.entries(config.forms.forms)) {
    (form.checks ?? []).forEach((check, i) => {
      check.with.forEach((slot, j) => {
        const why = Object.hasOwn(slots, slot) ? skippable(slots[slot]) : null;
        if (why === null) return;
        report('forms.yaml', ['forms', id, 'checks', i, 'with', j], `check "${check.action}" reads "${slot}", which may be left empty (${why}), and a check runs only once every slot it reads holds a value, so it never runs then`, 'nothing to do if the form may go on unchecked without it; otherwise check a slot that is never skipped, or hand off when it runs out');
      });
    });
  }
  // Forms that send each other round in a loop by outcomes (and next): meant, perhaps, where each pass
  // reads other values; the engine sends a caller who goes round it within one turn to a person.
  const forms = config.forms.forms;
  const outcomes = slotOutcomesOf(slots);
  const routeEdges = config.routes === null ? undefined : routeFormEdges(routesOf(config.routes));
  for (const loop of moveCycles(forms, outcomes, routeEdges)) {
    const byRoute = routeEdges !== undefined && loop.some((from, i) => (routeEdges[from] ?? []).includes(loop[(i + 1) % loop.length]!));
    if (byRoute) report('routes.yaml', ['afterForm', loop.find((from, i) => (routeEdges![from] ?? []).includes(loop[(i + 1) % loop.length]!))!], `the forms go round in a loop by routes after a form (then: form), their outcomes and next: ${[...loop, loop[0]!].join(' -> ')}, so a caller can be sent round it, and one sent round it within one turn goes to a person (needs-human)`, 'nothing to do if each pass reads values the caller can change; otherwise end the loop: send one of the routes to a form outside it, or go on (continue)');
    else report('forms.yaml', ['forms', loop[0]!], `the forms go round in a loop by their outcomes (then: form) and next: ${[...loop, loop[0]!].join(' -> ')}, so a caller can be sent round it, and one sent round it within one turn goes to a person (needs-human)`, 'nothing to do if each pass reads values the caller can change; otherwise end the loop: send one of the outcomes to a form outside it, or end the call there');
  }
  // An identity factor that runs out goes on unverified: a form its outcome enters that needs identity
  // would ask the same factor again (from the start of its ladder), and round again.
  const actions = config.policy.actions;
  const levelOf = (tool: string): number => (Object.hasOwn(actions, tool) ? (actions[tool]!.level ?? DEFAULT_ACTION_LEVEL) : 0);
  const needOf = (form: string): number => {
    const def = forms[form]!;
    return Math.max(provenLevel(config, form), ...(def.calls ?? []).map(levelOf), ...(def.checks ?? []).map((c) => levelOf(c.action)));
  };
  for (const factor of config.identity?.levels[1].factors ?? []) {
    const to = slotOutcomeForm(outcomes[factor]);
    if (to === undefined || !Object.hasOwn(forms, to)) continue;
    const need = needOf(to);
    if (need < 1) continue;
    const library = config.slots !== null && Object.hasOwn(config.slots, factor) && (config.slots[factor] as { type?: unknown }).type !== 'code';
    report(library ? SLOTS_FILE : codeFile, library ? [factor, 'onMaxAttempts', 'form'] : ['slots', factor, 'onMaxAttempts'], `the identity factor "${factor}" goes, when it runs out of attempts, to the form "${to}", which needs identity level ${need}, so the caller, still not verified, is asked "${factor}" again there, and can be sent round again`, `nothing to do if that is meant; otherwise send it to a form anyone may use (level 0), or hand off`);
  }
  const prompts = config.prompts[config.defaultLocale] ?? {};
  for (const slot of askedSlots(config)) {
    const spec = Object.hasOwn(slots, slot) ? slots[slot] : undefined;
    if (spec === undefined) continue;
    const max = spec.attempts ?? DEFAULT_THRESHOLDS.MAX_ATTEMPTS;
    const numbered = new RegExp(`^ask_${slot}_(retry|noinput)(\\d+)$`);
    for (const line of Object.keys(prompts)) {
      const m = numbered.exec(line);
      if (m === null) continue;
      const k = Number(m[2]);
      if (k >= 1 && k < max) continue;
      report(FILE_NAMES.prompts, ['prompts', line], `the line "${line}" is said at the slot "${slot}"'s failure ${k}, which its ladder never reaches: it re-asks at failures 1 to ${max - 1} (attempts: ${max})`, k < 1 ? `number it from 1 (the first failure), or delete it` : `raise the slot's attempts above ${k}, or delete the line`);
    }
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
 * The warning for a slot whose own `listen` says it listens before its form is open (`up-front`,
 * `anywhere` or `call`) while every form that lists it says its slots do not (forms.yaml
 * `listenBeforeEntered: false`, the default for an internal form): the slot's own setting wins, so
 * the designer is told which one the call follows.
 */
function listenWarnings(config: LoadedConfig, slots: Readonly<Record<string, SlotSpec | undefined>>, report: (file: string, path: DataPath, message: string, fix: string) => void, codeFile: string): void {
  /** The forms that list `id`, when every one says its slots do not listen before it is open; else null. */
  const waiting = (id: string): { names: string; one: boolean; byDefault: boolean } | null => {
    const forms = Object.entries(config.forms.forms).filter(([, form]) => form.slots.includes(id));
    if (forms.length === 0 || forms.some(([, form]) => form.listenBeforeEntered ?? form.internal !== true)) return null;
    return { names: forms.map(([form]) => `"${form}"`).join(', '), one: forms.length === 1, byDefault: forms.some(([, form]) => form.listenBeforeEntered === undefined) };
  };
  const says = (w: { names: string; one: boolean; byDefault: boolean }): string => `${w.one ? 'the form' : 'every form'} that lists it (${w.names}) says its slots do not listen before it is open (listenBeforeEntered: false${w.byDefault ? ', the default for an internal form' : ''})`;
  const carried = config.app.carrySlots ?? [];
  for (const [id, spec] of Object.entries(slots)) {
    const listen = spec?.listen;
    if (listen === undefined || listen === 'form') continue;
    const w = waiting(id);
    if (w === null) continue;
    const message = `the slot "${id}" says listen: ${listen}, but ${says(w)}; the slot's own listen wins`;
    const fix = 'nothing to do if that is meant; otherwise delete the slot\'s "listen", so it is asked once its form is open';
    if (config.slots !== null && Object.hasOwn(config.slots, id)) report(SLOTS_FILE, [id, 'listen'], message, fix);
    else report(codeFile, ['slots', id, 'listen'], message, fix);
  }
  // A slot app.yaml carries listens for the call (listen: call's shorthand), whatever its forms say.
  carried.forEach((id, i) => {
    if (slots[id]?.listen !== undefined) return;
    const w = waiting(id);
    if (w === null) return;
    report('app.yaml', ['carrySlots', i], `the slot "${id}" is carried (carrySlots), which listens for the whole call, but ${says(w)}; carrySlots wins`, 'nothing to do if that is meant; otherwise take the slot out of carrySlots, so it is asked once its form is open');
  });
}

/**
 * The warning for Telnyx voices named for some of the app's locales and not the others
 * (voice.locales.<tag>.voices.telnyx). On Telnyx the start language's voice is written on the relay
 * element too (server/voice/telnyx.ts: with the voices on the <Language> children alone Telnyx said
 * nothing on live calls), so a language with no voice of its own may keep the voice the call started
 * with after a switch: not yet checked on a live call either way. The deployment's TELNYX_VOICE, which
 * the default locale takes, is the server's to say (it warns at start).
 */
function telnyxVoiceWarnings(config: LoadedConfig, report: (file: string, path: DataPath, message: string, fix: string) => void): void {
  const locales = Object.keys(config.prompts);
  const voiceLocales = config.app.voice?.locales;
  if (locales.length < 2 || voiceLocales === undefined) return;
  const voiced = (tag: string): boolean => {
    const own = Object.hasOwn(voiceLocales, tag) ? voiceLocales[tag] : undefined;
    return own?.voices !== undefined && Object.hasOwn(own.voices, 'telnyx');
  };
  const named = locales.filter(voiced);
  if (named.length === 0 || named.length === locales.length) return;
  const missing = locales.filter((tag) => !voiced(tag));
  report('app.yaml', ['voice', 'locales'], `a Telnyx voice is named for ${named.join(', ')} but not for ${missing.join(', ')}: on Telnyx the start language's voice is on the relay element too, so a call that switches to ${missing.length === 1 ? 'that locale' : 'one of those'} may keep the voice it started with, reading its language in another's voice (not yet checked on a live call)`, `name a Telnyx voice for every locale (voice.locales.<tag>.voices.telnyx), or for none`);
}

/**
 * The warnings for what a carrier is sent of the app's languages (channel/speechLanguages.ts), never
 * refusals, since a folder does not say which carriers the server answers on: a locale spoken or heard
 * as a language tag with no region (`es`), which Twilio refused on a live call; and a language other
 * than English heard by a recognizer that hears English only, its own, the server's default for the
 * default locale (Deepgram flux on Twilio, unless TWILIO_SPEECH_MODEL names another), or, where the
 * locale names none, the one the document names for another language. `pnpm diagnose` says the same
 * with the server's own settings, and refuses a bare tag on a server that answers on Twilio.
 */
function speechLanguageWarnings(config: LoadedConfig, report: (file: string, path: DataPath, message: string, fix: string) => void): void {
  const speech = speechLocalesOfFolder(config);
  const voiceLocales = config.app.voice?.locales;
  const at = (locale: string, field?: 'tts' | 'transcription' | 'recognition', carrier?: string): DataPath => {
    const own = voiceLocales !== undefined && Object.hasOwn(voiceLocales, locale) ? voiceLocales[locale] : undefined;
    if (own === undefined) return voiceLocales !== undefined ? ['voice', 'locales'] : config.app.voice !== undefined ? ['voice'] : config.app.locale !== undefined ? ['locale'] : ['id'];
    if (field === undefined || own[field] === undefined) return ['voice', 'locales', locale];
    return field === 'recognition' && carrier !== undefined && own.recognition !== undefined && Object.hasOwn(own.recognition, carrier) ? ['voice', 'locales', locale, 'recognition', carrier] : ['voice', 'locales', locale, field];
  };
  const bare = bareSpeechTags(speech);
  for (const locale of [...new Set(bare.map((b) => b.locale))]) {
    const mine = bare.filter((b) => b.locale === locale);
    const { message, fix } = bareTagFinding(locale, mine);
    report('app.yaml', at(locale, mine.find((b) => b.own)?.field), message, fix);
  }
  for (const h of englishOnlyHearings(speech)) {
    const { message, fix } = englishOnlyFinding(h, false);
    report('app.yaml', at(h.locale, 'recognition', h.carrier), message, fix);
  }
}

/**
 * The lines the engine says an intent's or a form's label in (core/turn.ts: {intentLabel}, and {a} and {b}
 * of the two lines that name two), with what they name: `forms` the form intents and the internal forms
 * (formLabel), `confirmed` also done and the informational intents, which a caller may be asked to confirm
 * (gates.ts isRoutable, inform_explicit).
 */
const LABEL_LINES: Readonly<Record<string, 'forms' | 'confirmed'>> = {
  ack_intent: 'forms',
  confirm_intent_explicit: 'confirmed',
  disambiguate_intent: 'forms',
  ack_intent_then: 'forms',
  ack_queued: 'forms',
  bridge_next: 'forms',
};

/**
 * A locale's labels that name nothing: an intent intents.yaml does not have (locale/<tag>/intents.yaml),
 * and a form forms.yaml does not have, or one that is no internal form (locale/<tag>/forms.yaml: a form
 * intent's label is its intent's). Problems, each at its key, with the near name.
 */
function checkLocaleLabels(config: LoadedConfig, locateKey: LoadResult['locate']): Problem[] {
  const problems: Problem[] = [];
  const intents = Object.keys(config.intents.intents);
  const internal = Object.entries(config.forms.forms).filter(([, f]) => f.internal === true).map(([id]) => id);
  for (const [tag, file] of Object.entries(config.localeIntents ?? {})) {
    const name = `locale/${tag}/intents.yaml`;
    for (const id of Object.keys(file.intents)) {
      if (intents.includes(id)) continue;
      const at = locateKey(name, ['intents', id]) ?? { line: 1, column: 1 };
      const near = closest(id, intents);
      problems.push({ file: name, ...at, path: formatPath(['intents', id]), message: `"${id}" is not an intent in ${FILE_NAMES.intents}, so its label is never said`, fix: near ? `rename it to "${near}" if it is that intent, or delete it` : `delete it, or add the intent "${id}" to ${FILE_NAMES.intents}` });
    }
  }
  for (const [tag, file] of Object.entries(config.localeForms ?? {})) {
    const name = `locale/${tag}/forms.yaml`;
    for (const id of Object.keys(file.forms)) {
      if (internal.includes(id)) continue;
      const at = locateKey(name, ['forms', id]) ?? { line: 1, column: 1 };
      if (Object.hasOwn(config.forms.forms, id)) {
        problems.push({ file: name, ...at, path: formatPath(['forms', id]), message: `the form "${id}" is an intent's, so its label is the intent's, not the form's`, fix: `move it to locale/${tag}/intents.yaml as "intents: { ${id}: { label: ... } }"` });
        continue;
      }
      const near = closest(id, internal);
      problems.push({ file: name, ...at, path: formatPath(['forms', id]), message: `"${id}" is not an internal form in ${FILE_NAMES.forms}, so its label is never said`, fix: near ? `rename it to "${near}" if it is that form, or delete it` : `delete it: only an internal form (internal: true) has a label of its own` });
    }
  }
  return problems;
}

/**
 * The warning for a locale whose lines say an intent's label (LABEL_LINES, in its own words in
 * locale/<tag>/prompts.yaml) and that gives no label of its own for an intent or a form they can name:
 * the label is said in the default locale's words in the middle of the locale's line ("le puedo ayudar a
 * report a problem", on a live call of 2026-10-13). One per locale, with every id it lacks. A warning,
 * never a refusal: a label the same in both languages is the app's to leave out.
 */
function localeLabelWarnings(config: LoadedConfig, report: (file: string, path: DataPath, message: string, fix: string) => void): void {
  const intents = config.intents.intents;
  const formIntents = Object.entries(intents).filter(([, d]) => d.kind === 'form').map(([id]) => id);
  const internal = Object.entries(config.forms.forms).filter(([, f]) => f.internal === true).map(([id]) => id);
  for (const [tag, prompts] of Object.entries(config.prompts)) {
    if (tag === config.defaultLocale) continue;
    const lines = Object.keys(LABEL_LINES).filter((id) => Object.hasOwn(prompts, id));
    if (lines.length === 0) continue;
    const named = new Set([...formIntents, ...internal]);
    // confirm_intent_explicit also names what a caller may be asked to confirm outside a form: done, and
    // an informational intent (gates.ts inform_explicit), each of which says, switches or answers (informationOf).
    if (lines.some((id) => LABEL_LINES[id] === 'confirmed')) {
      if (Object.hasOwn(intents, 'done')) named.add('done');
      for (const [id, d] of Object.entries(intents)) if (d.kind === 'informational') named.add(id);
    }
    const own = { ...(config.localeIntents?.[tag]?.intents ?? {}), ...(config.localeForms?.[tag]?.forms ?? {}) };
    const missing = [...named].filter((id) => !Object.hasOwn(own, id));
    if (missing.length === 0) continue;
    const said = (id: string): string => `${id} ("${Object.hasOwn(intents, id) ? intents[id]!.label : config.forms.forms[id]!.label}")`;
    const inIntents = missing.filter((id) => Object.hasOwn(intents, id));
    const inForms = missing.filter((id) => !Object.hasOwn(intents, id));
    const where = [
      ...(inIntents.length > 0 ? [`locale/${tag}/intents.yaml (intents: { ${inIntents[0]}: { label: ... } })`] : []),
      ...(inForms.length > 0 ? [`locale/${tag}/forms.yaml (forms: { ${inForms[0]}: { label: ... } })`] : []),
    ];
    report(
      `locale/${tag}/prompts.yaml`,
      ['prompts', lines[0]!],
      `the ${tag} lines ${lines.join(', ')} say an intent's label, and the locale gives none of its own for ${missing.map(said).join(', ')}: ${missing.length === 1 ? 'it is' : 'they are'} said in the default locale's words in the middle of those ${tag} lines`,
      `give each its label in ${tag} in ${where.join(' and ')}`,
    );
  }
}

/**
 * The warning for consent to text for the whole call (app.yaml's textConsent) that no form can use: no
 * slot it covers is in a form, so it is asked and never stands in for an offer.
 */
function textConsentWarnings(config: LoadedConfig, report: (file: string, path: DataPath, message: string, fix: string) => void): void {
  const covers = config.app.textConsent?.covers;
  if (covers === undefined || covers.length === 0) return;
  const asked = new Set(Object.values(config.forms.forms).flatMap((form) => form.slots));
  if (covers.some((slot) => asked.has(slot))) return;
  report('app.yaml', ['textConsent', 'covers'], `textConsent covers ${covers.map((slot) => `"${slot}"`).join(', ')}, but no form asks ${covers.length === 1 ? 'it' : 'any of them'}, so the caller is asked consent that nothing uses`, 'cover a slot a form asks (one that offers the number the caller is calling from), or delete "textConsent"');
}

/**
 * The warning for a slot that proposes at the greeting (`offerAt: greeting`) in an app with no
 * call-start lookup (app.yaml's `callerNumber.lookup`): the greeting comes before anything else could
 * load the facts, so nothing is proposed there, and the slot proposes at the slot instead.
 */
function greetingOfferWarnings(config: LoadedConfig, slots: Readonly<Record<string, SlotSpec | undefined>>, report: (file: string, path: DataPath, message: string, fix: string) => void, codeFile: string): void {
  if (config.app.callerNumber?.lookup !== undefined) return;
  for (const [id, spec] of Object.entries(slots)) {
    if (spec?.offer !== 'facts' || spec.offerAt !== 'greeting') continue;
    const library = config.slots !== null && Object.hasOwn(config.slots, id);
    const message = `the slot "${id}" proposes at the greeting (offerAt: greeting), but app.yaml has no callerNumber lookup, so nothing has loaded the facts by then and it is proposed at the slot instead`;
    const fix = 'add "callerNumber: { use: hint, lookup: <tool> }" to app.yaml, or delete "offerAt"';
    if (library) report(SLOTS_FILE, [id, 'offerAt'], message, fix);
    else report(codeFile, ['slots', id, 'offerAt'], message, fix);
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
    if (level > 0) report('policy.yaml', ['actions', lookup, ...(policy.actions[lookup]!.level !== undefined ? ['level'] : [])], `the action "${lookup}" is the call-start lookup (app.yaml's callerNumber.lookup), which runs before anyone is verified, but it needs level ${level}, so the gate always refuses it and nothing is looked up`, `set its level to 0 (what it returns may be said to a caller not yet verified, so return what the app means to say then); or delete "lookup" and load the facts from a form's entry call after identity`);
  }
  if (lookup !== undefined && policy.audit?.callerNumber === 'keep') {
    report('policy.yaml', ['audit', 'callerNumber'], 'the call-start lookup\'s param, the number the caller is calling from, is recorded as it is (keep) in the trace, the console and the audit', 'write "callerNumber: last4" unless the whole number must be recorded');
  }
  const factors: readonly string[] = config.identity?.levels[1].factors ?? [];
  const offering = Object.entries(slots).filter(([id, spec]) => spec?.callerNumber !== undefined && !factors.includes(id)).map(([id]) => id);
  for (const [tool, action] of Object.entries(policy.actions)) {
    action.rules.forEach((entry, i) => {
      if (typeof entry !== 'object' || entry === null || !('callerNumber' in entry)) return;
      const rule = readRule(entry);
      if (rule.rule !== 'callerNumber') return;
      const path: DataPath = ['actions', tool, 'rules', i, 'callerNumber'];
      // A param named callerNumber is the number as the session keeps it (the lookup's param, callerOf(s).number): compared as it is meant to be.
      if (!offering.includes(rule.field) && rule.field !== 'callerNumber') report('policy.yaml', [...path, 'field'], `"${rule.field}" is no slot that offers the caller's number, so the rule compares it with the number as the carrier sent it, digit for digit (+15555550142 is not 5555550142)`, `name the slot that offers the number (its value is the number as the slot holds it), or pass the number in that form`);
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

/** A key's spoken names, in the languages the warnings below read (English, Spanish), by key. */
const KEY_WORDS: Readonly<Record<string, readonly string[]>> = {
  '0': ['zero', 'cero'], '1': ['one', 'uno'], '2': ['two', 'dos'], '3': ['three', 'tres'], '4': ['four', 'cuatro'],
  '5': ['five', 'cinco'], '6': ['six', 'seis'], '7': ['seven', 'siete'], '8': ['eight', 'ocho'], '9': ['nine', 'nueve'],
  '*': ['star', 'asterisco'], '#': ['pound', 'hash', 'numeral'],
};
/** Every digit's name, for a key followed by another digit ("nine one one"), which is a number and no key. */
const DIGIT_WORDS = Object.entries(KEY_WORDS).filter(([k]) => /\d/.test(k)).flatMap(([, w]) => w).join('|');
/**
 * The words a line asks a caller to press a key with, in English and Spanish, each form a line uses:
 * press, pressing, dial, key, enter, push; oprima, oprime, marca, marque, pulsa, pulse, presiona,
 * presione, teclea, teclee.
 */
const PRESS = '(?:press(?:ing)?|dial(?:ing)?|key|enter|push|oprim[ae]|marc[ae]|marque|puls[ae]|presion[ae]|tecle[ae])';
/** What may stand between the press word and the key: an article, then "number", "número", "tecla" or "key". */
const BEFORE_KEY = '(?:(?:the|el|la)\\s+)?(?:(?:number|n[uú]mero|tecla|key)\\s+)?';

/**
 * Whether a line asks the caller to press `digit`: a press word ("press", "oprima", "marque", ...),
 * an optional article and "number", "número" or "tecla", then the key, written as the key or as its
 * name ("press 9", "oprima el número 9", "presione la tecla 9", "by pressing nine", "press star").
 * Only with a press word, so a figure in a line ("open 9 to 5") is no key; and a key followed by
 * another digit is a number, not a key ("dial nine one one", "press 9-1-1", "dial 1-800-...", "enter
 * the 9 digit number").
 */
export function namesKey(line: string, digit: string): boolean {
  const key = digit === '*' ? '\\*' : digit;
  const words = (KEY_WORDS[digit] ?? []).join('|');
  // Not a key: another digit after it ("19", "9-1-1", "9 1 1", "nine one one"), or "digit(s)" after it.
  const notAKey = `(?!\\d|[\\s-]+\\d|[\\s-]+(?:${DIGIT_WORDS}|digits?|d[ií]gitos?)\\b)`;
  const said = new RegExp(`\\b${PRESS}\\s+${BEFORE_KEY}(?:${key}${notAKey}${words !== '' ? `|(?:${words})\\b${notAKey}` : ''})`, 'iu');
  return said.test(line);
}

/**
 * The menu's keys against the lines that name them, with English and Spanish press words (namesKey),
 * in every locale; at most one warning per key and line, at the key's menu entry:
 *
 * - A line said at the open question (the greeting, app.yaml's prompts.greetings.voice, else
 *   `greeting`; `greet_after_offer`, `ask_intent`, `nomatch_open`, `anything_else`) that asks the
 *   caller to press a key whose entry takes it only once the menu is offered (MenuEntry.fromGreeting;
 *   intents.yaml's menuListens): a caller who presses it there hears nothing.
 * - The opening offer's line (prompts.greetings.offer, else `greeting_offer`: the caller-ID question,
 *   the consent to text, a proposal at the greeting) that names any key: no menu key is taken while
 *   the offer is unanswered (the key answers the offer, or keys the identity question), so it is live
 *   only once the offer is answered.
 * - A `*` or `#` entry: the voice server passes those keys over on a phone call (they only end keys
 *   held at an offer that takes a yes or a no), so the entry can never be pressed. No line warning is
 *   given for one: this says it.
 */
function menuKeyWarnings(config: LoadedConfig, report: (file: string, path: DataPath, message: string, fix: string) => void): void {
  const { menu, menuListens } = config.intents;
  const greetings = config.app.prompts?.greetings;
  const greeting = greetings?.voice ?? 'greeting';
  const openLines = [greeting, 'greet_after_offer', 'ask_intent', 'nomatch_open', 'anything_else'];
  const offer = greetings?.offer ?? 'greeting_offer';
  const defaults = config.prompts[config.defaultLocale] ?? {};
  /** The first locale whose line `id` asks for `digit`, as written in a message ('' for the default), or null. */
  const naming = (id: string, digit: string): string | null => {
    for (const [locale, prompts] of Object.entries(config.prompts)) {
      const line = (prompts[id] ?? defaults[id])?.text;
      if (line !== undefined && namesKey(line, digit)) return locale === config.defaultLocale ? '' : ` (${locale})`;
    }
    return null;
  };
  menu.forEach(({ digit, fromGreeting }, i) => {
    const at: DataPath = ['menu', i, 'digit'];
    if (digit === '*' || digit === '#') {
      report('intents.yaml', at,
        `menu digit "${digit}" can never be pressed on a phone call: the voice server passes * and # over (they only end keys held at an offer that takes a yes or a no), so a caller who presses ${digit} hears nothing`,
        'give this entry a key from 0 to 9');
      return;
    }
    if (!(fromGreeting ?? menuListens === 'greeting')) {
      for (const id of openLines) {
        const where = naming(id, digit);
        if (where === null) continue;
        report('intents.yaml', at,
          `the ${id === greeting ? 'greeting' : 'line'} "${id}"${where} asks the caller to press ${digit}, and the menu takes that key only once it has been offered (after the second missed answer): a caller who presses ${digit} there hears nothing`,
          'add "fromGreeting: true" to this menu entry, so the key is taken from the greeting on (or "menuListens: greeting" at the top of intents.yaml for every key); or take the key out of the line');
      }
    }
    const where = naming(offer, digit);
    if (where !== null) {
      report('intents.yaml', at,
        `the opening offer's line "${offer}"${where} asks the caller to press ${digit}, and no menu key is taken while the call's opening offer (the caller-ID question, the consent to text, a proposal at the greeting) is unanswered: a ${digit} pressed there answers the offer, or is keyed into the identity question`,
        'name the key in the line said once the offer is answered (greet_after_offer), with "fromGreeting: true" on this entry; or take it out of the offer\'s line');
    }
  });
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
  // The lines a library slot says when it runs out of attempts (slots.yaml onMaxAttempts): its `say`,
  // and its handoff's line for a reason of its own.
  for (const ref of slotOutcomeReferences(config)) refs.push(ref);
  // The lines a route says (routes.yaml): its `say`, and its handoff's line.
  for (const ref of routeReferences(config)) refs.push(ref);
  // The lines a knowledge answer is said through: a form's answers (kb_answer and kb_unavailable, or its own) and an intent's passage.
  for (const { id, file, path } of knowledgePromptReferences(config)) refs.push({ id, file, path });
  const identity = identityParts(config);
  if (identity?.failedPromptId !== undefined) refs.push({ id: identity.failedPromptId, file: 'identity.yaml', path: identity.failedPath });
  for (const [which, id] of Object.entries(config.app.prompts?.greetings ?? {})) {
    if (id !== undefined) refs.push({ id, file: 'app.yaml', path: ['prompts', 'greetings', which] });
  }
  return refs;
}

/** The lines routes say (routes.yaml): each rule's `say` and its handoff's line (handoff_<reason>, needs-human by default), an else's too. */
function routeReferences(config: LoadedConfig): Reference[] {
  const refs: Reference[] = [];
  const lists: [DataPath, readonly RouteRuleYaml[]][] = [];
  if (config.routes?.start) lists.push([['start'], config.routes.start]);
  if (config.routes?.afterIdentity) lists.push([['afterIdentity'], config.routes.afterIdentity]);
  for (const [form, rules] of Object.entries(config.routes?.afterForm ?? {})) lists.push([['afterForm', form], rules]);
  for (const [at, rules] of lists) {
    rules.forEach((rule, i) => {
      const w = writtenOutcome(rule);
      if (w === null) return;
      const written = w.outcome;
      const base: DataPath = [...at, i, ...w.at];
      if (written.say !== undefined) refs.push({ id: written.say, file: 'routes.yaml', path: [...base, 'say'] });
      if (written.then === 'handoff') refs.push({ id: handoffPromptId(written.reason ?? ROUTE_HANDOFF_REASON), file: 'routes.yaml', path: [...base, written.reason !== undefined ? 'reason' : 'then'] });
    });
  }
  return refs;
}

/** The lines library slots say when they run out of attempts (slots.yaml onMaxAttempts written out): `say`, and handoff_<reason> for a reason of its own. */
function slotOutcomeReferences(config: LoadedConfig): Reference[] {
  const refs: Reference[] = [];
  for (const [id, raw] of Object.entries(config.slots ?? {})) {
    const o = (raw as { onMaxAttempts?: unknown }).onMaxAttempts;
    if (typeof o !== 'object' || o === null) continue;
    const { say, then, reason } = o as { say?: unknown; then?: unknown; reason?: unknown };
    if (typeof say === 'string') refs.push({ id: say, file: SLOTS_FILE, path: [id, 'onMaxAttempts', 'say'] });
    if (then === 'handoff' && typeof reason === 'string') refs.push({ id: handoffPromptId(reason), file: SLOTS_FILE, path: [id, 'onMaxAttempts', 'reason'] });
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
    problems.push(...checkConsentLine(config, locale, prompts, file, locate));
    problems.push(...checkVariants(locale === config.defaultLocale ? null : locale, prompts, file, locate, { ...(config.slots ?? {}), ...(code?.slots ?? {}) }));
    if (locale !== config.defaultLocale) problems.push(...checkTranslation(config, locale, prompts, file, locate, needed));
  }
  return problems;
}

/**
 * A line's other wordings (prompts.yaml's `variants`), in each locale: only the lines said in turn have
 * them (core/wordings.ts rotatesLine: the acknowledgement of a request, the not-found line, the hold lines, and a slot's own question); each is fixed text, so the line is not generated; and
 * each names the variables of the line's text, so whichever is said is given what it says.
 */
function checkVariants(locale: string | null, prompts: LoadedConfig['prompts'][string], file: string, locate: LoadResult['locate'], slots: Readonly<Record<string, unknown>>): Problem[] {
  const problems: Problem[] = [];
  for (const [id, p] of Object.entries(prompts)) {
    if (p.variants === undefined) continue;
    const line = locale === null ? `the line "${id}"` : `the ${locale} line "${id}"`;
    const at = (path: (string | number)[]): { line: number; column: number } => locate(file, path) ?? { line: 1, column: 1 };
    const path = ['prompts', id, 'variants'];
    if (!rotatesLine(id, slots)) {
      problems.push({ file, ...at(path), path: formatPath(path), message: `${line} has variants, other wordings said in turn, which only the lines said in turn have (${ROTATING_LINES.join(', ')}, and a slot's own question, ask_<slot>)`, fix: 'delete variants from this line' });
      continue;
    }
    if (p.mode === 'generative' || p.generate !== undefined) {
      problems.push({ file, ...at(path), path: formatPath(path), message: `${line} has variants and is generated (${p.mode === 'generative' ? 'mode: generative' : 'generate'}); its wordings are fixed text, said word for word`, fix: `delete variants, or ${p.mode === 'generative' ? 'mode: generative' : 'generate'}` });
    }
    const vars = variablesOf(p.text).sort();
    p.variants.forEach((variant, i) => {
      const own = variablesOf(variant).sort();
      if (own.join(',') === vars.join(',')) return;
      const named = vars.length === 0 ? 'no variable' : vars.map((v) => `{${v}}`).join(', ');
      problems.push({
        file,
        ...at([...path, i]),
        path: formatPath([...path, i]),
        message: `${line}'s variant "${variant}" ${own.length === 0 ? 'names no variable' : `names ${own.map((v) => `{${v}}`).join(', ')}`}, and its text names ${named}: every wording is given what the text is`,
        fix: `name exactly ${named} in the variant`,
      });
    });
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
 * The consent question (app.yaml's textConsent, `consent_texts`), in each locale that has it: it says
 * the last four digits of the number a grant is for, `{last4}`, so a yes is to a number the caller
 * heard of, and it is given nothing else, so a line that uses another fails when it is said.
 */
function checkConsentLine(config: LoadedConfig, locale: string, prompts: LoadedConfig['prompts'][string], file: string, locate: LoadResult['locate']): Problem[] {
  if (config.app.textConsent === undefined || !has(prompts, CONSENT_PROMPT)) return [];
  const used = variablesOf(prompts[CONSENT_PROMPT]!.text);
  const extra = used.filter((name) => name !== 'last4');
  const line = locale === config.defaultLocale ? `the line "${CONSENT_PROMPT}"` : `the ${locale} line "${CONSENT_PROMPT}"`;
  const at = locate(file, ['prompts', CONSENT_PROMPT, 'text']) ?? { line: 1, column: 1 };
  const path = formatPath(['prompts', CONSENT_PROMPT, 'text']);
  const problems: Problem[] = [];
  if (!used.includes('last4')) {
    problems.push({ file, ...at, path, message: `${line} asks consent to text for the whole call but does not say which number ({last4}), so a yes would be to a number the caller never heard of`, fix: 'say {last4} in the line ("Can I text you helpful links during this call, at the number ending in {last4}?")' });
  }
  if (extra.length > 0) {
    problems.push({ file, ...at, path, message: `${line} uses ${extra.map((name) => `{${name}}`).join(', ')}, which the engine does not give it (it gives the consent question only {last4}), so saying it would fail`, fix: 'use only {last4} in this line' });
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
export function packageRootOf(dir: string): string {
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

/**
 * Every scripted call's known gap (Scenario.knownGap, harness-text/scenarioGap.ts): its shape, as a
 * corpus line's is checked (a one-line reason, and an outcome of outcome fields), and a pinned end
 * other than the call's own expectation, for an app whose app.yaml names a fixtures directory with a
 * scenarios/ folder. A file that is not a JSON list is left to the regression, which refuses it.
 */
function checkScenarioGaps(config: LoadedConfig, dir: string, fixturesRoot?: string): Problem[] {
  const fixtures = config.app.fixtures;
  if (!fixtures) return [];
  const root = fixturesRoot ?? packageRootOf(dir);
  const folder = `${fixtures.dir.replace(/\/+$/, '')}/scenarios`;
  const absolute = resolve(root, folder);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return [];
  const real = realpathSync(absolute);
  if (!isInside(realpathSync(root), real)) return [];
  const problems: Problem[] = [];
  for (const name of readdirSync(real).filter((f) => f.endsWith('.json')).sort()) {
    const path = join(real, name);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_CORPUS_BYTES) continue;
    const text = readFileSync(path, 'utf8');
    let calls: unknown;
    try {
      calls = JSON.parse(text);
    } catch {
      continue;
    }
    if (!Array.isArray(calls)) continue;
    const file = relative(resolve(dir), join(absolute, name)).split('\\').join('/');
    const lines = text.split('\n');
    for (const [index, call] of calls.entries()) {
      if (typeof call !== 'object' || call === null) continue;
      const { id, expect, knownGap } = call as { id?: unknown; expect?: unknown; knownGap?: unknown };
      if (knownGap === undefined || typeof id !== 'string') continue;
      const found = scenarioGapProblems({ id, knownGap, ...(typeof expect === 'object' && expect !== null ? { expect: expect as never } : {}) });
      if (found.length === 0) continue;
      // The call's "knownGap" key, the first after its id; the id's line, else the file's first.
      const idLine = lines.findIndex((l) => l.includes(`"id"`) && l.includes(JSON.stringify(id)));
      const gapLine = idLine === -1 ? -1 : lines.findIndex((l, i) => i >= idLine && l.includes('"knownGap"'));
      const line = (gapLine !== -1 ? gapLine : Math.max(idLine, 0)) + 1;
      const column = gapLine !== -1 ? lines[gapLine]!.indexOf('"knownGap"') + 1 : 1;
      for (const { kind, message } of found) {
        problems.push({
          file,
          line,
          column,
          path: formatPath([index, 'knownGap']),
          message,
          fix: kind === 'restates'
            ? `pin the end the model gives instead (regress --client recorded --scenario ${id} shows it), or remove the tag: a call that reaches its own expectation needs none`
            : 'write "knownGap": {"reason": "<what the model reads, and what the caller hears>", "outcome": {<the end outcome fields the model gives, e.g. "promptId": "confirm_intent_explicit">}}',
        });
      }
    }
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
