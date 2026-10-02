import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppDefinitionError, CODE_FILE, crossLink, type AppCode } from './defineApp';
import { loadAppFolder, type LoadedConfig, type LoadResult } from './load';
import { WHOLE_FILE, closest, formatPath, type DataPath, type Problem } from './problems';
import { FILE_NAMES } from './schema/index';

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
 *  - every prompt the engine itself says exists in every locale (ENGINE_PROMPTS below);
 *  - every intent has examples in the app's corpus, when app.yaml names a fixtures directory;
 *  - every prompt is `mode: fixed`: the schema allows no other mode, and refuses one with a message
 *    that says so (see the load tests), so there is nothing more to check here.
 *
 * The app module: `app.ts` (or `app.mts`, `app.js`, `app.mjs`) in the app folder, exporting the
 * app's code parts as `code` (an AppCode), or as the default export. It may also call defineApp
 * itself, as the example app does, to be the app's build: a defineApp that throws an
 * AppDefinitionError at import is reported as the problems it carries. Importing needs a TypeScript
 * loader for an app.ts, which is how the `dialogwright` command runs (tsx); a folder with no app
 * module is checked as YAML only, and the check says so.
 */

/** A line the engine says by name in every app: its id, and when it says it (for the message). */
export const ENGINE_PROMPTS: Readonly<Record<string, string>> = {
  ask_intent: 'it asks what the caller wants',
  nomatch_open: 'it did not understand the caller and asks again',
  no_input: 'the caller said nothing',
  ack_intent: 'it starts the form the caller asked for',
  confirm_intent_explicit: 'it checks which request the caller meant',
  disambiguate_intent: 'it asks which of two requests the caller meant',
  ack_intent_then: 'the caller asked for two things and it starts the first',
  ack_queued: 'the caller asked for a second thing mid-form and it is put in the queue',
  bridge_next: 'it moves from one form to the next queued one',
  ack_frustration: 'the caller is frustrated',
  offer_transfer: 'it offers to connect the caller to a person',
  ack_declined: 'the caller declined a read-back or the transfer offer',
  system_slow_dtmf_hint: 'a system is slow on a call with a keypad',
  system_slow_chat: 'a system is slow in a chat',
  ask_change: 'it asks which detail of a read-back to change',
  confirm_dtmf: 'it asks the caller to confirm on the keypad',
  anything_else: 'a form is done and it asks whether there is more',
  goodbye: 'a call ends',
  goodbye_chat: 'a chat ends',
  screen_reprompt: 'it declines something the caller said outside a form and steers back',
  screen_reprompt_form: 'it declines something the caller said in a form and steers back',
  handoff_live_agent: 'the caller asks for a person',
  handoff_frustrated: 'the caller is frustrated and is handed to a person',
  handoff_max_attempts: 'the caller was asked too many times and is handed to a person',
  handoff_system_failure: 'a system failed and the caller is handed to a person',
  handoff_needs_human: 'a request that needs a person is handed over',
  handoff_security: 'a caller who tried to manipulate the agent is handed to a person',
};

/** What the engine says only when the app has the feature: the menu, identity, a portal. */
const MENU_PROMPT = { id: 'nomatch_dtmf_menu', why: 'it offers the keypad menu after a caller was not understood' };
export const IDENTITY_PROMPTS: readonly { id: string; why: string }[] = [
  { id: 'handoff_identity', why: 'a caller who could not be verified is handed to a person' },
  { id: 'identity_verified', why: 'the caller was verified' },
  { id: 'ask_otp', why: 'it asks for the one-time code' },
  { id: 'ask_otp_spoken', why: 'the caller said the code instead of keying it' },
  { id: 'otp_spoken_reissued', why: 'the caller said the code and a new one is sent' },
  { id: 'otp_verified', why: 'the one-time code matched' },
  { id: 'otp_failed', why: 'the one-time code did not match' },
];
export const PORTAL_PROMPTS: readonly { id: string; why: string }[] = [
  { id: 'signin_required', why: 'a chat caller must sign in to the portal' },
  { id: 'signin_reminder', why: 'a chat caller has not signed in yet' },
  { id: 'signin_thanks', why: 'a chat caller signed in' },
  { id: 'signin_ready', why: 'a chat caller signed in with nothing waiting' },
  { id: 'greeting_chat_signed_in', why: 'a chat opens for a signed-in subject' },
  { id: 'greeting_chat_delegate', why: 'a chat opens for someone acting for subjects' },
];

/** The prompt ids the engine says for this app, each with when it says it. */
export function enginePrompts(config: LoadedConfig, code?: AppCode): { id: string; why: string }[] {
  const greetings = config.app.prompts?.greetings;
  const needs: { id: string; why: string }[] = [
    { id: greetings?.voice ?? 'greeting', why: 'a call opens' },
    { id: greetings?.chat ?? 'greeting_chat', why: 'a chat opens' },
    ...Object.entries(ENGINE_PROMPTS).map(([id, why]) => ({ id, why })),
  ];
  if (config.intents.menu.length > 0) needs.push(MENU_PROMPT);
  const slots = new Set<string>(Object.values(config.forms.forms).flatMap((form) => form.slots));
  for (const slot of config.identity?.factorSlots ?? []) slots.add(slot);
  for (const slot of slots) {
    needs.push({ id: `ask_${slot}`, why: `it asks for the slot "${slot}"` });
    needs.push({ id: `ask_${slot}_retry`, why: `it asks for the slot "${slot}" again after an answer that missed` });
  }
  if (config.identity) {
    needs.push(...IDENTITY_PROMPTS);
    needs.push({ id: config.identity.failedPromptId ?? 'identity_failed', why: 'the identity factors did not match' });
  }
  if (code?.portal) needs.push(...PORTAL_PROMPTS);
  const seen = new Set<string>();
  return needs.filter(({ id }) => !seen.has(id) && seen.add(id));
}

/** The files an app's module may be, in the order they are looked for. */
export const APP_MODULES = ['app.ts', 'app.mts', 'app.js', 'app.mjs'] as const;

export interface CheckOptions {
  /** The app's code parts, when the caller has them: they are checked, and no app module is imported. */
  code?: AppCode;
  /** The directory app.yaml's `fixtures.dir` is relative to. Default: the nearest folder above the app folder with a package.json, else the working directory. */
  fixturesRoot?: string;
}

export interface CheckResult {
  problems: Problem[];
  /** Whether the folder was checked against the app's code: false when there was none to check. */
  codeChecked: boolean;
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
  const problems: Problem[] = [];
  let code: AppCode | undefined;
  let linked = false;
  if ('problems' in found) {
    problems.push(...found.problems);
    linked = found.linked;
  } else if (found.code) {
    code = found.code;
    problems.push(...crossLink(config, code, locate));
    linked = true;
  }
  problems.push(...checkPrompts(config, locate, code, linked));
  problems.push(...checkCorpus(config, locate, dir, options.fixturesRoot));
  return { problems: sortProblems(problems), codeChecked: code !== undefined || linked };
}

// ---------------------------------------------------------------------------------------------
// The app's code
// ---------------------------------------------------------------------------------------------

type Found = { code?: AppCode } | { problems: Problem[]; linked: boolean };

/**
 * Imports the folder's app module and takes its `code` (or default) export. A module that throws
 * an AppDefinitionError while it is imported (it builds the app with defineApp) has already
 * cross-checked the folder, and its problems are the answer.
 */
async function loadCode(dir: string): Promise<Found> {
  const file = APP_MODULES.find((name) => existsSync(join(dir, name)));
  if (!file) return {};
  let module: Record<string, unknown>;
  try {
    module = (await import(/* @vite-ignore */ pathToFileURL(resolve(dir, file)).href)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AppDefinitionError) return { problems: [...error.problems], linked: true };
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return {
      problems: [{ file, line: 0, column: 0, path: WHOLE_FILE, message: `${file} could not be loaded (${message})`, fix: `run \`tsx ${file}\` in the app folder to see the full error; ${file} must import without running anything else` }],
      linked: false,
    };
  }
  const code = module.code ?? module.default;
  if (typeof code !== 'object' || code === null) {
    return {
      problems: [{ file, line: 0, column: 0, path: WHOLE_FILE, message: `${file} exports no app code: neither \`code\` nor a default export is an object`, fix: `in ${file}, write \`export const code: AppCode = { slots, tools, systems, forms }\` (AppCode is exported by "dialogwright")` }],
      linked: false,
    };
  }
  return { code: code as AppCode };
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
  if (config.identity?.failedPromptId !== undefined) refs.push({ id: config.identity.failedPromptId, file: 'identity.yaml', path: ['failedPromptId'] });
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
function checkPrompts(config: LoadedConfig, locate: LoadResult['locate'], code: AppCode | undefined, linked: boolean): Problem[] {
  const problems: Problem[] = [];
  const refs = referencesOf(config);
  const engine = enginePrompts(config, code);
  for (const [locale, prompts] of Object.entries(config.prompts)) {
    const file = promptsFile(locale, config);
    const at = locate(file, ['prompts']) ?? { line: 1, column: 1 };
    const known = Object.keys(prompts);
    const where = locale === config.defaultLocale ? file : `the ${locale} prompts`;
    const missing = (id: string, why: string, path: DataPath = ['prompts']): void => {
      const near = closest(id, known);
      problems.push({
        file,
        line: at.line,
        column: at.column,
        path: formatPath(path),
        message: `prompt "${id}" is missing from ${where}; ${why}`,
        fix: `${near ? `rename "${near}" to "${id}" if that is the line, or ` : ''}add "${id}:" with its text and interruptible to ${file}`,
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
    for (const { id, why } of engine) {
      if (!has(prompts, id) && !reported.has(id)) missing(id, `the engine says it when ${why}`);
    }
  }
  return problems;
}

const has = (obj: object, key: string): boolean => Object.hasOwn(obj, key);

// ---------------------------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------------------------

/** The folder app.yaml's fixtures `dir` is relative to: the app's package, which is the nearest folder above the app folder that has a package.json. */
function packageRootOf(dir: string): string {
  for (let at = resolve(dir); ; at = dirname(at)) {
    if (existsSync(join(at, 'package.json'))) return at;
    if (dirname(at) === at) return process.cwd();
  }
}

/** Every intent has a labelled example in the corpus, for an app whose app.yaml names a fixtures directory. */
function checkCorpus(config: LoadedConfig, locate: LoadResult['locate'], dir: string, fixturesRoot?: string): Problem[] {
  const fixtures = config.app.fixtures;
  if (!fixtures) return [];
  const corpus = `${fixtures.dir.replace(/\/+$/, '')}/corpus.jsonl`;
  const absolute = resolve(fixturesRoot ?? packageRootOf(dir), corpus);
  const at = locate('app.yaml', ['fixtures', 'dir']) ?? { line: 1, column: 1 };
  if (!existsSync(absolute)) {
    return [
      {
        file: 'app.yaml',
        line: at.line,
        column: at.column,
        path: 'fixtures.dir',
        message: `the app has no corpus: ${corpus} does not exist (looked in ${absolute})`,
        fix: `create ${corpus} with a line per labelled utterance, such as {"id":"hours-01","text":"when are you open","intent":"hours","context":"no_form"}, or point fixtures.dir at the folder that has it (it is relative to the package)`,
      },
    ];
  }
  const problems: Problem[] = [];
  const file = relative(resolve(dir), absolute).split('\\').join('/');
  const counts = new Map<string, number>();
  readFileSync(absolute, 'utf8').split('\n').forEach((text, i) => {
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

/** Problems by file (the folder's files in their order, locale files, any other file, then app.ts), then position. */
function sortProblems(problems: readonly Problem[]): Problem[] {
  const names: string[] = Object.values(FILE_NAMES);
  const rank = (file: string): number => {
    if (file === CODE_FILE) return names.length + 2;
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
