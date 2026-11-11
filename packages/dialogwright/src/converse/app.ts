import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import { z } from 'zod';
import type { App } from '../core/app/types';
import { positionOf, problemsOfIssues, type Problem } from '../define/problems';
import { appSchema } from '../define/schema/app';
import type { JsonSchema } from '../define/schema/json';
import type { AppRoutes } from '../server/appRoutes';
import type { Texts } from '../texts/types';
import { AGENT_FILE, AgentBusinessError, readAgentBusiness, resolveAgentSettings } from './business/load';
import type { AgentBusiness } from './business/schema';
import { policyOf } from './policy';
import { fakeCalendar, type Calendar, type Slot } from './sources/calendar';
import { businessZone } from './state';
import type { ToolImpl } from './turn';

/**
 * A converse app (docs/designs/2026-11-11-agent-runtime.md, "One runtime, chosen per app"): a folder whose
 * app.yaml says `mode: converse` and names the app (`id`, as a scripted app's does), and whose agent.yaml
 * is the business, joined with the code of each action it names.
 */
export interface ConverseApp {
  mode: 'converse';
  id: string;
  dir: string;
  business: AgentBusiness;
  tools: Record<string, ToolImpl>;
  /** The app's own pages, under /<id>: routes made with the app, or made by the server as it starts (ConversePagesFactory). */
  pages?: AppRoutes | ConversePagesFactory;
  onText?: App['onText'];
  /** The app's chat settings (app.yaml's `chat`). */
  chat: ConverseChatSettings;
  /**
   * The app made again, with state of its own (its systems, its calendar), where its code keeps any: a test
   * harness starts each simulated call on one (pnpm eval), so no call sees what another booked. Absent, the
   * app keeps no state of its own and is used as it is.
   */
  fresh?: () => ConverseApp;
}

/** What a converse app's pages are made with, as the server starts: as a scripted app's pages are (AppPageDeps), for an app with no scripted parts. */
export interface ConversePageDeps {
  /** The app, its agent.yaml's references read from its own settings. */
  app: ConverseApp;
  /** Where its pages are mounted, `/<app id>`. */
  base: string;
  /** One of the app's settings by name: on a host its own settings file over the server's, on a server of one the server's environment. */
  env(name: string): string | undefined;
  /** The app's sender (TEXT_FROM), each text recorded in its audit; absent where the server has none. */
  texts?: Texts;
  now(): number;
  log(line: string): void;
  /** The server's public name (PUBLIC_HOST), for a form's Origin check. */
  publicHost: string;
  /** The console has a sign-in (CONSOLE_AUTH=token): a console page may offer Sign out. */
  consoleSignIn: boolean;
}

/** A converse app's pages, made by the server as it starts. */
export type ConversePagesFactory = (deps: ConversePageDeps) => AppRoutes;

/** What a converse app's chat takes from app.yaml's `chat`. */
export interface ConverseChatSettings {
  /**
   * A chat has no calling number. With this on (app.yaml `chat.callerNumberFromContext: true`), a chat
   * whose start's context names `callerNumber` is taken as calling from it: the account it is recognised
   * as, and the "caller" token of a phone param. Off by default, so a site cannot claim an account.
   */
  callerNumberFromContext: boolean;
}

/** The file beside agent.yaml that names a converse app and holds its chat settings. */
export const APP_FILE = 'app.yaml';

type AppYaml = z.output<typeof appSchema>;
let appJsonSchema: JsonSchema | null = null;

/**
 * The problems of a converse app's app.yaml, checked by app.yaml's own schema (as `pnpm check` checks it),
 * and that it says `mode: converse`: each at its line with a fix. The file's value where it has none.
 */
export function converseAppYamlProblems(text: string, file: string = APP_FILE): { problems: Problem[]; value?: AppYaml } {
  const lines = new LineCounter();
  const doc = parseDocument(text, { version: '1.2', schema: 'core', strict: true, uniqueKeys: true, prettyErrors: false, logLevel: 'error', lineCounter: lines, customTags: [] });
  const problems: Problem[] = [];
  for (const e of doc.errors) {
    const at = lines.linePos(e.pos[0]);
    problems.push({ file, line: at.line, column: at.col, path: '(file)', message: e.message.split('\n')[0] ?? e.message, fix: 'correct the YAML at this position (the files are YAML 1.2)' });
  }
  if (problems.length > 0) return { problems };
  const raw = doc.toJS();
  const parsed = appSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    appJsonSchema ??= z.toJSONSchema(appSchema, { io: 'input', target: 'draft-7' }) as JsonSchema;
    return { problems: problemsOfIssues(parsed.error.issues, { file, doc, lines, value: raw ?? {}, schema: appJsonSchema }) };
  }
  if (parsed.data.mode !== 'converse') {
    // At the mode key's value where it has one; at the file's start where it names none.
    const at = parsed.data.mode === undefined ? { line: 1, column: 1 } : positionOf(doc, lines, ['mode']);
    return { problems: [{ file, line: at.line, column: at.column, path: 'mode', message: `a converse app's app.yaml says "mode: converse"${parsed.data.mode === undefined ? ', and this one names no mode' : `, and this one says "${parsed.data.mode}"`}`, fix: 'write "mode: converse" in app.yaml' }] };
  }
  return { problems: [], value: parsed.data };
}

/** The app.yaml of a converse app's folder, checked (converseAppYamlProblems); throws AgentBusinessError with its problems. */
function readAppYaml(dir: string): AppYaml {
  let text: string;
  try {
    text = readFileSync(resolve(dir, APP_FILE), 'utf8');
  } catch {
    throw new AgentBusinessError([{ file: APP_FILE, line: 1, column: 1, path: '(file)', message: `${APP_FILE} cannot be read in ${dir}`, fix: `create ${APP_FILE} there, with the app's id and "mode: converse"` }]);
  }
  const { problems, value } = converseAppYamlProblems(text);
  if (!value) throw new AgentBusinessError(problems);
  return value;
}

/**
 * The app of the folder `dir`: its app.yaml (the app's id, `mode: converse`, its chat settings), its
 * agent.yaml (its env.<NAME> references kept as written: the server reads them from the app's own settings
 * as it starts, appWithSettings) and `code`. Refuses (AgentBusinessError, a path
 * and a fix per problem) an app.yaml its schema refuses or that is not converse's, an action with no code,
 * code for no action, and what the business's gate cannot hold (policyOf); agent.yaml's own check already
 * refuses a follow-on that takes a param its parent has not.
 */
export function defineConverseApp(dir: string, code: { tools: Record<string, ToolImpl>; pages?: AppRoutes | ConversePagesFactory; onText?: App['onText']; fresh?: () => ConverseApp }): ConverseApp {
  const yaml = readAppYaml(dir);
  const business = readAgentBusiness(dir);
  const problems: Problem[] = [];
  const add = (path: string, message: string, fix: string): void => void problems.push({ file: AGENT_FILE, line: 1, column: 1, path, message, fix });
  for (const name of Object.keys(business.actions)) {
    if (!Object.hasOwn(code.tools, name)) add(`actions.${name}`, `the action "${name}" has no code`, `add tools.${name} to the app's code, or delete the action`);
  }
  for (const name of Object.keys(code.tools)) {
    if (!Object.hasOwn(business.actions, name)) add('(code)', `the tool "${name}" is no action`, `add "${name}" under actions in ${AGENT_FILE}, or delete it from the code (actions: ${Object.keys(business.actions).join(', ') || 'none'})`);
  }
  if (problems.length > 0) throw new AgentBusinessError(problems);
  policyOf(business);
  return {
    mode: 'converse',
    id: yaml.id,
    dir: resolve(dir),
    business,
    tools: { ...code.tools },
    chat: { callerNumberFromContext: yaml.chat?.callerNumberFromContext === true },
    ...(code.pages !== undefined ? { pages: code.pages } : {}),
    ...(code.onText !== undefined ? { onText: code.onText } : {}),
    ...(code.fresh !== undefined ? { fresh: code.fresh } : {}),
  };
}

/** The app with agent.yaml's env.<NAME> references read from `settings`, the app's own (the server does this as it starts). */
export function appWithSettings(app: ConverseApp, settings: Record<string, string | undefined>): ConverseApp {
  return { ...app, business: resolveAgentSettings(app.business, settings) };
}

/** Whether a hosted app is a converse app (the server's dispatch: a converse app's chat runs on the converse runtime). */
export function isConverseApp(app: unknown): app is ConverseApp {
  return typeof app === 'object' && app !== null && (app as { mode?: unknown }).mode === 'converse';
}

/** The business's calendar (agent.yaml sources.calendar), its today in the business's zone (businessZone), or null where it has none. */
export function businessCalendar(b: AgentBusiness, now: () => Date): (Calendar & { bookings: { slotId: string; details: Record<string, string>; key: string }[] }) | null {
  const c = b.sources.calendar;
  if (c === undefined) return null;
  return fakeCalendar({ days: c.days, windows: c.windows, now, timeZone: businessZone(b) });
}

export type { Calendar, Slot };
